import { z } from 'zod'

/** Coverage of the canonical Learning semantic index, as the web app shows it. */
export const LearningIndexStatus = z.object({
  bank: z.string(), model: z.string(), enabled: z.boolean(), scheduleEnabled: z.boolean(),
  watermark: z.string(), canonicalMessages: z.number(), rawObservations: z.number(), indexedMessages: z.number(), indexedChunks: z.number(),
  pendingMessages: z.number(), emptyMessages: z.number(), mediaOnlyMessages: z.number(), unsupportedMessages: z.number(), errorMessages: z.number(),
  latestIndexedAt: z.string().nullable(), activeRunId: z.string().nullable(), runStatus: z.string().nullable(),
  scope: z.enum(['all-queryable', 'bounded-pilot']),
  limitations: z.array(z.string()),
})
