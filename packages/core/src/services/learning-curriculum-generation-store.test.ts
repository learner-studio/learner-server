import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Kysely } from 'kysely'

import { getKysely } from '../db.js'
import type { DB } from '../types/db.types.js'
import { buildCurriculumRows, type CurriculumWriteRequest } from '../lib/learning/curriculum-writer.js'
import type { CurriculumSourceRef } from '../lib/learning/curriculum-generation-types.js'
import { LearningCurriculumGenerationStore } from './learning-curriculum-generation-store.js'

/**
 * Namespaced per process AND per run: the suite is sharded and two test
 * processes overlap routinely, so a fixed id here would collide and, because a
 * failing setup cancels every in-flight subtest, take unrelated files down.
 */
const RUN = `gen-store-test-${process.pid}-${Date.now()}`
const OWNER = `${RUN}-owner`
const OTHER_OWNER = `${RUN}-stranger`
const CURRICULUM = `${RUN}-curriculum`

const db: Kysely<DB> = await getKysely()
const store = new LearningCurriculumGenerationStore(db)

const source: CurriculumSourceRef = {
  sourceId: '6-006', provider: 'mit-ocw', title: 'Introduction to Algorithms',
  url: 'https://ocw.mit.edu/courses/6-006/', licence: 'CC BY-NC-SA 4.0',
  attribution: 'MIT OpenCourseWare', retrievedAt: new Date().toISOString(), contentChars: 4000,
}

const request: CurriculumWriteRequest = {
  curriculumId: CURRICULUM,
  ownerUserId: OWNER,
  sources: [source],
  outline: {
    title: 'Algorithms', description: 'A first course.', domain: 'algorithms', scale: 'course',
    lanes: [{ id: 'foundations', title: 'Foundations', summary: 'Groundwork.' }],
    modules: [0, 1, 2, 3].map((n) => ({
      id: `m${n}`, laneId: 'foundations', title: `M${n}`, summary: `M${n}`,
      topics: [`topic ${n}`], sourceIds: n === 0 ? ['6-006'] : [],
    })),
    moduleDependencies: [{ moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.9, rationale: 'first' }],
  },
  proposal: {
    moduleDependencies: [{ moduleId: 'm1', dependsOnModuleId: 'm0', confidence: 0.9, rationale: 'first' }],
    concepts: [0, 1, 2, 3].map((n) => ({
      moduleId: `m${n}`, topic: `topic ${n}`, name: `concept ${n}`, summary: 's', explanation: 'e', example: 'x',
      capability: 'explain' as const,
    })),
    conceptEdges: [{ fromConcept: 'concept 0', toConcept: 'concept 1', kind: 'hard-prerequisite' as const, confidence: 0.8 }],
  },
}

async function removeFixture(): Promise<void> {
  await db.deleteFrom('learningConceptEdges').where('curriculumId', '=', CURRICULUM).execute()
  await db.deleteFrom('learningCurriculumModuleConcepts').where('curriculumId', '=', CURRICULUM).execute()
  await db.deleteFrom('learningCurriculumModuleDependencies').where('curriculumId', '=', CURRICULUM).execute()
  await db.deleteFrom('learningCurriculumModules').where('curriculumId', '=', CURRICULUM).execute()
  await db.deleteFrom('learningCurriculumLanes').where('curriculumId', '=', CURRICULUM).execute()
  await db.deleteFrom('learningConcepts').where('id', 'like', `${CURRICULUM}.%`).execute()
  await db.deleteFrom('learningCurricula').where('id', '=', CURRICULUM).execute()
  await db.deleteFrom('learningCurriculumSources').where('runId', 'in', [RUN, `${RUN}-b`]).execute()
  await db.deleteFrom('learningCurriculumGenerationRuns').where('id', 'in', [RUN, `${RUN}-b`]).execute()
}

// Registered BEFORE anything is seeded: a setup that throws half way still
// leaves rows behind, and a teardown registered afterwards never runs.
afterAll(removeFixture)

