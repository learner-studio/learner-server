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
     * The oldest DUE arrival (one routed to at least one concept, or not yet routed under the current revision; a message that
     * matched nothing is not due, whoever wrote it) newer than both the oldest stuck item and the last service: a reactive
     * reading or a settled pass (the last route with assessment off), floored at when Learning or assessment was last switched
     * on. Null when nothing is stuck or none is due.
     */
    unservedSince: z.string().nullable().default(null),
    /**
     * Due-arrival minutes since `unservedSince`: each gap between due arrivals, and the time since the last, capped at 30 min.
     * Not the learner's working time: an overnight backfill of concept-matching messages accrues too. Red at `stallHours` of them.
     */
    unservedActiveMinutes: z.number().default(0),
    /**
     * The backstop's evidence: the oldest unserved arrival that is the stuck items' own work (unrouted or held, or routed to a
     * concept that is blocked or retrying). Red once it is 48 h old and `stuckReturnedAt` is at least 12 h after it.
     */
    stuckUnservedSince: z.string().nullable().default(null),
    /** The newest such arrival at least `stallHours` old: the learner came back and that work went unserved too. */
    stuckReturnedAt: z.string().nullable().default(null),
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
