import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'
import { LosslessArchiveBatchResult, LosslessArchiveMode, LosslessArchivePrefer } from '@learner/core/lib/learning/lossless-archive-schemas.js'

export const LearningLosslessArchiveWorkflowInput = z.object({ mode: LosslessArchiveMode, prefer: LosslessArchivePrefer.optional() })

export const learningLosslessArchiveWorkflow = defineWorkflow({
  title: 'Lossless CLI archive capture and restore verification',
  input: LearningLosslessArchiveWorkflowInput, output: LosslessArchiveBatchResult,
  func: async ({}, data, { workflow }) => {
    const discovery = await workflow.do('Inventory approved sources', 'discoverLearningLosslessArchiveStep',
      { runId: workflow.runId, mode: data.mode, ...(data.prefer?.length ? { prefer: data.prefer } : {}) },
      { retries: 2, retryDelay: '5s' })
    const captured = await workflow.do('Capture verified bytes and seal checkpoints', 'captureLearningLosslessArchiveStep',
      { runId: discovery.runId }, { retries: 2, retryDelay: '10s' })
    const retried = await workflow.do('Retry pending sources from durable checkpoints', 'captureLearningLosslessArchiveStep',
      captured, { retries: 2, retryDelay: '10s' })
    const finalCapture = await workflow.do('Finish bounded recovery passes', 'captureLearningLosslessArchiveStep',
      retried, { retries: 2, retryDelay: '10s' })
    const verified = await workflow.do('Reconstruct durable versions', 'verifyLearningLosslessArchiveStep',
      finalCapture, { retries: 2, retryDelay: '10s' })
    await workflow.do('Archive gateway media and project exposure observations', 'ingestLearningExposureSpoolStep',
      {}, { retries: 2, retryDelay: '10s' })
    await workflow.do('Notify canonical index after projection','markLearningIndexDirtyStep',{runId:workflow.runId},{retries:2,retryDelay:'1s'})
    await workflow.do('Wake canonical index','dispatchLearningIndexStep',{}, {retries:2,retryDelay:'1s'})
    return await workflow.do('Publish coverage and fidelity gaps', 'finishLearningLosslessArchiveStep',
      verified, { retries: 2, retryDelay: '5s' })
  },
})
