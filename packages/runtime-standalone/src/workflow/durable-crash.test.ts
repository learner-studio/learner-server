import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { createDatabase } from '@learner/core/db/handle.js'
import { DurableEngine } from './durable.js'
import { PROBE_WORKFLOW, probeHost } from './durable-crash.fixture.js'

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
