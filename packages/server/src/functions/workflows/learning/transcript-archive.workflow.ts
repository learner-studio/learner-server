import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'

import { RunLearningTranscriptArchiveScanStepOutput } from './transcript-archive-steps.function.js'

export const LearningTranscriptArchiveWorkflowInput = z.object({
  scanMode: z.enum(['periodic', 'daily']),
})

export const LearningTranscriptArchiveWorkflowOutput = RunLearningTranscriptArchiveScanStepOutput

export const learningTranscriptArchiveWorkflow = defineWorkflow({
  input: LearningTranscriptArchiveWorkflowInput,
  output: LearningTranscriptArchiveWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    const discovery = await workflow.do(
      '1. Discover configured local transcript stores',
      'discoverLearningTranscriptSourcesStep',
      { scanMode: data.scanMode },
    )
    return await workflow.do(
      '2. Deliver and verify a bounded transcript batch',
      'runLearningTranscriptArchiveScanStep',
      discovery,
      { retries: 2, retryDelay: '10s' },
    )
  },
})
