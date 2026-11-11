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
  /** A gain's best earlier medium/high reading; null for a first clear reading. */
  previousPercent: z.number().nullable(),
  /** A gain's percent − previousPercent (≥ 10); null for a first clear reading. Never negative. */
  delta: z.number().nonnegative().nullable(),
  confidence: z.enum(['medium', 'high']),
  /** When the reading went live (a reactive reading: when its pass finished). */
  completedAt: z.string(),
  /** The first demonstration's quote from the learner's own words, when the reading has one. */
  quote: z.string().nullable(),
})

export const GetMasteryNotificationsInput = z.object({
  /**
   * null: the newest `limit`. A time: readings live strictly after it, the OLDEST `limit` of
   * them, so a client that moves its cursor to the newest `completedAt` it received never
   * skips one. A page never splits readings that share a `completedAt` and may exceed `limit` by them.
   */
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

/** The Osmosis Map's progress strip (S5). The web passes the selected curriculum's concepts. */
export const GetMasteryProgressInput = z.object({ conceptIds: z.array(z.string()).max(5000) })
export const MasteryProgressWindow = z.object({
  window: z.enum(['24h', '7d', '30d']),
  /**
   * The curriculum's mean, over its concepts, of each one's latest counted (medium/high)
   * reading at the window's start and now; a concept with none counts as 0.
   */
  beforePercent: z.number(),
  nowPercent: z.number(),
  /** Concepts with a prior-blind gain beyond grader noise in the window (the only ▲). Declines are never counted. */
  up: z.number().int().nonnegative(),
  /** Concepts whose first clear reading (live grader) came in the window: an event, not a gain beyond noise. */
  firstClear: z.number().int().nonnegative(),
})
export const MasteryProgress = z.object({
  /** beforePercent/nowPercent are the LIVE grader's scores: each grading starts from the previous score, so they rise on their own. */
  scores: z.literal('live'),
  /** Mean rise of one live grading over its prior, measured (null before any). */
  liveRisePerGrading: z.number().nullable(),
  windows: z.array(MasteryProgressWindow),
  /** Curriculum concepts due for spaced review now (held-out concepts excluded). */
  due: z.number().int().nonnegative(),
})

// ---------------------------------------------------------------------------------------------
// Honest statistics (docs/specs/mastery-change-statistics.md). Signed: declines are included.
// Readings are placed by EVIDENCE time. Positive-only stays for the toasts and the strip's "up".

/** A 95 % interval, bootstrapped over concepts. */
export const MasteryInterval = z.object({ low: z.number(), high: z.number() })

export const GetMasteryChangesInput = z.object({
  /** Change since this many days ago (the last reading before then is the start); null = all time. */
  sinceDays: z.number().int().min(1).max(3650).nullable().default(null),
})
export const MasteryConceptChange = z.object({
  conceptId: z.string(),
  conceptName: z.string(),
  /** First and last PRIOR-BLIND measurement used (points). */
  from: z.number(),
  to: z.number(),
  /** Evidence times (ISO) of the first and last measurement used. */
  fromAt: z.string(),
  toAt: z.string(),
  /** to − from, signed. */
  delta: z.number(),
  /** Precision-weighted slope over the concept's measurements, points per week; null when they share one time. */
  slopePerWeek: z.number().nullable(),
  readings: z.number().int(),
  /** Beyond prior-blind grader noise after Benjamini–Hochberg across the concepts reported together (5 % false discoveries). */
  beyondNoise: z.boolean(),
  /** Two-sided p-value of the change against none. */
  pValue: z.number(),
  /** A measurement at 0 or 100, where the scale cannot show further movement. */
  atBound: z.boolean(),
})
/** An aggregate of per-concept change: random-effects mean, t-widened bootstrap interval over concepts. */
export const MasteryAggregate = z.object({
  /** Random-effects mean of per-concept change, points; null with no concept measured twice. */
  meanChange: z.number().nullable(),
  /** Null below `minimumConcepts` concepts: not enough data for an honest interval. */
  changeInterval: MasteryInterval.nullable(),
  meanSlopePerWeek: z.number().nullable(),
  slopeInterval: MasteryInterval.nullable(),
  /** sd of true change between concepts beyond grader noise (DerSimonian–Laird τ). */
  betweenConceptSd: z.number().nullable(),
  nConcepts: z.number().int(),
  minimumConcepts: z.number().int(),
  nReadings: z.number().int(),
  /** Concepts beyond noise after Benjamini–Hochberg; one at a time, and how many of those chance alone gives. */
  nBeyondNoise: z.number().int(),
  nBeyondNoiseUnadjusted: z.number().int(),
  expectedBeyondNoiseByChance: z.number(),
  nAtBound: z.number().int(),
  /** Mean live (anchored) gradings between each concept's first and last measurement. */
  meanGradingsBetween: z.number().nullable(),
  /** The change interval excludes zero and clears the prior-blind grader's drift over the mean span (review round 2, S-b). */
  conclusive: z.boolean(),
  /** The drift a verdict must clear: points per week with its 95 % interval, the concepts' mean span in weeks, and the interval times the span. Null for the live series. */
  drift: z.object({
    perWeek: z.number().nullable(),
    interval: z.object({ low: z.number(), high: z.number() }).nullable(),
    spanWeeks: z.number(),
    expected: z.object({ low: z.number(), high: z.number() }).nullable(),
  }).nullable(),
  /** The change interval excludes zero but not the drift: "rose"/"fell" withheld. */
  withheldForDrift: z.boolean(),
})
export const MasteryNoise = z.object({
  /** sd of one prior-blind grading (identical-evidence regrades with no prior in the prompt): the error every verdict uses. */
  blindSd: z.number(),
  blindDf: z.number().int(),
  blindSource: z.enum(['measured', 'fallback']),
  /** sd of one blind measurement's EVIDENCE error, common to its replicates (review round 2, NB1): Var(measurement) = evidenceSd² + blindSd²/k. */
  evidenceSd: z.number(),
  /** 95 % interval of evidenceSd from blind measurements of different evidence close in time; null while it is the fallback. */
  evidenceInterval: z.object({ low: z.number(), high: z.number() }).nullable(),
  evidencePairs: z.number().int(),
  evidenceSource: z.enum(['measured', 'fallback']),
  /** Replicates earn precision only once evidenceSd is measured; until then a measurement of any k counts as one grading. */
  replicateCredit: z.boolean(),
  /** sd of one live grading given the same prior: the live grader's fresh noise, small because it copies the prior. */
  anchoredSd: z.number(),
  anchoredDf: z.number().int(),
  /** Live gradings' move from their own prior: how much scores rise per grading on their own. */
  drift: z.object({
    gradings: z.number().int(),
    meanMove: z.number().nullable(),
    sdMove: z.number().nullable(),
    equal: z.number().nullable(),
    up: z.number().nullable(),
    down: z.number().nullable(),
  }),
})
/** Why the notification feed is quiet (review S10): the recency rule's pass rate and how far grading is behind. */
export const MasteryFeedHealth = z.object({
  windowDays: z.number().int(),
  recencyDays: z.number().int(),
  /** Counted readings citing a learner message that went live in the window. */
  citedReadings: z.number().int(),
  /** Of them, cited a message at most `recencyDays` older than the reading going live. */
  withinRecency: z.number().int(),
  /** Of them, news: recent and newer than everything already shown (the feed's own rule). */
  news: z.number().int(),
  /** Median days from the cited message to the reading going live; null with no reading in the window. */
  medianLagDays: z.number().nullable(),
  newestEvidenceAt: z.string().nullable(),
})
export const MasteryChanges = z.object({
  sinceDays: z.number().int().nullable(),
  noise: MasteryNoise,
  /** Points a prior-blind measurement of `gainThresholdGradings` gradings must rise over one earlier of as many to be a gain (one-sided 95 %), never below the +10 floor. */
  gainThreshold: z.number(),
  /** The learner's usual (median) gradings per blind measurement. */
  gainThresholdGradings: z.number().int(),
  /** Prior-blind measurements: the only series that carries a verdict. */
  concepts: z.array(MasteryConceptChange),
  aggregate: MasteryAggregate,
  /** The live scores (each grading starts from the previous score): descriptive, with what the grader's own drift explains. */
  anchored: MasteryAggregate.extend({ expectedFromDrift: z.number().nullable() }),
  feed: MasteryFeedHealth,
})

export const HoldoutPower = z.object({
  /** 'ancova' once the arms are fitted; 'all_pairs' (follow-up on baseline over every concept measured twice) before. */
  varianceSource: z.enum(['ancova', 'all_pairs']).nullable(),
  residualSd: z.number().nullable(),
  /** Smallest effect detectable with today's n at 80 % power, two-sided α = 0.05. */
  minimumDetectableEffect: z.number().nullable(),
  /** Concepts measured twice needed in all (and of them held out) to detect `targetEffect` points. */
  targetEffect: z.number(),
  conceptsNeeded: z.number().int().nullable(),
  heldOutNeeded: z.number().int().nullable(),
  conceptsStillNeeded: z.number().int().nullable(),
  /** Concepts newly measured twice per week (last four weeks), and the weeks the rest takes at that pace. */
  pacePerWeek: z.number().nullable(),
  weeksToTarget: z.number().int().nullable(),
})
export const HoldoutArms = z.object({ taught: z.number().int(), heldOut: z.number().int() })
export const HoldoutEstimate = z.object({
  /** 'setting_baseline' until `minimumPerArm` concepts per arm are measured twice; then 'estimate'. */
  state: z.enum(['setting_baseline', 'estimate']),
  measuredTwice: HoldoutArms,
  /** Concepts with a pre-start baseline but no follow-up yet (for `probe`: probed concepts whose FIRST probe produced no prior-blind reading). */
  baselineOnly: HoldoutArms,
  /** First measured after the start: no baseline untouched by teaching, so outside the estimate. */
  noPreStartBaseline: HoldoutArms,
  /** Share of each arm's pre-start concepts measured again (1 − attrition). */
  measuredTwiceShare: z.object({ taught: z.number().nullable(), heldOut: z.number().nullable() }),
  /** Mean live gradings between baseline and follow-up per arm: unequal means unequal opportunity. */
  gradingsBetween: z.object({ taught: z.number().nullable(), heldOut: z.number().nullable() }),
  /** The model adjusts for gradings between (the live, anchored series). */
  adjustedForGradings: z.boolean(),
  /** Whether the model adjusts for weeks from baseline to follow-up (the probe headline: the arms are probed at different rates, review round 2 NB2). */
  adjustedForElapsed: z.boolean(),
  /** Mean weeks from baseline to follow-up per arm: unequal = follow-ups at different times. */
  elapsedWeeks: z.object({ taught: z.number().nullable(), heldOut: z.number().nullable() }),
  minimumPerArm: z.number().int(),
  /** Taught minus held-out follow-up, adjusted for baseline (ANCOVA), points. Null while setting the baseline. */
  effect: z.number().nullable(),
  interval: MasteryInterval.nullable(),
  conclusive: z.boolean(),
  /** Unadjusted, to read the estimate by: mean change from baseline and mean baseline per arm. */
  meanChange: z.object({ taught: z.number().nullable(), heldOut: z.number().nullable() }),
  meanBaseline: z.object({ taught: z.number().nullable(), heldOut: z.number().nullable() }),
  power: HoldoutPower,
})
export const HoldoutEffect = z.object({
  experimentKey: z.string(),
  /** The current phase: a changed holdout share starts a new one. */
  phase: z.number().int(),
  buckets: z.number().int(),
  heldOutShare: z.number(),
  startedAt: z.string(),
  noise: MasteryNoise,
  /** The headline: each probed concept's prior-blind answer to its FIRST delivered probe, an equal opportunity in both arms. Null until a first probe is answered. */
  probe: HoldoutEstimate.nullable(),
  /** Per arm, concepts with a pre-start baseline and how many of them had a first probe delivered: the headline conditions on being probed (review round 2, S-d). */
  probed: z.object({
    taught: z.object({ probed: z.number().int(), eligible: z.number().int() }),
    heldOut: z.object({ probed: z.number().int(), eligible: z.number().int() }),
  }),
  /** Every prior-blind measurement: opportunistic (teaching drives how often a concept is read), never a verdict. */
  estimate: HoldoutEstimate,
  /** The live scores, adjusted for gradings between: descriptive only. */
  anchored: HoldoutEstimate,
})
