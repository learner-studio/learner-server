/**
 * Runs the opt-in integration suites that need a schema of their own, each in a
 * disposable database created for the run and dropped after it passes.
 *
 * They cannot use learner_test: the exposure suites TRUNCATE tables that other
 * Learning tables reference by foreign key, so each suite gets only the tables
 * it owns, built from the migrations that introduced them
 * (packages/core/test/fixtures/source-migrations) plus the workflow tables.
 *
 * Without --run it prints the plan and touches nothing. With --run it needs root
 * (databases are created as the postgres superuser via runuser) and grants the
 * role named by TEST_DATABASE_URL on the disposable database only.
 *   bun --env-file=/etc/learner/db.env scripts/learning/isolated-suites.ts [--run] [exposure|consolidation-trigger ...]
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { usage } from './_db.js'

const ROOT = join(import.meta.dir, '../..')
const FIXTURES = 'packages/core/test/fixtures/source-migrations'
const WORKFLOWS = 'packages/server/src/db/migrations/0002_workflows.sql'

interface Suite {
  prefix: string
  migrations: string[]
  env: string[]
  /** Run in order; a later group runs only when the earlier ones passed. */
  groups: string[][]
}

const SUITES: Record<string, Suite> = {
  exposure: {
    prefix: 'learner_exposure_test_',
    migrations: [WORKFLOWS, `${FIXTURES}/0154-lossless-cli-archive.sql`, `${FIXTURES}/0155-learning-exposure.sql`, `${FIXTURES}/0158-learning-exposure-work.sql`],
    env: ['LOSSLESS_ARCHIVE_TEST_DATABASE_URL', 'LEARNING_EXPOSURE_TEST_DATABASE_URL'],
    groups: [
      ['packages/core/src/services/learning-lossless-archive-service.test.ts',
        'packages/core/src/services/learning-exposure-service.test.ts',
        'packages/core/src/services/learning-exposure-ingest-service.test.ts',
        'packages/core/src/services/learning-exposure-work-service.test.ts'],
      ['packages/core/src/services/learning-lossless-archive-sync-service.test.ts'],
    ],
  },
  'consolidation-trigger': {
    prefix: 'learner_consolidation_trigger_test_',
    migrations: [`${FIXTURES}/0160-learning-hindsight-consolidation-trigger.sql`],
    env: ['LEARNING_CONSOLIDATION_TRIGGER_TEST_DATABASE_URL'],
    groups: [['packages/core/src/services/learning-hindsight-consolidation-trigger-service.test.ts']],
  },
}

const args = process.argv.slice(2)
const names = args.filter((arg) => !arg.startsWith('-'))
const unknown = names.filter((name) => !(name in SUITES))
usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/isolated-suites.ts [--run] [${Object.keys(SUITES).join('|')} ...]
Prints the plan; --run creates one disposable database per suite, applies its
migrations, runs its tests against it and drops it when they pass (a failing
database is kept for inspection).`, unknown.length > 0)
const execute = args.includes('--run')
const selected = names.length ? names : Object.keys(SUITES)

const source = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!source.username) throw new Error('TEST_DATABASE_URL must name the test role: run with --env-file=/etc/learner/db.env')
const role = decodeURIComponent(source.username)
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

async function postgres(argv: string[], input?: string): Promise<string> {
  // postgres cannot read files under /root: SQL always goes in on stdin.
  const child = Bun.spawn(['runuser', '-u', 'postgres', '--', ...argv], { cwd: '/var/tmp', stdin: input ? new Blob([input]) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${argv[0]} failed: ${stderr.slice(0, 1000)}`)
  return stdout
}
const psql = (database: string, input: string) => postgres(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', database], input)

let failed = false
for (const name of selected) {
  const suite = SUITES[name]!
  const target = `${suite.prefix}${randomUUID().replaceAll('-', '')}`
  if (!new RegExp(`^${suite.prefix}[a-f0-9]{32}$`).test(target)) throw new Error('Unsafe test database name')
  const url = new URL(source.toString())
  url.pathname = `/${target}`
  if (!execute) {
    console.log(JSON.stringify({ suite: name, plan: {
      createDatabase: `${suite.prefix}<uuid>`, owner: 'postgres', grantTo: role,
      migrations: suite.migrations, testEnv: suite.env, testGroups: suite.groups,
      cleanup: 'dropdb when every group passes; kept for inspection otherwise',
    } }, null, 2))
    continue
  }
  await postgres(['createdb', target])
  for (const migration of suite.migrations) await psql(target, await readFile(join(ROOT, migration), 'utf8'))
  await psql(target, `GRANT CREATE ON SCHEMA public TO ${quote(role)}; GRANT ALL ON ALL TABLES IN SCHEMA public TO ${quote(role)}; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO ${quote(role)};`)
  let code = 0
  for (const group of suite.groups) {
    if (code !== 0) break
    const child = Bun.spawn(['bun', 'test', ...group], {
      cwd: ROOT, stdout: 'inherit', stderr: 'inherit',
      env: { ...process.env, TMPDIR: '/tmp', ...Object.fromEntries(suite.env.map((key) => [key, url.toString()])) },
    })
    code = await child.exited
  }
  if (code !== 0) {
    failed = true
    console.log(JSON.stringify({ suite: name, passed: false, retainedIsolatedDatabase: target }))
    continue
  }
  const active = await postgres(['psql', '-X', '-A', '-t', '-d', 'postgres', '-c', `SELECT count(*) FROM pg_stat_activity WHERE datname='${target}'`])
  if (Number(active.trim()) !== 0) throw new Error(`${target} still has active clients; retained for inspection`)
  await postgres(['dropdb', target])
  console.log(JSON.stringify({ suite: name, passed: true, isolatedDatabase: target, cleanup: 'dropped' }))
}
process.exitCode = failed ? 1 : 0
