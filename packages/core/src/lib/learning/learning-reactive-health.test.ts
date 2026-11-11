import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { UNPAID_FAILURE_MARKER as COORDINATOR_MARKER } from './learning-archive-coordinator.js'
import {
  REACTIVE_NO_READING_ERROR_HOURS, REACTIVE_NO_READING_MIN_SETTLED, REACTIVE_STALL_CHECK_WATCHDOG_MINUTES, REACTIVE_STALL_HOURS, REACTIVE_STUCK_UNPAID_FAILURES, STALL_CHECK_RECLAIM_IDLE_MS, UNPAID_FAILURE_MARKER,
  deriveReactiveGradingHealth, ensureStallCheckRun, readReactiveGradingAlerts, readReactiveGradingHealth, type ReactiveGradingHealthInput,
} from './learning-reactive-health.js'

const now = new Date('2026-11-11T12:00:00Z')
const hours = (h: number) => new Date(now.getTime() - h * 36e5)
const minutes = (m: number) => new Date(now.getTime() - m * 60_000)
type Routing = ReactiveGradingHealthInput['routing']
type Grading = ReactiveGradingHealthInput['grading']
const routing = (patch: Partial<Routing> = {}): Routing => ({ waiting: 0, oldestWaitingAt: null, lastRoutedAt: hours(300), held: 0, exhausted: 0, oldestExhaustedAt: null, ...patch })
const grading = (patch: Partial<Grading> = {}): Grading => ({ waiting: 0, oldestWaitingAt: null, running: 0, lastSettledAt: hours(300), settledInWindow: 0, lastReadingAt: hours(300),
  blocked: 0, blockedUnpaid: 0, oldestBlockedAt: null, retryingUnpaid: 0, oldestRetryingAt: null, unverifiedPasses: 0, ...patch })
const base = (patch: Partial<ReactiveGradingHealthInput> = {}): ReactiveGradingHealthInput => ({
  now, enabled: true, assessmentEnabled: true, routingError: null, routing: routing(), grading: grading(), ...patch,
})
const derive = (patch: Partial<ReactiveGradingHealthInput> = {}) => deriveReactiveGradingHealth(base(patch))

