import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createDatabase } from '@learner/core/db/handle.js'
import { DurableEngine } from './durable.js'
import { PROBE_WORKFLOW, probeHost } from './durable-crash.fixture.js'
import { STALE_RUNNING_RUN_MS, listUnsettledRuns, settleAbandonedRuns } from '@learner/core/lib/workflow/workflow-runs.js'

const url = process.env.TEST_DATABASE_URL
const LEASE_MS = 1000

/**
 * A worker is SIGKILLed after step `one` commits; a second executor adopts the
 * run once the lease lapses and finishes it without re-running `one`.
 */
describe.skipIf(!url)('durable workflow crash/resume (learner_test)', () => {
  const db = url ? createDatabase(url, { max: 4 }) : (undefined as never)

  beforeAll(async () => {
    await db.query('CREATE TABLE IF NOT EXISTS durable_probe (run_id text NOT NULL, step text NOT NULL, at timestamptz NOT NULL DEFAULT now())')
  })
  afterAll(async () => { await db.close() })

  test('a killed executor resumes from the checkpoint', async () => {
    const engine = new DurableEngine(db, { leaseMs: LEASE_MS }).attach(probeHost(db))
    const { runId } = await engine.startWorkflow(PROBE_WORKFLOW, { probe: true })

    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'durable-crash.fixture.ts'), runId, String(LEASE_MS)], {
      env: { ...process.env, TEST_DATABASE_URL: url }, stdout: 'pipe', stderr: 'inherit',
    })
    const reader = child.stdout.getReader()
    let out = ''
    while (!out.includes('workflow-step-pause')) {
      const { value, done } = await reader.read()
      if (done) throw new Error(`fixture exited before pausing: ${out}`)
      out += new TextDecoder().decode(value)
    }
    child.kill('SIGKILL')
    await child.exited

    // Mid-run state: step one checkpointed, two never started, lease held by the dead executor.
    const steps = await engine.getRunSteps(runId)
    expect(steps.map((s) => [s.stepName, s.status])).toEqual([['one', 'succeeded']])
    expect((await engine.getRun(runId))?.status).toBe('running')
    expect(await engine.findOrphanedRuns([PROBE_WORKFLOW])).not.toContainEqual({ runId, workflow: PROBE_WORKFLOW })

    await Bun.sleep(LEASE_MS + 300)
    expect(await engine.findOrphanedRuns([PROBE_WORKFLOW])).toContainEqual({ runId, workflow: PROBE_WORKFLOW })

    await engine.runWorkflowJob(runId)
    const run = await engine.getRun(runId)
    expect(run?.status).toBe('completed')
    expect(run?.output).toEqual({ one: 'one', two: 'two', input: { probe: true } })
    const executed = (await db.query<{ step: string; n: string }>(
      'SELECT step, count(*)::text AS n FROM durable_probe WHERE run_id = $1 GROUP BY step ORDER BY step', [runId])).rows
    expect(executed).toEqual([{ step: 'one', n: '1' }, { step: 'two', n: '1' }])
  }, 30_000)
})

/**
 * The other half of recovery: a run whose executor died and was never resumed
 * past the stale bound must leave the recovery set, or every later worker boot
 * re-adopts it, and a worker stopped again before the step ends abandons it
 * again (the stuck archive sweeps on 2026-10-27).
 */
describe.skipIf(!url)('abandoned runs are settled, not re-adopted (learner_test)', () => {
  const db = url ? createDatabase(url, { max: 4 }) : (undefined as never)
  afterAll(async () => { await db.close() })

  test('settleAbandonedRuns fails a dead run and drops it from findOrphanedRuns; a live step keeps one', async () => {
    const engine = new DurableEngine(db, { leaseMs: LEASE_MS }).attach(probeHost(db))
    const dead = (await engine.startWorkflow(PROBE_WORKFLOW, { probe: 'dead' })).runId
    const live = (await engine.startWorkflow(PROBE_WORKFLOW, { probe: 'live' })).runId
    const old = new Date(Date.now() - STALE_RUNNING_RUN_MS - 60_000)
    await db.query(`UPDATE learner_workflow_runs SET status = 'running', lease_owner = 'gone:1', lease_until = $2::timestamptz, created_at = $2::timestamptz, updated_at = $2::timestamptz
      WHERE workflow_run_id = ANY($1::text[])`, [[dead, live], old])
    await db.query(`INSERT INTO learner_workflow_steps (workflow_run_id, step_name, status, created_at, updated_at)
      VALUES ($1, 'one', 'running', $2::timestamptz, $2::timestamptz), ($3, 'one', 'running', $2::timestamptz, now())`, [dead, old, live])
    expect(await engine.findOrphanedRuns([PROBE_WORKFLOW])).toEqual(expect.arrayContaining([
      { runId: dead, workflow: PROBE_WORKFLOW }, { runId: live, workflow: PROBE_WORKFLOW }]))

    // Through the guard's own query: both are older than every recency window a sweep would read.
    const runs = (await listUnsettledRuns(engine, PROBE_WORKFLOW)).filter((r) => r.id === dead || r.id === live)
    expect(runs).toHaveLength(2)
    const blocking = await settleAbandonedRuns(engine, engine, runs)

    expect(blocking.map((r) => r.id)).toEqual([live])
    expect(await engine.getRun(dead)).toMatchObject({ status: 'failed', error: { name: 'AbandonedRunError' } })
    expect((await engine.getRun(live))?.status).toBe('running')
    const orphans = await engine.findOrphanedRuns([PROBE_WORKFLOW])
    expect(orphans).not.toContainEqual({ runId: dead, workflow: PROBE_WORKFLOW })
    expect(orphans).toContainEqual({ runId: live, workflow: PROBE_WORKFLOW })
    await db.query(`DELETE FROM learner_workflow_runs WHERE workflow_run_id = ANY($1::text[])`, [[dead, live]])
  })
})
