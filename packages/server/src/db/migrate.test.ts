import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from 'pg'
import { migrateToLatest } from './migrate.js'

// Branches add migrations in parallel: 0044 can be applied before 0043 lands. The later, lower-numbered file must
// still run, not stop the units at boot with "corrupted migrations". Needs a role that may CREATE DATABASE (CI, the
// pre-push container); skipped elsewhere.
const base = process.env.TEST_DATABASE_URL
test.skipIf(!base)('a migration numbered below one already applied runs when it lands later', async () => {
  const name = `learner_migrateorder_${Date.now()}`, dir = mkdtempSync(join(tmpdir(), 'migrate-order-'))
  const admin = new Client({ connectionString: base })
  await admin.connect()
  try {
    try { await admin.query(`CREATE DATABASE ${name}`) } catch { console.warn('[migrateorder] skipped: the test role may not create a database'); return }
    const url = new URL(base!)
    url.pathname = `/${name}`
    writeFileSync(join(dir, '0002_later.sql'), 'CREATE TABLE later(id int)')
    expect(await migrateToLatest(url.toString(), dir)).toEqual(['0002_later'])
    writeFileSync(join(dir, '0001_earlier.sql'), 'CREATE TABLE earlier(id int)')
    expect(await migrateToLatest(url.toString(), dir)).toEqual(['0001_earlier'])
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await admin.end()
    rmSync(dir, { recursive: true, force: true })
  }
})
