import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineFunction } from '../../runtime/define.js'
import { NotFoundError } from '@learner/core/runtime/errors.js'
import { z } from 'zod'
import { isRunActive } from '@learner/core/lib/workflow/workflow-runs.js'
import {
  LosslessArchiveBatchResult, LosslessArchiveRunInput, LosslessArchiveStartInput, LosslessArchiveStatusOutput,
} from '@learner/core/lib/learning/lossless-archive-schemas.js'

export const StartLearningLosslessArchiveInput = LosslessArchiveStartInput
export const EmptyLosslessArchiveInput = z.object({})
export const GetLearningLosslessArchiveSweepOutput = z.object({
  status: z.enum(['running', 'suspended', 'completed', 'failed', 'cancelled']),
  result: LosslessArchiveBatchResult.nullable(),
})
export const VerifyLearningLosslessArchiveVersionInput = z.object({ versionId: z.string().uuid() })
export const VerifyLearningLosslessArchiveVersionOutput = z.object({
  versionId: z.string().uuid(), sha256: z.string(), byteLength: z.number(), verified: z.literal(true),
})

export const startLearningLosslessArchiveSweep = defineFunction({
  title: 'Backfill approved CLI archives', expose: true, audit: true, scopes: ['admin'],
  input: StartLearningLosslessArchiveInput, output: LosslessArchiveRunInput,
  func: async ({ learningLosslessArchiveSyncService, workflowRunService, workflowService }, { mode, prefer }, { session, rpc }) => {
    if (learningAdmissionPaused()) throw new Error('Learning admission is paused')
    learningLosslessArchiveSyncService.assertEnabled()
    const runs = await workflowRunService.listRuns({ workflowName: 'learningLosslessArchiveWorkflow', limit: 20 })
    const active = runs.find((run) => isRunActive(run))
    // An in-flight sweep still owns its plan, so we return its runId as before
    // rather than starting a second one -- but a `prefer` hint is queued on the
    // sync service so the next discover honours it instead of dropping it.
    if (active) {
      if (prefer?.length) learningLosslessArchiveSyncService.enqueuePrefer(prefer)
      return { runId: active.id }
    }
    return await workflowService.startWorkflow('learningLosslessArchiveWorkflow',
      { mode, ...(prefer?.length ? { prefer } : {}) },
      { type: 'http', userId: session.userId }, rpc)
  },
})

export const getLearningLosslessArchiveSweep = defineFunction({
  title: 'Inspect a lossless CLI archive run', expose: true, readonly: true, scopes: ['admin'],
  input: LosslessArchiveRunInput, output: GetLearningLosslessArchiveSweepOutput,
  func: async ({ workflowRunService }, { runId }) => {
    const run = await workflowRunService.getRun(runId)
    if (!run || run.workflow !== 'learningLosslessArchiveWorkflow') throw new NotFoundError('Archive run not found')
    const result = LosslessArchiveBatchResult.safeParse(run.output)
    return { status: run.status, result: result.success ? result.data : null }
  },
})

export const getLearningLosslessArchiveStatus = defineFunction({
  title: 'Inspect archive coverage without transcript disclosure', expose: true, readonly: true, scopes: ['admin'],
  input: EmptyLosslessArchiveInput, output: LosslessArchiveStatusOutput,
  func: async ({ learningLosslessArchiveSyncService }) => learningLosslessArchiveSyncService.status(),
})

export const verifyLearningLosslessArchiveVersion = defineFunction({
  title: 'Verify a restored archive version', expose: true, readonly: true, scopes: ['admin'],
  input: VerifyLearningLosslessArchiveVersionInput, output: VerifyLearningLosslessArchiveVersionOutput,
  func: async ({ learningLosslessArchiveSyncService }, { versionId }) =>
    learningLosslessArchiveSyncService.verifyVersion(versionId),
})
