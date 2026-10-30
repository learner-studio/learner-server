import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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

/**
 * The `conceptId` hint a deep link sends (docs/specs/mastery-notifications.md S5) picks the
 * curriculum to open, so it is a second way to name a curriculum: it must obey the same
 * visibility rule as `curriculumId`. Another learner's concept opens the default library,
 * never their private curriculum; an explicit `curriculumId` is never overridden by it.
 */
const HINT = `graph-hint-test-${process.pid}-${Date.now()}`
const learnerA = `${HINT}-a`
const learnerB = `${HINT}-b`
const curriculumOf = (owner: string) => `${owner}-curriculum`
const conceptOf = (owner: string) => `${owner}.concept`
const provenance = { kind: 'model-generated', source: 'test', version: '1' }

describe.skipIf(!process.env.TEST_DATABASE_URL)('getLearningGraph conceptId hint (learner_test)', () => {
  let previous: string | undefined
  const owners = [learnerA, learnerB]
  const drop = async () => {
    const db = await getKysely()
    for (const owner of owners) {
      await db.deleteFrom('learningCurriculumLanes').where('curriculumId', '=', curriculumOf(owner)).execute()
      await db.deleteFrom('learningCurricula').where('id', '=', curriculumOf(owner)).execute()
      await db.deleteFrom('learningConcepts').where('id', '=', conceptOf(owner)).execute()
    }
  }
  // Seeded in beforeAll so the teardown is registered even if seeding throws.
  beforeAll(async () => {
    previous = process.env.LEARNING_LOCAL_MVP_ENABLED
    process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
    await drop()
    const db = await getKysely()
    for (const owner of owners) {
      const id = curriculumOf(owner)
      await db.insertInto('learningCurricula').values({ id, title: id, description: id, domain: 'test', status: 'draft', sourceKind: 'generated', ownerUserId: owner, provenance }).execute()
      await db.insertInto('learningCurriculumLanes').values({ curriculumId: id, id: `${id}-lane`, title: 'Lane', summary: 'Lane', laneOrder: 1, color: '#123456', provenance }).execute()
      await db.insertInto('learningCurriculumModules').values({ curriculumId: id, id: `${id}-m`, laneId: `${id}-lane`, step: 1, title: 'M', summary: 'M', parentId: null, masteryGoals: JSON.stringify(['Explain it.']), provenance }).execute()
      await db.insertInto('learningConcepts').values({ id: conceptOf(owner), title: 'C', summary: 'C', explanation: 'C', example: 'C', domain: 'test', capability: 'explain', x: 0, y: 0, sourceKind: 'generated', provenance }).execute()
      await db.insertInto('learningCurriculumModuleConcepts').values({ curriculumId: id, moduleId: `${id}-m`, conceptId: conceptOf(owner), position: 1 }).execute()
    }
  })
  afterAll(async () => {
    await drop()
    if (previous === undefined) delete process.env.LEARNING_LOCAL_MVP_ENABLED
    else process.env.LEARNING_LOCAL_MVP_ENABLED = previous
  })
  const graphFor = async (userId: string, input: { curriculumId?: string; conceptId?: string }) => {
    const kysely = await getKysely()
    const curricula = new LearningCurriculumStore(kysely)
    const assessments = new LearningConceptAssessmentService(curricula, noModel, noModel)
    const services = { learningCurriculumStore: curricula, learningConceptAssessment: assessments,
      learningVectorTurns: new LearningVectorTurnService(kysely, assessments, curricula) }
    return getLearningGraph.func(services as any, input, { session: { userId }, rpc: {} } as any)
  }

  test('a concept in my own curriculum opens that curriculum', async () => {
    const graph = await graphFor(learnerA, { conceptId: conceptOf(learnerA) })
    expect(graph.curriculum.id).toBe(curriculumOf(learnerA))
    expect(graph.concepts.map((c) => c.id)).toContain(conceptOf(learnerA))
  })

  test("another learner's concept opens the default library, not their curriculum", async () => {
    // Positive control: the concept is reachable, for its owner.
    expect((await graphFor(learnerB, { conceptId: conceptOf(learnerB) })).curriculum.id).toBe(curriculumOf(learnerB))
    const graph = await graphFor(learnerA, { conceptId: conceptOf(learnerB) })
    expect(graph.curriculum.id).toBe('computer-science')
    expect(graph.availableCurriculums.map((c) => c.id)).not.toContain(curriculumOf(learnerB))
    expect(graph.concepts.map((c) => c.id)).not.toContain(conceptOf(learnerB))
  })

  test('an explicit curriculumId wins over the hint', async () => {
    const graph = await graphFor(learnerA, { curriculumId: 'computer-science', conceptId: conceptOf(learnerA) })
    expect(graph.curriculum.id).toBe('computer-science')
  })

  test('an unknown concept opens the default library', async () => {
    expect((await graphFor(learnerA, { conceptId: `${HINT}.no-such-concept` })).curriculum.id).toBe('computer-science')
  })
})
