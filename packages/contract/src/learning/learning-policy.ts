import { z } from 'zod'

/**
 * Learning intervention policy: the one schema the server enforces and the web
 * app edits. Percent weights move in steps of 20, matching the sliders.
 *
 * Live: injectionRate, randomizedInjection, progressionLinearity (prerequisite
 * strictness), prerequisiteCount, prerequisiteDepth, spacedRepetition, reviewHops, blindProbes, probeRate and probeHops. The
 * other weights are stored but not yet read by the policy.
 */
const Weight = (fallback: number) => z.number().int().min(0).max(100).multipleOf(20).default(fallback)

export const PREREQUISITE_DEPTH_ALL = 'all'
export const PrerequisiteDepth = z.union([z.number().int().min(1).max(5), z.literal(PREREQUISITE_DEPTH_ALL)])
export type PrerequisiteDepth = z.infer<typeof PrerequisiteDepth>

/** reviewHops at this value means any distance in the concept graph (still never an unconnected concept). */
export const REVIEW_HOPS_ALL = 5
export const ReviewHops = z.number().int().min(1).max(REVIEW_HOPS_ALL)

/** Spaced-repetition schedule: days a concept may go unexposed, by published mastery percent (lowest band first). */
export const REVIEW_SCHEDULE = [
  { below: 20, days: 1 },
  { below: 40, days: 2 },
  { below: 60, days: 4 },
  { below: 80, days: 8 },
  { below: 101, days: 16 },
] as const
/** Unknown is not zero mastery: an unscored concept gets its own middle interval. */
export const REVIEW_UNSCORED_DAYS = 3
export const reviewIntervalDays = (understandingPercent: number | null): number =>
  understandingPercent === null ? REVIEW_UNSCORED_DAYS : REVIEW_SCHEDULE.find((band) => understandingPercent < band.below)!.days

export const LearningPolicySettings = z.object({
  /** Ceiling on teaching interventions: at most rate/20 of any 5 consecutive turns in a session. */
  injectionRate: Weight(40),
  /** Randomized injection: a turn worth teaching is injected by a coin flip with probability injectionRate/100
   * (a pure function of the turn id) instead of the quota, so injected and skipped turns can be compared. */
  randomizedInjection: z.boolean().default(false),
  /** Prerequisite strictness: a prerequisite below this understanding percent is unmet. 0 disables fallback. */
  progressionLinearity: Weight(60),
  /** How many unmet prerequisite concepts to inject (1-5). */
  prerequisiteCount: z.number().int().min(1).max(5).default(2),
  /** How many hops up the prerequisite hierarchy to look (1-5), or every ancestor. */
  prerequisiteDepth: PrerequisiteDepth.default(2),
  /** Spaced repetition: re-inject a due concept the learner met before when it is related to the turn. */
  spacedRepetition: z.boolean().default(false),
  /** Hop distance for relevancy (1-5): the most edges between a due concept and the turn's concepts; 5 means all. */
  reviewHops: ReviewHops.default(1),
  /** Blind probes: on some injected turns, one neutral check question about a concept related to the turn. Only a
   * turn with a related concept in BOTH the held-out and the taught arm is probed; a fair coin on the turn id
   * then picks the arm. A question, never a lesson. */
  blindProbes: z.boolean().default(false),
  /** Percent of turns that draw a probe (a pure function of the turn id). Fewer are delivered: see probe_outcome. */
  probeRate: Weight(20),
  /** Hop distance for a probe (1-5; 5 means all): the most edges between a probed concept and the turn's concepts.
   * Its own setting, wider than reviewHops by default: one concept in five is held out, so near the turn there
   * is often none, and a turn without one in range is not probed at all. */
  probeHops: ReviewHops.default(2),
  /**
   * Independent gradings per reading (docs/specs/mastery-change-statistics.md): the published
   * reading is their mean. 1 = one grading, today's behaviour; each extra one costs a full model call.
   */
  gradingReplicates: z.number().int().min(1).max(5).default(1),
  /**
   * osmosis-concept-holdout share: 1 concept in `holdoutBuckets` is never taught. Changing it starts
   * a new experiment phase (learning_holdout_phases); the analysis reads the current phase only.
   */
  holdoutBuckets: z.number().int().min(2).max(20).default(5),
  reviewUrgency: Weight(40),
  taskRelevance: Weight(80),
  misconceptionPriority: Weight(80),
  frontierPull: Weight(40),
  uncertaintyProbing: Weight(40),
  repetitionAvoidance: Weight(60),
  transferDepth: Weight(60),
})
export type LearningPolicySettings = z.infer<typeof LearningPolicySettings>
export const DEFAULT_LEARNING_POLICY: LearningPolicySettings = LearningPolicySettings.parse({})

export const LearningPolicyConfig = LearningPolicySettings.extend({ updatedAt: z.string().nullable() })
export type LearningPolicyConfig = z.infer<typeof LearningPolicyConfig>

/** The injection ceiling counts turns in windows of this size; a 20% slider step is one turn. */
export const INJECTION_WINDOW_TURNS = 5
