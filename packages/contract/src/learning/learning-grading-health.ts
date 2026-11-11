import { z } from 'zod'

/**
 * Health of reactive grading (getLearningGradingHealth): red when indexed arrivals
 * or admitted concepts have waited longer than `stallHours` with nothing in that
 * stage completed, so a stalled grader is loud in the web app instead of a log line.
 */
export const ReactiveGradingHealth = z.object({
  status: z.enum(['ok', 'warning', 'error']),
  checkedAt: z.string(),
  stallHours: z.number(),
  enabled: z.boolean(),
  assessmentEnabled: z.boolean(),
  routing: z.object({
    waiting: z.number(), oldestWaitingAt: z.string().nullable(), lastRoutedAt: z.string().nullable(),
    held: z.number(), exhausted: z.number(), oldestExhaustedAt: z.string().nullable(), error: z.string().nullable(),
  }),
  grading: z.object({
    waiting: z.number(), oldestWaitingAt: z.string().nullable(), running: z.number(), lastSettledAt: z.string().nullable(),
    settledInWindow: z.number(), lastReadingAt: z.string().nullable(), blocked: z.number(), blockedUnpaid: z.number(), oldestBlockedAt: z.string().nullable(),
    retryingUnpaid: z.number(), oldestRetryingAt: z.string().nullable(), unverifiedPasses: z.number(),
  }),
  /** The scheduled stall check itself; null where schedules are off (nothing would run it). */
  stallCheck: z.object({ lastFinishedAt: z.string().nullable(), lastStatus: z.string().nullable() }).nullable(),
  messages: z.array(z.string()),
})
