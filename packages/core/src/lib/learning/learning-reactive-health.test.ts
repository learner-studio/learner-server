import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { REACTIVE_STALL_HOURS, UNPAID_FAILURE_MARKER, deriveReactiveGradingHealth, readReactiveGradingHealth, type ReactiveGradingHealthInput } from './learning-reactive-health.js'

const now = new Date('2026-11-11T12:00:00Z')
const hours = (h: number) => new Date(now.getTime() - h * 36e5)
const base = (patch: Partial<ReactiveGradingHealthInput> = {}): ReactiveGradingHealthInput => ({
  now, enabled: true, assessmentEnabled: true, routingError: null,
  routing: { waiting: 0, oldestWaitingAt: null, lastRoutedAt: hours(300), held: 0, exhausted: 0 },
  grading: { waiting: 0, oldestWaitingAt: null, running: 0, lastSettledAt: hours(300), lastReadingAt: hours(300), blocked: 0, blockedUnpaid: 0 },
  ...patch,
})

describe('reactive grading stall signal', () => {
  test('red when indexed arrivals have waited past the bound and no batch routed for as long (the 2026-10-30 stall)', () => {
    const health = deriveReactiveGradingHealth(base({ routingError: 'Vector routing failed; pending arrivals retained.',
      routing: { waiting: 4596, oldestWaitingAt: hours(281), lastRoutedAt: hours(280), held: 0, exhausted: 0 } }))
    expect(health.status).toBe('error')
    expect(health.messages[0]).toStartWith('Routing stalled: 4596 indexed arrivals waiting since')
    expect(health.messages[0]).toContain('Vector routing failed')
  })
  test('red when concepts have waited past the bound and no pass settled for as long', () => {
    const health = deriveReactiveGradingHealth(base({ grading: { waiting: 1120, oldestWaitingAt: hours(200), running: 0, lastSettledAt: hours(280), lastReadingAt: hours(280), blocked: 441, blockedUnpaid: 246 } }))
    expect(health.status).toBe('error')
    expect(health.messages).toHaveLength(2)
    expect(health.messages[0]).toStartWith('Grading stalled: 1120 concepts waiting')
    expect(health.messages[1]).toBe('441 concepts blocked at the retry breaker (246 failed before any paid call); run the reactive recovery.')
  })
  test('green while work waits but the stage completed within the bound', () => {
    expect(deriveReactiveGradingHealth(base({
      routing: { waiting: 300, oldestWaitingAt: hours(10), lastRoutedAt: hours(1), held: 0, exhausted: 0 },
      grading: { waiting: 40, oldestWaitingAt: hours(30), running: 4, lastSettledAt: hours(REACTIVE_STALL_HOURS - 1), lastReadingAt: hours(2), blocked: 0, blockedUnpaid: 0 },
    })).status).toBe('ok')
  })
  test('green when work arrived recently, even after a long quiet spell (not yet a stall)', () => {
    expect(deriveReactiveGradingHealth(base({ routing: { waiting: 5, oldestWaitingAt: hours(1), lastRoutedAt: hours(500), held: 0, exhausted: 0 } })).status).toBe('ok')
  })
  test('green when idle: nothing waiting, nothing completed for weeks', () => {
    const health = deriveReactiveGradingHealth(base())
    expect(health.status).toBe('ok')
    expect(health.messages).toEqual([])
  })
  test('green when reactive grading is disabled, whatever is waiting; grading rule ignored when assessment is off', () => {
    const stalled = { waiting: 9, oldestWaitingAt: hours(100), running: 0, lastSettledAt: null, lastReadingAt: null, blocked: 0, blockedUnpaid: 0 }
    expect(deriveReactiveGradingHealth(base({ enabled: false, grading: stalled })).status).toBe('ok')
    expect(deriveReactiveGradingHealth(base({ assessmentEnabled: false, grading: stalled })).status).toBe('ok')
  })
  test('held arrivals that exhausted their retries surface as a warning, not silence', () => {
    const health = deriveReactiveGradingHealth(base({ routing: { waiting: 0, oldestWaitingAt: null, lastRoutedAt: hours(1), held: 2, exhausted: 1 } }))
    expect(health.status).toBe('warning')
    expect(health.messages[0]).toContain('1 arrivals exhausted their routing retries')
  })
})

