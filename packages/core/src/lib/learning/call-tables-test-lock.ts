import { Client } from 'pg'

/**
 * For tests only. scripts/run-tests.ts runs test files in parallel against the one
 * learner_test database, and the call tests empty shared tables (learning_call_speech,
 * learning_call_identity, the singleton learning_readai_webhook row). Each such file
 * holds this session-level advisory lock from beforeAll to afterAll, so the files run
 * one after another instead of deleting each other's rows mid-test.
 */
export async function lockCallTables(): Promise<() => Promise<void>> {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await client.connect()
  await client.query(`SELECT pg_advisory_lock(hashtext('learner-test-call-tables'))`)
  return async () => { await client.end() }
}
