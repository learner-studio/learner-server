// Runs the test suite the way CI does: against a database nothing else has touched, in the
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
// database per run, dropped afterwards, so concurrent pushes from several checkouts never share
// one. The credentials are the throwaway ones ci.yml uses; nothing here is a secret.
//
//   bun scripts/test-clean-db.ts [run-tests args...]
//   exit 3: Docker is not available (the hook then falls back to learner_test and says so)
import { $ } from 'bun'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const CONTAINER = 'learner-ci-pg'
const IMAGE = 'postgres:17' // keep in step with .github/workflows/ci.yml
const PORT = Number(process.env.LEARNER_CI_PG_PORT ?? 55440)
const admin = `postgres://learner:learner@127.0.0.1:${PORT}/postgres`

if ((await $`docker info --format '{{.ServerVersion}}'`.quiet().nothrow()).exitCode !== 0) {
  console.error('[test-clean-db] Docker is not available')
  process.exit(3)
}

const state = (await $`docker inspect -f '{{.State.Running}}' ${CONTAINER}`.quiet().nothrow())
if (state.exitCode !== 0) {
  await $`docker run -d --name ${CONTAINER} --restart unless-stopped -p 127.0.0.1:${PORT}:5432 --tmpfs /var/lib/postgresql/data:rw,size=2g -e POSTGRES_USER=learner -e POSTGRES_PASSWORD=learner -e POSTGRES_DB=postgres ${IMAGE}`.quiet()
} else if (state.stdout.toString().trim() !== 'true') {
  await $`docker start ${CONTAINER}`.quiet()
}

// pg_isready is true for a moment during the image's init restart; a real query is not.
const psql = (sql: string) => $`docker exec ${CONTAINER} psql -U learner -d postgres -qAtX -c ${sql}`.quiet().nothrow()
for (let i = 0; ; i++) {
  if ((await psql('select 1')).exitCode === 0) break
  if (i > 120) throw new Error(`[test-clean-db] ${CONTAINER} did not accept connections`)
  await Bun.sleep(250)
}

// Databases left by a run that was killed: older than an hour, never the one in use.
const stale = (await psql(`select datname from pg_database where datname like 'learner_ci_%' and split_part(datname,'_',3)::bigint < ${Date.now() - 3_600_000}`)).stdout.toString().split('\n').filter(Boolean)
for (const name of stale) await psql(`drop database if exists "${name}" with (force)`)

const db = `learner_ci_${Date.now()}_${process.pid}`
const created = await psql(`create database "${db}"`)
if (created.exitCode !== 0) throw new Error(`[test-clean-db] create database failed: ${created.stderr}`)
const env: Record<string, string | undefined> = { ...process.env, TEST_DATABASE_URL: admin.replace(/\/postgres$/, `/${db}`) }
delete env.DATABASE_URL
delete env.LEARNER_DATABASE_URL

let code = 1
try {
  const migrate = Bun.spawnSync(['bun', 'packages/server/src/db/migrate.ts', '--test'], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  if (migrate.exitCode !== 0) {
    process.stdout.write(migrate.stdout.toString() + migrate.stderr.toString())
    throw new Error('[test-clean-db] migration failed')
  }
  console.log(`[test-clean-db] ${IMAGE} (en_US.utf8), fresh database ${db}`)
  const tests = Bun.spawn(['bun', 'scripts/run-tests.ts', ...process.argv.slice(2)], { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit' })
  code = await tests.exited
} finally {
  await psql(`drop database if exists "${db}" with (force)`)
}
process.exit(code)