beforeAll(async () => {
  await removeFixture()
  await store.createRun({ id: RUN, ownerUserId: OWNER, objective: 'I want to understand algorithms better' })
})

describe('a generation run is private to the learner who started it', () => {
  test('the owner reads their own run', async () => {
    const run = await store.getRun(RUN, OWNER)
    expect(run?.objective).toBe('I want to understand algorithms better')
    expect(run?.status).toBe('interpreting')
  })

  test('another learner reads nothing, not a permission error', async () => {
    // Returning null rather than throwing is deliberate at this layer: the RPC
    // turns it into "no such run", which does not confirm the run exists.
    expect(await store.getRun(RUN, OTHER_OWNER)).toBeNull()
  })

  test('a listing shows the owner their own runs only', async () => {
    const mine = await store.listRuns(OWNER)
    expect(mine.map((run) => run.id)).toContain(RUN)
    const theirs = await store.listRuns(OTHER_OWNER)
    expect(theirs.map((run) => run.id)).not.toContain(RUN)
  })

  test('a step reads a run by id without an owner, because it has no session', async () => {
    expect((await store.getRunById(RUN))?.ownerUserId).toBe(OWNER)
  })
})

describe('a run records its progress durably', () => {
  test('creating the same run twice does not reset it', async () => {
    // The first workflow step may replay, and replaying it must not throw away
    // the status a later step already reached.
    await store.updateRun(RUN, { status: 'outlining' })
    await store.createRun({ id: RUN, ownerUserId: OWNER, objective: 'ignored on replay' })
    const run = await store.getRun(RUN, OWNER)
    expect(run?.status).toBe('outlining')
    expect(run?.objective).toBe('I want to understand algorithms better')
  })

  test('the outline round-trips through jsonb unchanged', async () => {
    await store.updateRun(RUN, { outline: request.outline, status: 'awaiting-approval' })
    const run = await store.getRun(RUN, OWNER)
    expect(run?.outline?.modules.map((module) => module.id)).toEqual(['m0', 'm1', 'm2', 'm3'])
    expect(run?.outline?.modules[0]!.sourceIds).toEqual(['6-006'])
  })

  test('sources are recorded once and read back as citations', async () => {
    await store.recordSources(RUN, [source])
    await store.recordSources(RUN, [source])
    const sources = await store.listSources(RUN)
    expect(sources.length).toBe(1)
    expect(sources[0]).toMatchObject({ sourceId: '6-006', licence: 'CC BY-NC-SA 4.0', attribution: 'MIT OpenCourseWare' })
  })
})

