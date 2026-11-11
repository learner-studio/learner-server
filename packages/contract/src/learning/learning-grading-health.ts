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
    /**
     * The oldest DUE arrival (a user message, an arrival routed to a concept, or one not yet routed) newer than both the
     * oldest stuck item and the last reactive reading (the last route with assessment off); null when nothing is stuck or none is due.
     */
    unservedSince: z.string().nullable().default(null),
    /**
     * Due-arrival minutes since `unservedSince`: each gap between due arrivals, and the time since the last, capped at 30 min.
     * Not the learner's working time: an overnight backfill of concept-matching messages accrues too. Red at `stallHours`
     * of them, or once `unservedSince` is 48 h old.
     */
    unservedActiveMinutes: z.number().default(0),
  }),
  grading: z.object({
    waiting: z.number(), oldestWaitingAt: z.string().nullable(), running: z.number(), lastSettledAt: z.string().nullable(),
    settledInWindow: z.number(), lastReadingAt: z.string().nullable(), blocked: z.number(), blockedUnpaid: z.number(), oldestBlockedAt: z.string().nullable(),
    retryingUnpaid: z.number(), oldestRetryingAt: z.string().nullable(), unverifiedPasses: z.number(),
  }),
  /**
   * The scheduled stall check itself; null where schedules are off (nothing would run it).
   * `lastFinishedAt` is the last run that reached a verdict (completed, or failed with the stall alarm);
   * `failing` is the error of the latest run when it crashed without a verdict.
   */
  stallCheck: z.object({ lastFinishedAt: z.string().nullable(), lastStatus: z.string().nullable(), failing: z.string().nullable().default(null) }).nullable(),
  messages: z.array(z.string()),
})
