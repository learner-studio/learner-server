import { afterAll } from 'bun:test'
import { bindDatabase, createDatabase } from '../packages/core/src/db/handle.ts'
import { LEARNING_CURRICULA } from '../packages/core/src/functions/learning/computer-science-seed.ts'
import { LearningCurriculumStore } from '../packages/core/src/services/learning-curriculum-store.ts'

/**
 * Test runs point every database path at learner_test. Integration tests that
 * use the process-wide database get it bound here; anything that reads
 * DATABASE_URL directly sees the test database too, never `learner`. The
 * shipped curriculum library is synced first, as the API does at startup.
 */
const url = process.env.TEST_DATABASE_URL
if (url) {
  process.env.DATABASE_URL = url
  process.env.LEARNER_DATABASE_URL = url
  const db = bindDatabase(createDatabase(url, { max: 4, applicationName: 'learner-test' }))
  // The API seeds the shipped curriculum library at startup; tests expect it present.
  await new LearningCurriculumStore(db.kysely).syncSeeds(LEARNING_CURRICULA)
  afterAll(() => db.close())
} else {
  delete process.env.DATABASE_URL
  delete process.env.LEARNER_DATABASE_URL
}
