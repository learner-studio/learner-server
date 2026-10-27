import { afterAll, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { acquireRuntimeRole, releaseRuntimeRole, setRuntimeRole } from './learning-worker-runtime.js'

// The role fence on learner_test. A worker started while a peer still holds the
// fence must wait and take over, never exit: under `bun --watch` an exit leaves
// the service "active" and dead (2026-10-27: a gate worker held the fence while
// systemd restarted the dev worker, which then served nothing for 15 minutes).
describe.skipIf(!process.env.TEST_DATABASE_URL)('acquireRuntimeRole (learner_test)', () => {
  setRuntimeRole('api') // the live API never takes a fence, and this is learner_test anyway
  const holder = async () => {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    expect((await client.query(`SELECT pg_try_advisory_lock(hashtext('learner-runtime:api')) AS locked`)).rows[0].locked).toBe(true)
    return client
  }
  afterAll(() => releaseRuntimeRole())

  test('gives up only when told to wait a bounded time', async () => {
    const peer = await holder()
    try { await expect(acquireRuntimeRole({ retryMs: 20, waitMs: 60, log: () => {} })).rejects.toThrow(/already active/) }
    finally { await peer.end() }
  })

  test('waits while a peer holds the fence, then takes it over when the peer dies', async () => {
    const peer = await holder()
    const logs: string[] = []
    let acquired = false
    const waiting = acquireRuntimeRole({ retryMs: 25, log: (m) => logs.push(m) }).then(() => { acquired = true })
    await Bun.sleep(150)
    expect(acquired).toBe(false)
    await peer.end() // the holder dies (kill -9 closes its session the same way)
    await waiting
    expect(acquired).toBe(true)
    expect(logs[0]).toMatch(/held by another process/)
    expect(logs.at(-1)).toMatch(/acquired after \d+ wait/)
    // And it really holds it now: a third process cannot.
    const third = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await third.connect()
    expect((await third.query(`SELECT pg_try_advisory_lock(hashtext('learner-runtime:api')) AS locked`)).rows[0].locked).toBe(false)
    await third.end()
  })
})
