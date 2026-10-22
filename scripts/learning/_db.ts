import { bindDatabase, createDatabase, type DatabaseHandle } from '@learner/core/db/handle.js'

/**
 * The learner database for an operator script, bound for core modules
 * (`metaDbQuery`, `getKysely`, the services). Run with
 * `bun --env-file=/etc/learner/db.env scripts/learning/<script>.ts`.
 *
 * `readOnly` sets `default_transaction_read_only` on every pooled session, so
 * a read-only script that drifts into a write fails in Postgres rather than
 * changing data. A URL that names a host database is refused outright.
 */
export function learnerDatabaseUrl(): string {
  const url = process.env.LEARNER_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('No database URL: run with --env-file=/etc/learner/db.env')
  const name = new URL(url).pathname.replace(/^\//, '')
  if (!/^learner(?:_test)?$/.test(name)) throw new Error(`Refusing database "${name}": scripts run against learner or learner_test only`)
  return url
}

export function openLearnerDatabase({ readOnly }: { readOnly: boolean }): DatabaseHandle {
  const url = new URL(learnerDatabaseUrl())
  if (readOnly) url.searchParams.set('options', '-c default_transaction_read_only=on')
  return bindDatabase(createDatabase(url.toString(), { max: 4, applicationName: 'learner-script' }))
}

/** Prints usage and exits 0 for `--help`; exits 2 with usage when `invalid`. */
export function usage(text: string, invalid = false): void {
  const help = process.argv.includes('--help') || process.argv.includes('-h')
  if (!help && !invalid) return
  ;(help ? console.log : console.error)(text.trim())
  process.exit(help ? 0 : 2)
}
