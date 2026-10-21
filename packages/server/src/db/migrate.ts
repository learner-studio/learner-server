import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Kysely, PostgresDialect, sql } from 'kysely'
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration'
import { Pool } from 'pg'

/**
 * Ordered plain-SQL migrations: every `NNNN_name.sql` in ./migrations runs once,
 * in file-name order, each inside its own transaction, tracked by Kysely's
 * Migrator in `learner_migrations`.
 */
const MIGRATIONS_DIR = join(import.meta.dir, 'migrations')

export class SqlFileMigrationProvider implements MigrationProvider {
  constructor(private readonly dir = MIGRATIONS_DIR) {}
  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
    const out: Record<string, Migration> = {}
    for (const file of files) {
      const text = await readFile(join(this.dir, file), 'utf8')
      out[file.replace(/\.sql$/, '')] = { up: async (db) => { await sql.raw(text).execute(db) } }
    }
    return out
  }
}

export async function migrateToLatest(url: string): Promise<string[]> {
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: url, max: 1 }) }) })
  try {
    const migrator = new Migrator({ db, provider: new SqlFileMigrationProvider(), migrationTableName: 'learner_migrations', migrationLockTableName: 'learner_migrations_lock' })
    const { error, results } = await migrator.migrateToLatest()
    for (const r of results ?? []) console.info(JSON.stringify({ event: 'migration', name: r.migrationName, status: r.status }))
    if (error) throw error
    return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName)
  } finally {
    await db.destroy()
  }
}

if (import.meta.main) {
  const url = process.argv[2] === '--test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL (or TEST_DATABASE_URL with --test) is required')
  await migrateToLatest(url)
}
