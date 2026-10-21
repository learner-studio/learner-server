import { NotFoundError } from '@learner/core/runtime/errors.js'
import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import { getRunUserId } from '@learner/core/lib/workflow/workflow-runs.js'
import { RunLearningHindsightRealtimeConsolidationStepOutput } from '../workflows/learning/hindsight-realtime-consolidation-steps.function.js'

const WORKFLOW = 'learningHindsightRealtimeConsolidationWorkflow'
export const StartLearningHindsightRealtimeConsolidationInput = z.object({
  bankId: z.string().min(1), scope: z.array(z.string().min(1)).max(16), sequence: z.number().int().nonnegative(),
  watermark: z.string().min(1), pendingFacts: z.number().int().nonnegative(), oldestPendingAt: z.string().datetime().nullable(),
})
export const StartLearningHindsightRealtimeConsolidationOutput = z.object({ runId: z.string().uuid() })
export const GetLearningHindsightRealtimeConsolidationInput = z.object({ runId: z.string().uuid() })
export const GetLearningHindsightRealtimeConsolidationOutput = z.object({
  status: z.enum(['running','suspended','completed','failed','cancelled']), result: RunLearningHindsightRealtimeConsolidationStepOutput.nullable(),
})
export const GetLearningHindsightRealtimeConsolidationStatusInput = z.object({})
export const GetLearningHindsightRealtimeConsolidationStatusOutput = z.object({ enabled: z.boolean(), bankConfigured: z.boolean(), countsKnown: z.boolean(), triggerRows: z.number().int().nonnegative().nullable(), activeRows: z.number().int().nonnegative().nullable() })

export const startLearningHindsightRealtimeConsolidation = defineFunction({
  title: 'Start a completed-fact Hindsight consolidation checkpoint', expose: true, audit: true, scopes: ['admin'],
  input: StartLearningHindsightRealtimeConsolidationInput, output: StartLearningHindsightRealtimeConsolidationOutput,
  func: async ({ workflowService }, input, { session, rpc }) => workflowService.startWorkflow(WORKFLOW, input, { type: 'http', userId: session.userId }, rpc),
})

export const getLearningHindsightRealtimeConsolidation = defineFunction({
  title: 'Read a Hindsight consolidation checkpoint', expose: true, readonly: true, audit: true, scopes: ['admin'],
  input: GetLearningHindsightRealtimeConsolidationInput, output: GetLearningHindsightRealtimeConsolidationOutput,
  func: async ({ workflowRunService }, { runId }, { session }) => {
    const run = await workflowRunService.getRun(runId)
    if (!run || run.workflow !== WORKFLOW || getRunUserId(run) !== session.userId) throw new NotFoundError('Hindsight consolidation checkpoint not found')
    const result = RunLearningHindsightRealtimeConsolidationStepOutput.safeParse(run.output)
    return { status: run.status, result: result.success ? result.data : null }
  },
})

export const getLearningHindsightRealtimeConsolidationStatus = defineFunction({
  title: 'Read Hindsight consolidation trigger status without source data', expose: true, readonly: true, audit: true, scopes: ['admin'],
  input: GetLearningHindsightRealtimeConsolidationStatusInput, output: GetLearningHindsightRealtimeConsolidationStatusOutput,
  func: async ({ learningHindsightConsolidationTriggerService }) => learningHindsightConsolidationTriggerService.status(),
})
