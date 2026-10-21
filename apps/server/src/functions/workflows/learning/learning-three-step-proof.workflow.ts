import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'

export const LearningThreeStepProofWorkflowInput = z.object({
  runId: z.string().uuid(),
  maxBatchTokens: z.number().int().positive().max(400_000).default(400_000),
})
export const LearningThreeStepProofWorkflowOutput = z.record(z.string(), z.unknown())

export const learningThreeStepProofWorkflow = defineWorkflow({
  input: LearningThreeStepProofWorkflowInput,
  output: LearningThreeStepProofWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    const stepInput = { runId: data.runId, maxBatchTokens: data.maxBatchTokens }
    await workflow.do('Verify frozen three-step proof and native one-call preflight', 'preflightLearningThreeStepProof', stepInput, { retries: 0 })
    await workflow.do('Run one native Hindsight consolidation', 'runLearningThreeStepConsolidation', stepInput, { retries: 0 })
    await workflow.do('Run one review-only node assessment', 'runLearningThreeStepAssessment', stepInput, { retries: 0 })
    return await workflow.do('Persist the three-step proof report', 'finalizeLearningThreeStepProof', stepInput, { retries: 0 })
  },
})
