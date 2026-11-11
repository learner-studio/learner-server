import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { rpcService } from '@pikku/core/rpc'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { SIM_ARMS, deleteSimRun, type SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { analyzeSimRun, loadSimRun, plannedCalls } from '@learner/core/lib/learning/learning-sim-analysis.js'
import { HALYARD_CATALOG, HALYARD_HELD_OUT } from '@learner/core/lib/learning/learning-sim-halyard.js'

/**
 * learningSimLearnerWorkflow end to end on its OWN database, learner_sim_test_<checkout> (never the shared
 * learner_test, where a fictional curriculum is read by every other test file; one per checkout, so a lane's
 * unpushed migration never breaks another lane's suite). The database is created when the role may
 * (CI's throwaway Postgres) and migrated; without it the file is skipped. One learner per arm, queued steps on
 * pg-boss, the stub transport and stub grader model, so it proves the loop is wired and idempotent, never an
 * effect. SIM_LIVE=true runs the same loop on the real Codex transport (slow; paid from the subscription).
 */
// One database per checkout when it exists (created once by an admin: the test role may not CREATE DATABASE), so a
// lane's unpushed migration never breaks another lane's suite; otherwise the shared learner_sim_test.
const ownDatabase = `learner_sim_test_${createHash('sha256').update(fileURLToPath(new URL('../../..', import.meta.url))).digest('hex').slice(0, 8)}`
let simDatabase = 'learner_sim_test'
const urlFor = (name: string) => { const u = new URL(process.env.TEST_DATABASE_URL!); u.pathname = `/${name}`; return u.toString() }
const ready = await (async () => {
  if (!process.env.TEST_DATABASE_URL) return false
  const { Client } = await import('pg')
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await admin.connect()
  try {
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [ownDatabase])).rowCount) simDatabase = ownDatabase
    else if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [simDatabase])).rowCount) await admin.query(`CREATE DATABASE ${simDatabase}`)
  } catch (error) {
    console.warn(`[simulated-learner] skipped: ${simDatabase} is missing and cannot be created (${String(error).slice(0, 120)})`)
    return false
  } finally { await admin.end() }
  const { migrateToLatest } = await import('../../server/src/db/migrate.js')
  await migrateToLatest(urlFor(simDatabase))
  return true
})()
const simUrl = ready ? urlFor(simDatabase) : null
const live = process.env.SIM_LIVE === 'true'
const model = (effort: string) => ({ model: 'gpt-5.6-luna', effort, timeoutSec: 300 })
const config = (runId: string, arm: SimLearnerConfig['arm'], i: number): SimLearnerConfig => ({
  runId, learnerId: `l${String(i + 1).padStart(2, '0')}`, arm, lane: 'medium', sessions: 2, turns: 2,
  transport: live ? 'codex' : 'stub', learnerModel: model('low'), agentModel: model('low'), scorerModel: model('low'),
  retests: 1, leakageProbe: true,
})

