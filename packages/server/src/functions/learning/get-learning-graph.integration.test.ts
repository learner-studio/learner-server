import { describe, expect, test } from 'bun:test'
import { getKysely } from '@learner/core/db.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'
import { LearningCurriculumStore } from '@learner/core/services/learning-curriculum-store.js'
import { LearningVectorTurnService } from '@learner/core/services/learning-vector-turn-service.js'
import { getLearningGraph } from './get-learning-graph.function.js'

// Ported from the previous host's curriculum scenario (graph half; its turn-context
// half calls a model and its dataset/corpus checks need the operator's real data).
// The model service is a stub that fails the test if anything reaches it.
const noModel = new Proxy({}, { get: () => () => { throw new Error('getLearningGraph must not call a model') } }) as any

describe.skipIf(!process.env.TEST_DATABASE_URL)('Learning graph (learner_test)', () => {
  test('a learner with no curricula of their own gets the shipped Computer Science graph', async () => {
    const previous = process.env.LEARNING_LOCAL_MVP_ENABLED
    process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
    try {
      const kysely = await getKysely()
      const curricula = new LearningCurriculumStore(kysely)
      const assessments = new LearningConceptAssessmentService(curricula, noModel, noModel)
      const services = { learningCurriculumStore: curricula, learningConceptAssessment: assessments,
        learningVectorTurns: new LearningVectorTurnService(kysely, assessments, curricula) }
      const userId = `graph-test-${crypto.randomUUID()}`
      const graph = await getLearningGraph.func(services as any, { curriculumId: 'computer-science' }, { session: { userId }, rpc: {} } as any)

      expect(graph.curriculum.id).toBe('computer-science')
      expect(graph.availableCurriculums.map((c) => c.id)).toContain('computer-science')
      expect(graph.curriculum.lanes.length).toBeGreaterThanOrEqual(13)
      expect(graph.curriculum.modules.length).toBeGreaterThanOrEqual(70)
      expect(graph.concepts.length).toBeGreaterThanOrEqual(350)
      expect(graph.curriculum.modules.some((m) => m.dependsOnModuleIds.length > 1)).toBe(true)
      // An unknown id falls back to the library rather than failing or leaking.
      const fallback = await getLearningGraph.func(services as any, { curriculumId: `private-${crypto.randomUUID()}` }, { session: { userId }, rpc: {} } as any)
      expect(fallback.curriculum.id).toBe(graph.availableCurriculums[0]!.id)
    } finally {
      if (previous === undefined) delete process.env.LEARNING_LOCAL_MVP_ENABLED
      else process.env.LEARNING_LOCAL_MVP_ENABLED = previous
    }
  })
})
