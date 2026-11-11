import { z } from 'zod'

/**
 * Health of reactive grading (getLearningGradingHealth), so a stalled grader is loud in the web app instead of a
 * log line. `error` (it fails the scheduled stall check and reaches the learner's CLI sessions) when: indexed
 * arrivals or admitted concepts have waited longer than `stallHours` with nothing in that stage completed since the
 * later of its last completion and the last switch-on; stuck items (blocked, retrying unpaid, exhausted holds) have
 * due arrivals unserved for `stallHours` of active time, or (the backstop) their own work unserved 48 h with the
 * learner back to more of it; passes keep settling with no reading for 24 h; or the stall check itself is dead or
 * crashing. `warning` for the same stuck items without that evidence, routing that matched no concept for 24 h
 * against a history that matched, and passes graded without some chunks. The full rules are in
 * docs/operations/reactive-grading-runbook.md.
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
    /**
     * This owner's routes in the last 24 h (`routed`, `matched` to at least one concept) and in the 30 days before them
     * (`baselineRouted`, `baselineMatched`). A warning when 20+ routed and none matched while the baseline had 20+ and matched 5%+.
     */
    matching: z.object({ routed: z.number(), matched: z.number(), baselineRouted: z.number(), baselineMatched: z.number() }).nullable().default(null),
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
