import { defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'

import {
  LearningHookProviderSchema,
  normalizeLearningHook,
} from '@learner/core/lib/learning/learning-hooks.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const ReceiveLearningHookInput = z.record(z.string(), z.unknown())

export const ReceiveLearningHookOutput = z.object({
  accepted: z.boolean(),
  provider: LearningHookProviderSchema,
  queued: z.number().int().nonnegative(),
  ignored: z.boolean(),
  eventIds: z.array(z.string()),
  reason: z.string().nullable(),
})

export const receiveLearningHook = defineSessionlessFunction({
  title: 'Receive Learning Hook',
  description: 'Normalize a provider lifecycle hook and enqueue it for local learning ingestion.',
  // HTTP-only ingress. The provider hook must be public to the local runtime,
  // but it is not a model-facing RPC and should not be exposed as one.
  expose: false,
  auth: false,
  readonly: false,
  input: ReceiveLearningHookInput,
  output: ReceiveLearningHookOutput,
  func: async ({ queueService }, input, { http }) => {
    assertLearningLocalMvpEnabled()
    const routeProvider = http?.request?.params().provider
    const bodyProvider = input.provider
    const providerResult = LearningHookProviderSchema.safeParse(routeProvider ?? bodyProvider)
    if (!providerResult.success) {
      throw new Error('Learning hook provider must be anthropic or openai')
    }

    const normalized = normalizeLearningHook(providerResult.data, input)
    const jobIds: string[] = []
    for (const event of normalized.events) {
      jobIds.push(await queueService.add('learning.hook-ingest', event, {
        jobId: `learning-hook:${event.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 250 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      }))
    }
    return {
      accepted: true,
      provider: providerResult.data,
      queued: jobIds.length,
      ignored: normalized.ignored,
      eventIds: normalized.events.map((event) => event.id),
      reason: normalized.reason ?? null,
    }
  },
})
