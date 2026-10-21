import { defineWorkflow } from "../../../runtime/define.js";
import { z } from "zod";
import { LosslessArchiveProofOutput } from "./lossless-archive-proof-steps.function.js";

export const LearningLosslessArchiveProofWorkflowInput = z.object({});
export const LearningLosslessArchiveProofWorkflowOutput =
  LosslessArchiveProofOutput;

export const learningLosslessArchiveProofWorkflow = defineWorkflow({
  title: "Synthetic lossless archive fidelity and recovery proof",
  input: LearningLosslessArchiveProofWorkflowInput,
  output: LearningLosslessArchiveProofWorkflowOutput,
  func: async ({}, _input, { workflow }) => {
    const fixture = await workflow.do(
      "Create an owned synthetic archive fixture",
      "setupLearningLosslessArchiveProofStep",
      { runId: workflow.runId },
      { retries: 2, retryDelay: "1s" },
    );
    const captured = await workflow.do(
      "Capture and restore hostile bytes and SQLite state",
      "captureLearningLosslessArchiveProofStep",
      fixture,
      { retries: 2, retryDelay: "2s" },
    );
    const recovered = await workflow.do(
      "Detect mutations and recover interrupted commits",
      "recoverLearningLosslessArchiveProofStep",
      captured,
      { retries: 2, retryDelay: "2s" },
    );
    return await workflow.do(
      "Publish metadata-only proof evidence",
      "finishLearningLosslessArchiveProofStep",
      recovered,
      { retries: 2, retryDelay: "1s" },
    );
  },
});
