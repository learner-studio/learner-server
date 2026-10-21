import { defineWorkflow } from '../../../runtime/define.js'
import { LearningPlaygroundWorkflowInput, LearningPlaygroundResponseOutput } from '@learner/core/lib/learning/learning-playground.js'

export const learningPlaygroundWorkflow = defineWorkflow({
  input: LearningPlaygroundWorkflowInput,
  output: LearningPlaygroundResponseOutput,
  func: async ({}, data, { workflow }) => {
    const lookup = await workflow.do('Learning lookup', 'lookupLearningPlaygroundStep', data, { retries: 0 })
    const responseResult = await workflow.do('CLI response', 'respondLearningPlaygroundStep', { ...data, lookup }, { retries: 0 })
    await workflow.do('Background normalization', 'normalizeLearningPlaygroundStep', { ...data, lookup, responseResult }, { retries: 2, retryDelay: '1s' })
    return responseResult
  },
})
