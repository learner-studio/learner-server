import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { UNPAID_FAILURE_MARKER as COORDINATOR_MARKER } from './learning-archive-coordinator.js'
import {
  REACTIVE_NO_READING_ERROR_HOURS, REACTIVE_NO_READING_MIN_SETTLED, REACTIVE_STALL_CHECK_WATCHDOG_MINUTES, REACTIVE_STALL_HOURS, REACTIVE_STUCK_UNPAID_FAILURES, STALL_CHECK_RECLAIM_IDLE_MS, UNPAID_FAILURE_MARKER,
  REACTIVE_ACTIVE_GAP_MINUTES, REACTIVE_BACKSTOP_RETURN_HOURS, REACTIVE_MEASURE_STEP, REACTIVE_OPERATOR_REMINDER_DAYS, REACTIVE_UNSERVED_BACKSTOP_HOURS, STALL_VERDICT_PREFIX, deriveReactiveGradingHealth, ensureStallCheckRun, readReactiveGradingAlerts, readReactiveGradingHealth, readStallCheckState, readUnservedArrivals, withGradingAlerts,
  type ReactiveGradingHealthInput,
} from './learning-reactive-health.js'
import { releaseUnpaidReactiveSessions } from './learning-reactive-recovery.js'
import { UPSERT_REACTIVE_SETTINGS } from './learning-reactive-consolidation.js'

