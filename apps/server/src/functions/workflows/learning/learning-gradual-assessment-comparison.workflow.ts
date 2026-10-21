import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'

export const LearningGradualAssessmentComparisonWorkflowInput = z.object({ runId: z.string().uuid() })
export const LearningGradualAssessmentComparisonWorkflowOutput = z.record(z.string(), z.unknown())

export const learningGradualAssessmentComparisonWorkflow = defineWorkflow({
  input: LearningGradualAssessmentComparisonWorkflowInput,
  output: LearningGradualAssessmentComparisonWorkflowOutput,
  func: async (_services, data, { workflow }) => {
    await workflow.do('Verify the frozen gradual-assessment comparison and identical arm contract', 'preflightLearningGradualAssessmentComparison', data, { retries: 0 })
    await Promise.all([
      workflow.do('Run the Luna High gradual assessment arm', 'runLearningGradualAssessmentArm', { ...data, armId: 'luna-high' }, { retries: 0 }),
      workflow.do('Run the AGY Gemini 3.7 Flash High gradual assessment arm', 'runLearningGradualAssessmentArm', { ...data, armId: 'agy-3.7-flash-high' }, { retries: 0 }),
    ])
    return await workflow.do('Persist the gradual-assessment comparison report', 'finalizeLearningGradualAssessmentComparison', data, { retries: 0 })
  },
})
