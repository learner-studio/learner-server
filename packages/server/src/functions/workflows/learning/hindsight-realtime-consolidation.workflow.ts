import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'

import { RunLearningHindsightRealtimeConsolidationStepOutput } from './hindsight-realtime-consolidation-steps.function.js'

export const LearningHindsightRealtimeConsolidationWorkflowInput = z.object({
  bankId: z.string().min(1), scope: z.array(z.string().min(1)).max(16), sequence: z.number().int().nonnegative(), watermark: z.string().min(1),
  pendingFacts: z.number().int().nonnegative(), oldestPendingAt: z.string().datetime().nullable(),
})
export const LearningHindsightRealtimeConsolidationWorkflowOutput = RunLearningHindsightRealtimeConsolidationStepOutput

/** Three one-minute checkpoints bound a run; a later periodic dispatch resumes only its saved native ID. */
export const learningHindsightRealtimeConsolidationWorkflow = defineWorkflow({
  input: LearningHindsightRealtimeConsolidationWorkflowInput, output: LearningHindsightRealtimeConsolidationWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    const submitted = await workflow.do('1. Reserve completed fact watermark and submit once', 'runLearningHindsightRealtimeConsolidationStep', data, { retries: 0 })
    if (submitted.state !== 'polling' && submitted.state !== 'submitted') return submitted
    await workflow.sleep('Wait one minute before native operation checkpoint 1', '1min')
    const firstPoll = await workflow.do('2. Checkpoint only the returned native operation', 'pollLearningHindsightRealtimeConsolidationStep', { bankId: data.bankId, scope: data.scope }, { retries: 0 })
    if (firstPoll.state !== 'polling') return firstPoll
    await workflow.sleep('Wait one minute before native operation checkpoint 2', '1min')
    const secondPoll = await workflow.do('3. Checkpoint the existing native operation again', 'pollLearningHindsightRealtimeConsolidationStep', { bankId: data.bankId, scope: data.scope }, { retries: 0 })
    if (secondPoll.state !== 'polling') return secondPoll
    await workflow.sleep('Wait one minute before native operation checkpoint 3', '1min')
    return await workflow.do('4. Final bounded native operation checkpoint', 'pollLearningHindsightRealtimeConsolidationStep', { bankId: data.bankId, scope: data.scope }, { retries: 0 })
  },
})
