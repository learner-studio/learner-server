import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * A test file's OWN database, never a shared one: `learner_<kind>_test_<8 hex>`, migrated to latest.
 *
 * - Where the test role may CREATE DATABASE (CI's throwaway Postgres, the pre-push gate's container,
 *   scripts/test-clean-db.ts) it is one per test RUN: the hash covers this checkout and the run's own
 *   TEST_DATABASE_URL database, so concurrent runs never share it. It is tagged
 *   `COMMENT ... 'learner-test-run:<run database>'`, and the gate drops every tagged database with its run.
 * - On the dev box the role may not; an admin creates the per-checkout one once
 *   (`createdb -O learner learner_<kind>_test_<checkout hash>`), so a lane's unpushed migration never breaks
 *   another lane's suite. Without it the caller skips, with a warning.
 *
 * The 8-hex suffix is what learning-sim-experiment.ts's SIM_DATABASE guard accepts.
 */
export async function ownTestDatabaseUrl(kind: string): Promise<string | null> {
  if (!/^[a-z]+$/.test(kind)) throw new Error(`own test database kind must be lowercase letters: ${kind}`)
  if (!process.env.TEST_DATABASE_URL) return null
  const base = new URL(process.env.TEST_DATABASE_URL)
  const runDatabase = base.pathname.slice(1)
  const checkout = fileURLToPath(new URL('../../../../', import.meta.url))
  const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 8)
  const perRun = `learner_${kind}_test_${hash(`${checkout}\n${runDatabase}`)}`
  const perCheckout = `learner_${kind}_test_${hash(checkout)}`
  const { Client } = await import('pg')
  const admin = new Client({ connectionString: base.toString() })
  await admin.connect()
  let name: string | null = null
  try {
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [perRun])).rowCount) name = perRun
    else {
      try {
        await admin.query(`CREATE DATABASE ${perRun}`)
        await admin.query(`COMMENT ON DATABASE ${perRun} IS 'learner-test-run:${runDatabase}'`)
        name = perRun
      } catch {
        if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [perCheckout])).rowCount) name = perCheckout
      }
    }
  } finally { await admin.end() }
  if (!name) {
    console.warn(`[${kind}] skipped: ${perCheckout} is missing and the test role may not create a database`)
    return null
  }
  const url = new URL(base)
  url.pathname = `/${name}`
  const { migrateToLatest } = await import('../../../server/src/db/migrate.js')
  await migrateToLatest(url.toString())
  return url.toString()
}
