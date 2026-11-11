import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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
import { ASSESSMENT_MODEL, buildConceptAssessmentInput } from '@learner/core/lib/learning/learning-concept-assessment.js'
import { conceptFromGraphs } from '@learner/core/services/learning-concept-assessment.js'
import { attemptDirectory } from '@learner/llm/lib/cli/durable-cli-call.js'
import { type Crashable, fakeCli, spawnCrashable, until } from '@learner/llm/lib/cli/testing/crash-harness.js'

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
      cwd: PKG, env: { ...process.env, LEARNER_RUNTIME_DIRECTORY: join(scratch, 'runtime'), LEARNER_ATTEMPT_POLL_MS: '100', LEARNER_RUNTIME_ROLE: 'learning-worker', ...env },
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
  const startRun = async (runId: string) => {
    const services = await booted
    const rpc = rpcService.getContextRPCService(services, {}, false)
    const started = await services.workflowService.startWorkflow('learningConceptAssessmentWorkflow', { runId }, { type: 'internal' }, rpc)
    return started.runId
  }
  const finished = async (workflowRunId: string, w: Crashable) => {
    const services = await booted
    let status = ''
    await until(async () => { status = (await services.workflowRunService.getRun(workflowRunId))?.status ?? ''; return ['completed', 'failed', 'cancelled'].includes(status) }, 60_000, `run ${workflowRunId}`, w)
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
  const fake = (p: Awaited<ReturnType<typeof prepared>>, sleepMs: number, extra: Record<string, string> = {}) => fakeCli(scratch, p.runId, p.answer, sleepMs, extra).env
  const wrapperGroup = (runId: string, key: string) => Number(readFileSync(join(attemptDirectory(key, attempts), 'call-1', 'wrapper.pid'), 'utf8'))

  test('SIGKILL during the main grading call: the restarted worker adopts the detached call; one receipt, one reading, nothing paid twice', async () => {
    const p = await prepared()
    const first = startWorker(fake(p, 2_500))
    const wf = await startRun(p.runId)
    await until(() => p.calls() === 1, 30_000, 'the main grading call', first)
    await stop(first, 'SIGKILL')
    const second = startWorker(fake(p, 300))
    expect(await finished(wf, second)).toBe('completed')
    expect(await outcome(p.runId)).toEqual({ receipts: ['completed'], replicates: ['completed'], readings: 1, reclaims: ['takeover assessment'] })
    expect(p.calls()).toBe(2) // the main grading (once, adopted) + replicate 2
    await stop(second, 'SIGTERM')
  }, 120_000)

  test('SIGTERM during a replicate call: the stop hands the step over cleanly and the run completes with one replicate receipt', async () => {
    const p = await prepared()
    const first = startWorker(fake(p, 2_500))
    const wf = await startRun(p.runId)
    await until(() => p.calls() === 2, 40_000, 'the replicate call', first)
    await stop(first, 'SIGTERM')
    const second = startWorker(fake(p, 300))
    expect(await finished(wf, second)).toBe('completed')
    const o = await outcome(p.runId)
    expect({ ...o, reclaims: [] }).toEqual({ receipts: ['completed'], replicates: ['completed'], readings: 1, reclaims: [] })
    expect(p.calls()).toBe(2)
    await stop(second, 'SIGTERM')
  }, 120_000)

  test('the worker AND its CLI child are killed (a control-group stop): the repeat-free call runs again once; one receipt, one reading', async () => {
    const p = await prepared()
    const first = startWorker(fake(p, 2_500))
    const wf = await startRun(p.runId)
    await until(() => p.calls() === 1, 30_000, 'the main grading call', first)
    const group = wrapperGroup(p.runId, `assessment:${p.runId}`)
    await stop(first, 'SIGKILL')
    process.kill(-group, 'SIGKILL')
    const second = startWorker(fake(p, 300))
    expect(await finished(wf, second)).toBe('completed')
    expect(await outcome(p.runId)).toEqual({ receipts: ['completed'], replicates: ['completed'], readings: 1, reclaims: ['takeover assessment'] })
    expect(p.calls()).toBe(3) // main, main again (free), replicate 2
    await stop(second, 'SIGTERM')
  }, 120_000)

  test('a metered backend never pays twice: the killed call is not repeated, and the run does not publish a reading', async () => {
    const p = await prepared()
    const metered = { LEARNER_METERED_BACKENDS: 'codex' }
    const first = startWorker(fake(p, 2_500, metered))
    const wf = await startRun(p.runId)
    await until(() => p.calls() === 1, 30_000, 'the main grading call', first)
    const group = wrapperGroup(p.runId, `assessment:${p.runId}`)
    await stop(first, 'SIGKILL')
    process.kill(-group, 'SIGKILL')
    const second = startWorker(fake(p, 300, metered))
    await finished(wf, second)
    const o = await outcome(p.runId)
    expect(o.readings).toBe(0)
    expect(o.receipts).not.toContain('completed')
    expect(o.reclaims).toEqual([])
    expect(p.calls()).toBe(1)
    await stop(second, 'SIGTERM')
  }, 120_000)
})
