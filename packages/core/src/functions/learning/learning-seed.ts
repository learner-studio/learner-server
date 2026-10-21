import { z } from 'zod'
import { LearningConceptAssessmentSchema } from '../../lib/learning/learning-concept-assessment-schemas.js'
import { VectorExperiment } from '../../lib/learning/learning-vector-turn-schemas.js'

export const LearningProvenanceSchema = z.object({
  /**
   * Where a node came from. The four are genuinely different claims and the
   * shape report depends on telling them apart: `external-material` means the
   * node was transcribed from published course material, `model-generated`
   * means a model proposed it for this learner's own curriculum, and
   * `model-seed` is reserved for the shipped library. Collapsing the middle
   * two would make grounded share unmeasurable, which is the one number that
   * answers whether reference material changed the curriculum or only its
   * wording.
   */
  kind: z.enum(['model-seed', 'external-material', 'human-curated', 'model-generated']),
  source: z.string(),
  version: z.string(),
})

const DEFAULT_SEED_PROVENANCE = {
  kind: 'model-seed' as const,
  source: 'openai-gpt-5.6',
  version: '2026-09-04',
}

export const LearningConceptSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  explanation: z.string(),
  example: z.string(),
  domain: z.string().default('computer-science'),
  capability: z.string().default('conceptual-reasoning'),
  provenance: LearningProvenanceSchema.default(DEFAULT_SEED_PROVENANCE),
  x: z.number(),
  y: z.number(),
})

export const LearningMasteryLevelSchema = z.enum([
  'unknown',
  'exposed',
  'partially-understood',
  'operational',
  'well-understood',
  'uncertain',
])

export const LearningMasterySummarySchema = z.object({
  level: LearningMasteryLevelSchema,
  score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  interval: z.object({
    low: z.number().min(0).max(1),
    high: z.number().min(0).max(1),
  }),
  firstExposureAt: z.string().nullable(),
  lastRetrievalAt: z.string().nullable(),
  lastSuccessfulRetrievalAt: z.string().nullable(),
  nextReviewAt: z.string().nullable(),
  evidenceCount: z.number().int().nonnegative(),
  strongEvidenceCount: z.number().int().nonnegative(),
})

export const LearningEvidenceSchema = z.object({
  id: z.string(),
  provider: z.enum(['anthropic', 'openai']),
  location: z.enum(['local', 'remote']),
  threadId: z.string(),
  threadTitle: z.string(),
  agent: z.string(),
  occurredAt: z.string(),
  userTurn: z.string(),
  assistantTurn: z.string().nullable(),
  indication: z.enum([
    'recognition',
    'reconstruction',
    'explanation',
    'prediction',
    'application',
    'transfer',
    'delayed-retrieval',
    'misconception',
    'insufficient-evidence',
  ]),
  confidence: z.number().min(0).max(1),
  outcome: z.enum(['supports', 'partial', 'contradicts', 'indeterminate']),
})

export const LearningMasteryPromotionSchema = z.object({
  fromLevel: LearningMasteryLevelSchema,
  toLevel: LearningMasteryLevelSchema,
  occurredAt: z.string(),
  evidenceId: z.string().nullable(),
  indication: z.string(),
  confidence: z.number().min(0).max(1),
})

export const LearningEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(['hard-prerequisite', 'related']),
  confidence: z.number().min(0).max(1).default(1),
  provenance: LearningProvenanceSchema.default(DEFAULT_SEED_PROVENANCE),
})

export const LearningLaneSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  order: z.number().int().positive(),
  color: z.string(),
  provenance: LearningProvenanceSchema,
})

export const LearningModuleSchema = z.object({
  id: z.string(),
  step: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  laneId: z.string(),
  conceptIds: z.array(z.string()),
  parentId: z.string().nullable(),
  dependsOnModuleIds: z.array(z.string()).default([]),
  masteryGoals: z.array(z.string()).default([
    'Explain the module as a connected mental model.',
    'Predict how changing one part affects the rest of the system.',
  ]),
  provenance: LearningProvenanceSchema.default(DEFAULT_SEED_PROVENANCE),
})

export const LearningGraphSchema = z.object({
  curriculum: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    /**
     * Matches the `learning_curricula_status_check` constraint exactly. It was
     * `z.literal('seed')` while every curriculum shipped with the app. A
     * generated one is proposed before it is accepted, and because `getGraph`
     * parses EVERY row through this schema and `listGraphs` maps it inside a
     * Promise.all, a status this schema refuses does not hide one curriculum —
     * it rejects the whole list and 500s the learning page.
     */
    status: z.enum(['seed', 'draft', 'approved']),
    domain: z.string().default('computer-science'),
    provenance: LearningProvenanceSchema.default(DEFAULT_SEED_PROVENANCE),
    lanes: z.array(LearningLaneSchema).min(1),
    modules: z.array(LearningModuleSchema),
  }),
  concepts: z.array(LearningConceptSchema),
  edges: z.array(LearningEdgeSchema),
})

export const LearningGraphWithLearnerStateSchema = LearningGraphSchema.extend({
  vectorExperiment: VectorExperiment.optional(),
  availableCurriculums: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(['seed', 'draft', 'approved']),
  })),
  selectedCurriculumId: z.string(),
  availableDatasets: z.array(z.object({
    tag: z.string(),
    label: z.string(),
    runId: z.string(),
    experimentLabel: z.string(),
    pairCount: z.number().int().nonnegative(),
    matchCount: z.number().int().nonnegative(),
    conceptIds: z.array(z.string()),
    completedAt: z.string(),
  })),
  concepts: z.array(LearningConceptSchema.extend({
    mastery: LearningMasterySummarySchema,
    assessment: LearningConceptAssessmentSchema.optional(),
  })),
})

export const LearningConceptDetailSchema = z.object({
  concept: LearningConceptSchema,
  moduleIds: z.array(z.string()),
  mastery: LearningMasterySummarySchema,
  evidence: z.object({
    total: z.number().int().nonnegative(),
    preview: LearningEvidenceSchema.nullable(),
  }),
  masteryPromotions: z.array(LearningMasteryPromotionSchema),
})

export type LearningGraph = z.infer<typeof LearningGraphSchema>
export type LearningGraphWithLearnerState = z.infer<typeof LearningGraphWithLearnerStateSchema>
export type LearningMasterySummary = z.infer<typeof LearningMasterySummarySchema>

export const emptyLearningMastery = (): LearningMasterySummary => ({
  level: 'unknown',
  score: 0,
  confidence: 0,
  interval: { low: 0, high: 0 },
  firstExposureAt: null,
  lastRetrievalAt: null,
  lastSuccessfulRetrievalAt: null,
  nextReviewAt: null,
  evidenceCount: 0,
  strongEvidenceCount: 0,
})

export const addLearnerState = (
  graph: LearningGraph,
  availableCurriculums: LearningGraph[] = [graph],
  availableDatasets: LearningGraphWithLearnerState['availableDatasets'] = [],
): LearningGraphWithLearnerState => ({
  ...graph,
  availableCurriculums: availableCurriculums.map(({ curriculum }) => ({
    id: curriculum.id,
    title: curriculum.title,
    description: curriculum.description,
    status: curriculum.status,
  })),
  selectedCurriculumId: graph.curriculum.id,
  availableDatasets,
  concepts: graph.concepts.map((concept) => ({ ...concept, mastery: emptyLearningMastery() })),
})
