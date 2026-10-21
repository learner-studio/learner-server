import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'
import { markIndexDirty } from '@learner/core/lib/learning/learning-index-admission.js'

export const LearningCliVectorE2EInput = z.object({
  runId: z.string().uuid(),
  sessionId: z.string().uuid(),
  marker: z.string().min(20).max(160).regex(/^cli-vector-e2e-[a-f0-9-]+$/),
  workflowRunId: z.string().uuid().optional(),
})
export const LearningCliVectorE2ESummary = z.object({
  runId: z.string().uuid(), workflowRunId: z.string().uuid().nullable(), provider: z.literal('claude'), model: z.literal('haiku'),
  sessionId: z.string().uuid(), markerSha256: z.string(), promptSha256: z.string(), replySha256: z.string().nullable(),
  promptBytes: z.number(), replyBytes: z.number().nullable(), sourcePath: z.string(), sourceId: z.string().uuid().nullable(),
  archiveRunId: z.string().uuid().nullable(), versionIds: z.array(z.string().uuid()), observationIds: z.array(z.string().uuid()),
  messageIds: z.array(z.string()), chunkIds: z.array(z.string()), operationIds: z.array(z.string().uuid()),
  callAttempts: z.number(), masteryExcluded: z.literal(true), status: z.string(), startedAt: z.string(),
  cliCompletedAt: z.string().nullable(), archivedAt: z.string().nullable(), indexedAt: z.string().nullable(), cleanedAt: z.string().nullable(),
  timings: z.record(z.string(), z.unknown()), cleanupCounts: z.record(z.string(), z.unknown()), error: z.string().nullable(),
})
export const FailLearningCliVectorE2EInput = z.object({ error: z.object({ message: z.string() }) })
export const FailLearningCliVectorE2EOutput = z.object({ cleaned: z.boolean() })

export const prepareLearningCliVectorE2EStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: ({ learningCliVectorE2E }, input) => {
    if (!input.workflowRunId) throw new Error('Durable workflow identity required')
    return learningCliVectorE2E.prepare(input, input.workflowRunId)
  },
})
export const callLearningCliVectorE2EStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  workflowQueued: true, workflowTimeout: '3m', workflowRetries: 0,
  func: ({ learningCliVectorE2E }, input) => learningCliVectorE2E.call(input),
})
export const captureLearningCliVectorE2EStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: ({ learningCliVectorE2E }, input) => learningCliVectorE2E.capture(input),
})
export const notifyLearningCliVectorE2EIndexStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: async ({ learningCliVectorE2E }, input, { rpc }) => {
    try {
      await markIndexDirty(input.runId)
      await rpc.invoke('dispatchLearningIndexStep', {})
      return learningCliVectorE2E.inspect(input.runId)
    } catch (error) {
      await learningCliVectorE2E.failAndClean(input.runId, error)
      throw error
    }
  },
})
export const waitLearningCliVectorE2EIndexStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  workflowQueued: true, workflowTimeout: '4m', workflowRetries: 0,
  func: ({ learningCliVectorE2E }, input) => learningCliVectorE2E.waitIndexed(input),
})
export const verifyLearningCliVectorE2EStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: ({ learningCliVectorE2E }, input) => learningCliVectorE2E.verify(input),
})
export const cleanupLearningCliVectorE2EStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: ({ learningCliVectorE2E }, { runId }) => learningCliVectorE2E.cleanup(runId),
})
export const proveLearningCliVectorE2ECleanStep = defineSessionlessFunction({ input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: ({ learningCliVectorE2E }, { runId }) => learningCliVectorE2E.proveClean(runId),
})
export const failLearningCliVectorE2EStep = defineSessionlessFunction({
  input: FailLearningCliVectorE2EInput, output: FailLearningCliVectorE2EOutput,
  func: async ({ learningCliVectorE2E, workflowRunService }, { error }, { workflowStep }) => {
    if (!workflowStep?.runId) throw new Error('CLI vector E2E compensation requires a workflow run')
    const run = await workflowRunService.getRun(workflowStep.runId)
    if (!run || run.workflow !== 'learningCliVectorE2EWorkflow') throw new Error('CLI vector E2E compensation received the wrong workflow run')
    const input = LearningCliVectorE2EInput.parse(run.input)
    const receipt = await learningCliVectorE2E.inspectOrNull(input.runId)
    if (!receipt) return { cleaned: false }
    await learningCliVectorE2E.failAndClean(input.runId, new Error(error.message))
    return { cleaned: true }
  },
})
