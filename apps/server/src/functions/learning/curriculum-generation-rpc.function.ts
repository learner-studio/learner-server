import { defineFunction } from '../../runtime/define.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  CurriculumGraphProposal,
  CurriculumOutline,
  CurriculumRunStatus,
  CurriculumSourceRef,
} from '@learner/core/lib/learning/curriculum-generation-types.js'
import { canApproveRun, canRebuildRun } from '@learner/core/lib/learning/curriculum-run-gates.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import {
  StartCurriculumBuildInput,
  StartCurriculumProposalInput,
} from './curriculum-generation.function.js'

/**
 * The four things a learner does with a curriculum generation run: start one,
 * watch it, approve the outline it proposes, or reject it.
 *
 * Approval is its own RPC rather than a flag on start, because it is the point
 * of the whole design: the learner reads a transcribed syllabus and decides
 * whether it is the thing they asked for BEFORE any tree is built. Rejecting
 * is equally first-class — a rejected run keeps its outline and its sources, so
 * the next attempt can be compared against what was turned down.
 *
 * Every read is scoped to `session.userId`. Generated curricula are private,
 * and a run id must never be enough to read one.
 */

const RunView = z.object({
  runId: z.string(),
  status: CurriculumRunStatus,
  objective: z.string(),
  domain: z.string().nullable(),
  scale: z.string().nullable(),
  curriculumId: z.string().nullable(),
  outline: CurriculumOutline.nullable(),
  proposal: CurriculumGraphProposal.nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export const StartCurriculumGenerationInput = z.object({
  objective: z.string().min(8).max(500),
})

export const StartCurriculumGenerationOutput = z.object({
  runId: z.string(),
  status: CurriculumRunStatus,
})

export const startCurriculumGeneration = defineFunction({
  title: 'Start Curriculum Generation',
  description: 'Turn a stated learning objective into a proposed curriculum outline.',
  // Same gate as every other Learning write: the surface is dev-only and
  // admin-held. Ownership is still enforced per run inside the function —
  // the scope says who may reach the feature, the run row says whose it is.
  scopes: ['admin'],
  expose: true,
  input: StartCurriculumGenerationInput,
  output: StartCurriculumGenerationOutput,
  func: async ({ learningCurriculumGenerationStore, workflowService }, { objective }, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    const runId = randomUUID()
    // The row exists before the workflow starts, so a workflow that fails to
    // dispatch still leaves the learner something to look at.
    await learningCurriculumGenerationStore.createRun({ id: runId, ownerUserId: session.userId, objective })
    const proposalInput: z.infer<typeof StartCurriculumProposalInput> = { runId, objective, userId: session.userId }
    await workflowService.startWorkflow(
      'curriculumProposalWorkflow',
      proposalInput,
      { type: 'http', userId: session.userId },
      rpc,
    )
    return { runId, status: 'interpreting' as const }
  },
})

export const GetCurriculumGenerationRunInput = z.object({ runId: z.string().min(1) })

export const GetCurriculumGenerationRunOutput = z.object({
  run: RunView,
  sources: z.array(CurriculumSourceRef),
})

export const getCurriculumGenerationRun = defineFunction({
  title: 'Get Curriculum Generation Run',
  description: 'Read one curriculum generation run and the material it was grounded in.',
  expose: true,
  readonly: true,
  input: GetCurriculumGenerationRunInput,
  output: GetCurriculumGenerationRunOutput,
  func: async ({ learningCurriculumGenerationStore }, { runId }, { session }) => {
    assertLearningLocalMvpEnabled()
    const run = await learningCurriculumGenerationStore.getRun(runId, session.userId)
    if (!run) throw new Error(`No such curriculum run: ${runId}`)
    return {
      run: {
        runId: run.id,
        status: run.status,
        objective: run.objective,
        domain: run.domain,
        scale: run.scale,
        curriculumId: run.curriculumId,
        outline: run.outline,
        proposal: run.graphProposal,
        error: run.error,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      },
      sources: await learningCurriculumGenerationStore.listSources(runId),
    }
  },
})

/** Exported even though it is empty: the previous host refused an inline schema at an
 * `input:` site (PKU489) and boots with a critical diagnostic, taking the whole
 * API down rather than skipping the one function. */
export const ListCurriculumGenerationRunsInput = z.object({})

export const ListCurriculumGenerationRunsOutput = z.object({ runs: z.array(RunView) })

export const listCurriculumGenerationRuns = defineFunction({
  title: 'List Curriculum Generation Runs',
  description: 'Every curriculum the signed-in learner has asked for.',
  expose: true,
  readonly: true,
  input: ListCurriculumGenerationRunsInput,
  output: ListCurriculumGenerationRunsOutput,
  func: async ({ learningCurriculumGenerationStore }, _input, { session }) => {
    assertLearningLocalMvpEnabled()
    const runs = await learningCurriculumGenerationStore.listRuns(session.userId)
    return {
      runs: runs.map((run) => ({
        runId: run.id,
        status: run.status,
        objective: run.objective,
        domain: run.domain,
        scale: run.scale,
        curriculumId: run.curriculumId,
        outline: run.outline,
        proposal: run.graphProposal,
        error: run.error,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
      })),
    }
  },
})

export const ApproveCurriculumOutlineInput = z.object({ runId: z.string().min(1) })

export const ApproveCurriculumOutlineOutput = z.object({
  runId: z.string(),
  status: CurriculumRunStatus,
})

export const approveCurriculumOutline = defineFunction({
  title: 'Approve Curriculum Outline',
  description: 'Accept a proposed outline and build the skill tree from it.',
  // Same gate as every other Learning write: the surface is dev-only and
  // admin-held. Ownership is still enforced per run inside the function —
  // the scope says who may reach the feature, the run row says whose it is.
  scopes: ['admin'],
  expose: true,
  input: ApproveCurriculumOutlineInput,
  output: ApproveCurriculumOutlineOutput,
  func: async ({ learningCurriculumGenerationStore, workflowService }, { runId }, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    const run = await learningCurriculumGenerationStore.getRun(runId, session.userId)
    if (!run) throw new Error(`No such curriculum run: ${runId}`)
    const gate = canApproveRun(run.status, run.outline !== null)
    if (!gate.allowed) throw new Error(`Run ${runId} cannot be approved: ${gate.reason}`)
    await learningCurriculumGenerationStore.updateRun(runId, { status: 'inferring', error: null })
    // Typed against the workflow's own input schema. `startWorkflow` takes the
    // payload as unknown and validates it at dispatch, so an extra or missing
    // key is a run that fails a second later with a schema error and a status
    // that never moves; the annotation makes that a compile error instead.
    const buildInput: z.infer<typeof StartCurriculumBuildInput> = { runId, userId: session.userId }
    await workflowService.startWorkflow(
      'curriculumBuildWorkflow',
      buildInput,
      { type: 'http', userId: session.userId },
      rpc,
    )
    return { runId, status: 'inferring' as const }
  },
})

export const RebuildCurriculumTreeInput = z.object({ runId: z.string().min(1) })

export const RebuildCurriculumTreeOutput = z.object({
  runId: z.string(),
  status: CurriculumRunStatus,
})

export const rebuildCurriculumTree = defineFunction({
  title: 'Rebuild Curriculum Tree',
  description: 'Write the concepts and edges again from an outline already approved, replacing the current graph.',
  // Same gate as every other Learning write: the surface is dev-only and
  // admin-held. Ownership is still enforced per run inside the function.
  scopes: ['admin'],
  expose: true,
  input: RebuildCurriculumTreeInput,
  output: RebuildCurriculumTreeOutput,
  func: async ({ learningCurriculumGenerationStore, workflowService }, { runId }, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    const run = await learningCurriculumGenerationStore.getRun(runId, session.userId)
    if (!run) throw new Error(`No such curriculum run: ${runId}`)
    const gate = canRebuildRun(run.status, run.outline !== null)
    if (!gate.allowed) throw new Error(`Run ${runId} cannot be rebuilt: ${gate.reason}`)
    await learningCurriculumGenerationStore.updateRun(runId, { status: 'inferring', error: null })
    // The SAME build workflow the approval starts. A rebuild is not a second
    // code path — it is the existing durable build re-entered, which is what
    // keeps the two from drifting apart. The curriculum id is derived from the
    // outline title and the run id, so the write lands on the very rows this
    // run wrote before and replaces them.
    const buildInput: z.infer<typeof StartCurriculumBuildInput> = { runId, userId: session.userId }
    await workflowService.startWorkflow(
      'curriculumBuildWorkflow',
      buildInput,
      { type: 'http', userId: session.userId },
      rpc,
    )
    return { runId, status: 'inferring' as const }
  },
})

export const RejectCurriculumOutlineInput = z.object({
  runId: z.string().min(1),
  reason: z.string().max(500).optional(),
})

export const RejectCurriculumOutlineOutput = z.object({
  runId: z.string(),
  status: CurriculumRunStatus,
  removedCurriculum: z.boolean(),
})

export const rejectCurriculumOutline = defineFunction({
  title: 'Reject Curriculum Outline',
  description: 'Turn down a proposed outline, removing anything already built from it.',
  // Same gate as every other Learning write: the surface is dev-only and
  // admin-held. Ownership is still enforced per run inside the function —
  // the scope says who may reach the feature, the run row says whose it is.
  scopes: ['admin'],
  expose: true,
  input: RejectCurriculumOutlineInput,
  output: RejectCurriculumOutlineOutput,
  func: async ({ learningCurriculumGenerationStore }, { runId, reason }, { session }) => {
    assertLearningLocalMvpEnabled()
    const run = await learningCurriculumGenerationStore.getRun(runId, session.userId)
    if (!run) throw new Error(`No such curriculum run: ${runId}`)
    // A rejection after the build removes the tree, so a curriculum the learner
    // turned down cannot linger in their library. The outline and the sources
    // stay: they are the record of what was turned down.
    const removedCurriculum = run.curriculumId
      ? await learningCurriculumGenerationStore.deleteGeneratedCurriculum(run.curriculumId, session.userId)
      : false
    await learningCurriculumGenerationStore.updateRun(runId, {
      status: 'rejected',
      curriculumId: null,
      ...(reason ? { error: `Rejected by the learner: ${reason}` } : {}),
    })
    return { runId, status: 'rejected' as const, removedCurriculum }
  },
})
