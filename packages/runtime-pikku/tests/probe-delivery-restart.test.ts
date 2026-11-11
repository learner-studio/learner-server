import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { createLearnerClient } from '@learner/contract'
import { DEFAULT_LEARNING_POLICY, REVIEW_HOPS_ALL, type LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { createDatabase } from '@learner/core/db/handle.js'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { LIVE_CATALOG, LIVE_CATALOG_VERSION } from '@learner/core/lib/learning/learning-live-feedback.js'
import { LIVE_HELD_OUT } from '@learner/core/lib/learning/learning-live-turn.js'
import { type Crashable, spawnCrashable, until } from '@learner/llm/lib/cli/testing/crash-harness.js'
import { createAuth } from '@learner/server/auth.js'

/**
 * Restart safety of a blind probe's delivery (docs/operations/restart-safety.md, docs/specs/blind-probes.md
 * "Restarts"): a REAL API process (src/bin/api.ts) is killed in the middle of the submit RPC, between the
 * feedback write and the decision write, and the hook's retry against a new process must answer the one
 * stored decision. A trigger on this run's user holds the decision statement on an advisory lock, so the
 * kill lands at a known instant. SIGKILL and SIGTERM, each at two instants:
 * - committed: the statement commits after the kill (the reply is lost, the probe is recorded); the policy
 *   then moves (probes off, no injection) and the retry must still deliver the recorded probe;
 * - aborted: the statement never commits (nothing decided); the retry decides once.
 * On its own test database (ownTestDatabaseUrl('probe')) and its own queue schema.
 */
const url = await ownTestDatabaseUrl('probe')
const PKG = fileURLToPath(new URL('..', import.meta.url))

describe.skipIf(!url)('blind probe delivery across a restart, real API process (learner_probe_test_<checkout>)', () => {
  const run = randomUUID().slice(0, 8)
  const email = `probe-restart-${run}@test.invalid`
  const secret = `probe-restart-${randomUUID()}`
  const bossSchema = `lp_boss_probe_${run}`
  const hold = Math.floor(Math.random() * 2 ** 31)
  const children: Crashable[] = []
  let db: Client
  let userId: string
  let apiKey: string
  const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows as T[]
  const savePolicy = (patch: Partial<LearningPolicySettings>) => db.query(`INSERT INTO learning_policy_settings(config_key,settings,updated_by,updated_at) VALUES('default',$1::jsonb,'probe-restart-test',now())
    ON CONFLICT(config_key) DO UPDATE SET settings=EXCLUDED.settings`, [JSON.stringify({ ...DEFAULT_LEARNING_POLICY, ...patch })])

  /** A new API process on a free port, and a client for it. */
  const startApi = async () => {
    const api = spawnCrashable([process.execPath, 'src/bin/api.ts'], { cwd: PKG, env: { ...process.env, LEARNER_DATABASE_URL: url!, DATABASE_URL: url!, LEARNER_PORT: '0', LEARNER_HOST: '127.0.0.1',
      LEARNER_AUTH_SECRET: secret, LEARNER_ADMIN_EMAILS: email, LEARNING_LOCAL_MVP_ENABLED: 'true', LEARNER_PIKKU_PGBOSS_SCHEMA: bossSchema, LEARNER_POOL_MAX: '4', LEARNER_BOSS_POOL_MAX: '2',
      LEARNER_SCHEDULES_ENABLED: undefined, LEARNER_WEB_DIST: undefined, LEARNER_HABITS_DATABASE_URL: undefined, LEARNER_GROWTHBOOK_URL: undefined, LEARNER_GROWTHBOOK_API_URL: undefined } })
    children.push(api)
    const listening = () => /"url":"(http:\/\/127\.0\.0\.1:\d+)"/.exec(api.log())?.[1]
    await until(() => Boolean(listening()), 90_000, 'the API to listen', api)
    return { api, call: createLearnerClient({ baseUrl: listening()!, apiKey }) }
  }
  const turn = (conceptId: string) => {
    const ids = { sessionId: `probe-restart-${randomUUID()}`, turnId: randomUUID() }
    return { begin: { ...ids, message: `Please help me with ${conceptId} in this code.`, foundationFirst: true }, submit: { ...ids, catalogVersion: LIVE_CATALOG_VERSION, taughtConceptIds: [],
      matches: [{ conceptId, quote: conceptId, relationship: 'task_context' as const, outcome: 'not_assessed' as const, reason: 'The task is about it.' }] } }
  }
  const stored = async (turnId: string) => (await rows<{ injected: boolean | null; context: string | null; concept_ids: string[]; probe_outcome: string | null; probe_concept_id: string | null }>(
    `SELECT injected, guidance_context AS context, guidance_concept_ids AS concept_ids, probe_outcome, probe_concept_id FROM learning_live_feedback_turns WHERE user_id=$1 AND turn_id=$2`, [userId, turnId]))[0]!

  beforeAll(async () => {
    db = new Client({ connectionString: url! })
    await db.connect()
    const handle = createDatabase(url!, { max: 2 })
    try {
      const now = new Date()
      userId = (await handle.kysely.insertInto('user').values({ id: randomUUID(), name: 'probe restart test', email, emailVerified: true, createdAt: now, updatedAt: now }).returning(['id']).executeTakeFirstOrThrow()).id
      apiKey = (await createAuth(handle.kysely, { secret, baseUrl: 'http://127.0.0.1', adminEmails: [email] }).api.createApiKey({ body: { userId, name: 'probe-restart-test' } })).key
    } finally { await handle.close() }
    // The decision statement of this user's turns waits for the advisory lock the test holds.
    await db.query(`CREATE OR REPLACE FUNCTION probe_restart_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(TG_ARGV[0]::bigint); RETURN NEW; END $$`)
    await db.query(`CREATE TRIGGER probe_restart_hold_${run} BEFORE UPDATE OF injected ON learning_live_feedback_turns FOR EACH ROW WHEN (NEW.user_id = '${userId}') EXECUTE FUNCTION probe_restart_hold(${hold})`)
  }, 120_000)
  afterAll(async () => {
    for (const child of children) { try { child.proc.kill('SIGKILL') } catch { /* gone */ } }
    await db.query(`DROP TRIGGER IF EXISTS probe_restart_hold_${run} ON learning_live_feedback_turns`)
    await db.query(`DELETE FROM learning_live_feedback_turns WHERE user_id=$1`, [userId])
    await db.query(`DELETE FROM "user" WHERE id=$1`, [userId])
    await db.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`)
    await db.end()
  }, 60_000)

  const probing = { blindProbes: true, probeRate: 100, probeHops: REVIEW_HOPS_ALL, injectionRate: 100 }
  let probedConcept: string | undefined
  /** A taught live concept whose turn gets a probe under `probing` (the candidates depend on the graph alone). */
  const conceptWithProbe = async (call: Awaited<ReturnType<typeof startApi>>['call']) => {
    for (const { id } of LIVE_CATALOG.filter((c) => !LIVE_HELD_OUT.has(c.id)).slice(0, 20)) {
      if (probedConcept) break
      const t = turn(id)
      await call('beginLearningFeedbackTurn', t.begin)
      await call('submitLearningTurnFeedback', t.submit)
      if ((await stored(t.submit.turnId)).probe_outcome === 'delivered') probedConcept = id
    }
    if (!probedConcept) throw new Error('no taught live concept got a probe')
    return probedConcept
  }

  test.each([['SIGKILL', 'committed'], ['SIGKILL', 'aborted'], ['SIGTERM', 'committed'], ['SIGTERM', 'aborted']] as const)('%s between the feedback write and the decision write (decision %s): the retry answers one stored decision', async (signal, fate) => {
    await savePolicy(probing)
    const first = await startApi()
    const t = turn(await conceptWithProbe(first.call))
    await first.call('beginLearningFeedbackTurn', t.begin)
    await db.query(`SELECT pg_advisory_lock($1)`, [hold])
    const lost = first.call('submitLearningTurnFeedback', t.submit).catch(() => null)
    const waiting = async () => (await rows<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND wait_event='advisory' AND query LIKE 'UPDATE learning_live_feedback_turns SET injected%'`))[0]?.pid
    await until(async () => Boolean(await waiting()), 30_000, 'the decision statement to wait on the lock', first.api)
    // Mid-step: the feedback is stored, the decision is not.
    expect(await rows(`SELECT 1 FROM learning_live_feedback_turns WHERE user_id=$1 AND turn_id=$2 AND feedback IS NOT NULL AND injected IS NULL`, [userId, t.submit.turnId])).toHaveLength(1)
    const pid = await waiting()
    const stopped = first.api.stop(signal)
    if (fate === 'committed') {
      if (signal === 'SIGKILL') await stopped // the process is dead while its statement still waits; released, it commits with no one to answer
      await db.query(`SELECT pg_advisory_unlock($1)`, [hold])
      await stopped
      await until(async () => (await stored(t.submit.turnId)).injected !== null, 30_000, 'the decision to commit')
      await savePolicy({ blindProbes: false, injectionRate: 0 }) // what a recomputation would now answer: no probe, no injection
    } else {
      await db.query(`SELECT pg_terminate_backend($1)`, [pid])
      await db.query(`SELECT pg_advisory_unlock($1)`, [hold])
      await stopped
      expect((await stored(t.submit.turnId)).injected).toBeNull()
    }
    await lost

    const second = await startApi()
    const replay = await second.call('submitLearningTurnFeedback', t.submit)
    const row = await stored(t.submit.turnId)
    expect(replay.replayed).toBe(true)
    expect(row).toMatchObject({ injected: true, probe_outcome: 'delivered' })
    expect(replay.guidance).toMatchObject({ decision: 'influence', context: row.context, conceptIds: row.concept_ids })
    expect(replay.guidance.context).toContain(`Blind probe: {"conceptId":${JSON.stringify(row.probe_concept_id)}`)
    // A further retry changes nothing.
    expect((await second.call('submitLearningTurnFeedback', t.submit)).guidance).toMatchObject({ context: row.context })
    expect(await stored(t.submit.turnId)).toEqual(row)
    await second.api.stop('SIGKILL')
  }, 300_000)
})
