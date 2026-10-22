import { z } from 'zod'

/**
 * Learning intervention policy: the one schema the server enforces and the web
 * app edits. Percent weights move in steps of 20, matching the sliders.
 *
 * Live: injectionRate, progressionLinearity (prerequisite strictness),
 * prerequisiteCount and prerequisiteDepth. The other weights are stored but not
 * yet read by the policy.
 */
const Weight = (fallback: number) => z.number().int().min(0).max(100).multipleOf(20).default(fallback)

export const PREREQUISITE_DEPTH_ALL = 'all'
export const PrerequisiteDepth = z.union([z.number().int().min(1).max(5), z.literal(PREREQUISITE_DEPTH_ALL)])
export type PrerequisiteDepth = z.infer<typeof PrerequisiteDepth>

export const LearningPolicySettings = z.object({
  /** Ceiling on teaching interventions: at most rate/20 of any 5 consecutive turns in a session. */
  injectionRate: Weight(40),
  /** Prerequisite strictness: a prerequisite below this understanding percent is unmet. 0 disables fallback. */
  progressionLinearity: Weight(60),
  /** How many unmet prerequisite concepts to inject (1-5). */
  prerequisiteCount: z.number().int().min(1).max(5).default(2),
  /** How many hops up the prerequisite hierarchy to look (1-5), or every ancestor. */
  prerequisiteDepth: PrerequisiteDepth.default(2),
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
