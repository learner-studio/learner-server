import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { rpcService } from '@pikku/core/rpc'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { SIM_ARMS, SimLearnerConfig as SimLearnerConfigSchema, deleteSimRun, simStubGrader, type SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { batch2Slots, factBudget, SIM_DAY_GAP, stratifiedHoldout } from '@learner/core/lib/learning/learning-sim-design.js'
import { HALYARD_FACT_EXAM, factSheet } from '@learner/core/lib/learning/learning-sim-facts.js'
import { loadLearningPolicy, saveLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { analyzeSimRun, loadSimRun, plannedCalls, renderSimReport } from '@learner/core/lib/learning/learning-sim-analysis.js'
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
  const runIdV2 = randomUUID()
  const fixtureRuns: string[] = []
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    const services = await createSingletonServices(await createConfig())
    // Gradings of the Learner arms run the product assessment workflow at k = 2 (one prior-blind replicate each),
    // on the stub grader model unless live.
    if (!live) (services as { learningConceptAssessment: unknown }).learningConceptAssessment = simStubGrader(services.learningCurriculumStore)
    const { updatedAt: _, ...policy } = await loadLearningPolicy()
    priorPolicy = policy
    await saveLearningPolicy({ ...policy, gradingReplicates: 2 }, 'simulated-learner-test')
    await services.backgroundJobs.start()
    return services
  })()
  let priorPolicy: Parameters<typeof saveLearningPolicy>[0] | null = null
  afterAll(async () => {
    const services = await booted
    if (priorPolicy) await saveLearningPolicy(priorPolicy, 'simulated-learner-test')
    // Only the grader's immutable assessment runs (and rows referencing them) may stay behind.
    for (const id of [runId, runIdV2, ...fixtureRuns]) expect((await deleteSimRun(id)).every((t) => t.startsWith('learning_concept_assessment') || t.startsWith('learning_vector_turn') || t.startsWith('learning_consolidator'))).toBe(true)
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
    const planned = configs.reduce((n, c) => n + Object.values(plannedCalls(c, 2)).reduce((x, y) => x + y, 0), 0)
    expect(report.cost.calls).toBeGreaterThan(0)
    expect(report.cost.calls).toBeLessThanOrEqual(planned)

    // Every grading of a Learner arm ran the product's assessment workflow, once per assessment run, with its planned
    // prior-blind replicate; the off arm graded directly (no workflow, no replicate).
    const graded = (await services.db.query(`SELECT c.learner_id, c.call_key, c.output->>'text' AS text FROM learning_sim_calls c
      WHERE c.run_id=$1 AND c.role='grader' AND c.call_key ~ '^s[0-9]+:grade:'`, [runId])).rows as Array<{ learner_id: string; call_key: string; text: string }>
    const armOf = (learnerId: string) => configs.find((c) => c.learnerId === learnerId)!.arm
    const main = graded.filter((g) => !/:r\d+$/.test(g.call_key))
    const assessmentRuns = (arm: (a: string) => boolean) => main.filter((g) => arm(armOf(g.learner_id))).map((g) => (JSON.parse(g.text) as { assessmentRunId: string }).assessmentRunId)
    const viaWorkflow = assessmentRuns((a) => a !== 'off'), direct = assessmentRuns((a) => a === 'off')
    expect(viaWorkflow.length).toBeGreaterThan(0)
    const flows = (ids: string[]) => services.db.query(`SELECT input::jsonb->>'runId' AS run, count(*)::int n, min(status) status FROM learner_workflow_runs
      WHERE workflow='learningConceptAssessmentWorkflow' AND input::jsonb->>'runId' = ANY($1::text[]) GROUP BY 1`, [ids])
    const flowRows = (await flows(viaWorkflow)).rows as Array<{ n: number; status: string }>
    expect(flowRows.length).toBe(viaWorkflow.length)
    expect(flowRows.every((r) => r.n === 1 && r.status === 'completed')).toBe(true)
    expect((await flows(direct)).rows).toEqual([])
    const replicated = (await services.db.query(`SELECT count(*)::int n FROM learning_concept_assessment_replicate_summaries WHERE run_id::text = ANY($1::text[]) AND replicates >= 1`, [viaWorkflow])).rows[0] as { n: number }
    expect(replicated.n).toBe(viaWorkflow.length)
    expect(graded.filter((g) => g.call_key.endsWith(':r2')).length).toBe(viaWorkflow.length)
    expect(graded.filter((g) => g.call_key.endsWith(':r2') && armOf(g.learner_id) === 'off')).toEqual([])

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
  // Batch 2 (docs/specs/simulated-learner-experiment.md, "Batch 2"): arm off in every lane, on and oracle in medium.
  // `k` picks the holdout block and Latin-square row; the three off learners share one, so only the lane differs.
  const v2 = (arm: SimLearnerConfig['arm'], lane: SimLearnerConfig['lane'], i: number, k: number): SimLearnerConfig => SimLearnerConfigSchema.parse({
    runId: runIdV2, learnerId: `l${lane === 'slow' ? 1 : lane === 'medium' ? 2 : 3}${String(i).padStart(3, '0')}`, arm, lane, sessions: 2, turns: 2,
    transport: live ? 'codex' : 'stub', learnerModel: model('low'), agentModel: model('low'), scorerModel: model('low'), retests: 0, leakageProbe: false,
    design: 'v2', heldOut: stratifiedHoldout(k, 'e2e'), taskOrder: [k % 5, (k + 1) % 5], factBudget: factBudget(lane), dayGap: SIM_DAY_GAP,
  })

  test('batch 2: fact budget held, no baseline exam, a simulated calendar, only arm on grades, and the lanes clock in order', async () => {
    const services = await booted
    const configs = [v2('off', 'slow', 1, 0), v2('off', 'medium', 2, 0), v2('off', 'fast', 3, 0), v2('on', 'medium', 4, 1), v2('oracle', 'medium', 5, 1)]
    const runs = await runAll(configs)
    expect(runs.map((r) => r.status)).toEqual(configs.map(() => 'completed'))
    for (const [i, run] of runs.entries()) {
      const out = run.output as { exams: Array<{ timepoint: number; total: number }>; calls: Array<{ role: string; n: number }> }
      const n = Object.fromEntries(out.calls.map((c) => [c.role, c.n]))
      // The baseline is an empty notebook's 0, never a model call.
      expect(out.exams.map((e) => e.timepoint)).toEqual([0, 1, 2])
      expect(out.exams[0]!.total).toBe(0)
      expect(n['exam-answer']).toBe(2)
      expect(n['agent-match'] ?? 0).toBe(configs[i]!.arm === 'off' ? 0 : 4)
      // Only arm on grades (its injection reads the grader), and never after the last session.
      expect(n.grader ?? 0).toBe(configs[i]!.arm === 'on' ? (n.grader ?? 0) : 0)
    }
    const graded = (await services.db.query(`SELECT learner_id, call_key FROM learning_sim_calls WHERE run_id=$1 AND role='grader'`, [runIdV2])).rows as Array<{ learner_id: string; call_key: string }>
    expect(graded.length).toBeGreaterThan(0)
    expect(graded.every((g) => g.learner_id === configs[3]!.learnerId && g.call_key.startsWith('s1:'))).toBe(true)
    // The budget: stated sheet facts per session never exceed it, and each is a fact the agent was shown.
    const agent = (await services.db.query(`SELECT learner_id, session, meta FROM learning_sim_messages WHERE run_id=$1 AND role='agent'`, [runIdV2])).rows as Array<{ learner_id: string; session: number; meta: { statedFactIds: string[]; sheets: string[] } }>
    for (const c of configs) for (const session of [1, 2]) {
      const turns = agent.filter((m) => m.learner_id === c.learnerId && m.session === session)
      const stated = turns.flatMap((m) => m.meta.statedFactIds)
      expect(stated.length).toBeGreaterThan(0)
      expect(stated.length).toBeLessThanOrEqual(c.factBudget!)
      expect(stated.every((id) => turns.some((m) => m.meta.sheets.some((sheet) => factSheet(sheet).facts.some((f) => f.id === id))))).toBe(true)
    }
    // The calendar: session 2 is dayGap days after session 1, in the past, for messages and live turns alike.
    const at = (await services.db.query(`SELECT session, min(created_at) AS at FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 GROUP BY session ORDER BY session`, [runIdV2, configs[3]!.learnerId])).rows as Array<{ at: Date }>
    expect(Math.round((at[1]!.at.getTime() - at[0]!.at.getTime()) / 86_400_000)).toBe(SIM_DAY_GAP)
    expect(at[1]!.at.getTime()).toBeLessThan(Date.now())
    const turns = (await services.db.query(`SELECT session_id, min(created_at) AS at, min(submitted_at) AS submitted FROM learning_live_feedback_turns WHERE user_id=$1 GROUP BY session_id ORDER BY 2`, [`sim-${runIdV2.slice(0, 8)}-${configs[3]!.learnerId}`])).rows as Array<{ at: Date; submitted: Date }>
    expect(turns.length).toBe(2)
    expect(Math.round((turns[1]!.at.getTime() - turns[0]!.at.getTime()) / 86_400_000)).toBe(SIM_DAY_GAP)
    expect(Math.abs(turns[0]!.submitted.getTime() - turns[0]!.at.getTime())).toBeLessThan(3_600_000)
    // The lanes still clock in the right order: the final exam rises with capacity (slow < medium < fast).
    const report = analyzeSimRun(await loadSimRun(runIdV2))
    const lanes = report.batch2!.checks.laneOrder.off!.map((l) => l.finalExam)
    expect(lanes[0]!).toBeLessThan(lanes[1]!)
    expect(lanes[1]!).toBeLessThan(lanes[2]!)
    expect(report.batch2!.checks.offLanesOrdered).toBe(true)
    expect(report.batch2!.checks.heldOutTargeted).toBe(0)
    expect(report.batch2!.checks.incomplete).toEqual([])
  }, live ? 3_600_000 : 300_000)

  /** A whole batch-2 run written as rows (no model call), read back by loadSimRun and analysed: the analysis path end
   * to end. Ability per learner, `effect` added to arm on's chance of knowing each fact; agents in Learner arms state
   * facts of the concept their injection targeted, arm off states a random concept's. */
  const plant = async (effect: number, seed: number) => {
    const rid = randomUUID()
    fixtureRuns.push(rid)
    let state = seed
    const r = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 }
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r())
    const services = await booted
    const ids = [...new Set(HALYARD_FACT_EXAM.map((q) => q.conceptId))]
    for (const slot of batch2Slots(rid, ['slow', 'medium'], () => 16, ['off', 'on', 'oracle'], 5)) {
      const learnerId = `l${slot.lane === 'slow' ? 1 : 2}${String(slot.index).padStart(3, '0')}`
      const config = SimLearnerConfigSchema.parse({ runId: rid, learnerId, arm: slot.arm, lane: slot.lane, sessions: 5, turns: 3, transport: 'stub', learnerModel: model('low'), agentModel: model('low'), scorerModel: model('low'),
        design: 'v2', heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap })
      await services.db.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [rid, learnerId, `sim-${rid.slice(0, 8)}-${learnerId}`, slot.arm, slot.lane, JSON.stringify(config)])
      const ability = 0.25 + 0.06 * normal() + (slot.lane === 'medium' ? 0.05 : 0) + (slot.arm === 'on' ? effect : 0)
      for (let t = 1; t <= 5; t++) {
        const scores = HALYARD_FACT_EXAM.map((q) => ({ id: q.id, points: r() < (ability * t) / 5 ? 2 : 0, note: 'planted' }))
        await services.db.query(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,$2,$3,'exam-score','planted','low',0,1,$4::jsonb)`, [rid, learnerId, `exam${t}:score`, JSON.stringify({ text: JSON.stringify({ scores }) })])
        const target = ids.filter((id) => !slot.heldOut.includes(id))[Math.floor(r() * 10)]!
        const stated = factSheet(slot.arm === 'off' ? ids[Math.floor(r() * ids.length)]! : target).facts.slice(0, slot.factBudget).map((f) => f.id)
        const meta = { decision: slot.arm === 'off' ? 'none' : 'influence', conceptIds: slot.arm === 'off' ? [] : [target], statedFactIds: stated, sheets: [], lookups: [], budgetLeft: slot.factBudget, overBudget: 0, invalidFacts: 0, review: null }
        await services.db.query(`INSERT INTO learning_sim_messages(run_id,learner_id,session,seq,role,text,meta) VALUES($1,$2,$3,1,'agent','planted',$4::jsonb)`, [rid, learnerId, t, JSON.stringify(meta)])
      }
    }
    const report = analyzeSimRun(await loadSimRun(rid))
    return { report, text: renderSimReport(rid, report) }
  }

  test('batch 2 analysis: a planted effect is recovered and a planted null stays null, through load, analysis and report', async () => {
    const effect = await plant(0.1, 7)
    const b = effect.report.batch2!
    expect(b.complete).toBe(96)
    expect(b.outcome.verdict).toBe('supported')
    expect(b.outcome.primary.mean).toBeGreaterThan(6)
    expect(b.outcome.primary.mean).toBeLessThan(14)
    expect(b.outcome.contrasts['oracle - off']!.examGain.lo).toBeLessThanOrEqual(0)
    expect(b.checks.offWithinLearnerCoversZero).toBe(true)
    expect(b.checks.offLanesOrdered).toBe(true)
    expect(b.mechanism.on!.targetedDose).toBeGreaterThan(b.mechanism.on!.otherDose)
    expect(effect.text).toContain('Verdict: supported')
    // Mechanism checks are reported before the outcome.
    expect(effect.text.indexOf('Mechanism checks')).toBeLessThan(effect.text.indexOf('### 3. Outcome'))

    const nil = (await plant(0, 11)).report.batch2!
    expect(nil.outcome.verdict).toBe('not shown')
    expect(nil.outcome.primary.lo).toBeLessThanOrEqual(0)
    expect(nil.outcome.primary.hi).toBeGreaterThanOrEqual(0)
    expect(nil.checks.offWithinLearnerCoversZero).toBe(true)
  }, 120_000)
})