describe.skipIf(!ready)('simulated-learner workflow, framework runtime (learner_sim_test_<checkout>)', () => {
  // Every service of this file binds learner_sim_test_<checkout> (createSingletonServices rebinds the process database).
  process.env.LEARNER_DATABASE_URL = simUrl!
  process.env.DATABASE_URL = simUrl!
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  // Its own queue schema: workers that stop at the end of this file must never hold another test file's jobs.
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_pikku_boss_test_sim'
  delete process.env.LEARNER_SCHEDULES_ENABLED
  setRuntimeRole('learning-worker')
  const runId = randomUUID()
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    const services = await createSingletonServices(await createConfig())
    await services.backgroundJobs.start()
    return services
  })()
  afterAll(async () => {
    const services = await booted
    // Only the grader's immutable assessment runs (and rows referencing them) may stay behind.
    expect((await deleteSimRun(runId)).every((t) => t.startsWith('learning_concept_assessment') || t.startsWith('learning_vector_turn') || t.startsWith('learning_consolidator'))).toBe(true)
    await services.backgroundJobs.stop()
  }, 60_000)

  const runAll = async (configs: SimLearnerConfig[]) => {
    const services = await booted
    const rpc = rpcService.getContextRPCService(services, {}, false)
    const ids = await Promise.all(configs.map(async (c) => (await services.workflowService.startWorkflow('learningSimLearnerWorkflow', c, { type: 'internal' }, rpc)).runId))
    const deadline = Date.now() + (live ? 3_500_000 : 250_000)
    const runs = []
    for (const id of ids) {
      let run = await services.workflowRunService.getRun(id)
      while (run && !['completed', 'failed', 'cancelled'].includes(run.status) && Date.now() < deadline) {
        await Bun.sleep(500)
        run = await services.workflowRunService.getRun(id)
      }
      runs.push(run!)
    }
    return runs
  }

  test('every arm completes: exams per timepoint, Learner calls only in the Learner arms, receipts reused on a rerun', async () => {
    const services = await booted
    const configs = SIM_ARMS.map((arm, i) => config(runId, arm, i))
    const runs = await runAll(configs)
    expect(runs.map((r) => r.status)).toEqual(configs.map(() => 'completed'))
    for (const [i, run] of runs.entries()) {
      const out = run.output as { arm: string; exams: Array<{ timepoint: number }>; calls: Array<{ role: string; n: number }> }
      expect(out.arm).toBe(configs[i]!.arm)
      expect(out.exams.map((e) => e.timepoint)).toEqual([0, 1, 2])
      const n = Object.fromEntries(out.calls.map((c) => [c.role, c.n]))
      expect(n.learner).toBe(4)
      expect(n['agent-reply']).toBe(4)
      expect(n.notebook ?? 0).toBe(configs[i]!.arm === 'frozen' ? 0 : 2)
      expect(n['exam-answer']).toBe(3)
      expect(n['exam-score']).toBe(3)
      // The agent submits feedback through the hook path only in the Learner arms.
      expect(n['agent-match'] ?? 0).toBe(configs[i]!.arm === 'off' ? 0 : 4)
    }
    // Agent turns of the Learner arms went through the live feedback tables under the Halyard catalog.
    const turns = await services.db.query(`SELECT count(*)::int n, count(DISTINCT catalog_version)::int versions, min(catalog_version) version FROM learning_live_feedback_turns WHERE user_id LIKE $1`, [`sim-${runId.slice(0, 8)}-%`])
    expect(turns.rows[0]).toMatchObject({ n: 4 * configs.filter((c) => c.arm !== 'off').length, versions: 1, version: HALYARD_CATALOG.version })
    // The control arm's agent saw irrelevant text where the hook's text would be; the off arm saw neither.
    const meta = await services.db.query(`SELECT learner_id, meta FROM learning_sim_messages WHERE run_id=$1 AND role='agent'`, [runId])
    for (const row of meta.rows as Array<{ learner_id: string; meta: { injectedChars?: number; decision?: string } }>) {
      const arm = configs.find((c) => c.learnerId === row.learner_id)!.arm
      if (arm === 'off') expect(row.meta).toMatchObject({ decision: 'none', injectedChars: 0 })
      else expect(row.meta.injectedChars).toBeGreaterThan(0)
    }

    // The analysis reads the run back without a model call: every learner complete, no held-out concept ever
    // injected, and calls within the plan (grading skips concepts with no new evidence).
    const report = analyzeSimRun(await loadSimRun(runId))
    expect(report.validity.incomplete).toEqual([])
    expect(report.validity.heldOutInjections).toBe(0)
    // Memory is never cut: every note a learner wrote is in its stored notebook.
    expect(report.validity.notebookTruncated).toBe(0)
    expect(report.validity.notebookCutChars).toBe(0)
    expect(HALYARD_HELD_OUT.size).toBeGreaterThan(0)
    expect(report.claim1.byArm.off!.examGain.n).toBe(1)
    // The frozen learner keeps no notebook, so its exam cannot move from the baseline (the ratchet control).
    const frozen = runs[configs.findIndex((c) => c.arm === 'frozen')]!.output as { exams: Array<{ total: number }> }
    expect(new Set(frozen.exams.map((e) => e.total)).size).toBe(1)
    expect(report.claim2.gradings.frozen!.gradings).toBeGreaterThan(0)
    const planned = configs.reduce((n, c) => n + Object.values(plannedCalls(c)).reduce((x, y) => x + y, 0), 0)
    expect(report.cost.calls).toBeGreaterThan(0)
    expect(report.cost.calls).toBeLessThanOrEqual(planned)

    // A rerun with the same configs is free: every model call is answered from its receipt.
    const before = (await services.db.query('SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1', [runId])).rows[0]
    const again = await runAll(configs)
    expect(again.map((r) => r.status)).toEqual(configs.map(() => 'completed'))
    expect((await services.db.query('SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1', [runId])).rows[0]).toEqual(before)

    // Every grading is a counted call, the retests and leakage probes included, so the cap sees all of them.
    const leaks = (await services.db.query(`SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1 AND role='grader' AND call_key LIKE 'leak:%'`, [runId])).rows[0]
    expect(leaks).toEqual({ n: 3 * configs.filter((c) => c.leakageProbe).length })

    // The hard cap: at the cap a stored receipt still answers, and no new call starts.
    const { setSimCallCap, simCall, stubTransport, SimCallBudgetExhausted } = await import('@learner/core/lib/learning/learning-sim-model.js')
    setSimCallCap({ runId, max: (before as { n: number }).n })
    try {
      const learnerId = configs[0]!.learnerId
      const spec = { model: 'stub', effort: 'low', timeoutSec: 30, runId, learnerId, role: 'learner' as const, prompt: 'cap probe' }
      const stored = (await services.db.query(`SELECT call_key FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND role='learner' LIMIT 1`, [runId, learnerId])).rows[0] as { call_key: string }
      expect((await simCall({ ...spec, callKey: stored.call_key }, stubTransport())).reused).toBe(true)
      await expect(simCall({ ...spec, callKey: 'cap-probe' }, stubTransport())).rejects.toBeInstanceOf(SimCallBudgetExhausted)
      // A whole rerun under the cap is still free and completes: it only replays receipts.
      expect((await runAll(configs)).map((r) => r.status)).toEqual(configs.map(() => 'completed'))
    } finally {
      setSimCallCap(null)
    }
  }, live ? 3_600_000 : 300_000)
})
