import { z } from 'zod'

/**
 * Learning intervention policy: the one schema the server enforces and the web
 * app edits. Percent weights move in steps of 20, matching the sliders.
 *
 * Live: injectionRate, progressionLinearity (prerequisite strictness),
 * prerequisiteCount, prerequisiteDepth, spacedRepetition and reviewHops. The
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
