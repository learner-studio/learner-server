import { pikkuWorkflowFunc } from '#pikku/workflow/pikku-workflow-types.gen.js'
import { LearningPlaygroundWorkflowInput, LearningPlaygroundResponseOutput } from '@learner/core/lib/learning/learning-playground.js'

export const learningPlaygroundWorkflow = pikkuWorkflowFunc({
  // A schedule or queue job starts the run with no owner; each step applies its own rules.
  auth: false,
  input: LearningPlaygroundWorkflowInput,
  output: LearningPlaygroundResponseOutput,
  func: async ({}, data, { workflow }) => {
    const lookup = await workflow.do('Learning lookup', 'lookupLearningPlaygroundStep', data, { retries: 0 })
    const responseResult = await workflow.do('CLI response', 'respondLearningPlaygroundStep', { ...data, lookup }, { retries: 3, retryDelay: '5s' })
    await workflow.do('Background normalization', 'normalizeLearningPlaygroundStep', { ...data, lookup, responseResult }, { retries: 2, retryDelay: '1s' })
    return responseResult
  },
})
