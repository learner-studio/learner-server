import { defineFunction } from "../../runtime/define.js";
import { NotFoundError } from "@learner/core/runtime/errors.js";
import { z } from "zod";
import { sql } from "kysely";
import { getRunUserId } from "@learner/core/lib/workflow/workflow-runs.js";
import { LosslessArchiveProofOutput } from "../workflows/learning/lossless-archive-proof-steps.function.js";

export const StartLearningLosslessArchiveProofInput = z.object({});
export const StartLearningLosslessArchiveProofOutput = z.object({
  runId: z.string().uuid(),
});
export const GetLearningLosslessArchiveProofInput = z.object({
  runId: z.string().uuid(),
});
export const GetLearningLosslessArchiveProofOutput = z.object({
  status: z.enum(["running", "suspended", "completed", "failed", "cancelled"]),
  result: LosslessArchiveProofOutput.nullable(),
});
export const GetLearningLosslessArchiveProofHistoryInput = z.object({});
export const GetLearningLosslessArchiveProofHistoryOutput = z.object({
  proofs: z.array(LosslessArchiveProofOutput),
});

export const startLearningLosslessArchiveProof = defineFunction({
  title: "Start isolated lossless archive proof",
  expose: true,
  audit: true,
  scopes: ["admin"],
  input: StartLearningLosslessArchiveProofInput,
  output: StartLearningLosslessArchiveProofOutput,
  func: async ({ workflowService }, _input, { session, rpc }) =>
    workflowService.startWorkflow(
      "learningLosslessArchiveProofWorkflow",
      {},
      { type: "http", userId: session.userId },
      rpc,
    ),
});

export const getLearningLosslessArchiveProof = defineFunction({
  title: "Read isolated lossless archive proof",
  expose: true,
  readonly: true,
  audit: true,
  scopes: ["admin"],
  input: GetLearningLosslessArchiveProofInput,
  output: GetLearningLosslessArchiveProofOutput,
  func: async ({ workflowRunService }, { runId }, { session }) => {
    const run = await workflowRunService.getRun(runId);
    if (
      !run ||
      run.workflow !== "learningLosslessArchiveProofWorkflow" ||
      getRunUserId(run) !== session.userId
    ) {
      throw new NotFoundError("Lossless archive proof not found");
    }
    const result = LosslessArchiveProofOutput.safeParse(run.output);
    return { status: run.status, result: result.success ? result.data : null };
  },
});

export const getLearningLosslessArchiveProofHistory = defineFunction({
  title: "List retained lossless archive proof evidence",
  expose: true,
  readonly: true,
  audit: true,
  scopes: ["admin"],
  input: GetLearningLosslessArchiveProofHistoryInput,
  output: GetLearningLosslessArchiveProofHistoryOutput,
  func: async ({ kysely }) => {
    const rows = await sql<{ result: unknown }>`
      SELECT result FROM learning_archive_runs
       WHERE run_kind = 'e2e' AND status = 'completed' AND result IS NOT NULL
       ORDER BY completed_at DESC LIMIT 20
    `.execute(kysely);
    return {
      proofs: rows.rows.flatMap(({ result }) => {
        const parsed = LosslessArchiveProofOutput.safeParse(result);
        return parsed.success ? [parsed.data] : [];
      }),
    };
  },
});
