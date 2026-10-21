import { defineWorkflow } from '../../../runtime/define.js'
import { LearningAssessmentRunInput, LearningAssessmentStepOutput } from '../../learning/learning-concept-assessment.function.js'

export const learningConceptAssessmentWorkflow = defineWorkflow({
  input: LearningAssessmentRunInput, output: LearningAssessmentStepOutput,
  func: async ({}, data, { workflow }) => {
    await workflow.do('Assess retrieved original messages', 'executeLearningConceptAssessmentStep', data, { retries: 0 })
    const result = await workflow.do('Publish review-only version-guarded estimate', 'publishLearningConceptAssessmentStep', data, { retries: 2, retryDelay: '1s' })
    return result
  },
})
