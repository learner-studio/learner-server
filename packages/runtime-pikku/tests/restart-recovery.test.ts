import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from 'pg'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { rpcService } from '@pikku/core/rpc'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { attemptFilesKey } from '@learner/core/lib/learning/llm-attempt-lease.js'
import { ASSESSMENT_MODEL, buildConceptAssessmentInput } from '@learner/core/lib/learning/learning-concept-assessment.js'
import { conceptFromGraphs } from '@learner/core/services/learning-concept-assessment.js'
import { attemptDirectory } from '@learner/llm/lib/cli/durable-cli-call.js'
import { defineSessionlessFunction } from '@learner/server/runtime/define.js'
import { runShared } from '../src/adapt.js'
import { type Crashable, fakeCli, spawnCrashable, until } from '@learner/llm/lib/cli/testing/crash-harness.js'
import { addWeeks, selectDriftPanel } from '@learner/core/lib/learning/grader-drift-panel.js'
import { purgeDriftFixtures, seedDriftReading } from './fixtures/drift-seed.js'

/**
 * Restart safety, end to end (docs/operations/restart-safety.md): a REAL worker process (src/bin/worker.ts) runs
 * learningConceptAssessmentWorkflow with replicate grading on; its model is a fake slow `codex` CLI that counts
 * every (paid) invocation. The test kills the worker in the middle of a grading call (SIGKILL, SIGTERM; with and
 * without its detached CLI child), starts a new worker, and checks that the run finishes by itself with one
 * receipt, one reading, nothing uncertain, and no call paid twice except where the backend's repeat is free.
 * A metered backend never repeats. Runs on its own test database (ownTestDatabaseUrl('restart')) and its own queue schema;
 * the process/fake-CLI harness is packages/llm/src/lib/cli/testing/crash-harness.ts. Every text is synthetic.
 */
const url = await ownTestDatabaseUrl('restart')
const BOSS_PREFIX = 'lp_boss_restart_'
const PKG = fileURLToPath(new URL('..', import.meta.url))

