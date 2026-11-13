import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { Client } from 'pg'
import { database } from '@learner/core/db/handle.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { graderNoise } from '@learner/core/lib/learning/grader-noise.js'
import { masteryNotifications } from '@learner/core/lib/learning/mastery-notifications.js'
import { NotFoundError, TooManyRequestsError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'
import { CI_MINT_EMAIL, createAuth, deviceEmail, sessionForUser } from '../../auth.js'
import { mintMachineKey } from '../../devices.js'
import { resolveEndpoints } from '../../pairing.js'
import { getLearnerDesktopStatus, getPairingEndpoints, pairDesktop, recordAppHeartbeat } from './learner-desktop.function.js'
import { getBaselineStatus, getMasteryNotifications, masteryLearnerFor, recordNotificationFeedback } from './mastery-notifications.function.js'
import { createTestDevice, MAX_LIVE_TEST_DEVICES, MAX_TEST_DEVICES_PER_HOUR, revokeTestDevice, SEED_QUOTE, seedMasteryGain, sweepTestDevices, TEST_DEVICE_GAIN_RULE } from './test-devices.function.js'

// CI test devices end to end on a migrated database (docs/specs/server-desktop-pairing.md, round 2).
// Keys and codes are throwaway, and still never printed: assertions compare them, they never show them.
// The shared learner_test the pre-commit hook uses gets 0040 only at deploy; pre-push and CI migrate a fresh database.
const migrated = process.env.TEST_DATABASE_URL
  ? (await metaDbQuery<{ present: boolean }>(`SELECT to_regclass('public.learner_test_devices') IS NOT NULL AS present`)).rows[0]?.present === true
  : false
describe.skipIf(!migrated)('CI test devices (learner_test)', () => {
  const db = database()
  const authConfig = { secret: 'test-devices-integration-secret-0123456789', baseUrl: 'http://127.0.0.1:3010', adminEmails: [] as string[] }
  const auth = createAuth(db.kysely, authConfig)
  const logs: string[] = []
  const logger = { info: (o: unknown) => logs.push(JSON.stringify(o)), warn: () => {}, error: () => {}, debug: () => {} }
  const config = { ...authConfig, authSecret: authConfig.secret, endpoints: resolveEndpoints({ port: 3010, servesWeb: false, publicApiUrl: 'https://h.example.org/learner-api' }) }
  const services = { db, kysely: db.kysely, config, logger } as never
  const ctx = (session?: Session) => ({ session }) as never
  const decode = (code: string) => JSON.parse(Buffer.from(code.slice('learner-pair-v1:'.length), 'base64url').toString()) as { apiUrl: string; clientId: string; apiKey: string }
  const sessionOf = async (key: string) => {
    const verified = await auth.api.verifyApiKey({ body: { key } })
    return verified.valid && verified.key ? sessionForUser(db.kysely, authConfig, verified.key.referenceId) : undefined
  }
  const create = async (runId = 'run-1') => {
    const out = await createTestDevice.func(services, { runId, ttlMinutes: 30 }, ctx())
    const payload = decode(out.pairingCode)
    return { ...out, key: payload.apiKey, session: (await sessionOf(payload.apiKey))! }
  }
  const seed = (clientId: string, conceptId?: string) => seedMasteryGain.func(services, { clientId, ...(conceptId ? { conceptId } : {}) }, ctx())
  const userIdOf = async (clientId: string) => (await metaDbQuery<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [deviceEmail(clientId)])).rows[0]?.id
  /** Every row keyed to a user, as the purge must leave none. */
  const footprint = async (userId: string, clientId: string) => (await metaDbQuery<Record<string, number>>(`SELECT
      (SELECT count(*)::int FROM "user" WHERE id = $1) AS users, (SELECT count(*)::int FROM apikey WHERE reference_id = $1) AS keys,
      (SELECT count(*)::int FROM learning_concept_assessment_runs WHERE user_id = $1) AS runs,
      (SELECT count(*)::int FROM learning_concept_assessment_receipts t JOIN learning_concept_assessment_runs r USING (run_id) WHERE r.user_id = $1) AS receipts,
      (SELECT count(*)::int FROM learning_notification_feedback f JOIN learning_concept_assessment_runs r USING (run_id) WHERE r.user_id = $1) AS feedback,
      (SELECT count(*)::int FROM learning_concept_assessment_replicate_summaries s JOIN learning_concept_assessment_runs r USING (run_id) WHERE r.user_id = $1) AS summaries,
      (SELECT count(*)::int FROM learner_desktop_devices WHERE client_id = $2) AS devices`, [userId, clientId])).rows[0]!
  const beat = (session: Session, clientId: string) => recordAppHeartbeat.func(services, { clientId, appVersion: 't', captureState: 'recording', outboxDepth: 0, detail: {} }, ctx(session))
  const wipe = async () => {
    await metaDbQuery(`UPDATE learner_test_devices SET expires_at = now() - interval '1 second' WHERE revoked_at IS NULL`)
    await sweepTestDevices.func(services, undefined, ctx())
    await metaDbQuery(`DELETE FROM learner_test_devices`)
  }
  beforeEach(async () => { await wipe(); logs.length = 0 })
  afterAll(wipe)

  test('create: one pairing code that works as that test device only, with confined scopes, and is never logged', async () => {
    // The longest runId the contract allows: its key name (device:ci-<runId>-<8 hex>, 59 chars) is past Better Auth's default 32.
    expect((await create('a'.repeat(40))).session.scopes).toEqual(['app', 'test-device'])
    const d = await create('12345-1')
    expect(/^ci-12345-1-[0-9a-f]{8}$/.test(d.clientId)).toBe(true)
    const payload = decode(d.pairingCode)
    expect([payload.apiUrl, payload.clientId]).toEqual(['https://h.example.org/learner-api', d.clientId])
    expect(d.session.scopes).toEqual(['app', 'test-device'])
    expect(d.session.userId).toBe((await userIdOf(d.clientId))!)
    // As that device and no other.
    await expect(Promise.resolve().then(() => getPairingEndpoints.func(services, { clientId: 'ben-mbp' }, ctx(d.session)))).rejects.toThrow('not ben-mbp')
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.some((line) => line.includes(d.key) || line.includes(d.pairingCode.slice(16)))).toBe(false)
  })

  test('the key dies at its TTL before any sweep, and the sweep leaves an unexpired device alone', async () => {
    const live = await create(), old = await create()
    await metaDbQuery(`UPDATE learner_test_devices SET expires_at = now() - interval '1 second' WHERE client_id = $1`, [old.clientId])
    expect(await sessionOf(old.key)).toBeUndefined()
    await sweepTestDevices.func(services, undefined, ctx())
    expect(await footprint(old.session.userId, old.clientId)).toEqual({ users: 0, keys: 0, runs: 0, receipts: 0, feedback: 0, summaries: 0, devices: 0 })
    expect((await sessionOf(live.key))?.scopes).toEqual(['app', 'test-device'])
    // Tombstones stay a day (the rate limit counts them), then go.
    await metaDbQuery(`UPDATE learner_test_devices SET revoked_at = now() - interval '25 hours' WHERE client_id = $1`, [old.clientId])
    await sweepTestDevices.func(services, undefined, ctx())
    expect((await metaDbQuery(`SELECT client_id FROM learner_test_devices`)).rows).toEqual([{ client_id: live.clientId }])
  })

  test('a test device reads and writes only its own seeded mastery, never another learner\'s', async () => {
    const a = await create('a'), b = await create('b')
    const seeded = await seed(a.clientId)
    const other = await seed(b.clientId)
    expect(await masteryLearnerFor(services, a.session)).toBe(a.session.userId)
    const feed = await masteryNotifications(metaDbQuery, a.session.userId, { since: null, limit: 20 }, TEST_DEVICE_GAIN_RULE)
    expect(feed.map((n) => [n.runId, n.kind, n.conceptId, n.completedAt])).toEqual([[seeded.runId, 'gain', seeded.conceptId, seeded.completedAt]])
    expect(await recordNotificationFeedback.func(services, { runId: other.runId, action: 'opened' }, ctx(a.session))).toMatchObject({ recorded: false })
    expect(await recordNotificationFeedback.func(services, { runId: seeded.runId, action: 'opened' }, ctx(a.session))).toMatchObject({ recorded: true })
    // A second seed takes a concept the device has not read, so it is announced too; a concept it has read is refused.
    expect((await seed(a.clientId)).conceptId).not.toBe(seeded.conceptId)
    await expect(seed(a.clientId, seeded.conceptId)).rejects.toThrow('already has a reading')
  })

  test('MasteryE2E: a seeded 50 % -> 65 % gain passes the real feed, chance gate included, for that device only', async () => {
    const d = await create('mastery'), other = await create('other')
    const noiseBefore = await graderNoise(metaDbQuery)
    const s = await seed(d.clientId)
    const feed = async (since: string | null, session = d.session) => (await getMasteryNotifications.func(services, { since, limit: 20 }, ctx(session))).notifications
    // The feed job's first run: one new, exactly the seeded run, "▲ 50% → 65%", with the fixed synthetic quote.
    expect(await feed(null)).toEqual([{ runId: s.runId, conceptId: s.conceptId, conceptName: expect.any(String), kind: 'gain',
      percent: 65, previousPercent: 50, delta: 15, confidence: 'medium', completedAt: s.completedAt, quote: SEED_QUOTE }])
    expect(await feed(s.completedAt)).toEqual([])
    expect(await feed(null, other.session)).toEqual([])
    // The declared calibration reaches test-device sessions only: the same rows under the owner's scopes stay withheld.
    expect(await feed(null, { ...d.session, scopes: ['admin'] })).toEqual([])
    // The same rows under a real learner's calibration are withheld: the rows do not get past the rule, the declared calibration does.
    expect(await masteryNotifications(metaDbQuery, d.session.userId, { since: null, limit: 20 })).toEqual([])
    const baseline = await getBaselineStatus.func(services, {}, ctx(d.session))
    expect(baseline.learning).toBeObject()
    expect(baseline.coach).toBeNull()
    // Even with a habits database configured, a test device never reads the owner's coach baseline.
    const habitsOn = { db, kysely: db.kysely, logger, config: { ...config, habitsDatabaseUrl: 'postgres://unused' }, learnerDesktopHabits: () => { throw new Error('test device read the habits database') } } as never
    expect((await getBaselineStatus.func(habitsOn, {}, ctx(d.session))).coach).toBeNull()
    const opened = await recordNotificationFeedback.func(services, { runId: s.runId, action: 'opened' }, ctx(d.session))
    expect(opened).toMatchObject({ recorded: true })
    for (const _ of [1, 2]) expect(await recordNotificationFeedback.func(services, { runId: s.runId, action: 'opened' }, ctx(d.session))).toEqual(opened)
    // Seeded replicate gradings never reach the grader-noise estimate every real learner's rule reads.
    expect(await graderNoise(metaDbQuery)).toEqual(noiseBefore)
  })

  test('revoke deletes the device and every row it wrote, and nothing of a real device with a test-shaped id', async () => {
    const d = await create()
    const { runId } = await seed(d.clientId)
    await recordNotificationFeedback.func(services, { runId, action: 'nice' }, ctx(d.session))
    await beat(d.session, d.clientId)
    expect(await footprint(d.session.userId, d.clientId)).toEqual({ users: 1, keys: 1, runs: 14, receipts: 14, feedback: 1, summaries: 14, devices: 1 })
    expect(await revokeTestDevice.func(services, { clientId: d.clientId }, ctx())).toEqual({ revoked: true })
    expect(await footprint(d.session.userId, d.clientId)).toEqual({ users: 0, keys: 0, runs: 0, receipts: 0, feedback: 0, summaries: 0, devices: 0 })
    expect(await sessionOf(d.key)).toBeUndefined()
    // A device user with a test-shaped id but no learner_test_devices row (mint-api-key and pairDesktop refuse
    // ci- ids, so only a purge-then-recreate could make one): it gets no session, and revoke and seed refuse it alike.
    const real = 'ci-real-0badc0de'
    const { userId } = await mintMachineKey(db.kysely, config, deviceEmail(real), `device:${real}`)
    expect(await sessionForUser(db.kysely, authConfig, userId)).toBeUndefined()
    await metaDbQuery(`INSERT INTO learner_desktop_devices(client_id, user_id, app_version, capture_state, outbox_depth) VALUES ($1, $2, 't', 'recording', 0)`, [real, userId])
    expect(await revokeTestDevice.func(services, { clientId: real }, ctx())).toEqual({ revoked: false })
    expect(await revokeTestDevice.func(services, { clientId: 'ci-nobody-00000000' }, ctx())).toEqual({ revoked: false })
    await expect(seed(real)).rejects.toBeInstanceOf(NotFoundError)
    await expect(seed('ci-nobody-00000000')).rejects.toThrow(`ci-nobody-00000000 is not a live test device`)
    await sweepTestDevices.func(services, undefined, ctx())
    expect(await footprint(userId, real)).toMatchObject({ users: 1, keys: 1, devices: 1 })
    await metaDbQuery(`DELETE FROM learner_desktop_devices WHERE client_id = $1`, [real])
    await metaDbQuery(`DELETE FROM apikey WHERE reference_id = $1`, [userId])
    await metaDbQuery(`DELETE FROM "user" WHERE id = $1`, [userId])
  })

  test('races: a seed after a revoke is refused; a heartbeat that lands after it is purged by the next sweep', async () => {
    const d = await create()
    await revokeTestDevice.func(services, { clientId: d.clientId }, ctx())
    await expect(seed(d.clientId)).rejects.toBeInstanceOf(NotFoundError)
    // The heartbeat's session was resolved before the revoke; its write commits after it.
    await beat(d.session, d.clientId)
    await sweepTestDevices.func(services, undefined, ctx())
    expect((await footprint(d.session.userId, d.clientId)).devices).toBe(0)
  })

  test('B1: a device purged between its commit and its key mint gets no key, and a recreated ci- user no session', async () => {
    // createTestDevice's mint reads the user through services.kysely: the sweep lands right before that read.
    const hook = <T extends object>(target: T, before: () => Promise<unknown>): T => new Proxy(target, { get: (t, p) => {
      const v = Reflect.get(t, p)
      if (p === 'executeTakeFirst') return async () => { await before(); return (v as () => unknown).call(t) }
      return typeof v === 'function' ? (...a: unknown[]) => { const r = v.apply(t, a); return r && typeof r === 'object' && p !== 'then' ? hook(r, before) : r } : v
    } })
    let fired = false
    const sweepFirst = async () => {
      if (fired) return
      fired = true
      await metaDbQuery(`UPDATE learner_test_devices SET expires_at = now() - interval '1 second' WHERE run_id = 'race'`)
      await sweepTestDevices.func(services, undefined, ctx())
    }
    const racing = new Proxy(db.kysely, { get: (t, p) => {
      const v = Reflect.get(t, p)
      return p === 'selectFrom' ? (...a: unknown[]) => hook((v as (...x: unknown[]) => object).apply(t, a), sweepFirst) : typeof v === 'function' ? v.bind(t) : v
    } })
    await expect(createTestDevice.func({ ...(services as object), kysely: racing } as never, { runId: 'race', ttlMinutes: 1 }, ctx())).rejects.toBeInstanceOf(NotFoundError)
    expect(fired).toBe(true)
    const [row] = (await metaDbQuery<{ client_id: string }>(`SELECT client_id FROM learner_test_devices WHERE run_id = 'race'`)).rows
    expect(await userIdOf(row!.client_id)).toBeUndefined()
    expect((await metaDbQuery(`SELECT 1 FROM apikey WHERE name = $1`, [`device:${row!.client_id}`])).rowCount).toBe(0)
    // Defense in depth: had the user been recreated (the mint before the fix), its key gets no session.
    const recreated = await mintMachineKey(db.kysely, config, deviceEmail(row!.client_id), `device:${row!.client_id}`)
    expect(await sessionOf(recreated.key)).toBeUndefined()
    await sweepTestDevices.func(services, undefined, ctx())
    expect(await footprint(recreated.userId, row!.client_id)).toMatchObject({ users: 0, keys: 0 })
  })

  test('S1: an API key over /api/auth reads its session and nothing else', async () => {
    const d = await create()
    const call = (path: string, body?: object) => auth.handler(new Request(`${authConfig.baseUrl}/api/auth${path}`, body
      ? { method: 'POST', headers: { 'x-api-key': d.key, 'content-type': 'application/json', origin: authConfig.baseUrl }, body: JSON.stringify(body) }
      : { headers: { 'x-api-key': d.key } }))
    for (const [path, body] of [['/api-key/create', { name: 'more' }], ['/update-user', { name: 'renamed' }]] as const) {
      const res = await call(path, body)
      expect([path, res.status]).toEqual([path, 403])
      expect(await res.text()).toContain('may only call get-session')
    }
    expect((await call('/get-session')).status).toBe(200)
    expect(await footprint(d.session.userId, d.clientId)).toMatchObject({ keys: 1 })
  })

  test('S2/N1: under the purge GUC the trigger still refuses a real user\'s readings, a live test device\'s, and a revoked row naming a real user', async () => {
    const d = await create()
    const { runId: liveRun } = await seed(d.clientId)
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    try {
      await client.query('BEGIN')
      const realUser = `real-${crypto.randomUUID()}`, realRun = crypto.randomUUID()
      await client.query(`INSERT INTO "user"(id, name, email, email_verified) VALUES ($1, 'real', $2, true)`, [realUser, `${realUser}@example.org`])
      await client.query(`INSERT INTO learning_concept_assessment_runs(run_id, user_id, request_id, concept_id, node_version, input_hash, snapshot)
        VALUES ($1, $2, $1, 'c', 'v', 'h', '{}'::jsonb)`, [realRun, realUser])
      await client.query(`INSERT INTO learning_concept_assessment_receipts(run_id, receipt, completed_at) VALUES ($1, '{"status":"completed"}'::jsonb, now())`, [realRun])
      await client.query(`SELECT set_config('learner.test_device_purge', 'on', true)`)
      const refused = async (sql: string, params: unknown[]) => {
        await client.query('SAVEPOINT s')
        const error = await client.query(sql, params).then(() => null, (e: Error) => e)
        await client.query('ROLLBACK TO SAVEPOINT s')
        return error?.message
      }
      const immutable = 'Learning assessment evidence and receipts are immutable'
      expect(await refused(`DELETE FROM learning_concept_assessment_receipts WHERE run_id = $1`, [realRun])).toBe(immutable)
      expect(await refused(`DELETE FROM learning_concept_assessment_runs WHERE run_id = $1`, [liveRun])).toBe(immutable)
      // Once the device is revoked its rows may be deleted, never updated.
      await client.query(`UPDATE learner_test_devices SET revoked_at = now() WHERE client_id = $1`, [d.clientId])
      expect(await refused(`UPDATE learning_concept_assessment_receipts SET completed_at = now() WHERE run_id = $1`, [liveRun])).toBe(immutable)
      expect(await refused(`DELETE FROM learning_concept_assessment_receipts WHERE run_id = $1`, [liveRun])).toBeUndefined()
      // A revoked test row that names a real user (only a bug could write one) unlocks nothing, and the purge skips it.
      await client.query(`INSERT INTO learner_test_devices(client_id, user_id, run_id, expires_at, revoked_at) VALUES ('ci-poison-0badc0de', $1, 'p', now(), now())`, [realUser])
      expect(await refused(`DELETE FROM learning_concept_assessment_runs WHERE run_id = $1`, [realRun])).toBe(immutable)
    } finally {
      await client.query('ROLLBACK')
      await client.end()
    }
  })

  test('N2: a revoked row naming a real user is skipped by the purge: the user and its key stay', async () => {
    const { userId, key } = await mintMachineKey(db.kysely, config, 'someone@example.org', 'learner-hook')
    await metaDbQuery(`INSERT INTO learner_test_devices(client_id, user_id, run_id, expires_at, revoked_at) VALUES ('ci-poison-0badc0de', $1, 'p', now(), now())`, [userId])
    await sweepTestDevices.func(services, undefined, ctx())
    expect((await metaDbQuery(`SELECT 1 FROM "user" WHERE id = $1`, [userId])).rowCount).toBe(1)
    expect((await metaDbQuery(`SELECT 1 FROM apikey WHERE reference_id = $1`, [userId])).rowCount).toBe(1)
    await metaDbQuery(`DELETE FROM learner_test_devices WHERE client_id = 'ci-poison-0badc0de'`)
    expect((await sessionOf(key))?.userId).toBe(userId)
    await metaDbQuery(`DELETE FROM apikey WHERE reference_id = $1`, [userId])
    await metaDbQuery(`DELETE FROM "user" WHERE id = $1`, [userId])
  })

  test('S3: the caps hold under concurrent creates, and a seed racing a revoke leaves nothing behind', async () => {
    const results = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => createTestDevice.func(services, { runId: `burst-${i}`, ttlMinutes: 5 }, ctx())))
    expect(results.filter((r) => r.status === 'fulfilled').length).toBe(MAX_LIVE_TEST_DEVICES)
    expect(results.every((r) => r.status === 'fulfilled' || r.reason instanceof TooManyRequestsError)).toBe(true)
    await wipe()
    for (let i = 0; i < 4; i++) {
      const d = await create(`race-${i}`)
      await Promise.allSettled([seed(d.clientId), Bun.sleep(i * 3).then(() => revokeTestDevice.func(services, { clientId: d.clientId }, ctx()))])
      // No sweep: the revoke alone must leave no reading, whichever won the row lock.
      expect(await footprint(d.session.userId, d.clientId)).toMatchObject({ users: 0, runs: 0, receipts: 0 })
    }
  })

  test('a leaked ci-mint key is capped: live devices and devices per hour', async () => {
    for (let i = 0; i < MAX_LIVE_TEST_DEVICES; i++) await createTestDevice.func(services, { runId: `cap-${i}`, ttlMinutes: 5 }, ctx())
    await expect(createTestDevice.func(services, { runId: 'cap-over', ttlMinutes: 5 }, ctx())).rejects.toBeInstanceOf(TooManyRequestsError)
    await wipe()
    await metaDbQuery(`INSERT INTO learner_test_devices(client_id, user_id, run_id, expires_at, revoked_at)
      SELECT 'ci-rate-' || i || '-0000000' || (i % 10), 'rate-' || i, 'rate', now(), now() FROM generate_series(1, $1) i`, [MAX_TEST_DEVICES_PER_HOUR])
    await expect(createTestDevice.func(services, { runId: 'rate-over', ttlMinutes: 5 }, ctx())).rejects.toThrow('in the last hour')
  })

  test('test devices stay out of the owner\'s device dashboard and every cross-user read\'s predicate', async () => {
    const d = await create()
    await beat(d.session, d.clientId)
    const { devices } = await getLearnerDesktopStatus.func(services, {}, ctx())
    expect(devices.map((x) => x.clientId)).not.toContain(d.clientId)
    expect((await metaDbQuery(`SELECT learner_test_user($1) AS test, learner_test_user('someone') AS other`, [d.session.userId])).rows[0]).toEqual({ test: true, other: false })
  })

  test('pairDesktop: admin only, never a ci- id, one live code per device', async () => {
    expect(pairDesktop.meta.scopes).toEqual(['admin'])
    expect(pairDesktop.input!.safeParse({ clientId: 'ci-run-0badc0de' }).success).toBe(false)
    const first = await pairDesktop.func(services, { clientId: 'td-mac' }, ctx())
    const out = await pairDesktop.func(services, { clientId: 'td-mac' }, ctx())
    expect(decode(out.pairingCode).clientId).toBe('td-mac')
    expect((await sessionOf(decode(out.pairingCode).apiKey))?.scopes).toEqual(['app'])
    // Re-pairing revokes the code shown before.
    expect(await sessionOf(decode(first.pairingCode).apiKey)).toBeUndefined()
    expect(logs.some((line) => line.includes(decode(out.pairingCode).apiKey))).toBe(false)
    const userId = (await userIdOf('td-mac'))!
    await metaDbQuery(`DELETE FROM apikey WHERE reference_id = $1`, [userId])
    await metaDbQuery(`DELETE FROM "user" WHERE id = $1`, [userId])
  })

  test('mint-api-key: --pairing-code prints only the code, --ci-mint only a confined key, and ci- device ids are refused', async () => {
    const run = (...extra: string[]) => {
      const proc = Bun.spawnSync(['bun', join(import.meta.dir, '../../../scripts/mint-api-key.ts'), ...extra], {
        env: { ...process.env, LEARNER_DATABASE_URL: process.env.TEST_DATABASE_URL, LEARNER_AUTH_SECRET: authConfig.secret, LEARNER_PUBLIC_API_URL: 'https://h.example.org/learner-api' },
      })
      return { code: proc.exitCode, out: proc.stdout.toString().trim(), err: proc.stderr.toString() }
    }
    const paired = run('--device', 'td-script', '--pairing-code')
    expect(paired.code).toBe(0)
    expect(/^learner-pair-v1:[A-Za-z0-9_-]+$/.test(paired.out)).toBe(true)
    expect(decode(paired.out).apiUrl).toBe('https://h.example.org/learner-api')
    expect(paired.err.includes(decode(paired.out).apiKey)).toBe(false)
    const ci = run('--ci-mint')
    expect(ci.code).toBe(0)
    expect((await sessionOf(ci.out))?.scopes).toEqual(['ci-mint'])
    expect(run('--ci-mint', '--revoke').code).toBe(0)
    expect((await metaDbQuery(`SELECT 1 FROM "user" WHERE email = $1`, [CI_MINT_EMAIL])).rowCount).toBe(0)
    expect(run('--device', 'ci-sneaky-0badc0de', '--pairing-code').code).not.toBe(0)
    expect(run('--device', 'td-script', '--revoke').code).toBe(0)
  })

  // Restart safety (docs/operations/restart-safety.md): revoke and sweep are one transaction with no outside
  // effect. Killed mid-purge (held on the user row's lock, after the readings were deleted inside it), the
  // process leaves the device whole and live; the next run deletes it, once.
  for (const signal of ['SIGKILL', 'SIGTERM'] as const) test(`a revoke killed mid-purge (${signal}) rolls back whole, and the next run completes it`, async () => {
    const d = await create()
    await seed(d.clientId)
    const blocker = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await blocker.connect()
    await blocker.query('BEGIN')
    await blocker.query('SELECT 1 FROM "user" WHERE id = $1 FOR UPDATE', [d.session.userId])
    const app = `td-crash-${signal}`
    const child = Bun.spawn(['bun', '-e', `
      const { createDatabase } = await import(${JSON.stringify(join(import.meta.dir, '../../../../core/src/db/handle.ts'))})
      const { revokeTestDevices } = await import(${JSON.stringify(join(import.meta.dir, '../../devices.ts'))})
      await revokeTestDevices(createDatabase(process.env.TEST_DATABASE_URL, { max: 1, applicationName: ${JSON.stringify(app)} }), ${JSON.stringify(d.clientId)})`],
    { env: process.env, stdout: 'ignore', stderr: 'ignore' })
    const waiting = async () => (await metaDbQuery(`SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`, [app])).rowCount > 0
    for (let i = 0; !(await waiting()); i++) { if (i > 200) throw new Error('the revoke never reached the user row'); await Bun.sleep(50) }
    child.kill(signal)
    await child.exited
    await blocker.query('ROLLBACK')
    await blocker.end()
    for (let i = 0; (await metaDbQuery(`SELECT 1 FROM pg_stat_activity WHERE application_name = $1`, [app])).rowCount > 0; i++) { if (i > 200) throw new Error('backend lingered'); await Bun.sleep(50) }
    expect(await footprint(d.session.userId, d.clientId)).toMatchObject({ users: 1, keys: 1, runs: 14, receipts: 14 })
    expect((await sessionOf(d.key))?.scopes).toEqual(['app', 'test-device'])
    expect(await revokeTestDevice.func(services, { clientId: d.clientId }, ctx())).toEqual({ revoked: true })
    expect(await footprint(d.session.userId, d.clientId)).toEqual({ users: 0, keys: 0, runs: 0, receipts: 0, feedback: 0, summaries: 0, devices: 0 })
    expect(await revokeTestDevice.func(services, { clientId: d.clientId }, ctx())).toEqual({ revoked: false })
  }, 30_000)
})
