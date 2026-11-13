import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { migrateToLatest } from './migrate.js'

// Branches add migrations in parallel: 0044 can be applied before another branch's 0043 lands. On a database already
// at latest (0044 included), a file numbered below it must still run, not stop the units at boot with
// "corrupted migrations". The probe runs against every real migration plus one new lower-numbered file.
const url = await ownTestDatabaseUrl('migrateorder')
const PROBE = '0043_order_probe'
test.skipIf(!url)('a migration numbered below one already applied runs when it lands later', async () => {
  const real = join(import.meta.dir, 'migrations'), dir = mkdtempSync(join(tmpdir(), 'migrate-order-'))
  const db = new Client({ connectionString: url! })
  await db.connect()
  try {
    for (const file of readdirSync(real)) symlinkSync(join(real, file), join(dir, file))
    expect(readdirSync(real).some((f) => f > `${PROBE}.sql` && /^\d{4}_/.test(f))).toBe(true)
    writeFileSync(join(dir, `${PROBE}.sql`), 'CREATE TABLE learner_migrate_order_probe(id int)')
    expect(await migrateToLatest(url!, dir)).toEqual([PROBE])
    expect(await migrateToLatest(url!, dir)).toEqual([])
  } finally {
    // The per-checkout database (dev box) outlives the run: leave its ledger as the real migrations left it.
    await db.query('DROP TABLE IF EXISTS learner_migrate_order_probe')
    await db.query('DELETE FROM learner_migrations WHERE name = $1', [PROBE])
    await db.end()
    rmSync(dir, { recursive: true, force: true })
  }
})
