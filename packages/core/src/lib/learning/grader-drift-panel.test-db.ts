import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * The drift panel's tests run on a database of their OWN checkout, learner_drift_test_<checkout hash>, never on the
 * shared learner_test: one checkout's unpushed migration must not break another's suite (the mechanism of
 * 31fb89e). The test role may not CREATE DATABASE on the dev box, so an admin creates it once per checkout
 * (`createdb -O learner learner_drift_test_<hash>`); CI's throwaway Postgres lets the role create it here. Without
 * it the tests are skipped with a warning, never run against the shared database.
 */
export const DRIFT_TEST_DATABASE = `learner_drift_test_${createHash('sha256').update(fileURLToPath(new URL('../../../../../', import.meta.url))).digest('hex').slice(0, 8)}`

export async function driftTestDatabaseUrl(): Promise<string | null> {
  if (!process.env.TEST_DATABASE_URL) return null
  const { Client } = await import('pg')
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await admin.connect()
  try {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [DRIFT_TEST_DATABASE])).rowCount) await admin.query(`CREATE DATABASE ${DRIFT_TEST_DATABASE}`)
  } catch (error) {
    console.warn(`[drift-panel] skipped: ${DRIFT_TEST_DATABASE} is missing and cannot be created (${String(error).slice(0, 120)})`)
    return null
  } finally { await admin.end() }
  const url = new URL(process.env.TEST_DATABASE_URL)
  url.pathname = `/${DRIFT_TEST_DATABASE}`
  const { migrateToLatest } = await import('../../../../server/src/db/migrate.js')
  await migrateToLatest(url.toString())
  return url.toString()
}
