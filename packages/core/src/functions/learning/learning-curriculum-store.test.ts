import assert from 'node:assert/strict'
import test from 'node:test'
import { getKysely } from '../../db.js'
import { COMPUTER_SCIENCE } from './computer-science-seed.js'
import type { LearningGraph } from './learning-seed.js'

const retiredSeed: LearningGraph = {
  curriculum: {
    id: 'learning-store-test-retired-seed',
    title: 'Retired seed',
    description: 'A seed used to prove authoritative synchronization.',
    domain: 'test',
    status: 'seed',
    provenance: { kind: 'model-seed', source: 'test', version: '1' },
    lanes: [{
      id: 'retired-lane',
      title: 'Retired lane',
      summary: 'Temporary test lane.',
      order: 1,
      color: '#999999',
      provenance: { kind: 'model-seed', source: 'test', version: '1' },
    }],
    modules: [{
      id: 'retired-module',
      step: 1,
      title: 'Retired module',
      summary: 'Temporary test module.',
      laneId: 'retired-lane',
      conceptIds: ['learning-store-test-retired-concept'],
      parentId: null,
      dependsOnModuleIds: [],
      masteryGoals: ['Explain why retired seed data is removed.', 'Predict which rows remain after synchronization.'],
      provenance: { kind: 'model-seed', source: 'test', version: '1' },
    }],
  },
  concepts: [{
    id: 'learning-store-test-retired-concept',
    title: 'Retired concept',
    summary: 'Temporary test concept.',
    explanation: 'This concept should disappear when its seed curriculum is retired.',
    example: 'Authoritative seed synchronization removes it.',
    domain: 'test',
    capability: 'explain',
    provenance: { kind: 'model-seed', source: 'test', version: '1' },
    x: 0,
    y: 0,
  }],
  edges: [],
}

test('Learning curriculum store retires removed seed curricula without touching non-seed content', async () => {
  const { LearningCurriculumStore } = await import('../../services/learning-curriculum-store.js')
  const db = await getKysely()
  const store = new LearningCurriculumStore(db)
  const protectedId = 'learning-store-test-human-curriculum'

  await db.deleteFrom('learningCurricula').where('id', '=', protectedId).execute()
  await store.syncSeeds([retiredSeed, COMPUTER_SCIENCE])
  await db.insertInto('learningCurricula').values({
    id: protectedId,
    title: 'Human curriculum',
    description: 'This row must never be replaced or retired by seed synchronization.',
    domain: 'test',
    status: 'seed',
    sourceKind: 'user',
    provenance: { kind: 'human-curated', source: 'test', version: '1' },
  }).execute()

  try {
    await store.syncSeeds([COMPUTER_SCIENCE])
    assert.equal(await store.getGraph(retiredSeed.curriculum.id), undefined)
    assert.equal(
      await db.selectFrom('learningConcepts').select('id')
        .where('id', '=', retiredSeed.concepts[0]!.id).executeTakeFirst(),
      undefined,
      'orphaned seed concepts should be removed with a retired seed curriculum',
    )
    const protectedRow = await db.selectFrom('learningCurricula').select(['title', 'sourceKind'])
      .where('id', '=', protectedId).executeTakeFirstOrThrow()
    assert.deepEqual(protectedRow, { title: 'Human curriculum', sourceKind: 'user' })
    await assert.rejects(
      store.syncSeeds([{ ...COMPUTER_SCIENCE, curriculum: { ...COMPUTER_SCIENCE.curriculum, id: protectedId } }]),
      /Refusing to overwrite non-seed curriculum/,
    )
  } finally {
    await db.deleteFrom('learningCurricula').where('id', '=', protectedId).execute()
    await store.syncSeeds([COMPUTER_SCIENCE])
  }
})

test('Learning curriculum store synchronizes Computer Science idempotently', async () => {
  const { LearningCurriculumStore } = await import('../../services/learning-curriculum-store.js')
  const store = new LearningCurriculumStore(await getKysely())

  // Compare SEEDS only. This used to assert over every curriculum in the
  // database, which was true when the only way to get one was to ship it. A
  // learner can now generate their own, and those rows are none of this test's
  // business: seed synchronization is required to leave them alone, which is
  // exactly what the sibling test above proves. Asserting over the whole table
  // would turn any generated curriculum, or a concurrent run's fixture, into a
  // failure of seed idempotency.
  const seedsOnly = (graphs: Awaited<ReturnType<typeof store.listGraphs>>) =>
    graphs.filter((graph) => graph.curriculum.status === 'seed')

  await store.syncSeeds([COMPUTER_SCIENCE])
  const first = seedsOnly(await store.listGraphs())
  await store.syncSeeds([COMPUTER_SCIENCE])
  const second = seedsOnly(await store.listGraphs())

  assert.deepEqual(second.map((graph) => graph.curriculum.id), ['computer-science'])
  assert.deepEqual(
    second.map((graph) => [graph.curriculum.id, graph.curriculum.modules.length, graph.concepts.length, graph.edges.length]),
    first.map((graph) => [graph.curriculum.id, graph.curriculum.modules.length, graph.concepts.length, graph.edges.length]),
    'running seed sync twice must not duplicate curriculum content',
  )
})
