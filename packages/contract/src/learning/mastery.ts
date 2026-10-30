import { z } from 'zod'

/**
 * Mastery notifications (docs/specs/mastery-notifications.md). Positive only:
 * every notification is a first clear reading or a gain, and `delta` is never
 * negative. learner-desktop polls `getMasteryNotifications` with the newest
 * `completedAt` it has seen as `since` (the server keeps no cursor); the web app
 * calls the same RPCs with its admin session.
 */
export const MasteryNotification = z.object({
  /** The assessment run that produced the reading; the key for dedupe and feedback. */
  runId: z.string(),
  conceptId: z.string(),
  conceptName: z.string(),
  kind: z.enum(['first_clear', 'gain']),
  percent: z.number(),
  /** The best earlier medium/high reading, or null when there is none. */
  previousPercent: z.number().nullable(),
  /** percent − previousPercent when positive, else null. Never negative. */
  delta: z.number().nonnegative().nullable(),
  confidence: z.enum(['medium', 'high']),
  completedAt: z.string(),
  /** The first demonstration's quote from the learner's own words, when the reading has one. */
  quote: z.string().nullable(),
})

export const GetMasteryNotificationsInput = z.object({
  /** Only readings completed strictly after this time; null for all of them. */
  since: z.string().datetime({ offset: true }).nullable(),
  limit: z.number().int().min(1).max(100).default(20),
})
export const GetMasteryNotificationsOutput = z.object({
  /** Newest first. */
  notifications: z.array(MasteryNotification),
})

export const BaselineStatus = z.object({
  learning: z.object({
    /** Concepts tracking: one high reading, or two medium ones. */
    have: z.number().int(),
    /** Concepts the learner has been exposed to. */
    need: z.number().int(),
    /** New tracking concepts per day over the last 14 days. */
    pacePerDay: z.number(),
    /** Null while there are fewer than 3 days of readings, or no pace yet. */
    daysLeft: z.number().int().nullable(),
  }),
  /** Null when this server has no habits database. */
  coach: z.object({
    arms: z.array(z.object({ arm: z.string(), have: z.number().int(), need: z.number().int() })),
    /** The baseline arm's 30 s breach rate, or the prior (0.35) until it has 50 rows. */
    baselineBreachRate: z.number(),
    baselineRateMeasured: z.boolean(),
    pacePerArmPerDay: z.number(),
    daysLeft: z.number().int().nullable(),
  }).nullable(),
})

export const RecordNotificationFeedbackInput = z.object({
  runId: z.string().min(1),
  action: z.enum(['opened', 'nice', 'not_right', 'ignored']),
})
export const RecordNotificationFeedbackOutput = z.object({
  /** False when the run is not one of this learner's live readings. A replay is still true. */
  recorded: z.boolean(),
  at: z.string(),
})
