import assert from 'node:assert/strict'
import test from 'node:test'
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery } from 'kysely'
import type { DB } from '../types/db.types.js'
import { COMPUTER_SCIENCE } from '../functions/learning/computer-science-seed.js'
import { LearningCurriculumStore } from './learning-curriculum-store.js'

test('scoped seed synchronization never retires curricula, deletes concept records, or touches learner evidence', async () => {
  const queries: CompiledQuery[] = []
  // Compiles the real service queries without connecting to any database.
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (value) => new PostgresIntrospector(value),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => { if (event.level === 'query') queries.push(event.query) },
  })
  try {
    await new LearningCurriculumStore(db).syncSeed(COMPUTER_SCIENCE)
    const deletes = queries.filter(({ sql }) => sql.startsWith('delete '))
    assert.equal(deletes.length, 2)
    for (const query of deletes) {
      assert.match(query.sql, /^delete from "learning(ConceptEdges|CurriculumLanes)" where "curriculumId" = \$1$/)
      assert.deepEqual(query.parameters, ['computer-science'])
    }
    const writes = queries.filter(({ sql }) => /^(insert|update|delete) /.test(sql))
    assert.equal(writes.length, 9, 'The complete current curriculum snapshot must be written')
    for (const { sql } of writes) {
      assert.doesNotMatch(sql, /assessment|receipt|feedback|archive|experiment|catalog/i)
      assert.doesNotMatch(sql, /^delete from "learning(Curricula|Concepts)"/)
    }
    const conceptUpsert = writes.find(({ sql }) => sql.startsWith('insert into "learningConcepts"'))
    assert.ok(conceptUpsert)
    assert.match(conceptUpsert.sql, /on conflict \("id"\) do update set/)
    for (const concept of COMPUTER_SCIENCE.concepts) assert.ok(conceptUpsert.parameters.includes(concept.id), concept.id)
  } finally {
    await db.destroy()
  }
})