describe.skipIf(!url)('restart recovery, real worker process (learner_restart_test_<checkout>)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'restart-tier-'))
  const bossSchema = `${BOSS_PREFIX}${Math.floor(Date.now() / 1000)}_${randomUUID().slice(0, 8)}`
  const attempts = join(scratch, 'attempts')
  // Small pools: the suite runs files in parallel on one Postgres, and each worker here is a whole process.
  Object.assign(process.env, { LEARNER_DATABASE_URL: url!, DATABASE_URL: url!, LEARNING_LOCAL_MVP_ENABLED: 'true', LEARNER_PIKKU_PGBOSS_SCHEMA: bossSchema, LEARNER_LLM_ATTEMPT_DIR: attempts,
    LEARNER_POOL_MAX: '4', LEARNER_BOSS_POOL_MAX: '2' })
  delete process.env.LEARNER_SCHEDULES_ENABLED
  setRuntimeRole('api')
  let db: Client
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)) as unknown as { rows: T[]; rowCount: number }
  // The test process only STARTS runs (send-only, like the API); the worker processes execute them.
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    return createSingletonServices(await createConfig())
  })()

  const workers: Crashable[] = []
  const startWorker = (env: Record<string, string>) => {
    const worker = spawnCrashable([process.execPath, 'src/bin/worker.ts'], {
      cwd: PKG, env: { ...process.env, LEARNER_RUNTIME_DIRECTORY: join(scratch, 'runtime'), LEARNER_ATTEMPT_POLL_MS: '100', LEARNER_RUNTIME_ROLE: 'learning-worker',
        // No Langfuse keys: the generations stay in this database's telemetry outbox, where the tests read them.
        LEARNER_LANGFUSE_ENV_FILE: join(scratch, 'no-langfuse.env'), ...env },
    })
    workers.push(worker)
    return worker
  }
  const stop = (w: Crashable, signal: 'SIGKILL' | 'SIGTERM') => w.stop(signal)

  beforeAll(async () => {
    db = new Client({ connectionString: url! })
    await db.connect()
    await q(`INSERT INTO learning_policy_settings(config_key,settings,updated_by,updated_at) VALUES('default',$1::jsonb,'restart-test',now())
      ON CONFLICT(config_key) DO UPDATE SET settings=EXCLUDED.settings`, [JSON.stringify({ ...DEFAULT_LEARNING_POLICY, gradingReplicates: 2 })])
  })
  // A failed test leaves its worker running on the shared queue schema, where it would take the next test's jobs.
  beforeEach(async () => { for (const w of workers.splice(0)) { w.proc.kill('SIGKILL'); await w.proc.exited } })
  afterAll(async () => {
    for (const w of workers) { try { w.proc.kill('SIGKILL') } catch { /* gone */ } }
    try { const services = await booted; await services.backgroundJobs?.stop() } catch { /* not booted */ }
    await q(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`).catch(() => undefined)
    await db.end()
    rmSync(scratch, { recursive: true, force: true })
  }, 60_000)

  /** One prepared manual run (as `prepare` leaves it) and the fake model's valid answer for it. */
  const prepared = async () => {
    // A concept of the seeded curriculum: publishing version-guards the estimate against it.
    const services = await booted
    const graphs = await services.learningCurriculumStore.listGraphs()
    const conceptId = graphs.flatMap((g) => g.concepts)[0]?.id
    if (!conceptId) throw new Error('the test database has no curriculum concept')
    const concept = conceptFromGraphs(graphs, conceptId)
    const evidence = [{ id: 'm1', conversationId: 'c', role: 'user', text: 'I explained the synthetic concept.', occurredAt: '2026-10-01T12:00:00.000Z' }]
    const built = buildConceptAssessmentInput(concept, evidence, null)
    const runId = randomUUID()
    const userId = `restart-user-${randomUUID()}`
    const snapshot = { ...built, evidence, prior: null, model: ASSESSMENT_MODEL, promptRevision: 'restart-test', indexStartedAt: new Date().toISOString() }
    await q(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,$2,$1,$3,$4,$5,$6::jsonb)`,
      [runId, userId, conceptId, built.nodeVersion, `${built.inputHash}-${runId}`, JSON.stringify(snapshot)])
    const answer = JSON.stringify({ proposals: [{ conceptId, nodeVersion: built.nodeVersion, understandingPercent: 40, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: true }] })
    return { runId, answer, calls: fakeCli(scratch, runId, answer, 0).calls }
  }
  const startRun = async (workflow: string, input: Record<string, unknown>) => {
    const services = await booted
    const rpc = rpcService.getContextRPCService(services, {}, false)
    return (await services.workflowService.startWorkflow(workflow, input, { type: 'internal' }, rpc)).runId
  }
  // A killed worker's step is re-run once its lease lapses (60 s) and the next 30 s recovery sweep sees it.
  const finished = async (workflowRunId: string, w: Crashable) => {
    const services = await booted
    let status = ''
    await until(async () => { status = (await services.workflowRunService.getRun(workflowRunId))?.status ?? ''; return ['completed', 'failed', 'cancelled'].includes(status) }, 180_000, `run ${workflowRunId}`, w)
    if (status !== 'completed' && process.env.RESTART_TEST_DEBUG) {
      console.log(JSON.stringify((await services.workflowRunService.getRunSteps(workflowRunId)).map((s: Record<string, unknown>) => ({ name: s.stepName, status: s.status, error: s.error })), null, 1))
      console.log(w.log().slice(-6000))
    }
    return status
  }
  const outcome = async (runId: string) => ({
    receipts: (await q<{ status: string }>(`SELECT receipt->>'status' AS status FROM learning_concept_assessment_receipts WHERE run_id=$1`, [runId])).rows.map((r) => r.status),
    replicates: (await q<{ status: string }>(`SELECT receipt->>'status' AS status FROM learning_concept_assessment_replicates WHERE run_id=$1 ORDER BY replicate`, [runId])).rows.map((r) => r.status),
    readings: Number((await q<{ n: string }>('SELECT count(*) AS n FROM learning_mastery_readings WHERE run_id=$1', [runId])).rows[0]!.n),
    reclaims: (await q<{ attempt_key: string; action: string }>(`SELECT attempt_key, action FROM learning_llm_attempt_reclaims WHERE attempt_key LIKE '%' || $1 || '%' ORDER BY id`, [runId])).rows.map((r) => `${r.action} ${r.attempt_key.split(':')[0]}`),
  })
  /**
   * The model generations of a run's attempts in the telemetry outbox (what Langfuse receives), joined by id: the
   * lease's attempt key names the call directory the generation carries. Ids and flags only, never text.
   */
  const generations = async (runId: string) => {
    const keys = (await q<{ attempt_key: string }>(`SELECT attempt_key FROM learning_llm_attempt_leases WHERE attempt_key LIKE '%' || $1 || '%' ORDER BY created_at`, [runId])).rows.map((r) => r.attempt_key)
    const found: { attempt: string; adopted: boolean; session: string | null; label: string | null; traced: boolean }[] = []
    for (const key of keys) {
      const dir = attemptDirectory(attemptFilesKey(key, process.env.LEARNER_DATABASE_URL), attempts).split('/').pop()!
      const rows = (await q<{ attrs: Record<string, string> }>(`SELECT jsonb_object_agg(a->>'key', a->'value'->>'stringValue') AS attrs FROM telemetry_outbox,
        jsonb_array_elements(payload->'body'->'resourceSpans'->0->'scopeSpans'->0->'spans'->0->'attributes') a
        WHERE destination='langfuse' AND payload::text LIKE '%' || $1 || '%' GROUP BY telemetry_outbox.id`, [dir])).rows
      for (const { attrs } of rows) {
        const meta = JSON.parse(attrs['langfuse.observation.metadata']!)
        found.push({ attempt: key.split(':')[0]!, adopted: meta.adopted, session: attrs['langfuse.session.id'] ?? null, label: attrs['langfuse.trace.name'] ?? null, traced: typeof meta.pikkuTraceId === 'string' })
      }
    }
    return found
  }
  const fake = (p: Awaited<ReturnType<typeof prepared>>, sleepMs: number, extra: Record<string, string> = {}) => fakeCli(scratch, p.runId, p.answer, sleepMs, extra).env
  const wrapperGroup = (runId: string, key: string) => Number(readFileSync(join(attemptDirectory(attemptFilesKey(key, process.env.LEARNER_DATABASE_URL), attempts), 'call-1', 'wrapper.pid'), 'utf8'))

  /** A one-item drift panel (the weekly run regrades every panel, so earlier runs' fixtures go first) and the fake model's answer. */
  const panel = async () => {
    await purgeDriftFixtures(q, 'drift-%')
    const user = `drift-${randomUUID()}`
    const { conceptId } = await seedDriftReading(q, user, 0, 40)
    await selectDriftPanel(q as never, user, 1)
    const answer = JSON.stringify({ proposals: [{ conceptId, understandingPercent: 40, confidence: 'medium',
      demonstrated: [{ description: 'synthetic', sourceId: `m-0-${user}`, quote: 'Synthetic' }], gaps: [], nextCheck: 'Explain it.', needsReview: true }] })
    return { user, week: addWeeks('2000-01-03', Math.floor(Math.random() * 5000)), cli: (sleepMs: number) => fakeCli(scratch, user, answer, sleepMs) }
  }

  // Worker only (a scoped restart: the CLI child lives on and its result is adopted, one call), and the control group
  // (the child dies too: the step's retry or the next worker runs the free call again). Review round 3, R3-B1.
  test('a run started from inside a workflow step names that step\'s run as its parent', async () => {
    const services = await booted
    const parent = randomUUID()
    // Through the production path: runShared installs the step's scope (adapt.ts). The probe workflow is model-free
    // and harmless to any later worker.
    const step = defineSessionlessFunction(async () => startRun('learningWorkerProbeWorkflow', { delay: '5s' }))
    const child = await runShared('parentStep', step, services as never, {}, { workflowStep: { runId: parent, invocationId: 'i', stepId: 's' } } as never)
    expect((await services.workflowRunService.getRun(child))?.wire).toMatchObject({ parentRunId: parent })
  })

  // Pikku's workflow recovery (worker.ts startRecovery), on the model-free probe workflow: step, 5 s sleep, step.
  const steps = async (wf: string) => (await q<{ step_name: string; status: string; current_attempt: number }>(
    'SELECT step_name, status, current_attempt FROM learner_workflow_steps WHERE workflow_run_id=$1 ORDER BY created_at', [wf])).rows
  const meshJobs = (wf: string) => q<{ state: string }>(`SELECT state FROM "${bossSchema}".job WHERE name='pikku-mesh-rpc' AND data::text LIKE '%' || $1 || '%'`, [wf])

  test('SIGKILL after a step\'s side effect, before its checkpoint: the live worker\'s periodic recovery re-runs it, not its boot', async () => {
    const first = startWorker({ LEARNER_FAULT_PAUSE_AFTER_STEP_RPC: 'learningWorkerIdentityStep:600000' })
    const wf = await startRun('learningWorkerProbeWorkflow', { delay: '5s' })
    await until(() => first.log().includes('workflow-step-pause') && first.log().includes(wf), 30_000, 'the paused step', first)
    const second = startWorker({})
    await until(() => second.log().includes('is held by another process'), 30_000, 'the second worker waiting for the fence', second)
    await stop(first, 'SIGKILL')
    await until(() => second.log().includes('worker-started'), 30_000, 'the second worker taking over', second)
    // Its start-up pass leaves the step alone: the killed worker's lease on it has not lapsed yet.
    await Bun.sleep(5_000)
    expect((await steps(wf))[0]).toMatchObject({ status: 'running', current_attempt: 1 })
    expect(await finished(wf, second)).toBe('completed')
    expect(second.log()).toMatch(/Workflow recovery: \d+ sleeps woken, \d+ re-armed, \d+ steps re-dispatched, [1-9]\d* stalled runs/)
    // Re-run as a second attempt by the second worker; the sleep's wake-up came through Pikku's mesh-rpc queue worker.
    expect((await steps(wf))[0]).toMatchObject({ status: 'succeeded', current_attempt: 2 })
    expect(((await (await booted).workflowRunService.getRun(wf))?.output as { before: { pid: number } }).before.pid).toBe(second.proc.pid)
    expect((await meshJobs(wf)).rows.map((r) => r.state)).toContain('completed')
    await stop(second, 'SIGTERM')
  }, 300_000)

  test('a worker killed between a step\'s error and its retry write: the next worker retries the step, the run completes', async () => {
    const first = startWorker({ LEARNER_FAULT_PAUSE_AFTER_STEP_RPC: 'learningWorkerIdentityStep:600000' })
    const wf = await startRun('learningWorkerProbeWorkflow', { delay: '5s' })
    await until(() => first.log().includes('workflow-step-pause') && first.log().includes(wf), 30_000, 'the paused step', first)
    await stop(first, 'SIGKILL')
    // The state that kill leaves when it lands between setStepError and createRetryAttempt, its jobs gone, idle 2 min.
    await q(`UPDATE learner_workflow_steps SET status='failed', lease_expires_at=NULL, error='{"message":"synthetic"}', updated_at=now() - interval '2 minutes'
      WHERE workflow_run_id=$1 AND status='running'`, [wf])
    await q(`UPDATE learner_workflow_runs SET updated_at=now() - interval '2 minutes' WHERE workflow_run_id=$1`, [wf])
    await q(`DELETE FROM "${bossSchema}".job WHERE data::text LIKE '%' || $1 || '%' AND state IN ('created','retry','active')`, [wf])
    const second = startWorker({})
    expect(await finished(wf, second)).toBe('completed')
    expect((await steps(wf))[0]).toMatchObject({ status: 'succeeded', current_attempt: 2 })
    await stop(second, 'SIGTERM')
  }, 300_000)

  test('a sleep whose wake-up job is lost still wakes, on the same live worker', async () => {
    const w = startWorker({})
    await until(() => w.log().includes('worker-started'), 30_000, 'the worker', w)
    await Bun.sleep(2_000) // past its start-up recovery pass, which would re-arm the sleep
    const wf = await startRun('learningWorkerProbeWorkflow', { delay: '5s' })
    await until(async () => (await steps(wf)).some((s) => s.status === 'scheduled'), 30_000, 'the sleep', w)
    const lost = await q(`DELETE FROM "${bossSchema}".job WHERE name='pikku-mesh-rpc' AND state='created' AND data::text LIKE '%' || $1 || '%'`, [wf])
    expect(lost.rowCount).toBe(1)
    expect(await finished(wf, w)).toBe('completed')
    expect(w.log()).toMatch(/Workflow recovery: [1-9]\d* sleeps woken/)
    await stop(w, 'SIGTERM')
  }, 300_000)

  for (const signal of ['SIGKILL', 'SIGTERM'] as const) for (const group of [false, true]) {
    test(`${signal} ${group ? 'to the worker AND its CLI child' : 'to the worker'} during a drift-panel regrade: the week completes; one completed regrade, nothing uncertain`, async () => {
      const p = await panel()
      const first = startWorker(p.cli(group ? 6_000 : 2_500).env)
      const wf = await startRun('learningDriftPanelWorkflow', { week: p.week })
      await until(() => p.cli(0).calls() === 1, 30_000, 'the regrade call', first)
      if (group) process.kill(-wrapperGroup(p.user, `drift:${p.user}:0:${p.week}`), signal)
      await stop(first, signal)
      const second = startWorker(p.cli(300).env)
      expect(await finished(wf, second)).toBe('completed')
      expect((await q('SELECT status, calls FROM learning_drift_panel_regrades WHERE user_id=$1', [p.user])).rows).toEqual([{ status: 'completed', calls: 1 }])
      if (!group) expect(p.cli(0).calls()).toBe(1) // the live child's result is adopted
      else {
        expect(p.cli(0).calls()).toBeGreaterThanOrEqual(2) // the killed call ran again (free)
        expect(p.cli(0).calls()).toBeLessThanOrEqual(3) // at most one more re-run: never a loop
      }
      await stop(second, 'SIGTERM')
    }, 300_000)
  }

  test('SIGKILL during the main grading call: the restarted worker adopts the detached call; one receipt, one reading, nothing paid twice', async () => {
    const p = await prepared()
    const first = startWorker(fake(p, 2_500))
    const wf = await startRun('learningConceptAssessmentWorkflow', { runId: p.runId })
    await until(() => p.calls() === 1, 30_000, 'the main grading call', first)
    await stop(first, 'SIGKILL')
    const second = startWorker(fake(p, 300))
    expect(await finished(wf, second)).toBe('completed')
    expect(await outcome(p.runId)).toEqual({ receipts: ['completed'], replicates: ['completed'], readings: 1, reclaims: ['takeover assessment'] })
    expect(p.calls()).toBe(2) // the main grading (once, adopted) + replicate 2
    // Both durable calls reach Langfuse once each, the adopted one marked so, under the workflow run (session), the
    // step's function (trace name) and Pikku's trace id.
    const step = { session: wf, traced: true }
    expect(await generations(p.runId)).toEqual([{ attempt: 'assessment', adopted: true, label: 'executeLearningConceptAssessmentStep', ...step },
      { attempt: 'replicate', adopted: false, label: 'executeLearningAssessmentReplicateStep', ...step }])
    // The leases and the takeover's audit row join to the run and step by id; the takeover is in the new worker's log.
    const held = await q<{ attempt_key: string; workflow_run_id: string; step_name: string }>(`SELECT attempt_key, workflow_run_id, step_name FROM learning_llm_attempt_leases
      WHERE attempt_key LIKE '%' || $1 || '%' UNION ALL SELECT attempt_key, workflow_run_id, step_name FROM learning_llm_attempt_reclaims WHERE attempt_key LIKE '%' || $1 || '%'`, [p.runId])
    expect(held.rows.map((r) => [r.attempt_key.split(':')[0], r.workflow_run_id, r.step_name]).sort()).toEqual([['assessment', wf, 'executeLearningConceptAssessmentStep'],
      ['assessment', wf, 'executeLearningConceptAssessmentStep'], ['replicate', wf, 'executeLearningAssessmentReplicateStep']])
    expect(second.log()).toMatch(new RegExp(`llm-attempt-takeover[^\\n]*assessment:${p.runId}[^\\n]*${wf}`))
    // The takeover overwrote the lease's run: its audit row keeps the run it took the call from.
    expect((await q<{ prev: string }>(`SELECT detail->>'previousRunId' AS prev FROM learning_llm_attempt_reclaims WHERE action='takeover' AND attempt_key LIKE '%' || $1 || '%'`, [p.runId])).rows).toEqual([{ prev: wf }])
    await stop(second, 'SIGTERM')
  }, 300_000)

  test('SIGTERM during a replicate call: the stop hands the step over cleanly and the run completes with one replicate receipt', async () => {
    const p = await prepared()
    const first = startWorker(fake(p, 2_500))
    const wf = await startRun('learningConceptAssessmentWorkflow', { runId: p.runId })
    await until(() => p.calls() === 2, 40_000, 'the replicate call', first)
    await stop(first, 'SIGTERM')
    const second = startWorker(fake(p, 300))
    expect(await finished(wf, second)).toBe('completed')
    const o = await outcome(p.runId)
    expect({ ...o, reclaims: [] }).toEqual({ receipts: ['completed'], replicates: ['completed'], readings: 1, reclaims: [] })
    expect(p.calls()).toBe(2)
    await stop(second, 'SIGTERM')
  }, 300_000)

  // A control-group stop (`systemctl stop|restart` without the scoped unit) signals the wrapper's group AND the worker.
  // SIGTERM is the review B1 case: the worker is still alive in its grace when the wrapper dies, and must not record
  // that as a failed grading. The call is long (6 s) so the worker is still polling it when the wrapper dies.
  for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
    test(`the worker AND its CLI child get ${signal} (a control-group stop): the repeat-free call runs again; one receipt, one reading`, async () => {
      const p = await prepared()
      const first = startWorker(fake(p, 6_000))
      const wf = await startRun('learningConceptAssessmentWorkflow', { runId: p.runId })
      await until(() => p.calls() === 1, 30_000, 'the main grading call', first)
      const group = wrapperGroup(p.runId, `assessment:${p.runId}`)
      process.kill(-group, signal)
      await stop(first, signal)
      const second = startWorker(fake(p, 300))
      expect(await finished(wf, second)).toBe('completed')
      const o = await outcome(p.runId)
      // The heal is audited as a takeover (the next worker) or a wrapper-lost (the stopping worker's own retry).
      expect({ ...o, reclaims: o.reclaims.filter((r) => r !== 'takeover assessment' && r !== 'wrapper-lost assessment') }).toEqual({ receipts: ['completed'], replicates: ['completed'], readings: 1, reclaims: [] })
      // Who re-runs it is timing: the stopping worker's step retry inside its grace (no takeover: same process), or
      // the next worker (a takeover). Either way it ran again rather than recording the killed call.
      if (process.env.RESTART_TEST_DEBUG) console.log(signal, JSON.stringify(o), 'calls', p.calls())
      expect(p.calls()).toBeGreaterThanOrEqual(3) // main, main again (free), replicate 2
      expect(p.calls()).toBeLessThanOrEqual(4) // at most one more re-run: never a loop
      await stop(second, 'SIGTERM')
    }, 300_000)
  }

  test('a metered backend never pays twice: the killed call is not repeated, and the run does not publish a reading', async () => {
    const p = await prepared()
    const metered = { LEARNER_METERED_BACKENDS: 'codex' }
    const first = startWorker(fake(p, 2_500, metered))
    const wf = await startRun('learningConceptAssessmentWorkflow', { runId: p.runId })
    await until(() => p.calls() === 1, 30_000, 'the main grading call', first)
    const group = wrapperGroup(p.runId, `assessment:${p.runId}`)
    await stop(first, 'SIGKILL')
    process.kill(-group, 'SIGKILL')
    const second = startWorker(fake(p, 300, metered))
    await finished(wf, second)
    const o = await outcome(p.runId)
    expect(o.readings).toBe(0)
    expect(o.receipts).not.toContain('completed')
    // Never taken over; each refused claim (one per step attempt) is recorded with its reason.
    expect(o.reclaims.length).toBeGreaterThan(0)
    expect(new Set(o.reclaims)).toEqual(new Set(['refused assessment']))
    expect(p.calls()).toBe(1)
    await stop(second, 'SIGTERM')
  }, 300_000)
})