describe('reactive grading stall signal', () => {
  test('red when indexed arrivals have waited past the bound and no batch routed for as long (the 2026-10-30 stall)', () => {
    const health = derive({ routingError: 'Vector routing failed; pending arrivals retained.', routing: routing({ waiting: 4596, oldestWaitingAt: hours(281), lastRoutedAt: hours(280) }) })
    expect(health.status).toBe('error')
    expect(health.messages[0]).toStartWith('Routing stalled: 4596 indexed arrivals waiting since')
    expect(health.messages[0]).toContain('Vector routing failed')
  })
  test('red when concepts have waited past the bound and no pass settled for as long', () => {
    const health = derive({ grading: grading({ waiting: 1120, oldestWaitingAt: hours(200), lastSettledAt: hours(280), lastReadingAt: hours(280), blocked: 441, blockedUnpaid: 246, oldestBlockedAt: hours(280) }) })
    expect(health.status).toBe('error')
    expect(health.messages[0]).toStartWith('Grading stalled: 1120 concepts waiting')
    expect(health.messages[1]).toStartWith(`Grading stuck since ${hours(280).toISOString()} with no reading in ${REACTIVE_STALL_HOURS} h`)
    expect(health.messages[1]).toContain('246 concepts blocked before any paid call (run the reactive recovery); 195 concepts blocked after a paid call (review their paid receipts, then retryLearningReactiveTarget)')
  })
  test('the grading bound is exact: waiting one minute short of it is green, one minute past it is red', () => {
    const waitingFor = (m: number) => derive({ grading: grading({ waiting: 3, oldestWaitingAt: minutes(m), lastSettledAt: minutes(m), lastReadingAt: minutes(m) }) }).status
    expect(waitingFor(REACTIVE_STALL_HOURS * 60 - 1)).toBe('ok')
    expect(waitingFor(REACTIVE_STALL_HOURS * 60 + 1)).toBe('error')
  })
  test('green while work waits but the stage completed within the bound', () => {
    expect(derive({
      routing: routing({ waiting: 300, oldestWaitingAt: hours(10), lastRoutedAt: hours(1) }),
      grading: grading({ waiting: 40, oldestWaitingAt: hours(30), running: 4, lastSettledAt: hours(REACTIVE_STALL_HOURS - 1), settledInWindow: 9, lastReadingAt: hours(2) }),
    }).status).toBe('ok')
  })
  test('green when work arrived recently, even after a long quiet spell (not yet a stall)', () => {
    expect(derive({ routing: routing({ waiting: 5, oldestWaitingAt: hours(1), lastRoutedAt: hours(500) }) }).status).toBe('ok')
  })
  test('green when idle: nothing waiting, nothing completed for weeks', () => {
    const health = derive()
    expect(health.status).toBe('ok')
    expect(health.messages).toEqual([])
  })
  test('green when reactive grading is disabled, whatever is waiting; grading rules ignored when assessment is off', () => {
    const stalled = grading({ waiting: 9, oldestWaitingAt: hours(100), lastSettledAt: null, lastReadingAt: null, settledInWindow: 4 })
    expect(derive({ enabled: false, grading: stalled }).status).toBe('ok')
    expect(derive({ assessmentEnabled: false, grading: stalled }).status).toBe('ok')
  })

  // Review B1: the "needs an operator" states must fail the stall check, not only warn.
  test('cause C alone is red: every concept at the breaker for days, routing healthy, no reading since', () => {
    const health = derive({ routing: routing({ lastRoutedAt: minutes(5) }), grading: grading({ blocked: 441, blockedUnpaid: 246, oldestBlockedAt: hours(288), lastSettledAt: hours(288), lastReadingAt: hours(288) }) })
    expect(health.status).toBe('error')
    expect(health.messages).toHaveLength(1)
    expect(health.messages[0]).toStartWith('Grading stuck since')
  })
  test('exhausted arrivals alone are red once exhausted past the bound with no reading in that window', () => {
    const health = derive({ routing: routing({ lastRoutedAt: minutes(5), exhausted: 4710, oldestExhaustedAt: hours(200) }), grading: grading({ lastReadingAt: hours(200) }) })
    expect(health.status).toBe('error')
    expect(health.messages[0]).toContain('4710 arrivals exhausted their routing retries')
  })
  test('stuck items stay a warning while readings are still being produced within the bound', () => {
    const health = derive({ grading: grading({ blocked: 201, oldestBlockedAt: hours(200), lastSettledAt: minutes(1), lastReadingAt: hours(REACTIVE_STALL_HOURS - 1) }) })
    expect(health.status).toBe('warning')
    expect(health.messages).toEqual(['Needs an operator: 201 concepts blocked after a paid call (review their paid receipts, then retryLearningReactiveTarget).'])
  })
  test('stuck items younger than the bound stay a warning even with no recent reading', () => {
    expect(derive({ routing: routing({ exhausted: 2, oldestExhaustedAt: hours(REACTIVE_STALL_HOURS - 1) }) }).status).toBe('warning')
  })
  test('concepts failing before any paid call again and again are named, and red once stuck past the bound with no reading', () => {
    const retrying = (since: Date, reading: Date) => derive({ grading: grading({ waiting: 2, oldestWaitingAt: since, lastSettledAt: minutes(1), retryingUnpaid: 2, oldestRetryingAt: since, lastReadingAt: reading }) })
    expect(retrying(hours(1), hours(1)).messages[0]).toContain(`2 concepts failing before any paid call ${REACTIVE_STUCK_UNPAID_FAILURES}+ times in a row`)
    expect(retrying(hours(1), hours(1)).status).toBe('warning')
    expect(retrying(hours(30), hours(30)).status).toBe('error')
  })

  // Review S8: settling without producing readings is not healthy.
  test('passes settling with no reading: a warning past the stall bound, red past the no-reading bound', () => {
    const settling = (readingHours: number) => derive({ grading: grading({ waiting: 5, oldestWaitingAt: hours(1), lastSettledAt: minutes(6), settledInWindow: 40, lastReadingAt: hours(readingHours) }) })
    expect(settling(REACTIVE_STALL_HOURS - 1).status).toBe('ok')
    expect(settling(REACTIVE_STALL_HOURS + 1).status).toBe('warning')
    expect(settling(REACTIVE_NO_READING_ERROR_HOURS + 1).status).toBe('error')
    // A few passes with no new evidence publish nothing legitimately.
    expect(derive({ grading: grading({ waiting: 5, oldestWaitingAt: hours(1), lastSettledAt: minutes(6), settledInWindow: REACTIVE_NO_READING_MIN_SETTLED - 1, lastReadingAt: hours(72) }) }).status).toBe('ok')
    expect(settling(72).messages[0]).toStartWith(`40 concepts settled in the last ${REACTIVE_STALL_HOURS} h but no reading was produced`)
  })

  // Review S2: the check that nobody runs is itself an alarm.
  test('the API sees a dead stall check: nothing finished within the watchdog window is red', () => {
    const watch = (lastFinishedAt: Date | null) => derive({ stallCheck: { lastFinishedAt, lastStatus: 'completed' } })
    expect(watch(minutes(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES - 1)).status).toBe('ok')
    expect(watch(minutes(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES + 1)).status).toBe('error')
    expect(watch(null).messages[0]).toStartWith(`No reactive stall check has finished in ${REACTIVE_STALL_CHECK_WATCHDOG_MINUTES} min (last never)`)
    expect(derive({ stallCheck: null }).status).toBe('ok')
  })
  test('passes that graded without unverified chunks are reported', () => {
    expect(derive({ grading: grading({ unverifiedPasses: 3 }) }).messages).toEqual([`3 passes in the last ${REACTIVE_STALL_HOURS} h graded without some indexed chunks the bank holds no vector for (their unverified chunk ids are in the pass snapshot, counts.unverifiedChunkIds).`])
  })
  test('the unpaid marker the health check counts by is the one the coordinator writes', () => {
    expect(UNPAID_FAILURE_MARKER).toBe(COORDINATOR_MARKER)
  })
})

