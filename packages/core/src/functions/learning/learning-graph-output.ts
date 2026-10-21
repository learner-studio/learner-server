import { CurriculumRollupsSchema, curriculumRollups } from '../../lib/learning/learning-curriculum-rollup.js'
import { LearningGraphWithLearnerStateSchema, type LearningGraphWithLearnerState } from './learning-seed.js'

/** The getLearningGraph response: the learner's graph plus the completion rollups the API owns. */
export const LearningGraphWithRollupsSchema = LearningGraphWithLearnerStateSchema.extend({
  rollups: CurriculumRollupsSchema,
})

/** Attach rollups computed over the graph's FINAL concepts, so they reflect the assessments actually served. */
export const withCurriculumRollups = <T extends LearningGraphWithLearnerState>(graph: T): T & { rollups: ReturnType<typeof curriculumRollups> } =>
  ({ ...graph, rollups: curriculumRollups(graph.curriculum, graph.concepts) })
