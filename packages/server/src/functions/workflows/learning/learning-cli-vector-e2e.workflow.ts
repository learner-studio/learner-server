import { defineWorkflow } from '../../../runtime/define.js'
import { LearningCliVectorE2EInput, LearningCliVectorE2ESummary } from './learning-cli-vector-e2e-steps.function.js'

export const learningCliVectorE2EWorkflow = defineWorkflow({
  title: 'One genuine CLI turn reaches archive, PostgreSQL and Hindsight, then is exactly removed',
  input: LearningCliVectorE2EInput, output: LearningCliVectorE2ESummary,
  func: async ({}, data, { workflow }) => {
    const stepInput = { ...data, workflowRunId: workflow.runId }
    await workflow.do('Reserve unique fixture and mastery exclusion', 'prepareLearningCliVectorE2EStep', stepInput, { retries: 0, onError: 'failLearningCliVectorE2EStep' })
    await workflow.do('Send exactly one tiny prompt through the shared CLI adapter', 'callLearningCliVectorE2EStep', data, { retries: 0, onError: 'failLearningCliVectorE2EStep' })
    await workflow.do('Capture and project the genuine dedicated transcript', 'captureLearningCliVectorE2EStep', data, { retries: 0, onError: 'failLearningCliVectorE2EStep' })
    await workflow.do('Notify the canonical index through durable admission', 'notifyLearningCliVectorE2EIndexStep', data, { retries: 2, retryDelay: '1s', onError: 'failLearningCliVectorE2EStep' })
    await workflow.do('Wait for exact fixture message embeddings', 'waitLearningCliVectorE2EIndexStep', data, { retries: 0, onError: 'failLearningCliVectorE2EStep' })
    await workflow.do('Recall and hydrate exact source evidence', 'verifyLearningCliVectorE2EStep', data, { retries: 0, onError: 'failLearningCliVectorE2EStep' })
    await workflow.do('Delete only enumerated fixture source, archive, exposure and vector data', 'cleanupLearningCliVectorE2EStep', data, { retries: 2, retryDelay: '1s', onError: 'failLearningCliVectorE2EStep' })
    return await workflow.do('Prove fixture payload and reingestion source are absent', 'proveLearningCliVectorE2ECleanStep', data, { retries: 2, retryDelay: '1s', onError: 'failLearningCliVectorE2EStep' })
  },
})