/** The reader's SQL against TEMP shadows (pg_temp first on the search path); no shared row is touched. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('reactive grading health reads the pipeline tables', () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  const q: MetaPgQueryFn = async (text, params) => { const r = await client.query(text, params ? [...params] : []); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }
  const user = `grading-health-${randomUUID()}`
  const clock = new Date()
  const ago = (h: number) => new Date(clock.getTime() - h * 36e5)
  const tables = ['learning_reactive_settings', 'learning_vector_arrivals', 'learning_reactive_routes', 'learning_reactive_route_holds', 'learning_reactive_admission',
    'learning_vector_turn_experiments', 'learner_workflow_runs', 'learner_workflow_steps']
  beforeAll(async () => {
    await client.connect()
    for (const table of tables) await q(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS)`)
    await q('CREATE TEMP TABLE learning_mastery_readings(user_id text,completed_at timestamptz)')
  })
  afterAll(async () => { await client.end() })
  beforeEach(async () => {
    await q(`TRUNCATE ${[...tables, 'learning_mastery_readings'].map(t => `pg_temp.${t}`).join(',')}`)
    await q(`INSERT INTO learning_reactive_settings(user_id,enabled,activated_at,config,revision) VALUES($1,true,$2,$3::jsonb,'rev-1')`,
      [user, ago(400), JSON.stringify({ enabled: true, assessmentEnabled: true })])
  })
  const admit = (session: string, notified: Date, { attempts = 0, failure = null, finished = null, waitingSince = null, failedAt = null, unpaid = 0 }:
    { attempts?: number; failure?: string | null; finished?: Date | null; waitingSince?: Date | null; failedAt?: Date | null; unpaid?: number } = {}) =>
    q(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_notified_at,last_failure,last_finished_at,waiting_since,last_failed_at,unpaid_failures)
      VALUES($1,$2,2,1,$3,$4,$5,$6,$7,$8,$9)`, [user, session, attempts, notified, failure, finished, waitingSince, failedAt, unpaid])
  const run = (status: string, created: Date, error: string | null = null, id = randomUUID()) =>
    q(`INSERT INTO learner_workflow_runs(workflow_run_id,workflow,status,input,error,created_at,updated_at) VALUES($1,'learningReactiveStallCheckWorkflow',$2,'{}',$3,$4,$4)`, [id, status, error, created]).then(() => id)

  test('idle owner reads green', async () => {
    await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at) VALUES($1,'m','rev-1','{}',$2,$3)`, [user, randomUUID(), ago(300)])
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.status).toBe('ok')
    expect(health.routing.waiting).toBe(0)
  })
  test('arrivals and concepts waiting past the bound with nothing completing read red; stuck blocked sessions are named', async () => {
    await q('INSERT INTO learning_vector_arrivals(message_id,created_at) VALUES($1,$2),($3,$4)', ['a', ago(7), 'b', ago(8)])
    await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at) VALUES($1,'m','rev-1','{}',$2,$3)`, [user, randomUUID(), ago(9)])
    await admit(randomUUID(), ago(7), { finished: ago(9) })
    await admit(randomUUID(), ago(8), { attempts: 3, failure: `Assessment workflow ended failed ${UNPAID_FAILURE_MARKER} (attempt 3 of 3)`, failedAt: ago(8) })
    await q('INSERT INTO learning_mastery_readings VALUES($1,$2)', [user, ago(9)])
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.status).toBe('error')
    expect(health.routing).toMatchObject({ waiting: 2, held: 0, exhausted: 0 })
    expect(health.grading).toMatchObject({ waiting: 1, blocked: 1, blockedUnpaid: 1, oldestBlockedAt: ago(8).toISOString(), lastReadingAt: ago(9).toISOString() })
    expect(health.messages.map(m => m.split(':')[0])).toEqual(['Routing stalled', 'Grading stalled', `Grading stuck since ${ago(8).toISOString().split(':')[0]}`])
  })
  test('the same backlog reads green once a batch routed and a pass settled within the bound', async () => {
    await q('INSERT INTO learning_vector_arrivals(message_id,created_at) VALUES($1,$2)', ['a', ago(7)])
    await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at) VALUES($1,'m','rev-1','{}',$2,$3)`, [user, randomUUID(), ago(1)])
    await admit(randomUUID(), ago(8), { finished: ago(2) })
    expect((await readReactiveGradingHealth(user, q, clock)).status).toBe('ok')
  })
  test('a concept the learner keeps touching ages from when it FIRST waited, not from its last arrival (review S7)', async () => {
    await admit(randomUUID(), ago(0.1), { waitingSince: ago(72), finished: ago(80) })
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.grading.oldestWaitingAt).toBe(ago(72).toISOString())
    expect(health.status).toBe('error')
    expect(health.messages[0]).toStartWith(`Grading stalled: 1 concepts waiting since ${ago(72).toISOString()}`)
  })
  test('a held arrival is not counted as waiting; an exhausted one warns, and is red once stuck past the bound with no reading', async () => {
    const event = (await q<{ event_id: string }>('INSERT INTO learning_vector_arrivals(message_id,created_at) VALUES($1,$2) RETURNING event_id', ['h', ago(30)])).rows[0]!.event_id
    await q(`INSERT INTO learning_reactive_route_holds(user_id,event_id,revision,message_id,reason,attempts,next_attempt_at,last_attempt_at) VALUES($1,$2,'rev-1','h','r',6,NULL,$3)`, [user, event, ago(20)])
    await q('INSERT INTO learning_mastery_readings VALUES($1,$2)', [user, ago(1)])
    const fresh = await readReactiveGradingHealth(user, q, clock)
    expect(fresh.routing).toMatchObject({ waiting: 0, held: 0, exhausted: 1, oldestExhaustedAt: ago(20).toISOString() })
    expect(fresh.status).toBe('warning')
    await q('TRUNCATE pg_temp.learning_mastery_readings')
    expect((await readReactiveGradingHealth(user, q, clock)).status).toBe('error')
  })
  test('settled passes in the window, repeatedly failing unpaid concepts and unverified passes are counted', async () => {
    await admit(randomUUID(), ago(1), { finished: ago(1) })
    await q('UPDATE pg_temp.learning_reactive_admission SET captured_generation=2')
    await admit(randomUUID(), ago(1), { waitingSince: ago(3), unpaid: REACTIVE_STUCK_UNPAID_FAILURES })
    await admit(randomUUID(), ago(1), { waitingSince: ago(2), unpaid: REACTIVE_STUCK_UNPAID_FAILURES - 1 })
    for (const unverified of [0, 2]) await q(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,config,created_at,unverified_chunks) VALUES($1,$2,'{"purpose":"live"}',$3,$4)`, [randomUUID(), user, ago(1), unverified])
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.grading).toMatchObject({ settledInWindow: 1, waiting: 2, retryingUnpaid: 1, oldestRetryingAt: ago(3).toISOString(), unverifiedPasses: 1 })
  })
  test('the API reads the stall check freshness; the check itself does not', async () => {
    await run('completed', ago(3))
    expect((await readReactiveGradingHealth(user, q, { now: clock, stallCheck: true })).messages[0]).toStartWith('No reactive stall check has finished')
    expect((await readReactiveGradingHealth(user, q, clock)).stallCheck).toBeNull()
    await run('failed', ago(0.2))
    expect((await readReactiveGradingHealth(user, q, { now: clock, stallCheck: true })).stallCheck).toEqual({ lastFinishedAt: ago(0.2).toISOString(), lastStatus: 'failed' })
  })

  // Review S2: delivery to the person, through the hook's begin packet.
  test('alerts: the owner sees their part of a failed stall check, and the watchdog when no check finished for an hour', async () => {
    const message = `Reactive grading stalled: ${user}: Grading stuck since X: 3 concepts. | someone-else: Routing stalled: 9.`
    await run('failed', ago(0.25), JSON.stringify({ message }))
    const alerts = await readReactiveGradingAlerts(user, true, q, clock)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toStartWith(`Reactive grading alarm (stall check at ${ago(0.25).toISOString()}): Grading stuck since X: 3 concepts.`)
    expect(alerts[0]).not.toContain('someone-else')
    await run('completed', ago(0.1))
    expect(await readReactiveGradingAlerts(user, true, q, clock)).toEqual([])
    const late = new Date(clock.getTime() + (REACTIVE_STALL_CHECK_WATCHDOG_MINUTES + 1) * 60_000)
    expect((await readReactiveGradingAlerts(user, true, q, late))[0]).toStartWith('Reactive grading is unmonitored')
    expect(await readReactiveGradingAlerts(user, false, q, late)).toEqual([])
    await q('UPDATE pg_temp.learning_reactive_settings SET enabled=false')
    expect(await readReactiveGradingAlerts(user, true, q, late)).toEqual([])
  })

  // Review S3: a lost run must not disable the check forever.
  test('the scheduler reclaims a stall-check run idle past the bound and starts a fresh one; a live one is left alone', async () => {
    const cancelled: string[] = [], started: string[] = []
    const start = async () => { const id = await run('running', clock); started.push(id); return id }
    const cancel = async (id: string) => { cancelled.push(id); await q("UPDATE pg_temp.learner_workflow_runs SET status='cancelled' WHERE workflow_run_id=$1", [id]) }
    const stuck = await run('running', new Date(clock.getTime() - STALL_CHECK_RECLAIM_IDLE_MS - 60_000))
    const first = await ensureStallCheckRun(start, cancel, q, clock)
    expect(first).toEqual({ started: started[0]!, live: null, reclaimed: [stuck] })
    expect(cancelled).toEqual([stuck])
    const second = await ensureStallCheckRun(start, cancel, q, clock)
    expect(second).toEqual({ started: null, live: started[0]!, reclaimed: [] })
    // A step touched recently keeps an old run live.
    await q("UPDATE pg_temp.learner_workflow_runs SET updated_at=$1 WHERE workflow_run_id=$2", [new Date(clock.getTime() - STALL_CHECK_RECLAIM_IDLE_MS - 60_000), started[0]])
    await q(`INSERT INTO learner_workflow_steps(workflow_run_id,step_name,status,updated_at) VALUES($1,'s','running',$2)`, [started[0], clock])
    expect((await ensureStallCheckRun(start, cancel, q, clock)).live).toBe(started[0]!)
  })
})
