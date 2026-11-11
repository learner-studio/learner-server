import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rpcService } from '@pikku/core/rpc'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { SIM_ARMS, deleteSimRun, type SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { analyzeSimRun, loadSimRun, plannedCalls } from '@learner/core/lib/learning/learning-sim-analysis.js'
import { HALYARD_CATALOG, HALYARD_HELD_OUT } from '@learner/core/lib/learning/learning-sim-halyard.js'

/**
 * learningSimLearnerWorkflow end to end on learner_test (docs/specs/simulated-learner-experiment.md): one learner
 * per arm, queued steps on pg-boss, the stub transport and stub grader model, so it proves the loop is wired and
 * idempotent, never an effect. SIM_LIVE=true runs the same loop on the real Codex transport (slow; paid from the
 * subscription), still on learner_test.
 */
const live = process.env.SIM_LIVE === 'true'
const model = (effort: string) => ({ model: 'gpt-5.6-luna', effort, timeoutSec: 300 })
const config = (runId: string, arm: SimLearnerConfig['arm'], i: number): SimLearnerConfig => ({
  runId, learnerId: `l${String(i + 1).padStart(2, '0')}`, arm, lane: 'medium', sessions: 2, turns: 2,
  transport: live ? 'codex' : 'stub', learnerModel: model('low'), agentModel: model('low'), scorerModel: model('low'),
  retests: 1, leakageProbe: true,
})

describe.skipIf(!process.env.TEST_DATABASE_URL)('simulated-learner workflow, framework runtime (learner_test)', () => {
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_pikku_boss_test'
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
  })

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
      expect(n.notebook).toBe(2)
      expect(n['exam-answer']).toBe(3)
      expect(n['exam-score']).toBe(3)
      // The agent submits feedback through the hook path only in the Learner arms.
      expect(n['agent-match'] ?? 0).toBe(configs[i]!.arm === 'off' ? 0 : 4)
    }
    // Agent turns of the Learner arms went through the live feedback tables under the Halyard catalog.
    const turns = await services.db.query(`SELECT count(*)::int n, count(DISTINCT catalog_version)::int versions, min(catalog_version) version FROM learning_live_feedback_turns WHERE user_id LIKE $1`, [`sim-${runId.slice(0, 8)}-%`])
    expect(turns.rows[0]).toMatchObject({ n: 12, versions: 1, version: HALYARD_CATALOG.version })
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
    expect(HALYARD_HELD_OUT.size).toBeGreaterThan(0)
    expect(report.claim1.byArm.off!.examGain.n).toBe(1)
    const planned = configs.reduce((n, c) => n + Object.values(plannedCalls(c)).reduce((x, y) => x + y, 0), 0)
    expect(report.cost.calls).toBeGreaterThan(0)
    expect(report.cost.calls).toBeLessThanOrEqual(planned)

    // A rerun with the same configs is free: every model call is answered from its receipt.
    const before = (await services.db.query('SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1', [runId])).rows[0]
    const again = await runAll(configs)
    expect(again.map((r) => r.status)).toEqual(configs.map(() => 'completed'))
    expect((await services.db.query('SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1', [runId])).rows[0]).toEqual(before)
  }, live ? 3_600_000 : 300_000)
})
