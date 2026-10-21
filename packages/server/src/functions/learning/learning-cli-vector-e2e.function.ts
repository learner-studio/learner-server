import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { LearningCliVectorE2EInput, LearningCliVectorE2ESummary } from '../workflows/learning/learning-cli-vector-e2e-steps.function.js'

// Dedicated RPC boundary: the retained scenario must exercise the live dev transport.

export const StartLearningCliVectorE2EOutput = z.object({ runId: z.string().uuid() })
export const GetLearningCliVectorE2EInput = z.object({ runId: z.string().uuid() })

export const startLearningCliVectorE2E = defineFunction({
  expose: true, audit: true, scopes: ['admin'], input: LearningCliVectorE2EInput, output: StartLearningCliVectorE2EOutput,
  func: async ({ workflowService }, input, { session, rpc }) => workflowService.startWorkflow(
    'learningCliVectorE2EWorkflow', input, { type: 'http', userId: session.userId }, rpc,
  ),
})
export const getLearningCliVectorE2E = defineFunction({
  expose: true, readonly: true, scopes: ['admin'], input: GetLearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: ({ learningCliVectorE2E }, { runId }) => learningCliVectorE2E.inspect(runId),
})