describe('writing a curriculum is one transaction and survives a replay', () => {
  test('the whole tree lands', async () => {
    await store.writeCurriculum(buildCurriculumRows(request))
    const counts = async (table: 'learningCurriculumLanes' | 'learningCurriculumModules' | 'learningCurriculumModuleConcepts' | 'learningCurriculumModuleDependencies' | 'learningConceptEdges') =>
      (await db.selectFrom(table).select(db.fn.countAll().as('n')).where('curriculumId', '=', CURRICULUM).executeTakeFirstOrThrow()).n
    expect(Number(await counts('learningCurriculumLanes'))).toBe(1)
    expect(Number(await counts('learningCurriculumModules'))).toBe(4)
    expect(Number(await counts('learningCurriculumModuleConcepts'))).toBe(4)
    expect(Number(await counts('learningCurriculumModuleDependencies'))).toBe(1)
    expect(Number(await counts('learningConceptEdges'))).toBe(1)
  })

  test('the curriculum is a draft owned by the learner, marked generated', async () => {
    const row = await db.selectFrom('learningCurricula').selectAll().where('id', '=', CURRICULUM).executeTakeFirstOrThrow()
    expect(row.status).toBe('draft')
    expect(row.sourceKind).toBe('generated')
    expect(row.ownerUserId).toBe(OWNER)
  })

  test('mastery goals survive as JSON, not as a Postgres array literal', async () => {
    // A JS array handed to a jsonb column serializes as {"..."} and is rejected
    // with SQLSTATE 22P02. The write must stringify it; this is the assertion
    // that catches a future refactor dropping that.
    const row = await db.selectFrom('learningCurriculumModules').select('masteryGoals')
      .where('curriculumId', '=', CURRICULUM).where('id', '=', 'm0').executeTakeFirstOrThrow()
    expect(Array.isArray(row.masteryGoals)).toBe(true)
  })

  test('writing the same curriculum again replaces it rather than duplicating it', async () => {
    // The write step of a durable workflow may replay after a crash.
    await store.writeCurriculum(buildCurriculumRows(request))
    const modules = await db.selectFrom('learningCurriculumModules').select('id')
      .where('curriculumId', '=', CURRICULUM).execute()
    expect(modules.length).toBe(4)
  })

  test('a rewrite with DIFFERENT concepts leaves no orphans behind', async () => {
    // Regenerating the concept layer under an unchanged outline is a real
    // operation (rebuildCurriculumTree), and the concept insert is an UPSERT —
    // so without an explicit delete the old rows survive with their memberships
    // and edges gone: nodes belonging to no lesson, accumulating on every
    // regeneration. This is the assertion that the graph is REPLACED.
    const renamed: CurriculumWriteRequest = {
      ...request,
      proposal: {
        ...request.proposal,
        concepts: request.proposal.concepts.map((concept) => ({ ...concept, name: `renamed ${concept.name}` })),
        conceptEdges: [],
      },
    }
    await store.writeCurriculum(buildCurriculumRows(renamed))
    const titles = (await db.selectFrom('learningConcepts').select('title')
      .where('id', 'like', `${CURRICULUM}.%`).execute()).map((row) => row.title).sort()
    expect(titles).toEqual(['renamed concept 0', 'renamed concept 1', 'renamed concept 2', 'renamed concept 3'])
  })

  test('the rewrite deletes only its OWN concepts, never the seed library', async () => {
    // The delete is by id prefix because learning_concepts has no curriculum
    // column. Seed ids carry no prefix at all, which is what makes that safe —
    // assert it rather than trust it.
    const seedConcept = await db.selectFrom('learningConcepts').select('id')
      .where('id', '=', 'algorithms-complexity--asymptotic-growth').executeTakeFirst()
    expect(seedConcept?.id).toBe('algorithms-complexity--asymptotic-growth')
  })
})

describe('rejecting removes the tree without touching anyone else', () => {
  test('a stranger cannot delete a curriculum they do not own', async () => {
    expect(await store.deleteGeneratedCurriculum(CURRICULUM, OTHER_OWNER)).toBe(false)
    const still = await db.selectFrom('learningCurricula').select('id').where('id', '=', CURRICULUM).executeTakeFirst()
    expect(still).toBeDefined()
  })

  test('the shipped library cannot be deleted through this path', async () => {
    // The seed has a null owner and sourceKind 'seed', so both guards refuse it.
    // This is the assertion that stops a rejected run taking the Computer
    // Science curriculum with it.
    expect(await store.deleteGeneratedCurriculum('computer-science', OWNER)).toBe(false)
    const seed = await db.selectFrom('learningCurricula').select('id').where('id', '=', 'computer-science').executeTakeFirst()
    expect(seed?.id).toBe('computer-science')
  })

  test('the owner removes their own generated curriculum and its concepts', async () => {
    expect(await store.deleteGeneratedCurriculum(CURRICULUM, OWNER)).toBe(true)
    const gone = await db.selectFrom('learningCurricula').select('id').where('id', '=', CURRICULUM).executeTakeFirst()
    expect(gone).toBeUndefined()
    const concepts = await db.selectFrom('learningConcepts').select('id').where('id', 'like', `${CURRICULUM}.%`).execute()
    expect(concepts).toEqual([])
  })
})
