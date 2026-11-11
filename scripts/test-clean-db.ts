// Runs the test suite the way CI does: against databases nothing else has touched, in the
// same Postgres image and locale as the CI service (postgres:17, en_US.utf8).
//
// Why the pre-push hook needs this (docs/checks.md, "What the local gate missed"):
//   - The dev box's learner_test is C.UTF-8; CI's postgres:17 is en_US.utf8. An ORDER BY on
//     text sorts differently ('a-c10-0' < 'a-c1-1' in en_US, the reverse in C), so a result
//     that depends on row order passes here and fails there.
//   - learner_test is shared by every checkout and keeps whatever earlier runs committed;
//     CI starts from an empty, freshly migrated database.
//
// One long-lived container (`learner-ci-pg`, data on tmpfs, 127.0.0.1 only) holds a fresh
// database per run. Files that need a database of their own (own-test-database.ts) create one
// tagged with the run's name; all of them are dropped with the run. The credentials are the
// throwaway ones ci.yml uses; nothing here is a secret.
//
// Concurrent pushes: one run peaks at ~75 connections (measured 2026-11-11), so runs take one
// of floor((max_connections - 20) / 90) slots (3 at 300) and a push past that waits for a slot
// instead of failing with "too many clients already".
//
//   bun scripts/test-clean-db.ts [run-tests args...]
//   exit 3: Docker is not available (the hook then falls back to learner_test and says so)
import { $ } from 'bun'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CONTAINER = 'learner-ci-pg'
const IMAGE = 'postgres:17' // keep in step with .github/workflows/ci.yml
const PORT = Number(process.env.LEARNER_CI_PG_PORT ?? 55440)
const MAX_CONNECTIONS = 300
const PER_RUN_CONNECTIONS = 90
const LOCK_DIR = '/var/tmp/learner-ci-pg'
const admin = `postgres://learner:learner@127.0.0.1:${PORT}/postgres`
const psql = (sql: string) => $`docker exec ${CONTAINER} psql -U learner -d postgres -qAtX -c ${sql}`.quiet().nothrow()

if ((await $`docker info --format '{{.ServerVersion}}'`.quiet().nothrow()).exitCode !== 0) {
  console.error('[test-clean-db] Docker is not available')
  process.exit(3)
}

const state = await $`docker inspect -f '{{.State.Running}}' ${CONTAINER}`.quiet().nothrow()
if (state.exitCode !== 0) {
  await $`docker run -d --name ${CONTAINER} --restart unless-stopped -p 127.0.0.1:${PORT}:5432 --tmpfs /var/lib/postgresql/data:rw,size=4g -e POSTGRES_USER=learner -e POSTGRES_PASSWORD=learner -e POSTGRES_DB=postgres ${IMAGE} -c max_connections=${MAX_CONNECTIONS}`.quiet()
} else if (state.stdout.toString().trim() !== 'true') {
  await $`docker start ${CONTAINER}`.quiet()
}
// pg_isready is true for a moment during the image's init restart; a real query is not.
for (let i = 0; ; i++) {
  if ((await psql('select 1')).exitCode === 0) break
  if (i > 120) throw new Error(`[test-clean-db] ${CONTAINER} did not accept connections`)
  await Bun.sleep(250)
}

if (!process.env.LEARNER_CI_SLOT) {
  // Take a slot: re-run this script under `flock -n` on each slot's lock file in turn; 75 means taken.
  const max = Number((await psql('show max_connections')).stdout.toString().trim())
  const slots = Math.max(1, Math.floor((max - 20) / PER_RUN_CONNECTIONS))
  mkdirSync(LOCK_DIR, { recursive: true })
  for (let waited = false; ; waited = true) {
    for (let slot = 0; slot < slots; slot++) {
      const run = Bun.spawn(['flock', '-n', '-E', '75', join(LOCK_DIR, `slot-${slot}.lock`), process.execPath, import.meta.path, ...process.argv.slice(2)],
        { cwd: ROOT, env: { ...process.env, LEARNER_CI_SLOT: String(slot) }, stdout: 'inherit', stderr: 'inherit' })
      const code = await run.exited
      if (code !== 75) process.exit(code)
    }
    if (!waited) console.log(`[test-clean-db] all ${slots} slot(s) busy (other pushes); waiting`)
    await Bun.sleep(2000)
  }
}

// Databases of a run that was killed: run databases older than an hour, and what they tagged.
const runAge = (name: string) => Date.now() - Number(name.split('_')[2])
const runs = (await psql(`select datname from pg_database where datname ~ '^learner_ci_[0-9]+_[0-9]+$'`)).stdout.toString().split('\n').filter(Boolean)
for (const name of runs.filter((n) => runAge(n) > 3_600_000)) await dropRun(name)

async function dropRun(name: string) {
  const tagged = (await psql(`select d.datname from pg_database d join pg_shdescription s on s.objoid = d.oid and s.classoid = 'pg_database'::regclass where s.description = 'learner-test-run:${name}'`)).stdout.toString().split('\n').filter(Boolean)
  for (const db of [...tagged, name]) await psql(`drop database if exists "${db}" with (force)`)
}

const db = `learner_ci_${Date.now()}_${process.pid}`
const created = await psql(`create database "${db}"`)
if (created.exitCode !== 0) throw new Error(`[test-clean-db] create database failed: ${created.stderr}`)
const env: Record<string, string | undefined> = { ...process.env, TEST_DATABASE_URL: admin.replace(/\/postgres$/, `/${db}`) }
delete env.DATABASE_URL
delete env.LEARNER_DATABASE_URL
delete env.LEARNER_CI_SLOT

let code = 1
try {
  const migrate = Bun.spawnSync(['bun', 'packages/server/src/db/migrate.ts', '--test'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  if (migrate.exitCode !== 0) {
    process.stdout.write(migrate.stdout.toString() + migrate.stderr.toString())
    throw new Error('[test-clean-db] migration failed')
  }
  console.log(`[test-clean-db] ${IMAGE} (en_US.utf8), fresh database ${db}, slot ${process.env.LEARNER_CI_SLOT}`)
  const tests = Bun.spawn(['bun', 'scripts/run-tests.ts', ...process.argv.slice(2)], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' })
  code = await tests.exited
} finally {
  await dropRun(db)
}
process.exit(code)
