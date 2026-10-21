import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'

import { getKysely } from '../../db.js'
import type { DB } from '../../types/db.types.js'
import { measureStoredCurriculumShape, readCurriculumShape } from './curriculum-shape-query.js'

const SEED_ID = 'computer-science'

/**
 * Namespaced per process AND per run, because the suite is sharded and two
 * `bun run test` processes overlap routinely on this box. A hardcoded id here
 * would collide with a concurrent run and, because a failing setup cancels
 * every in-flight subtest, take unrelated files down with it.
 */
const FIXTURE = `shape-query-test-${process.pid}-${Date.now()}`
const lane = `${FIXTURE}-lane`
const moduleId = (n: number) => `${FIXTURE}-m${n}`
const conceptId = (n: number) => `${FIXTURE}.c${n}`

const provenance = { kind: 'model-generated', source: 'test', version: '1' }

async function seedFixture(db: Kysely<DB>): Promise<void> {
  await db.insertInto('learningCurricula').values({
    id: FIXTURE, title: 'Fixture', description: 'Fixture', domain: 'test',
    status: 'draft', sourceKind: 'generated', ownerUserId: 'shape-query-test-owner',
    provenance,
  }).execute()
  await db.insertInto('learningCurriculumLanes').values({
    curriculumId: FIXTURE, id: lane, title: 'Lane', summary: 'Lane', laneOrder: 1,
    color: '#123456', provenance,
  }).execute()
  // Three modules in a chain, so depth and spine-ness are both determinate.
  await db.insertInto('learningCurriculumModules').values([0, 1, 2].map((n) => ({
    curriculumId: FIXTURE, id: moduleId(n), laneId: lane, step: n + 1,
    title: `M${n}`, summary: `M${n}`, parentId: null,
    // node-postgres turns a JS ARRAY into a Postgres array literal, which jsonb
    // rejects as malformed JSON; an object is serialized correctly. So an
    // array-valued jsonb column needs an explicit stringify, and only that one.
    masteryGoals: JSON.stringify(['Explain it.']),
    // Only the first module is grounded, so groundedShare must read 1/3.
    provenance: n === 0 ? { ...provenance, kind: 'external-material' } : provenance,
  }))).execute()
  await db.insertInto('learningCurriculumModuleDependencies').values([
    { curriculumId: FIXTURE, moduleId: moduleId(1), dependsOnModuleId: moduleId(0), confidence: 0.9, rationale: 'first' },
    { curriculumId: FIXTURE, moduleId: moduleId(2), dependsOnModuleId: moduleId(1), confidence: 0.4, rationale: 'second' },
  ]).execute()
  await db.insertInto('learningConcepts').values([0, 1, 2].map((n) => ({
    id: conceptId(n), title: `C${n}`, summary: `C${n}`, explanation: `C${n}`, example: `C${n}`,
    domain: 'test', capability: 'explain', x: n * 10, y: n * 10, sourceKind: 'generated', provenance,
  }))).execute()
  // Concept 0 belongs to TWO modules: four memberships over three concepts.
  await db.insertInto('learningCurriculumModuleConcepts').values([
    { curriculumId: FIXTURE, moduleId: moduleId(0), conceptId: conceptId(0), position: 1 },
    { curriculumId: FIXTURE, moduleId: moduleId(1), conceptId: conceptId(0), position: 1 },
    { curriculumId: FIXTURE, moduleId: moduleId(1), conceptId: conceptId(1), position: 2 },
    { curriculumId: FIXTURE, moduleId: moduleId(2), conceptId: conceptId(2), position: 1 },
  ]).execute()
  await db.insertInto('learningConceptEdges').values({
    curriculumId: FIXTURE, fromConceptId: conceptId(0), toConceptId: conceptId(1),
    kind: 'hard-prerequisite', confidence: 0.9, provenance,
  }).execute()
}

async function dropFixture(db: Kysely<DB>): Promise<void> {
  // Lanes cascade to modules and their children; edges hang off the curriculum.
  await db.deleteFrom('learningConceptEdges').where('curriculumId', '=', FIXTURE).execute()
  await db.deleteFrom('learningCurriculumLanes').where('curriculumId', '=', FIXTURE).execute()
  await db.deleteFrom('learningCurricula').where('id', '=', FIXTURE).execute()
  await db.deleteFrom('learningConcepts').where('id', 'in', [0, 1, 2].map(conceptId)).execute()
}

const db = await getKysely()

