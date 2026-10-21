import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'

const Projection = z.object({
  bankId: z.string().min(1), scope: z.array(z.string().min(1)).max(16), sequence: z.number().int().nonnegative(), watermark: z.string().min(1),
  pendingFacts: z.number().int().nonnegative(), oldestPendingAt: z.string().datetime().nullable(),
})
const Result = z.object({
  state: z.enum(['disabled','empty','no_change','below_threshold','busy','uncertain','submitted','polling','completed','failed','timed_out']),
  operationId: z.string().uuid().optional(),
})

export const RunLearningHindsightRealtimeConsolidationStepInput = Projection
export const RunLearningHindsightRealtimeConsolidationStepOutput = Result

export const runLearningHindsightRealtimeConsolidationStep = defineSessionlessFunction({
  title: 'Reserve and submit eligible native Hindsight consolidation',
  expose: false,
  tags: ['internal', 'learning-hindsight'],
  description: 'Uses completed derived-fact receipts only; a native submit transport ambiguity is fail-closed.',
  input: RunLearningHindsightRealtimeConsolidationStepInput,
  output: RunLearningHindsightRealtimeConsolidationStepOutput,
  func: async ({ learningHindsightConsolidationTriggerService }, input) => learningHindsightConsolidationTriggerService.trigger(input),
})

export const PollLearningHindsightRealtimeConsolidationStepInput = Projection.pick({ bankId: true, scope: true })
export const PollLearningHindsightRealtimeConsolidationStepOutput = Result

export const pollLearningHindsightRealtimeConsolidationStep = defineSessionlessFunction({
  title: 'Checkpoint one existing native Hindsight consolidation operation',
  expose: false,
  tags: ['internal', 'learning-hindsight'],
  input: PollLearningHindsightRealtimeConsolidationStepInput,
  output: PollLearningHindsightRealtimeConsolidationStepOutput,
  func: async ({ learningHindsightConsolidationTriggerService }, input) => learningHindsightConsolidationTriggerService.poll(input),
})
