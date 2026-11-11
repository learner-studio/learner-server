import { z } from 'zod'
import { learningNativeHookOutput } from './learning-context-delivery.js'

export const LearningHookContextInput = z.object({
  message:z.string().trim().min(1).max(6000),sessionId:z.string().min(1).max(200),requestId:z.string().uuid(),
  foundationFirst:z.boolean().default(false),
})
export const LearningHookContextOutput = z.object({
  decision:z.enum(['influence','no_context','fail_open']),context:z.string().max(4000),conceptIds:z.array(z.string()).max(5),
  datasetTag:z.literal('dev1'),experimentId:z.string().uuid().nullable(),foundationFirst:z.boolean(),
  policyRevision:z.enum(['foundation-first-v1','task-teaching-v2']),durationMs:z.number(),requestId:z.string().uuid(),
  /** Operator alarms, as on the live-feedback begin packet: a default install (liveFeedback off) gets them here (round-4 S5). */
  alerts:z.array(z.string()).default([]),
  /** Identifies the alarm state: the hook shows an alert once per key, then every 24 h. */
  alertKey:z.string().nullable().default(null),
})
export function claudeLearningContext(value: unknown) {
  const result=LearningHookContextOutput.safeParse(value)
  if(!result.success || result.data.decision!=='influence' || !result.data.context) return {}
  return learningNativeHookOutput('claude', result.data.context)
}
