import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { planReactiveRecovery, releaseUnpaidReactiveSessions } from './learning-reactive-recovery.js'

/**
 * Recovery releases ONLY blocked concepts whose last pass reserved no paid model
 * call; a pass that reserved one stays blocked for review. The release re-checks
 * that at its own write, so a stale plan cannot release a paid one, and replaying
 * it releases nothing twice. TEMP shadows only (pg_temp first on the search path).
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('reactive recovery plan and release', () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  const q: MetaPgQueryFn = async (text, params) => { const r = await client.query(text, params ? [...params] : []); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }
  const user = `reactive-recovery-${randomUUID()}`
  const ids = { unpaid: randomUUID(), paid: randomUUID(), unknown: randomUUID(), waiting: randomUUID() }
  const dispatch = { unpaid: randomUUID(), paid: randomUUID() }
  const pay = async (dispatchId: string) => {
    const run = randomUUID()
    await q('INSERT INTO learning_vector_turn_assessments(experiment_id,run_id) VALUES($1,$2)', [dispatchId, run])
    await q('INSERT INTO learning_concept_assessment_attempts(run_id) VALUES($1)', [run])
  }
  const attempts = async (session: string) => (await q<{ attempts: number }>('SELECT attempts FROM learning_reactive_admission WHERE session_id=$1', [session])).rows[0]!.attempts
  beforeAll(async () => {
    await client.connect()
    for (const table of ['learning_reactive_settings', 'learning_reactive_admission', 'learning_reactive_route_holds']) await q(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`)
    await q('CREATE TEMP TABLE learner_workflow_runs(workflow_run_id text PRIMARY KEY,input text NOT NULL)')
    await q('CREATE TEMP TABLE learning_vector_turn_assessments(experiment_id uuid NOT NULL,run_id text NOT NULL)')
    await q('CREATE TEMP TABLE learning_concept_assessment_attempts(run_id text NOT NULL)')
    await q('CREATE TEMP TABLE learning_vector_turn_experiments(run_id uuid,user_id text,config jsonb,status text,created_at timestamptz DEFAULT now())')
  })
  afterAll(async () => { await client.end() })
  beforeEach(async () => {
    await q('TRUNCATE pg_temp.learning_reactive_settings,pg_temp.learning_reactive_admission,pg_temp.learning_reactive_route_holds,pg_temp.learner_workflow_runs,pg_temp.learning_vector_turn_assessments,pg_temp.learning_concept_assessment_attempts,pg_temp.learning_vector_turn_experiments')
    await q(`INSERT INTO learning_reactive_settings(user_id,enabled,config,revision) VALUES($1,true,'{"enabled":true,"assessmentEnabled":true,"concurrency":4}','rev')`, [user])
    const blocked = async (session: string, dispatchId: string | null) => {
      const run = dispatchId ? randomUUID() : null
      if (run) await q('INSERT INTO learner_workflow_runs VALUES($1,$2)', [run, JSON.stringify({ dispatchId })])
      await q(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_run_id,last_failure) VALUES($1,$2,2,1,3,$3,'x')`, [user, session, run])
    }
    await blocked(ids.unpaid, dispatch.unpaid)
    await blocked(ids.paid, dispatch.paid); await pay(dispatch.paid)
    await blocked(ids.unknown, null)
    await q(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts) VALUES($1,$2,2,1,0)`, [user, ids.waiting])
    // One completed live pass of three parts sets the per-pass estimate.
    const experiment = randomUUID()
    await q(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,config,status) VALUES($1,$2,'{"purpose":"live"}','completed')`, [experiment, user])
    for (let i = 0; i < 3; i++) await q('INSERT INTO learning_vector_turn_assessments VALUES($1,$2)', [experiment, randomUUID()])
    // One arrival exhausted its routing retries, one is still being retried, one belongs to someone else.
    for (const [owner, next] of [[user, null], [user, new Date(Date.now() + 60_000)], ['someone-else', null]] as const)
      await q(`INSERT INTO learning_reactive_route_holds(user_id,event_id,revision,message_id,reason,attempts,next_attempt_at) VALUES($1,$2,'rev','m','r',6,$3)`, [owner, randomUUID(), next])
  })

  test('the plan separates releasable unpaid sessions from paid and unknown ones, and prices the recovery', async () => {
    expect(await planReactiveRecovery(user, q)).toEqual({ userId: user, concurrency: 4, waiting: 1, blocked: 3, releasableUnpaid: [ids.unpaid],
      blockedPaid: 1, blockedUnknown: 1, exhaustedHolds: 1, partsPerPass: 3, estimatedPaidCalls: 6 })
  })
  test('release resets only the unpaid session even when handed paid and unknown ids, and a replay releases nothing', async () => {
    expect(await releaseUnpaidReactiveSessions(user, [ids.unpaid, ids.paid, ids.unknown], q)).toEqual({ released: 1 })
    expect(await attempts(ids.unpaid)).toBe(0)
    expect(await attempts(ids.paid)).toBe(3)
    expect(await attempts(ids.unknown)).toBe(3)
    expect(await releaseUnpaidReactiveSessions(user, [ids.unpaid], q)).toEqual({ released: 0 })
    expect((await planReactiveRecovery(user, q)).releasableUnpaid).toEqual([])
  })
  test('a stale plan cannot release a session that reserved a paid call after the plan was made', async () => {
    const plan = await planReactiveRecovery(user, q)
    await pay(dispatch.unpaid)
    expect(await releaseUnpaidReactiveSessions(user, plan.releasableUnpaid, q)).toEqual({ released: 0 })
    expect(await attempts(ids.unpaid)).toBe(3)
  })
  test('another owner\'s session is never released', async () => {
    expect(await releaseUnpaidReactiveSessions('someone-else', [ids.unpaid], q)).toEqual({ released: 0 })
  })
})
