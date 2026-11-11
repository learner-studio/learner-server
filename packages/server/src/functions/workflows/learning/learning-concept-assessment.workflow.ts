import { defineWorkflow } from '../../../runtime/define.js'
import { LearningAssessmentRunInput, LearningAssessmentStepOutput } from '../../learning/learning-concept-assessment.function.js'


export const learningConceptAssessmentWorkflow = defineWorkflow({
  input: LearningAssessmentRunInput, output: LearningAssessmentStepOutput,
  func: async ({}, data, { workflow }) => {
    // gradingReplicates: k > 1 grades the reading k times and publishes the mean (no-op plan at k = 1).
    const plan = await workflow.do('Plan independent replicate gradings', 'planLearningAssessmentReplicatesStep', data, { retries: 2, retryDelay: '1s' })
    // Paid steps retry: the attempt lease (llm-attempt-lease.ts) waits for a live owner, takes over a dead one's call
    // on a repeat-free backend (3 takeovers at most) and refuses a metered unknown, so a retry never pays twice. A
    // call whose CLI child died with no result throws instead of recording a failure, and the retry takes it over.
    await workflow.do('Assess retrieved original messages', 'executeLearningConceptAssessmentStep', data, { retries: 3, retryDelay: '5s' })
    for (const replicate of plan.replicates) {
      await workflow.do('Grade one independent replicate', 'executeLearningAssessmentReplicateStep', { runId: data.runId, replicate }, { retries: 3, retryDelay: '5s' })
    }
    if (plan.replicates.length) await workflow.do('Publish the mean of the replicate gradings', 'combineLearningAssessmentReplicatesStep', data, { retries: 2, retryDelay: '1s' })
    const result = await workflow.do('Publish review-only version-guarded estimate', 'publishLearningConceptAssessmentStep', data, { retries: 2, retryDelay: '1s' })
    return result
  },
})