const now = new Date('2026-11-11T12:00:00Z')
/** Bun's toMatchObject passes for ANY two Dates (no enumerable keys), so a Date field is compared as its ISO string. */
const iso = <T extends { lastFinishedAt: Date | null }>(state: T) => ({ ...state, lastFinishedAt: state.lastFinishedAt?.toISOString() ?? null })
const hours = (h: number) => new Date(now.getTime() - h * 36e5)
const minutes = (m: number) => new Date(now.getTime() - m * 60_000)
type Routing = ReactiveGradingHealthInput['routing']
type Grading = ReactiveGradingHealthInput['grading']
const routing = (patch: Partial<Routing> = {}): Routing => ({ waiting: 0, oldestWaitingAt: null, lastRoutedAt: hours(300), held: 0, exhausted: 0, oldestExhaustedAt: null, unservedSince: null, unservedActiveMinutes: 0, stuckUnservedSince: null, stuckReturnedAt: null, ...patch })
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
    // Waiting work is not evidence for the stuck rule (only learner arrivals are), so the stuck items stay a warning here.
    expect(health.messages[1]).toStartWith('Needs an operator: ')
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

  // Review B1 / round-3 R3-B1: stuck items are red once learner arrivals after they got stuck went the bound of active time unserved.
  const active = (since: Date, minutesActive: number): Partial<Routing> => ({ lastRoutedAt: minutes(5), unservedSince: since, unservedActiveMinutes: minutesActive })
  test('cause C alone is red: every concept at the breaker for days, routing healthy, arrivals unserved for the bound of active time', () => {
    const health = derive({ routing: routing(active(hours(72), 420)), grading: grading({ blocked: 441, blockedUnpaid: 246, oldestBlockedAt: hours(288), lastSettledAt: hours(288), lastReadingAt: hours(288) }) })
    expect(health.status).toBe('error')
    expect(health.messages).toHaveLength(1)
    expect(health.messages[0]).toStartWith(`Grading stuck since ${hours(288).toISOString()}: due arrivals since ${hours(72).toISOString()} (72 h ago) unserved for 7 h of active time (last reading ${hours(288).toISOString()}, last settled pass ${hours(288).toISOString()})`)
  })
  test('exhausted arrivals alone are red on the same evidence', () => {
    const health = derive({ routing: routing({ ...active(hours(30), 400), exhausted: 4710, oldestExhaustedAt: hours(200) }), grading: grading({ lastReadingAt: hours(200) }) })
    expect(health.status).toBe('error')
    expect(health.messages[0]).toContain('4710 arrivals exhausted their routing retries')
  })
  test('the active-time bound is exact: one minute short of it is a warning, at it is red', () => {
    const blocked = (m: number) => derive({ routing: routing(active(hours(40), m)), grading: grading({ blocked: 216, oldestBlockedAt: hours(360), lastReadingAt: hours(40) }) }).status
    expect(blocked(REACTIVE_STALL_HOURS * 60 - 1)).toBe('warning')
    expect(blocked(REACTIVE_STALL_HOURS * 60)).toBe('error')
  })
  test('short of the active bound, the backstop decides on the stuck items\' own work: 48 h old AND the learner came back to more of it 12 h later (round-4 S4, round-5 B1)', () => {
    const light = (since: Date | null, returned: Date | null) => derive({ routing: routing({ ...active(since ?? hours(1), 120), stuckUnservedSince: since, stuckReturnedAt: returned }),
      grading: grading({ blocked: 216, oldestBlockedAt: hours(360), lastReadingAt: hours(72) }) }).status
    expect({ REACTIVE_UNSERVED_BACKSTOP_HOURS, REACTIVE_BACKSTOP_RETURN_HOURS }).toEqual({ REACTIVE_UNSERVED_BACKSTOP_HOURS: 48, REACTIVE_BACKSTOP_RETURN_HOURS: 12 })
    expect(light(minutes(48 * 60 - 1), hours(24))).toBe('warning')
    expect(light(hours(48), hours(24))).toBe('error')
    // The came-back bound is exact: 12 h after the oldest is red, 1 min short of it a warning.
    expect(light(hours(48), hours(36))).toBe('error')
    expect(light(hours(48), new Date(hours(36).getTime() - 60_000))).toBe('warning')
    // Not come back (the tail of one session, then away): a warning however old.
    expect(light(hours(200), null)).toBe('warning')
    // Only due arrivals that are not the stuck items' work (matched to healthy concepts, the pass published nothing): a warning.
    expect(light(null, null)).toBe('warning')
    expect(derive({ routing: routing({ ...active(hours(200), 120), stuckUnservedSince: hours(200), stuckReturnedAt: hours(100) }), grading: grading({ blocked: 216, oldestBlockedAt: hours(360) }) }).messages[0])
      .toContain(`unserved for 2 h of active time, the stuck items' own arrivals unserved since ${hours(200).toISOString()}`)
    // No unserved due arrival at all is no evidence, however old the stuck items (an idle learner).
    expect(derive({ routing: routing({ lastRoutedAt: hours(100) }), grading: grading({ blocked: 216, oldestBlockedAt: hours(360), lastReadingAt: hours(100) }) }).status).toBe('warning')
  })
  test('D1. assessment off: blocked and retrying concepts are left-overs that never go red; exhausted holds still can, served by routing (round-4 S2)', () => {
    const off = (patch: Partial<Routing>, gradingPatch: Partial<Grading> = {}) => derive({ assessmentEnabled: false, routing: routing(patch), grading: grading(gradingPatch) })
    const leftOvers = { blocked: 3, oldestBlockedAt: hours(30), retryingUnpaid: 1, oldestRetryingAt: hours(30) }
    expect(off(active(hours(10), 400), leftOvers).status).toBe('warning')
    expect(off(active(hours(100), 400), leftOvers).status).toBe('warning')
    const exhausted = off({ ...active(hours(10), 400), exhausted: 2, oldestExhaustedAt: hours(20) }, leftOvers)
    expect(exhausted.status).toBe('error')
    expect(exhausted.messages[0]).toContain(`(assessment off, last route ${minutes(5).toISOString()})`)
  })
  test('no unserved arrival is no evidence, whatever the minutes say; nothing stuck is no alarm, whatever the arrivals', () => {
    expect(derive({ routing: routing({ unservedSince: null, unservedActiveMinutes: 9999 }), grading: grading({ blocked: 216, oldestBlockedAt: hours(360) }) }).status).toBe('warning')
    expect(derive({ routing: routing(active(hours(72), 9999)) }).status).toBe('ok')
  })
  test('blocked for days, nothing waiting, no reading for 7 h → not error (a quiet night, round-2 N-B1)', () => {
    const night = derive({ routing: routing({ lastRoutedAt: hours(7) }), grading: grading({ blocked: 216, oldestBlockedAt: hours(15 * 24), lastSettledAt: hours(7), lastReadingAt: hours(7) }) })
    expect(night.status).toBe('warning')
    expect(night.messages).toEqual(['Needs an operator: 216 concepts blocked after a paid call (review their paid receipts, then retryLearningReactiveTarget).'])
  })
  test('waiting work is not evidence for the stuck rule (only arrivals are): routing or grading work waiting past the bound with stuck items stays a warning', () => {
    const stuck = { blocked: 216, oldestBlockedAt: hours(360), lastReadingAt: hours(7) }
    expect(derive({ routing: routing({ waiting: 3, oldestWaitingAt: hours(8), lastRoutedAt: hours(1) }), grading: grading(stuck) }).status).toBe('warning')
    expect(derive({ routing: routing({ lastRoutedAt: hours(1) }), grading: grading({ ...stuck, waiting: 2, oldestWaitingAt: hours(8), lastSettledAt: hours(1) }) }).status).toBe('warning')
  })
  test('concepts failing before any paid call again and again are named, and red only on the arrival evidence', () => {
    const retrying = (patch: Partial<Routing>) => derive({ routing: routing(patch), grading: grading({ lastSettledAt: minutes(1), retryingUnpaid: 2, oldestRetryingAt: hours(30), lastReadingAt: hours(30) }) })
    expect(retrying({}).messages[0]).toContain(`2 concepts failing before any paid call ${REACTIVE_STUCK_UNPAID_FAILURES}+ times in a row`)
    expect(retrying({}).status).toBe('warning')
    expect(retrying(active(hours(29), 380)).status).toBe('error')
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
  test('the no-reading boundaries are literal: 5 settled passes count and 4 do not; 24 h is the error bound', () => {
    const settled = (n: number, readingHours: number) => derive({ grading: grading({ waiting: 5, oldestWaitingAt: hours(1), lastSettledAt: minutes(6), settledInWindow: n, lastReadingAt: hours(readingHours) }) }).status
    expect(settled(4, 72)).toBe('ok')
    expect(settled(5, 72)).toBe('error')
    expect(settled(5, 23.5)).toBe('warning')
    expect(settled(5, 24.5)).toBe('error')
    expect({ REACTIVE_NO_READING_MIN_SETTLED, REACTIVE_NO_READING_ERROR_HOURS }).toEqual({ REACTIVE_NO_READING_MIN_SETTLED: 5, REACTIVE_NO_READING_ERROR_HOURS: 24 })
  })

  // Review S2: the check that nobody runs is itself an alarm.
  test('the API sees a dead stall check: nothing finished within the watchdog window is red', () => {
    const watch = (lastFinishedAt: Date | null) => derive({ stallCheck: { lastFinishedAt, lastStatus: 'completed' } })
    expect(watch(minutes(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES - 1)).status).toBe('ok')
    expect(watch(minutes(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES + 1)).status).toBe('error')
    expect(watch(null).messages[0]).toStartWith(`No reactive stall check has finished in ${REACTIVE_STALL_CHECK_WATCHDOG_MINUTES} min (last never)`)
    expect(derive({ stallCheck: null }).status).toBe('ok')
    // Measured from the later of the last verdict and the alarm's activation: a fresh install is not "unmonitored" (R3-N1).
    expect(derive({ stallCheck: { lastFinishedAt: null, lastStatus: null, activatedAt: minutes(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES - 1) } }).status).toBe('ok')
    expect(derive({ stallCheck: { lastFinishedAt: null, lastStatus: null, activatedAt: minutes(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES + 1) } }).status).toBe('error')
    expect(derive({ stallCheck: { lastFinishedAt: minutes(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES + 1), lastStatus: 'completed', activatedAt: minutes(5) } }).status).toBe('ok')
  })
  test('a stall check that crashes is itself red, even when an earlier verdict is fresh (round-2 N-S1)', () => {
    const health = derive({ stallCheck: { lastFinishedAt: minutes(20), lastStatus: 'failed', failing: 'column "waiting_since" does not exist' } })
    expect(health.status).toBe('error')
    expect(health.messages).toEqual(['The reactive stall check itself is failing: column "waiting_since" does not exist'])
  })
  test('passes that graded without unverified chunks are reported', () => {
    expect(derive({ grading: grading({ unverifiedPasses: 3 }) }).messages).toEqual([`3 passes in the last ${REACTIVE_STALL_HOURS} h graded without some indexed chunks the bank holds no vector for (their unverified chunk ids are in the pass snapshot, counts.unverifiedChunkIds).`])
  })
  test('the reminder reads the step the stall-check workflow actually names', async () => {
    const wiring = await Bun.file(new URL('../../../../server/src/wirings/learning-reactive-health.workflow.ts', import.meta.url)).text()
    expect(wiring).toContain(`workflow.do('${REACTIVE_MEASURE_STEP}', 'measureLearningReactiveHealthStep'`)
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
  const bounds = (stuckSince: Date | null, lastServed: Date | null) => ({ stuckSince, lastServed, revision: 'rev-1', assessmentEnabled: true })
  const active = ({ unservedSince, unservedActiveMinutes }: { unservedSince: Date | null; unservedActiveMinutes: number }) => ({ unservedSince, unservedActiveMinutes })
  const tables = ['learning_reactive_settings', 'learning_vector_arrivals', 'learning_reactive_routes', 'learning_reactive_route_holds', 'learning_reactive_admission', 'learning_reactive_targets',
    'learning_vector_turn_experiments', 'learner_workflow_runs', 'learner_workflow_steps']
  beforeAll(async () => {
    await client.connect()
    for (const table of tables) await q(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS)`)
    await q("CREATE TEMP TABLE learning_mastery_readings(user_id text,completed_at timestamptz,origin text DEFAULT 'reactive')")
    // configureReactive's upsert needs the owner key (round-5 S1 test).
    await q('CREATE UNIQUE INDEX ON pg_temp.learning_reactive_settings(user_id)')
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
  /** A finished stall check whose measure step recorded this owner's health as it reads now (what the reminder reads). */
  const measure = async (at = ago(0.1), status = 'succeeded') => {
    const health = await readReactiveGradingHealth(user, q, clock)
    const id = await run('completed', at)
    await q(`INSERT INTO learner_workflow_steps(workflow_run_id,step_name,status,result) VALUES($1,$2,$3,$4)`, [id, REACTIVE_MEASURE_STEP, status, JSON.stringify({ owners: [{ userId: user, ...health }] })])
  }
  /**
   * A learner session: one arrival every `every` min (default 10) from `fromH` to `toH` hours ago, routed as it
   * arrives unless `routed` is false, to `concept` (default concept-1, the concept `blocked` holds) unless `matched` is false.
   */
  const session = async (fromH: number, toH: number, { routed = true, matched = true, every = 10, concept = 'concept-1', revision = 'rev-1' } = {}) => {
    const tag = randomUUID()
    await q(`INSERT INTO learning_vector_arrivals(message_id,created_at) SELECT $3||'-'||g,$1::timestamptz+g*$4*interval '1 minute'
      FROM generate_series(0,floor(extract(epoch FROM $2::timestamptz-$1::timestamptz)/($4*60))::int) g`, [ago(fromH), ago(toH), tag, every])
    if (routed) await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at)
      SELECT $1,message_id,$4,$3::jsonb,event_id,created_at FROM learning_vector_arrivals WHERE message_id LIKE $2||'-%'`,
      [user, tag, JSON.stringify({ embeddingRevision: 'e', conceptIds: matched ? [concept] : [] }), revision])
  }

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
    // One unserved arrival after the block is 30 min of activity, not 6 h: the stuck concept is a warning.
    expect(health.messages.map(m => m.split(':')[0])).toEqual(['Routing stalled', 'Grading stalled', 'Needs an operator'])
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
    // No reading for 30 h but the learner was idle: still a warning (round-2 N-B1).
    expect((await readReactiveGradingHealth(user, q, clock)).status).toBe('warning')
    // Three isolated arrivals are 90 min of activity: still a warning. A 9 h session is red.
    for (const h of [10, 5, 1]) await session(h, h)
    expect((await readReactiveGradingHealth(user, q, clock)).status).toBe('warning')
    await session(10, 1)
    expect((await readReactiveGradingHealth(user, q, clock)).status).toBe('error')
  })
  test('settled passes in the window, repeatedly failing unpaid concepts and unverified passes are counted', async () => {
    await admit(randomUUID(), ago(1), { finished: ago(1) })
    await q('UPDATE pg_temp.learning_reactive_admission SET captured_generation=2')
    await admit(randomUUID(), ago(1), { waitingSince: ago(3), unpaid: REACTIVE_STUCK_UNPAID_FAILURES })
    await admit(randomUUID(), ago(1), { waitingSince: ago(2), unpaid: REACTIVE_STUCK_UNPAID_FAILURES - 1 })
    for (const unverified of [0, 2]) await q(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,config,created_at,unverified_chunks) VALUES($1,$2,'{"purpose":"live"}',$3,$4)`, [randomUUID(), user, ago(1), unverified])
    const health = await readReactiveGradingHealth(user, q, clock)
    // The retrying concept is stuck, not waiting work (R3-S1); the one short of the threshold still waits.
    expect(health.grading).toMatchObject({ settledInWindow: 1, waiting: 1, oldestWaitingAt: ago(2).toISOString(), retryingUnpaid: 1, oldestRetryingAt: ago(3).toISOString(), unverifiedPasses: 1 })
  })
  test('the API reads the stall check freshness; the check itself does not', async () => {
    await run('completed', ago(3))
    expect((await readReactiveGradingHealth(user, q, { now: clock, stallCheck: true })).messages[0]).toStartWith('No reactive stall check has finished')
    expect((await readReactiveGradingHealth(user, q, clock)).stallCheck).toBeNull()
    await run('failed', ago(0.2), JSON.stringify({ message: `${STALL_VERDICT_PREFIX}${user}: Grading stalled.` }))
    expect((await readReactiveGradingHealth(user, q, { now: clock, stallCheck: true })).stallCheck).toEqual({ lastFinishedAt: ago(0.2).toISOString(), lastStatus: 'failed', failing: null })
  })
  test('a crashed stall-check run is not a finished check: the watchdog keeps the last verdict and the crash is named (round-2 N-S1)', async () => {
    await run('completed', ago(2))
    await run('failed', ago(0.1), JSON.stringify({ message: 'column "waiting_since" does not exist' }))
    expect(iso(await readStallCheckState(q))).toMatchObject({ lastFinishedAt: ago(2).toISOString(), lastStatus: 'failed', failing: 'column "waiting_since" does not exist' })
    const health = await readReactiveGradingHealth(user, q, { now: clock, stallCheck: true })
    expect(health.status).toBe('error')
    expect(health.messages).toHaveLength(2)
    expect(health.messages[0]).toBe('The reactive stall check itself is failing: column "waiting_since" does not exist')
    expect(health.messages[1]).toStartWith(`No reactive stall check has finished in ${REACTIVE_STALL_CHECK_WATCHDOG_MINUTES} min (last ${ago(2).toISOString()})`)
  })
  test('unserved arrivals: only those after both the stuck item and the last service count; gaps add up to the cap (R3-B1)', async () => {
    const read = async (stuck: Date | null, served: Date | null) => active(await readUnservedArrivals(user, bounds(stuck, served), q, clock))
    expect(await read(ago(50), null)).toEqual({ unservedSince: null, unservedActiveMinutes: 0 })
    await session(40, 39)      // 7 arrivals: 60 min of gaps
    await session(20, 20)      // one arrival, 19 h later: counts one cap
    await session(2, 1)        // 7 arrivals, 18 h later: one cap plus 60 min; 1 h idle since counts one cap
    // 30 min: on dev 99.6% of the 52,292 gaps between arrivals in 60 days are 30 min or less; a longer one is a break.
    const cap = REACTIVE_ACTIVE_GAP_MINUTES
    expect(cap).toBe(30)
    expect(await read(ago(50), null)).toEqual({ unservedSince: ago(40), unservedActiveMinutes: 60 + cap + cap + 60 + cap })
    // The later of stuck and served bounds it, and an arrival exactly at the bound was served.
    expect(await read(ago(50), ago(20))).toEqual({ unservedSince: ago(2), unservedActiveMinutes: 60 + cap })
    expect(await read(ago(20), ago(50))).toEqual({ unservedSince: ago(2), unservedActiveMinutes: 60 + cap })
    expect(await read(null, ago(50))).toEqual({ unservedSince: null, unservedActiveMinutes: 0 })
    // The tail since the last arrival is real time while it is short.
    expect(active(await readUnservedArrivals(user, bounds(ago(3), null), q, new Date(ago(1).getTime() + 5 * 60_000)))).toEqual({ unservedSince: ago(2), unservedActiveMinutes: 65 })
  })
  test('due arrivals only: one that matched no concept is not due, whoever wrote it; a matched one, or one unrouted under the current revision, is (round-4 S1, round-5 B1, nit N3)', async () => {
    const read = async () => (await readUnservedArrivals(user, bounds(ago(50), null), q, clock)).unservedSince
    await session(12, 0, { matched: false, every: 60 })
    expect(await read()).toBeNull()
    // Another owner's route WITH concepts does not make them due for this owner.
    await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at)
      SELECT 'someone-else',message_id,'rev-1','{"conceptIds":["theirs"]}',event_id,created_at FROM learning_vector_arrivals`)
    expect(await read()).toBeNull()
    await session(4, 4)
    expect(await read()).toEqual(ago(4))
    await session(5, 5, { routed: false })
    expect(await read()).toEqual(ago(5))
    // Routed under an old revision only (matching nothing then) is unrouted now, as the waiting count reads it (round-5 nit N3).
    await session(6, 6, { matched: false, revision: 'rev-0' })
    expect(await read()).toEqual(ago(6))
    // Another owner's route with concepts does not make an arrival due for this one; its absence of a route for this owner does.
    await q(`UPDATE pg_temp.learning_reactive_routes SET user_id='someone-else' WHERE matches->'conceptIds'='[]'::jsonb AND routed_at=$1`, [ago(12)])
    expect(await read()).toEqual(ago(12))
  })
  test('the backstop pair: the oldest unserved arrival that is the stuck items\' own work, and the newest such one at least 6 h old (round-5 B1)', async () => {
    const [stuck, healthy, failing] = [randomUUID(), randomUUID(), randomUUID()]
    await q(`INSERT INTO learning_reactive_targets(user_id,session_id,concept_id) VALUES($1,$2,'concept-stuck'),($1,$3,'concept-ok'),($1,$4,'concept-retrying')`, [user, stuck, healthy, failing])
    await admit(stuck, ago(80), { attempts: 3, failedAt: ago(80) })
    await admit(healthy, ago(60), { waitingSince: ago(60) })
    await admit(failing, ago(80), { waitingSince: ago(80), unpaid: REACTIVE_STUCK_UNPAID_FAILURES })
    await session(60, 60, { concept: 'concept-ok' })
    await session(50, 50, { concept: 'concept-stuck' })
    await session(30, 30, { concept: 'concept-retrying' })
    await session(5, 5, { routed: false })
    const pair = (r: Awaited<ReturnType<typeof readUnservedArrivals>>) => ({ unservedSince: r.unservedSince, stuckUnservedSince: r.stuckUnservedSince, stuckReturnedAt: r.stuckReturnedAt })
    // The healthy concept's arrival is due but not the stuck items' work; the unrouted one 5 h ago is too young to be the return.
    expect(pair(await readUnservedArrivals(user, bounds(ago(70), null), q, clock))).toEqual({ unservedSince: ago(60), stuckUnservedSince: ago(50), stuckReturnedAt: ago(30) })
    expect((await readUnservedArrivals(user, bounds(ago(70), null), q, new Date(clock.getTime() + 3600_000))).stuckReturnedAt).toEqual(ago(5))
    // With assessment off only unrouted or held arrivals are the stuck items' work.
    expect(pair(await readUnservedArrivals(user, { ...bounds(ago(70), null), assessmentEnabled: false }, q, clock))).toEqual({ unservedSince: ago(60), stuckUnservedSince: ago(5), stuckReturnedAt: null })
    // A concept that settled is no longer stuck, nor one whose failures are below the threshold.
    await q('UPDATE pg_temp.learning_reactive_admission SET captured_generation=2 WHERE session_id=$1', [stuck])
    expect((await readUnservedArrivals(user, bounds(ago(70), null), q, clock)).stuckUnservedSince).toEqual(ago(30))
    await q('UPDATE pg_temp.learning_reactive_admission SET unpaid_failures=$2 WHERE session_id=$1', [failing, REACTIVE_STUCK_UNPAID_FAILURES - 1])
    expect((await readUnservedArrivals(user, bounds(ago(70), null), q, clock)).stuckUnservedSince).toEqual(ago(5))
  })
  test('switching Learning or assessment on stamps when; saving it unchanged, or switching it off, keeps the stamp (round-5 S1)', async () => {
    const owner = `switch-${randomUUID()}`
    const save = (enabled: boolean, assessmentEnabled: boolean) => q(UPSERT_REACTIVE_SETTINGS, [owner, enabled, JSON.stringify({ enabled, assessmentEnabled }), 'rev-1'])
    const stamp = async () => (await q<{ at: string | null; now: Date }>(`SELECT config->>'switchedOnAt' AS at,now() FROM learning_reactive_settings WHERE user_id=$1`, [owner])).rows[0]!
    const backdate = () => q(`UPDATE pg_temp.learning_reactive_settings SET config=jsonb_set(config,'{switchedOnAt}',to_jsonb('2026-01-01T00:00:00+00'::timestamptz)) WHERE user_id=$1`, [owner])
    const old = new Date('2026-01-01T00:00:00Z').getTime()
    await save(true, false)
    expect(new Date((await stamp()).at!).getTime()).toBeGreaterThan(old)
    await backdate()
    await save(true, false)
    await save(true, false)
    expect(new Date((await stamp()).at!).getTime()).toBe(old)
    await save(true, true)
    expect(new Date((await stamp()).at!).getTime()).toBeGreaterThan(old)
    await backdate()
    await save(true, false)
    expect(new Date((await stamp()).at!).getTime()).toBe(old)
    await save(false, false)
    await save(false, true)
    expect(new Date((await stamp()).at!).getTime()).toBeGreaterThan(old)
    await backdate()
    await save(true, true)
    expect(new Date((await stamp()).at!).getTime()).toBeGreaterThan(old)
    // A row from before the stamp keeps activated_at until it is next switched on.
    await q(`UPDATE pg_temp.learning_reactive_settings SET config=config-'switchedOnAt',activated_at='2025-06-01T00:00:00Z' WHERE user_id=$1`, [owner])
    await save(true, true)
    expect(new Date((await stamp()).at!).toISOString()).toBe('2025-06-01T00:00:00.000Z')
  })
  test('arrivals stamped ahead of the clock count their gaps but no negative tail (round-4 N3)', async () => {
    await session(1, -1 / 3)
    expect(active(await readUnservedArrivals(user, bounds(ago(2), null), q, clock))).toEqual({ unservedSince: ago(1), unservedActiveMinutes: 80 })
  })
  test('several stuck items of a kind age from the OLDEST one (round-4 N1)', async () => {
    for (const h of [5, 20]) await admit(randomUUID(), ago(h), { waitingSince: ago(h), unpaid: REACTIVE_STUCK_UNPAID_FAILURES })
    for (const h of [2, 30]) await q(`INSERT INTO learning_reactive_route_holds(user_id,event_id,revision,message_id,reason,attempts,next_attempt_at,last_attempt_at) VALUES($1,$2,'rev-1','h','r',6,NULL,$3)`, [user, randomUUID(), ago(h)])
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.grading).toMatchObject({ retryingUnpaid: 2, oldestRetryingAt: ago(20).toISOString() })
    expect(health.routing).toMatchObject({ exhausted: 2, oldestExhaustedAt: ago(30).toISOString() })
  })
  test('the reader feeds the unserved arrivals of the stuck items to the rule, served by the last reading or the activation', async () => {
    await admit(randomUUID(), ago(1), { attempts: 3, failedAt: ago(30) })
    await session(9, 0)
    const red = await readReactiveGradingHealth(user, q, clock)
    expect(red.routing).toMatchObject({ unservedSince: ago(9).toISOString(), unservedActiveMinutes: 9 * 60 })
    expect(red.status).toBe('error')
    await q('INSERT INTO learning_mastery_readings VALUES($1,$2)', [user, ago(2)])
    expect((await readReactiveGradingHealth(user, q, clock)).routing).toMatchObject({ unservedSince: new Date(ago(2).getTime() + 600_000).toISOString(), unservedActiveMinutes: 110 })
    await q('UPDATE pg_temp.learning_reactive_settings SET activated_at=$1', [ago(1)])
    expect((await readReactiveGradingHealth(user, q, clock)).routing.unservedSince).toBe(new Date(ago(1).getTime() + 600_000).toISOString())
  })
  test('a blocked concept ages from its block, or from when it first waited, never from its latest arrival (round-2 H13)', async () => {
    await admit(randomUUID(), ago(0.1), { attempts: 3, failedAt: ago(30), waitingSince: ago(50) })
    await admit(randomUUID(), ago(0.1), { attempts: 3, waitingSince: ago(40) })
    expect((await readReactiveGradingHealth(user, q, clock)).grading.oldestBlockedAt).toBe(ago(40).toISOString())
    await q('DELETE FROM pg_temp.learning_reactive_admission WHERE last_failed_at IS NULL')
    expect((await readReactiveGradingHealth(user, q, clock)).grading.oldestBlockedAt).toBe(ago(30).toISOString())
  })

  // Review S2: delivery to the person, through the hook's begin packet.
  test('alerts: the owner sees their part of a failed stall check, and the watchdog when no check finished for an hour', async () => {
    const message = `Reactive grading stalled: ${user}: Grading stuck since X: 3 concepts. | ${user}: Last routing error: a | b. | someone-else: Routing stalled: 9.`
    await q(`INSERT INTO learning_reactive_settings(user_id,enabled,activated_at,config,revision) VALUES('someone-else',true,$1,'{}','rev-1')`, [ago(400)])
    await run('failed', ago(0.5), JSON.stringify({ message }))
    await run('failed', ago(0.25), JSON.stringify({ message }))
    const red = await readReactiveGradingAlerts(user, true, q, clock)
    expect(red.alerts).toHaveLength(1)
    expect(red.alerts[0]).toStartWith(`Reactive grading alarm (stall check at ${ago(0.25).toISOString()}, red since ${ago(0.5).toISOString()}): Grading stuck since X: 3 concepts. Last routing error: a | b.`)
    expect(red.alerts[0]).not.toContain('someone-else')
    // The key names the state and when it began, so it is stable across the runs of one alarm (round-2 N-S3).
    expect(red.key).toBe(`alarm:${ago(0.5).toISOString()}`)
    await run('completed', ago(0.1))
    expect(await readReactiveGradingAlerts(user, true, q, clock)).toEqual({ alerts: [], key: null })
    const late = new Date(clock.getTime() + (REACTIVE_STALL_CHECK_WATCHDOG_MINUTES + 1) * 60_000)
    const unmonitored = await readReactiveGradingAlerts(user, true, q, late)
    expect(unmonitored.alerts[0]).toStartWith('Reactive grading is unmonitored')
    expect(unmonitored.key).toBe(`unmonitored:${ago(0.1).toISOString()}`)
    expect(await readReactiveGradingAlerts(user, false, q, late)).toEqual({ alerts: [], key: null })
    await q('UPDATE pg_temp.learning_reactive_settings SET enabled=false')
    expect(await readReactiveGradingAlerts(user, true, q, late)).toEqual({ alerts: [], key: null })
  })
  test('alerts: a stall check that crashes without a verdict alerts every owner, keyed by when it began failing (round-2 N-S1)', async () => {
    await run('completed', ago(0.75))
    await run('failed', ago(0.5), JSON.stringify({ message: 'connection terminated due to statement timeout' }))
    await run('failed', ago(0.25), JSON.stringify({ message: 'column "waiting_since" does not exist' }))
    const crashing = await readReactiveGradingAlerts(user, true, q, clock)
    expect(crashing.alerts).toHaveLength(1)
    expect(crashing.alerts[0]).toStartWith(`Reactive grading stall check is failing (last run at ${ago(0.25).toISOString()}, failing since ${ago(0.5).toISOString()}): column "waiting_since" does not exist`)
    expect(crashing.key).toBe(`failing:${ago(0.5).toISOString()}`)
    // An hour on, with no verdict since, the watchdog joins it: the completed run is the last finished check.
    const late = new Date(clock.getTime() + REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000)
    expect((await readReactiveGradingAlerts(user, true, q, late)).key).toBe(`failing:${ago(0.5).toISOString()}|unmonitored:${ago(0.75).toISOString()}`)
  })
  test('alerts: a completed check ends an episode, so the next stall is a new key (R3-S2, M10)', async () => {
    const message = `${STALL_VERDICT_PREFIX}${user}: Grading stuck since X.`
    await run('failed', ago(5), JSON.stringify({ message }))
    await run('failed', ago(4.75), JSON.stringify({ message }))
    const first = (await readReactiveGradingAlerts(user, true, q, ago(4.7))).key
    expect(first).toBe(`alarm:${ago(5).toISOString()}`)
    await run('completed', ago(3))
    await run('failed', ago(0.5), JSON.stringify({ message }))
    await run('failed', ago(0.25), JSON.stringify({ message }))
    const second = (await readReactiveGradingAlerts(user, true, q, clock)).key
    expect(second).toBe(`alarm:${ago(0.5).toISOString()}`)
    expect(second).not.toBe(first)
  })
  test('alerts: an own part runs to the next part naming a KNOWN owner, so a cause quoting `| Error:` stays whole (round-4 N6)', async () => {
    await q(`INSERT INTO learning_reactive_settings(user_id,enabled,activated_at,config,revision) VALUES('someone-else',true,$1,'{}','rev-1')`, [ago(400)])
    await run('failed', ago(0.25), JSON.stringify({ message: `${STALL_VERDICT_PREFIX}${user}: Routing stalled (a | Error: x). | someone-else: Grading stalled. | ${user}: Grading stuck.` }))
    const { alerts } = await readReactiveGradingAlerts(user, false, q, clock)
    expect(alerts[0]).toContain(': Routing stalled (a | Error: x). Grading stuck. See the Learning page')
    expect(alerts[0]).not.toContain('someone-else')
  })
  test('alerts: the watchdog boundary is exact: a verdict exactly 60 min old is still watched (round-4 N4)', async () => {
    await run('completed', ago(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES / 60))
    expect((await readReactiveGradingAlerts(user, true, q, clock)).key).toBeNull()
    expect((await readReactiveGradingAlerts(user, true, q, new Date(clock.getTime() + 1))).key).toStartWith('unmonitored:')
  })
  test('alerts: items needing an operator for more than 3 days are shown, keyed by the oldest; younger, or while red, they are not (round-4 S3)', async () => {
    expect(REACTIVE_OPERATOR_REMINDER_DAYS).toBe(3)
    await q(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_notified_at,last_failure,last_failed_at)
      VALUES($1,$2,2,1,3,$3,'paid call failed',$3)`, [user, randomUUID(), ago(REACTIVE_OPERATOR_REMINDER_DAYS * 24 - 0.1)])
    await measure(ago(0.2))
    expect(await readReactiveGradingAlerts(user, true, q, clock)).toEqual({ alerts: [], key: null })
    const old = ago(REACTIVE_OPERATOR_REMINDER_DAYS * 24 + 0.1)
    await q(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_notified_at,last_failure,last_failed_at)
      VALUES($1,$2,2,1,3,$3,'paid call failed',$3)`, [user, randomUUID(), old])
    // Read from the latest measurement, not measured per prompt: until the next check it still says "younger".
    expect((await readReactiveGradingAlerts(user, true, q, clock)).key).toBeNull()
    await measure(ago(0.1))
    const shown = await readReactiveGradingAlerts(user, true, q, clock)
    expect(shown.key).toBe(`stuck:${old.toISOString()}`)
    // A newer check whose measure step failed (no result) does not hide it: the last SUCCEEDED measurement is read.
    const crashed = await run('completed', ago(0.08))
    await q(`INSERT INTO learner_workflow_steps(workflow_run_id,step_name,status,result) VALUES($1,$2,'failed',NULL)`, [crashed, REACTIVE_MEASURE_STEP])
    expect((await readReactiveGradingAlerts(user, true, q, clock)).key).toBe(`stuck:${old.toISOString()}`)
    expect(shown.alerts[0]).toStartWith(`Reactive grading has needed an operator since ${old.toISOString()} (3.0 d; other concepts may still be graded): 2 concepts blocked after a paid call`)
    // While this owner is red, the alarm speaks instead.
    await run('failed', ago(0.05), JSON.stringify({ message: `${STALL_VERDICT_PREFIX}${user}: Grading stuck.` }))
    expect((await readReactiveGradingAlerts(user, true, q, clock)).key).toBe(`alarm:${ago(0.05).toISOString()}`)
  })
  test('a verdict is an error that STARTS with the prefix, stored as JSON or as text; a crash merely quoting it is a crash (R3-N4)', async () => {
    await run('failed', ago(0.5), `${STALL_VERDICT_PREFIX}${user}: Grading stalled.`)
    expect(iso(await readStallCheckState(q))).toMatchObject({ lastFinishedAt: ago(0.5).toISOString(), failing: null })
    await run('failed', ago(0.25), JSON.stringify({ message: `could not insert "${STALL_VERDICT_PREFIX}": statement timeout` }))
    expect(iso(await readStallCheckState(q))).toMatchObject({ lastFinishedAt: ago(0.5).toISOString(), lastStatus: 'failed', failing: `could not insert "${STALL_VERDICT_PREFIX}": statement timeout` })
  })
  test('the begin packet carries the alerts and their key; a failed alert read is logged and the turn goes out without them', async () => {
    const packet = Promise.resolve({ turnId: 't' })
    expect(await withGradingAlerts(packet, async () => ({ alerts: ['a'], key: 'alarm:x' }), () => { throw new Error('not called') })).toEqual({ turnId: 't', alerts: ['a'], alertKey: 'alarm:x' })
    const logged: unknown[] = []
    expect(await withGradingAlerts(packet, async () => { throw new Error('db down') }, error => logged.push(error))).toEqual({ turnId: 't', alerts: [], alertKey: null })
    expect(String(logged[0])).toContain('db down')
    expect(withGradingAlerts(Promise.reject(new Error('begin failed')), async () => ({ alerts: [], key: null }), () => undefined)).rejects.toThrow('begin failed')
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

  /**
   * The round-3 review's truth table (section 2), each row with its right answer, plus the three original
   * causes each alone with 4 h sessions over three days. Sessions are arrivals every 10 min; the clock is now.
   */
  describe('truth table', () => {
    /** `n` concepts at the breaker, concept-1..n (a session's matched arrivals go to concept-1). */
    const blocked = (n: number, sinceH: number, { unpaid = false } = {}) => q(`WITH s AS (INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_notified_at,last_failure,last_failed_at)
      SELECT $1,gen_random_uuid(),2,1,3,$2,$3,$2 FROM generate_series(1,$4) RETURNING session_id)
      INSERT INTO learning_reactive_targets(user_id,session_id,concept_id) SELECT $1,session_id,'concept-'||row_number() OVER() FROM s`, [user, ago(sinceH), unpaid ? `Assessment workflow ended failed ${UNPAID_FAILURE_MARKER} (attempt 3 of 3)` : 'paid call failed', n])
    const retrying = async (sinceH: number) => {
      const id = randomUUID()
      await admit(id, ago(sinceH), { waitingSince: ago(sinceH), failedAt: ago(0.5), unpaid: REACTIVE_STUCK_UNPAID_FAILURES })
      await q(`INSERT INTO learning_reactive_targets(user_id,session_id,concept_id) VALUES($1,$2,'concept-1')`, [user, id])
    }
    const switchedOn = (h: number) => q("UPDATE pg_temp.learning_reactive_settings SET config=config||jsonb_build_object('switchedOnAt',$1::timestamptz)", [ago(h)])
    const exhausted = async (atH: number) => {
      const event = (await q<{ event_id: string }>('INSERT INTO learning_vector_arrivals(message_id,created_at) VALUES($1,$2) RETURNING event_id', [randomUUID(), ago(atH)])).rows[0]!.event_id
      await q(`INSERT INTO learning_reactive_route_holds(user_id,event_id,revision,message_id,reason,attempts,next_attempt_at,last_attempt_at) VALUES($1,$2,'rev-1','h','r',6,NULL,$3)`, [user, event, ago(atH)])
    }
    const reading = (h: number) => q('INSERT INTO learning_mastery_readings VALUES($1,$2)', [user, ago(h)])
    const routedAt = (h: number) => q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at) VALUES($1,'r','rev-1','{}',$2,$3)`, [user, randomUUID(), ago(h)])
    const activated = (h: number) => q('UPDATE pg_temp.learning_reactive_settings SET activated_at=$1', [ago(h)])
    const assessmentOff = () => q(`UPDATE pg_temp.learning_reactive_settings SET config='{"enabled":true,"assessmentEnabled":false}'`)
    const manualReading = (h: number) => q("INSERT INTO learning_mastery_readings VALUES($1,$2,'manual')", [user, ago(h)])
    const hourlyReadings = async (hoursBack: number) => { for (let h = 0; h < hoursBack; h++) await reading(h + 0.1) }
    /** One prompt a day for `days` days: 5 arrivals over 4 min, the latest today. */
    const promptADay = async (days: number) => { for (let d = 0; d < days; d++) await session(d * 24 + 4 / 60, d * 24, { every: 1 }) }
    const checked = () => measure()
    const threeDays = async ({ routed = true } = {}) => { for (const day of [48, 24, 0]) await session(day + 4, day, { routed }) }
    const crash = (h: number) => run('failed', ago(h), JSON.stringify({ message: 'connection terminated due to statement timeout' }))
    const recoveryJustApplied = async () => {
      const session = randomUUID(), lastRun = randomUUID()
      await q(`INSERT INTO learner_workflow_runs(workflow_run_id,workflow,status,input,created_at,updated_at) VALUES($1,'learningReactiveConceptWorkflow','failed',$2,$3,$3)`, [lastRun, JSON.stringify({ dispatchId: randomUUID() }), ago(29)])
      await admit(session, ago(30), { attempts: 3, failure: `Assessment workflow ended failed ${UNPAID_FAILURE_MARKER} (attempt 3 of 3)`, finished: ago(30), waitingSince: ago(30), failedAt: ago(29), unpaid: REACTIVE_STUCK_UNPAID_FAILURES })
      await q('UPDATE pg_temp.learning_reactive_admission SET last_run_id=$1 WHERE session_id=$2', [lastRun, session])
      expect(await releaseUnpaidReactiveSessions(user, [session], q)).toEqual({ released: 1 })
    }
    type Row = { name: string; given: () => Promise<unknown>; status: 'ok' | 'warning' | 'error'; watch?: { key: string | null } }
    const rows: Row[] = [
      { name: '1. idle learner, 216 paid-blocked for 20 d, no reading for 9 h → warning', status: 'warning',
        given: async () => { await blocked(216, 480); await session(11, 9); await reading(9) } },
      { name: '2. idle learner, one concept retrying unpaid (waiting since 20 h), no reading for 9 h → warning (R3-S1)', status: 'warning',
        given: async () => { await retrying(20); await session(11, 9); await reading(9) } },
      { name: '3. cause B: arrivals waiting 8 h and 6.5 h, no batch routed for 8 h → error', status: 'error',
        given: async () => { await routedAt(8); await session(8, 6.5, { routed: false }) } },
      { name: '4. cause A: arrivals exhausted 10 h ago, the learner active 7 h straight, no reading → error', status: 'error',
        given: async () => { await exhausted(10); await session(7, 0) } },
      { name: '5. cause A: exhausted 30 h ago, 4 h sessions, no reading for 30 h → error (R3-B1)', status: 'error',
        given: async () => { await exhausted(30); await reading(30); await session(28, 24); await session(4, 0) } },
      { name: '6. cause C: blocked 10 h ago, the learner active 7 h straight → error', status: 'error',
        given: async () => { await blocked(3, 10); await session(7, 0) } },
      { name: '7. cause C: blocked 72 h ago, 4 h sessions, no reading for 72 h → error (R3-B1)', status: 'error',
        given: async () => { await blocked(3, 72); await reading(72); await threeDays() } },
      { name: '8. back after a week, the first 5.9 h active, cause C all week → warning', status: 'warning',
        given: async () => { await blocked(3, 168); await reading(168); await session(5.9, 0) } },
      { name: '9. the stall check crashing every run → error and a failing alert', status: 'error', watch: { key: `failing:${ago(0.75).toISOString()}` },
        given: async () => { await run('completed', ago(0.9)); await crash(0.75); await crash(0.5); await crash(0.25) } },
      { name: '10. the stall check not running (last verdict 2 h ago) → error and an unmonitored alert', status: 'error', watch: { key: `unmonitored:${ago(2).toISOString()}` },
        given: () => run('completed', ago(2)) },
      { name: '11a. the stall check never ran, schedules on, activated 3 h ago → error and an unmonitored alert (a dead worker)', status: 'error', watch: { key: 'unmonitored:never' },
        given: () => activated(3) },
      { name: '11b. the stall check never ran, activated 20 min ago → ok, no alert (R3-N1)', status: 'ok', watch: { key: null },
        given: () => activated(1 / 3) },
      { name: '12. recovery just applied to a concept waiting for 30 h, nothing settled for 30 h → ok (R3-N2)', status: 'ok',
        given: recoveryJustApplied },
      { name: '13. fresh install, no data, the check ran → ok', status: 'ok', watch: { key: null },
        given: async () => { await activated(0.5); await run('completed', ago(0.1)) } },
      { name: '14. 20 min after a restart, last verdict 35 min ago → ok', status: 'ok', watch: { key: null },
        given: () => run('completed', ago(35 / 60)) },
      { name: '15. back after a week, the first hour, 216 blocked, fresh arrivals → warning', status: 'warning',
        given: async () => { await blocked(216, 168); await reading(168); await session(1, 0) } },
      { name: 'cause A alone, 4 h sessions over three days → error', status: 'error',
        given: async () => { await exhausted(72); await reading(72); await threeDays() } },
      { name: 'cause B alone, 4 h sessions over three days → error', status: 'error',
        given: async () => { await routedAt(72); await reading(72); await threeDays({ routed: false }) } },
      { name: 'cause C alone (unpaid at the breaker), 4 h sessions over three days → error', status: 'error',
        given: async () => { await blocked(246, 72, { unpaid: true }); await reading(72); await threeDays() } },
      { name: 'two 4 h sessions 8 h apart, blocked since before the first → error', status: 'error',
        given: async () => { await blocked(3, 20); await reading(20); await session(16, 12); await session(4, 0) } },
      { name: '1 h last evening and 15 min this morning, blocked since before → warning', status: 'warning',
        given: async () => { await blocked(3, 20); await reading(20); await session(12, 11); await session(0.25, 0) } },
      { name: 'an idle night with one concept retrying unpaid, no arrival, no reading, nothing settled for 12 h → warning (R3-S1)', status: 'warning',
        given: async () => { await retrying(20); await reading(12) } },
      // Round-4 review truth table (T1-T9; D1 is the derive test above).
      { name: 'T1. total stall 10 d, one prompt a day, no reading 10 d → error by the 48 h backstop (round-4 S4)', status: 'error',
        given: async () => { await blocked(3, 241); await reading(241); await promptADay(10) } },
      { name: 'T2. the same for 12 d → error', status: 'error',
        given: async () => { await blocked(3, 289); await reading(289); await promptADay(12) } },
      { name: 'T3. total stall, arrivals every 31 min for 12 h → error', status: 'error',
        given: async () => { await blocked(3, 13); await reading(13); await session(12, 0, { every: 31 }) } },
      { name: 'T4. 216 blocked, last reading 9 h ago, assistant/background arrivals every 40 min overnight matching nothing → warning (round-4 S1)', status: 'warning',
        given: async () => { await blocked(216, 480); await reading(9); await session(9, 0, { matched: false, every: 40 }) } },
      { name: 'T5. hourly assistant-only arrivals overnight for 12 h, stuck items, no reading → warning (round-4 S1)', status: 'warning',
        given: async () => { await blocked(216, 480); await reading(12); await session(12, 0, { matched: false, every: 60 }) } },
      { name: 'T5b. user messages matching nothing for 7 h, stuck items, no reading → warning: a message that matched nothing is not grading work (round-5 B1)', status: 'warning',
        given: async () => { await blocked(3, 10); await reading(10); await session(7, 0, { matched: false }) } },
      { name: 'T6. assessment off, old blocked rows, active 7 h → warning (round-4 S2)', status: 'warning',
        given: async () => { await assessmentOff(); await blocked(3, 30); await reading(30); await session(7, 0) } },
      { name: 'T6b. assessment off, exhausted holds 30 h, routing still routing (last route 10 min ago), matched arrivals 7 h, no reading ever → warning: served by routing', status: 'warning',
        given: async () => { await assessmentOff(); await exhausted(30); await session(7, 1 / 6) } },
      { name: 'T6c. assessment off, exhausted holds 30 h and every arrival since held, nothing routed for 7 h → error', status: 'error',
        given: async () => { await assessmentOff(); await exhausted(30); await routedAt(7); for (const h of [6, 4, 2, 0.5]) await exhausted(h); await session(7, 0, { routed: false }) } },
      { name: 'T7. partial stall: 216 blocked 20 d, other concepts reading hourly, active 9 h → warning, and the person is told (round-4 S3)', status: 'warning', watch: { key: `stuck:${ago(480).toISOString()}` },
        given: async () => { await blocked(216, 480); await hourlyReadings(9); await session(9, 0); await checked() } },
      { name: 'T8. partial cause A: exhausted 80 h, others reading hourly → warning, and the person is told (round-4 S3)', status: 'warning', watch: { key: `stuck:${ago(80).toISOString()}` },
        given: async () => { await exhausted(80); await hourlyReadings(9); await session(9, 0); await checked() } },
      { name: 'T8b. a partial stall younger than 3 d → warning, nobody told yet', status: 'warning', watch: { key: null },
        given: async () => { await blocked(3, 70); await hourlyReadings(9); await session(9, 0); await checked() } },
      { name: 'T9. total stall, one MANUAL reading 2 h ago, active 9 h → error: a manual reading serves nothing (round-4 S3)', status: 'error',
        given: async () => { await blocked(3, 30); await reading(30); await manualReading(2); await session(9, 0) } },
      // Round-5 review truth table (N1-N17).
      { name: 'N1. 216 blocked; a reading right after the last session 49.5 h ago; one unmatched message 49 h ago; idle since → warning (round-5 B1)', status: 'warning',
        given: async () => { await blocked(216, 480); await session(52, 49.6); await reading(49.5); await session(49, 49, { matched: false }) } },
      { name: 'N2. 216 blocked; an 8 h session read hourly whose last 10 min of matched arrivals came after the last reading; idle 50 h → warning: the tail of one session (round-5 B1)', status: 'warning',
        given: async () => { await blocked(216, 480); await session(58, 50); for (let h = 50.2; h < 58; h++) await reading(h) } },
      { name: 'N2b. the same tail matched to a healthy concept, and the learner back 24 h ago to it with nothing published → warning: not the stuck items\' work (round-5 B1)', status: 'warning',
        given: async () => { await blocked(216, 480); await session(58, 50, { concept: 'concept-ok' }); for (let h = 50.2; h < 58; h++) await reading(h); await session(24, 24, { concept: 'concept-ok' }) } },
      { name: 'N2c. the same tail matched to a blocked concept, and the learner back 24 h ago to it, unserved since → error by the backstop (round-5 B1)', status: 'error',
        given: async () => { await blocked(216, 480); await session(58, 50); for (let h = 50.2; h < 58; h++) await reading(h); await session(24, 24) } },
      { name: 'N8. assessment off 4 d (blocked left-overs, daily 4 h matched sessions), switched on a minute ago → warning (round-5 S1)', status: 'warning',
        given: async () => { await blocked(3, 120); await reading(100); await threeDays(); await switchedOn(1 / 60) } },
      { name: 'N8b. switched on 7.5 h ago, blocked left-overs, active 7 h since with nothing served → error: the floor hides only what came before it', status: 'error',
        given: async () => { await blocked(3, 120); await reading(100); await switchedOn(7.5); await session(7, 0) } },
      { name: 'N16. assessment off, blocked left-overs 5 d → warning, and the person is told: they need an operator too (round-5 nit Y7)', status: 'warning', watch: { key: `stuck:${ago(120).toISOString()}` },
        given: async () => { await assessmentOff(); await blocked(3, 120); await checked() } },
      { name: 'N17. routed under an old revision only (matching nothing), unrouted now, 7 h, blocked → error (round-5 nit N3)', status: 'error',
        given: async () => { await blocked(3, 10); await reading(10); await session(7, 0, { matched: false, revision: 'rev-0' }) } },
      { name: 'stuck items; other concepts settling within the hour but publishing nothing; active 9 h → warning: a settled pass is service (round-5 B1)', status: 'warning',
        given: async () => { await blocked(3, 30); await reading(30); await session(9, 0); await admit(randomUUID(), ago(0.2), { finished: ago(0.2) }) } },
      { name: 'another owner\'s reading 1 h ago serves nothing for this one, active 9 h → error (round-4 N2)', status: 'error',
        given: async () => { await blocked(3, 30); await reading(30); await session(9, 0); await q('INSERT INTO learning_mastery_readings VALUES($1,$2)', ['someone-else', ago(1)]) } },
      { name: 'stuck items, the learner active for days and grading work waiting 8 h, a reading 1 h ago → warning (R3-S4)', status: 'warning',
        given: async () => { await blocked(3, 72); await threeDays(); await reading(1); await admit(randomUUID(), ago(8), { waitingSince: ago(8) }); await admit(randomUUID(), ago(1), { finished: ago(1) }) } },
    ]
    for (const row of rows) test(row.name, async () => {
      await row.given()
      const health = await readReactiveGradingHealth(user, q, { now: clock, stallCheck: row.watch !== undefined })
      expect({ status: health.status, messages: health.messages }).toMatchObject({ status: row.status })
      if (row.watch) expect((await readReactiveGradingAlerts(user, true, q, clock)).key).toBe(row.watch.key)
    })
    test('N15. schedules off: a measurement older than the watchdog window is not read, so items cleared since are not reminded (round-5 S2)', async () => {
      await blocked(3, 200)
      const measuredAt = async (h: number) => { await q('TRUNCATE pg_temp.learner_workflow_runs,pg_temp.learner_workflow_steps'); await measure(ago(h)) }
      await measuredAt(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES / 60 - 0.01)
      expect((await readReactiveGradingAlerts(user, false, q, clock)).key).toBe(`stuck:${ago(200).toISOString()}`)
      await measuredAt(REACTIVE_STALL_CHECK_WATCHDOG_MINUTES / 60 + 0.01)
      expect(await readReactiveGradingAlerts(user, false, q, clock)).toEqual({ alerts: [], key: null })
    })
    test('Y3. the reminder boundary is strict: stuck exactly 3 d is not yet reminded, a minute more is (round-5 nit)', async () => {
      await blocked(3, REACTIVE_OPERATOR_REMINDER_DAYS * 24)
      await checked()
      expect((await readReactiveGradingAlerts(user, false, q, clock)).key).toBeNull()
      expect((await readReactiveGradingAlerts(user, false, q, new Date(clock.getTime() + 60_000))).key).toBe(`stuck:${ago(REACTIVE_OPERATOR_REMINDER_DAYS * 24).toISOString()}`)
    })
  })
})