/** The reader's SQL against TEMP shadows (pg_temp first on the search path); no shared row is touched. */
describe.skipIf(!process.env.TEST_DATABASE_URL)('reactive grading health reads the pipeline tables', () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  const q: MetaPgQueryFn = async (text, params) => { const r = await client.query(text, params ? [...params] : []); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }
  const user = `grading-health-${randomUUID()}`
  const clock = new Date()
  const ago = (h: number) => new Date(clock.getTime() - h * 36e5)
  beforeAll(async () => {
    await client.connect()
    for (const table of ['learning_reactive_settings', 'learning_vector_arrivals', 'learning_reactive_routes', 'learning_reactive_route_holds', 'learning_reactive_admission'])
      await q(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`)
    await q('CREATE TEMP TABLE learning_mastery_readings(user_id text,completed_at timestamptz)')
  })
  afterAll(async () => { await client.end() })
  beforeEach(async () => {
    await q('TRUNCATE pg_temp.learning_reactive_settings,pg_temp.learning_vector_arrivals,pg_temp.learning_reactive_routes,pg_temp.learning_reactive_route_holds,pg_temp.learning_reactive_admission,pg_temp.learning_mastery_readings')
    await q(`INSERT INTO learning_reactive_settings(user_id,enabled,activated_at,config,revision) VALUES($1,true,$2,$3::jsonb,'rev-1')`,
      [user, ago(400), JSON.stringify({ enabled: true, assessmentEnabled: true })])
  })
  const admit = (session: string, notified: Date, attempts = 0, failure: string | null = null, finished: Date | null = null) =>
    q(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_notified_at,last_failure,last_finished_at) VALUES($1,$2,2,1,$3,$4,$5,$6)`,
      [user, session, attempts, notified, failure, finished])

  test('idle owner reads green', async () => {
    await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at) VALUES($1,'m','rev-1','{}',$2,$3)`, [user, randomUUID(), ago(300)])
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.status).toBe('ok')
    expect(health.routing.waiting).toBe(0)
  })
  test('arrivals and concepts waiting past the bound with nothing completing read red; unpaid blocked sessions are counted', async () => {
    await q('INSERT INTO learning_vector_arrivals(message_id,created_at) VALUES($1,$2),($3,$4)', ['a', ago(7), 'b', ago(8)])
    await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at) VALUES($1,'m','rev-1','{}',$2,$3)`, [user, randomUUID(), ago(9)])
    await admit(randomUUID(), ago(7), 0, null, ago(9))
    await admit(randomUUID(), ago(8), 3, `Assessment workflow ended failed ${UNPAID_FAILURE_MARKER} (attempt 3 of 3)`)
    await q('INSERT INTO learning_mastery_readings VALUES($1,$2)', [user, ago(9)])
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.status).toBe('error')
    expect(health.routing).toMatchObject({ waiting: 2, held: 0, exhausted: 0 })
    expect(health.grading).toMatchObject({ waiting: 1, blocked: 1, blockedUnpaid: 1, lastReadingAt: ago(9).toISOString() })
    expect(health.messages.map(m => m.split(':')[0])).toEqual(['Routing stalled', 'Grading stalled', '1 concepts blocked at the retry breaker (1 failed before any paid call); run the reactive recovery.'])
  })
  test('the same backlog reads green once a batch routed and a pass settled within the bound', async () => {
    await q('INSERT INTO learning_vector_arrivals(message_id,created_at) VALUES($1,$2)', ['a', ago(7)])
    await q(`INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id,routed_at) VALUES($1,'m','rev-1','{}',$2,$3)`, [user, randomUUID(), ago(1)])
    await admit(randomUUID(), ago(8), 0, null, ago(2))
    expect((await readReactiveGradingHealth(user, q, clock)).status).toBe('ok')
  })
  test('a held arrival is not counted as waiting; an exhausted one is a warning', async () => {
    const event = (await q<{ event_id: string }>('INSERT INTO learning_vector_arrivals(message_id,created_at) VALUES($1,$2) RETURNING event_id', ['h', ago(30)])).rows[0]!.event_id
    await q(`INSERT INTO learning_reactive_route_holds(user_id,event_id,revision,message_id,reason,attempts,next_attempt_at) VALUES($1,$2,'rev-1','h','r',6,NULL)`, [user, event])
    const health = await readReactiveGradingHealth(user, q, clock)
    expect(health.routing).toMatchObject({ waiting: 0, held: 0, exhausted: 1 })
    expect(health.status).toBe('warning')
  })
})