// Seeding runs in beforeAll, not at module top level, so that afterAll is
// already registered if it throws. A top-level seed that fails leaves its
// partial rows behind forever: the module never finishes loading, so no
// teardown is registered. That happened once here, and the orphan row then
// broke an unrelated test asserting over every curriculum in the database.
beforeAll(async () => {
  await dropFixture(db)
  await seedFixture(db)
})
afterAll(async () => { await dropFixture(db) })

describe('measureStoredCurriculumShape reads structure straight from the tables', () => {
  test('a concept in two modules is counted once, not once per membership', async () => {
    // This is the regression the metric exists for: summing per-module counts
    // reports four concepts where the curriculum defines three.
    const shape = await measureStoredCurriculumShape(db, FIXTURE)
    expect(shape).not.toBeNull()
    expect(shape!.concepts).toBe(3)
    expect(shape!.conceptsPerModule.mean).toBeCloseTo(4 / 3, 2)
  })

  test('a chain reads as a spine with depth equal to its length', async () => {
    const shape = await measureStoredCurriculumShape(db, FIXTURE)
    expect(shape!.isSpine).toBe(true)
    expect(shape!.maxDepth).toBe(2)
    expect(shape!.rootModules).toBe(1)
    expect(shape!.cycles).toEqual([])
  })

  test('grounding is read from module provenance, not from a source table', async () => {
    const shape = await measureStoredCurriculumShape(db, FIXTURE)
    expect(shape!.groundedShare).toBeCloseTo(1 / 3, 2)
  })

  test('confident edge share scores stored dependency confidences', async () => {
    // 0.9 clears the 0.8 bar and 0.4 does not, so exactly half.
    const shape = await measureStoredCurriculumShape(db, FIXTURE)
    expect(shape!.confidentEdgeShare).toBe(0.5)
  })

  test('an unknown curriculum measures to null rather than an empty shape', async () => {
    // An empty shape would read as a real curriculum with nothing in it, which
    // is how a typo in a curriculum id becomes a confident wrong answer.
    expect(await measureStoredCurriculumShape(db, `${FIXTURE}-absent`)).toBeNull()
  })
})

describe('the hand-authored seed is measurable and is not scored as generated', () => {
  test('the seed reports no dependency confidences at all', async () => {
    // The seed's 214 dependencies were authored by hand and carry no
    // confidence. Null means "not applicable"; zero would mean "every edge is
    // a guess", which is a different and false claim.
    const shape = await measureStoredCurriculumShape(db, SEED_ID)
    expect(shape).not.toBeNull()
    expect(shape!.confidentEdgeShare).toBeNull()
    expect(shape!.groundedShare).toBe(0)
  })

  test('the seed defines fewer concepts than it has memberships', async () => {
    const shape = await measureStoredCurriculumShape(db, SEED_ID)
    const memberships = await db
      .selectFrom('learningCurriculumModuleConcepts')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('curriculumId', '=', SEED_ID)
      .executeTakeFirstOrThrow()
    expect(shape!.concepts).toBeLessThan(Number(memberships.n))
  })

  test('the seed branches rather than running as one chain', async () => {
    const shape = await measureStoredCurriculumShape(db, SEED_ID)
    expect(shape!.isSpine).toBe(false)
    expect(shape!.maxWidth).toBeGreaterThan(1)
    expect(shape!.isolatedModules).toBe(0)
    expect(shape!.cycles).toEqual([])
  })
})

describe('readCurriculumShape places a candidate against a baseline', () => {
  test('comparing against the seed returns one row per metric with deltas', async () => {
    const reading = await readCurriculumShape(db, FIXTURE, SEED_ID)
    expect(reading!.baselineCurriculumId).toBe(SEED_ID)
    expect(reading!.comparison.length).toBe(17)
    const modules = reading!.comparison.find((row) => row.metric === 'Modules')
    expect(modules!.candidate).toBe(3)
    expect(modules!.delta).toBe(3 - modules!.baseline!)
  })

  test('a curriculum compared against itself reports no comparison', async () => {
    const reading = await readCurriculumShape(db, FIXTURE, FIXTURE)
    expect(reading!.baselineCurriculumId).toBeNull()
    expect(reading!.comparison).toEqual([])
  })

  test('an absent baseline leaves the measurement intact rather than failing it', async () => {
    // The measurement is the answer the caller asked for; a missing baseline
    // degrades the comparison, not the reading.
    const reading = await readCurriculumShape(db, FIXTURE, `${FIXTURE}-absent`)
    expect(reading!.shape.modules).toBe(3)
    expect(reading!.comparison).toEqual([])
  })
})
