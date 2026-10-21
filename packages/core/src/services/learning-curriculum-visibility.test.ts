import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

import { getKysely } from '../db.js'
import { LearningCurriculumStore } from './learning-curriculum-store.js'

/**
 * Who can see which curriculum.
 *
 * Generated curricula are private to the learner who asked for them, and the
 * only thing standing between "private" and "everyone's" is the owner filter
 * on the list query. This is not hypothetical: `learningCurriculumScenario`
 * asserts that exactly one curriculum is available to Ada, so an unfiltered
 * list turns the first generated curriculum into a failure of an unrelated,
 * already-green test.
 */
const OWNER = `visibility-test-owner-${process.pid}-${Date.now()}`
const OTHER = `${OWNER}-other`
const mine = `${OWNER}-mine`
const theirs = `${OWNER}-theirs`

const db = await getKysely()
const store = new LearningCurriculumStore(db)

const provenance = { kind: 'model-generated', source: 'test', version: '1' }

async function makeCurriculum(id: string, ownerUserId: string): Promise<void> {
  await db.insertInto('learningCurricula').values({
    id, title: id, description: id, domain: 'test',
    status: 'draft', sourceKind: 'generated', ownerUserId, provenance,
  }).execute()
  // A lane is required: LearningGraphSchema demands at least one, and a
  // curriculum that fails to parse would be filtered out for every user,
  // which would make this test pass for the wrong reason.
  await db.insertInto('learningCurriculumLanes').values({
    curriculumId: id, id: `${id}-lane`, title: 'Lane', summary: 'Lane',
    laneOrder: 1, color: '#123456', provenance,
  }).execute()
}

async function drop(): Promise<void> {
  for (const id of [mine, theirs]) {
    await db.deleteFrom('learningCurriculumLanes').where('curriculumId', '=', id).execute()
    await db.deleteFrom('learningCurricula').where('id', '=', id).execute()
  }
}

// Registered before the seed runs, so a failing setup still tears down. See
// the note in curriculum-shape-query.test.ts: a top-level seed that throws
// leaves rows behind that break unrelated tests reading the whole table.
beforeAll(async () => {
  await drop()
  await makeCurriculum(mine, OWNER)
  await makeCurriculum(theirs, OTHER)
})
afterAll(async () => { await drop() })

describe('listGraphsVisibleTo scopes generated curricula to their owner', () => {
  test('a learner sees their own generated curriculum', async () => {
    const ids = (await store.listGraphsVisibleTo(OWNER)).map((graph) => graph.curriculum.id)
    expect(ids).toContain(mine)
  })

  test('a learner does NOT see another learner\'s generated curriculum', async () => {
    const ids = (await store.listGraphsVisibleTo(OWNER)).map((graph) => graph.curriculum.id)
    expect(ids).not.toContain(theirs)
  })

  test('everyone still sees the shipped library, which has no owner', async () => {
    // A null owner means "shipped", not "unknown": the database CHECK ties the
    // null to source_kind = 'seed' exactly, so this is a guarantee rather than
    // a convention.
    const ids = (await store.listGraphsVisibleTo(OWNER)).map((graph) => graph.curriculum.id)
    expect(ids).toContain('computer-science')
  })

  test('a learner who owns nothing sees only the shipped library', async () => {
    // This is the assertion that protects learningCurriculumScenario, which
    // requires exactly one curriculum for Ada.
    const ids = (await store.listGraphsVisibleTo(`${OWNER}-owns-nothing`)).map((graph) => graph.curriculum.id)
    expect(ids).toEqual(['computer-science'])
  })

  test('the unfiltered list still returns everything, for the catalogue callers', async () => {
    // listGraphs backs concept catalogues read by hooks and the semantic index,
    // several of which have no session at all. Narrowing it would be a
    // different change with a much wider blast radius.
    const ids = (await store.listGraphs()).map((graph) => graph.curriculum.id)
    expect(ids).toContain(mine)
    expect(ids).toContain(theirs)
  })
})
