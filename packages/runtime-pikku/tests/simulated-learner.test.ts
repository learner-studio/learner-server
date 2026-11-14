import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeCli, spawnCrashable, until } from '@learner/llm/lib/cli/testing/crash-harness.js'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { rpcService } from '@pikku/core/rpc'
import { acquireRuntimeRole, releaseRuntimeRole, setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { SimLearnerConfig as SimLearnerConfigSchema, deleteSimRun, SIM_SHEETS, simPairKey, simProbeUserId, simStubGrader, type SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { draw, replayExams } from '@learner/core/lib/learning/learning-sim-memory.js'
import { simSlots, factBudget, SIM_DAY_GAP, stratifiedHoldout, williamsRow } from '@learner/core/lib/learning/learning-sim-design.js'
import { EXAM_FACTS, factsBySentence, unread, type StatedFact } from '@learner/core/lib/learning/learning-sim-matcher.js'
import { HALYARD_FACT_EXAM, factSheet } from '@learner/core/lib/learning/learning-sim-facts.js'
import { loadLearningPolicy, saveLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { analyzeSimRun, loadSimRun, plannedCalls, probeChangeTracking, renderSimReport, sessionDeliveries } from '@learner/core/lib/learning/learning-sim-analysis.js'
import { BLIND_COUNTED } from '@learner/core/lib/learning/mastery-notifications.js'
import { masteryChanges } from '@learner/core/lib/learning/mastery-change.js'
import { HALYARD_CATALOG, HALYARD_TASKS } from '@learner/core/lib/learning/learning-sim-halyard.js'
import { anchorPlan, staticPlan } from '@learner/core/lib/learning/learning-sim-ceiling.js'
import { judgeSample } from '@learner/core/lib/learning/learning-sim-judge.js'

/**
 * learningSimLearnerWorkflow (with its session and grade child runs) end to end on its OWN database
 * (own-test-database.ts: one per run where the role may create it, as in CI and the pre-push gate, else the
 * admin-created learner_sim_test_<checkout>; never the shared learner_test, where a fictional curriculum is read by
 * every other test file). Without it the file is skipped. One learner per arm, queued steps on
 * pg-boss, the stub transport and stub grader model, so it proves the loop is wired and idempotent, never an
 * effect. SIM_LIVE=true runs the same loop on the real Codex transport (slow; paid from the subscription).
 */
const simUrl = await ownTestDatabaseUrl('sim')
const ready = simUrl !== null
const live = process.env.SIM_LIVE === 'true'
const model = (effort: string) => ({ model: 'gpt-5.6-luna', effort, timeoutSec: 300 })

describe.skipIf(!ready)('simulated-learner workflow, framework runtime (learner_sim_test_<checkout>)', () => {
  // Every service of this file binds learner_sim_test_<checkout> (createSingletonServices rebinds the process database).
  process.env.LEARNER_DATABASE_URL = simUrl!
  process.env.DATABASE_URL = simUrl!
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  // Its own queue schema: workers that stop at the end of this file must never hold another test file's jobs.
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_pikku_boss_test_sim'
  delete process.env.LEARNER_SCHEDULES_ENABLED
  // Small pools: the gate's Postgres (max_connections 100) is shared by concurrent lanes, and the runtime defaults
  // (20 + 10) let four lanes exhaust it ("too many clients already").
  process.env.LEARNER_POOL_MAX = '4'
  process.env.LEARNER_BOSS_POOL_MAX = '3'
  setRuntimeRole('learning-worker')
  // Fixed: the memory rules draw from `${runId}|${learnerId}`, so a random id made the one-learner-per-lane order a
  // coin flip (slow and fast tied at 10 in 1 run of 4). Each run has its own database, so a fixed id cannot collide.
  const runId = 'e2e00000-0000-4000-8000-0000000000b2'
  const fixtureRuns: string[] = []
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    const services = await createSingletonServices(await createConfig())
    // The dev box's per-checkout database is reused, and the fixed run ids of this file (b2, b6) then meet the last
    // run's rows that deleteSimRun leaves: its gradings (append-only; row triggers refuse DELETE), which a rerun takes
    // for its own (no reservation, and the cap probe runs out of concepts), and its model-call attempt leases, which
    // a rerun takes over until the takeover budget refuses the call. A run that failed also leaves workflow runs
    // `running` with their jobs queued, which this file's worker (and the crash test's recovery) would pick up ahead
    // of its own. Only this file uses this database and this queue schema, so it starts from empty ledgers, runs and
    // jobs (the registered workflow versions stay); TRUNCATE fires no row trigger. Never on learner_sim (the
    // runner's): the name must be a per-checkout test database. CI creates a database per run and finds them empty.
    const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
    if (/^learner_sim_test_[a-z0-9]{8}$/.test(await assertSimDatabase())) {
      await services.db.query(`TRUNCATE learning_concept_assessment_runs, learning_llm_attempt_leases, learning_llm_attempt_reclaims,
        learning_sim_calls, learning_sim_messages, learning_sim_looks, learning_sim_learners,
        learner_workflow_runs, learner_workflow_steps, learner_workflow_step_history CASCADE`)
      if ((await services.db.query(`SELECT to_regclass('learner_pikku_boss_test_sim.job') AS t`)).rows[0]?.t) await services.db.query('TRUNCATE learner_pikku_boss_test_sim.job')
    }
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
    for (const id of [runId, ...fixtureRuns]) expect((await deleteSimRun(id)).every((t) => t.startsWith('learning_concept_assessment') || t.startsWith('learning_vector_turn') || t.startsWith('learning_consolidator'))).toBe(true)
    await services.backgroundJobs.stop()
  }, 60_000)

  const settle = async (id: string, ms: number) => {
    const services = await booted
    let run = await services.workflowRunService.getRun(id)
    for (const deadline = Date.now() + ms; run && !['completed', 'failed', 'cancelled'].includes(run.status) && Date.now() < deadline; run = await services.workflowRunService.getRun(id)) await Bun.sleep(500)
    return run!
  }
  /** The test sim worker (sim-worker.fixture.ts) in its own process, queue schema and runtime directory. */
  const CRASH_SCHEMA = 'learner_pikku_boss_test_sim_crash'
  const simWorker = (scratch: string, env: Record<string, string>) => spawnCrashable(['bun', fileURLToPath(new URL('./sim-worker.fixture.ts', import.meta.url))], {
    env: { ...process.env, LEARNER_PIKKU_PGBOSS_SCHEMA: CRASH_SCHEMA, LEARNER_RUNTIME_DIRECTORY: join(scratch, 'runtime'), ...env } })
  /** Learner runs on this process's workers; their summaries, in config order. */
  const runBatch = async (configs: SimLearnerConfig[]) => {
    const services = await booted
    const rpc = rpcService.getContextRPCService(services, {}, false)
    const ids = []
    for (const c of configs) ids.push((await services.workflowService.startWorkflow('learningSimLearnerWorkflow', c, { type: 'internal' }, rpc)).runId)
    const runs = []
    for (const id of ids) runs.push(await settle(id, live ? 3_500_000 : 250_000))
    expect(runs.map((r) => r.status)).toEqual(configs.map(() => 'completed'))
    return runs.map((r) => r.output as { learnerId: string; arm: string; exams: Array<{ timepoint: number; total: number }>; calls: Array<{ role: string; n: number }> })
  }
  /** Replay identity and label swap (revision 10, A1): every learner's stored deliveries, replayed through the memory
   * rule with its pair key, reproduce its exams exactly, and so do they under the other arm's label (the key and the
   * rule take no arm). Returns each learner's lane, final item mean, and whether dropping the `attributed` path (design
   * D.6 (i), read from the stored `statedFacts`) changes its exams, so a caller can see the replay is not vacuous. */
  const replayIsIdentity = async (rid: string) => (await loadSimRun(rid)).map((d) => {
    const deliveries = sessionDeliveries(d)
    expect(d.exams.map((e) => e.timepoint)).toEqual(Array.from({ length: d.config.sessions + 1 }, (_, t) => t))
    expect(replayExams(deliveries, d.config.lane, simPairKey(d.config))).toEqual(d.exams.slice(1))
    const swapped = { ...d.config, arm: d.config.arm === 'off' ? 'on' as const : 'off' as const }
    expect(replayExams(deliveries, swapped.lane, simPairKey(swapped))).toEqual(d.exams.slice(1))
    const matcherOnly = replayExams(deliveries, d.config.lane, simPairKey(d.config), { dropPaths: ['attributed'] })
    return { lane: d.config.lane, items: d.exams.at(-1)!.items, dropChanges: JSON.stringify(matcherOnly) !== JSON.stringify(d.exams.slice(1)) }
  })

  // The design (docs/specs/simulated-learner-experiment.md): arm off in every lane, on and anchor in medium.
  // `k` picks the holdout block and Williams row; the three off learners share one, so only the lane differs.
  const learner = (arm: SimLearnerConfig['arm'], lane: SimLearnerConfig['lane'], i: number, k: number): SimLearnerConfig => SimLearnerConfigSchema.parse({
    runId: runId, learnerId: `l${lane === 'slow' ? 1 : lane === 'medium' ? 2 : 3}${String(i).padStart(3, '0')}`, arm, lane, sessions: 2, turns: 2,
    transport: live ? 'codex' : 'stub', learnerModel: model('low'), agentModel: model('low'),
    heldOut: stratifiedHoldout(k, 'e2e'), taskOrder: williamsRow(k).slice(0, 2), factBudget: factBudget(lane), dayGap: SIM_DAY_GAP,
  })

  // Restart safety (docs/operations/restart-safety.md), on the shared crash harness: a one-learner run in a worker
  // process (sim-worker.fixture.ts) killed twice, at two different writes, resumes by run id with every effect exactly
  // once. First SIGKILL while a learner turn's CLI child is running (reservation written, no receipt; the child is
  // the fake slow `codex`, which counts every paid invocation). A second worker takes that call over and ADOPTS the
  // detached child's result, then is SIGKILLed inside the (pure) notebook step, its insert in flight: a test-only
  // trigger on this file's own database holds the row's INSERT, so the kill lands between the step's computation and
  // its write, and the test then terminates the held INSERT's backend, so the row never lands. A third worker resumes
  // that step and must recompute the row, then is stopped with SIGTERM inside a
  // grading (the product workflow settled, the grading rows not yet written). A fourth resumes and is SIGKILLed inside
  // a blind probe's grading, after the last session (revision 10, D.9); this process recovers that. Nothing
  // lost, nothing doubled, nothing pending, no CLI call paid twice, no grading runs the product workflow twice, and
  // each notebook is one row, equal to its recomputation from the stored deliveries.
  test('a run killed mid-session (SIGKILL in a model call, SIGKILL in the notebook step, SIGTERM in a grading, then SIGKILL in a probe grading) resumes by run id with every effect once and no call paid twice', async () => {
    const services = await booted
    const c = { ...learner('on', 'medium', 7, 1), runId: randomUUID() }
    fixtureRuns.push(c.runId)
    const KEY = 's1t2:learner', ANSWER = 'I will check the epoch before I change anything, then ask about the twins.'
    const scratch = mkdtempSync(join(tmpdir(), 'sim-crash-'))
    const codex = fakeCli(scratch, 'learner', ANSWER, 3_000)
    const worker = (hang: string) => simWorker(scratch, { ...codex.env, SIM_START: JSON.stringify({ workflow: 'learningSimLearnerWorkflow', input: c }), SIM_CODEX_KEY: KEY, SIM_HANG: hang,
      LEARNER_LLM_ATTEMPT_DIR: join(scratch, 'attempts'), LEARNER_ATTEMPT_POLL_MS: '100' })
    const call = async (key: string) => (await services.db.query('SELECT attempts, output FROM learning_sim_calls WHERE run_id=$1 AND call_key=$2', [c.runId, key])).rows[0] as { attempts: number; output: { text?: string } }
    const graderRows = async () => (await services.db.query(`SELECT count(*) FILTER (WHERE output ? 'text')::int recorded, count(*) FILTER (WHERE output->>'pending' = 'true' AND (output->>'invocations')::int = 4)::int reserved
      FROM learning_sim_calls WHERE run_id=$1 AND role='grader'`, [c.runId])).rows[0] as { recorded: number; reserved: number }
    const sleeping = async () => ((await services.db.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event='PgSleep' AND query LIKE 'INSERT INTO learning_sim_messages%'`)).rows as Array<{ pid: number }>)
    try {
      await services.db.query(`CREATE TABLE IF NOT EXISTS sim_crash_gate(run_id text PRIMARY KEY)`)
      await services.db.query(`CREATE OR REPLACE FUNCTION sim_crash_gate_wait() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN WHILE EXISTS (SELECT 1 FROM sim_crash_gate WHERE run_id = NEW.run_id) LOOP PERFORM pg_sleep(0.05); END LOOP; RETURN NEW; END $$`)
      await services.db.query(`DROP TRIGGER IF EXISTS sim_crash_gate ON learning_sim_messages`)
      await services.db.query(`CREATE TRIGGER sim_crash_gate BEFORE INSERT ON learning_sim_messages FOR EACH ROW WHEN (NEW.role = 'notebook') EXECUTE FUNCTION sim_crash_gate_wait()`)
      await services.db.query(`INSERT INTO sim_crash_gate VALUES($1)`, [c.runId])
      const first = worker('')
      await until(() => codex.calls() === 1, 120_000, 'the learner call to reach the CLI', first)
      await first.stop('SIGKILL')
      // Paid but not recorded: the invocation is counted toward the cap before the CLI ran (S1).
      expect(await call(KEY)).toEqual({ attempts: 0, output: { pending: true, invocations: 1 } })
      const second = worker('')
      await until(async () => (await sleeping()).length === 1, 200_000, 'the notebook insert to be in flight', second)
      await second.stop('SIGKILL')
      const notebooks = async () => (await services.db.query(`SELECT session, text, meta FROM learning_sim_messages WHERE run_id=$1 AND role='notebook' ORDER BY session`, [c.runId])).rows as Array<{ session: number; meta: { held: Record<string, number> } }>
      expect(await notebooks()).toEqual([])
      // The dead worker's backend still holds its INSERT: Postgres does not notice a client lost during pg_sleep, so
      // opening the gate would let the INSERT autocommit. Terminate that backend (on this database only: `sleeping`
      // reads current_database()), so the write is rolled back and the resumed step must recompute the row.
      for (const { pid } of await sleeping()) await services.db.query('SELECT pg_terminate_backend($1)', [pid])
      await until(async () => (await sleeping()).length === 0, 30_000, 'the held insert to be terminated')
      expect(await notebooks()).toEqual([])
      await services.db.query(`DROP TRIGGER sim_crash_gate ON learning_sim_messages`)
      const third = worker('record')
      await until(() => third.log().includes('HUNG'), 200_000, 'a grading to settle', third)
      // The third worker holds the fence: another worker on this database is refused, not run alongside it.
      await expect(acquireRuntimeRole({ waitMs: 0 })).rejects.toThrow('Runtime role already active')
      third.proc.kill('SIGTERM')
      expect(await Promise.race([third.proc.exited, Bun.sleep(90_000).then(() => 'still running')])).toBe(0)
      // Taken over and adopted: the receipt is the first child's answer and the CLI ran once. The resumed step counts a
      // second invocation before it learns it adopts: the cap over-counts a takeover, never under-counts a paid call.
      expect(await call(KEY)).toEqual({ attempts: 1, output: { text: ANSWER, invocations: 2 } })
      expect(codex.calls()).toBe(1)
      expect((await services.db.query(`SELECT action FROM learning_llm_attempt_reclaims WHERE attempt_key=$1`, [`sim:${c.runId}:${c.learnerId}:${KEY}`])).rows).toEqual([{ action: 'takeover' }])
      // Review 8 S3: the grading cut off by SIGTERM was never recorded, but its worst case (2k = 4) stays reserved.
      const grader = await graderRows()
      expect([grader.recorded, grader.reserved > 0]).toEqual([0, true])
      const settledAssessments = (await services.db.query(`SELECT count(*)::int n FROM learning_concept_assessment_runs JOIN learning_concept_assessment_receipts USING(run_id) WHERE request_id LIKE $1`, [`sim:${c.runId}:%`])).rows[0] as { n: number }
      expect(settledAssessments.n).toBeGreaterThan(0)
      // Revision 10 (D.9): a fourth worker resumes the run (once the SIGTERMed step's lease lapses) and is SIGKILLed
      // inside a blind probe's grading: the product workflow settled, the grading's rows not yet written.
      const probeRuns = async () => (await services.db.query(`SELECT r.request_id, r.user_id, count(t.run_id)::int receipts FROM learning_concept_assessment_runs r
        LEFT JOIN learning_concept_assessment_receipts t USING (run_id) WHERE r.request_id LIKE $1 GROUP BY r.run_id ORDER BY r.request_id`, [`sim:${c.runId}:%:p%`])).rows as Array<{ request_id: string; user_id: string; receipts: number }>
      const fourth = worker('record-probe')
      await until(() => fourth.log().includes('HUNG'), 300_000, 'a probe grading to settle', fourth)
      await fourth.stop('SIGKILL')
      const hung = await probeRuns()
      expect(hung.length).toBeGreaterThan(0)
      expect(hung.every((r) => r.receipts === 1)).toBe(true)
      expect((await graderRows()).reserved).toBeGreaterThan(0)
      // What a worker does (worker.ts): Pikku's workflow recovery, a startup pass and then one every 30 s. The step the
      // SIGTERM left still holds its lease at the startup pass; a later pass reclaims it once the lease lapses.
      services.workflowService.startRecovery()
      const ids = ((await services.db.query(`SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1`, [c.runId])).rows as Array<{ workflow_run_id: string }>).map((r) => r.workflow_run_id)
      expect(ids).toHaveLength(1)
      const run = await settle(ids[0]!, 200_000)
      expect(run.status).toBe('completed')
      expect(codex.calls()).toBe(1)
      const calls = (await services.db.query(`SELECT role, count(*)::int n, count(*) FILTER (WHERE NOT output ? 'text' AND NOT output ? 'failed')::int pending FROM learning_sim_calls WHERE run_id=$1 GROUP BY role`, [c.runId])).rows as Array<{ role: string; n: number; pending: number }>
      const n = Object.fromEntries(calls.map((r) => [r.role, r.n]))
      // Pending: neither an answer nor a final failure (a judge row's `failed` marker is settled, not pending).
      expect(calls.every((r) => r.pending === 0)).toBe(true)
      // Revision 10: the notebook and the exam are no model call.
      expect(Object.keys(n).sort()).toEqual(['agent-match', 'agent-reply', 'grader', 'learner'])
      expect([n.learner, n['agent-reply'], n['agent-match']]).toEqual([6, 4, 4])
      // 4 turns, the blind probe before session 2 and the end probe. The key (session, seq, role) rules out a duplicate message; none
      // lost: 2 sessions x (2 learner + 2 agent) + 2 notebooks (the probe is a receipt, not a message).
      expect((await services.db.query('SELECT count(*)::int n FROM learning_sim_messages WHERE run_id=$1', [c.runId])).rows[0]).toEqual({ n: 10 })
      expect((run.output as { exams: Array<{ timepoint: number }> }).exams.map((e) => e.timepoint)).toEqual([0, 1, 2])
      // Every settled grading recorded once (main + replicate), each by exactly one product workflow run.
      const assessments = (await services.db.query(`SELECT run_id::text AS id FROM learning_concept_assessment_runs WHERE request_id LIKE $1`, [`sim:${c.runId}:%`])).rows as Array<{ id: string }>
      expect(n.grader).toBe(2 * assessments.length)
      const flows = (await services.db.query(`SELECT input::jsonb->>'runId' AS run, count(*)::int n FROM learner_workflow_runs WHERE workflow='learningConceptAssessmentWorkflow' AND input::jsonb->>'runId' = ANY($1::text[]) GROUP BY 1`, [assessments.map((a) => a.id)])).rows as Array<{ n: number }>
      expect(flows.length).toBe(assessments.length)
      expect(flows.every((f) => f.n === 1)).toBe(true)
      // The probe grading killed after its product workflow settled: both probes (session 2 and the end) graded once
      // each under the one probe user, one assessment run and one receipt each.
      expect((await probeRuns()).map((r) => [r.request_id.split(':').slice(-2)[0], r.user_id, r.receipts])).toEqual([['p2', simProbeUserId(c), 1], ['p3', simProbeUserId(c), 1]])
      // The notebook step killed mid-write, its write rolled back: one row per session, recomputed by the resumed step,
      // and it is what the stored deliveries recompute to.
      expect((await notebooks()).map((n) => n.session)).toEqual([1, 2])
      await replayIsIdentity(c.runId)
    } finally {
      for (const { pid } of await sleeping()) await services.db.query('SELECT pg_terminate_backend($1)', [pid])
      await services.db.query(`DROP TRIGGER IF EXISTS sim_crash_gate ON learning_sim_messages`)
      await services.db.query(`DROP TABLE IF EXISTS sim_crash_gate`)
      await services.db.query(`DROP FUNCTION IF EXISTS sim_crash_gate_wait()`)
      services.workflowService.stopRecovery()
      await releaseRuntimeRole()
      await services.db.query(`DROP SCHEMA IF EXISTS ${CRASH_SCHEMA} CASCADE`)
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 700_000)

  // The experiment run end to end (spec "Durable workflows"), restart-safe (docs/operations/restart-safety.md): a stub
  // sequential run at the test wiring's looks of 2, 4 and 6 pairs, executed by the test sim worker, is SIGKILLed while
  // block 2 runs; a second worker recovers it by its workflow run alone. Look 1 is never re-taken, no learner runs twice
  // (waves of 4 in parallel), no call is pending or counted twice, the record is pinned on every learner, the report is
  // the run's output, and a second experiment run of the run id is refused. Rev10 P6 (design D.6): the run is a main
  // batch, so the blind judge runs after the last look: the second worker is SIGKILLed inside judge call judge:3 (on the
  // crash harness's fake slow `codex`), a third is SIGTERMed inside judge:5, and a fourth completes the run; each judge
  // item has one receipt, nothing pending, and each killed call's CLI ran once (adopted, never paid twice).
  test('the experiment workflow, killed mid-block 2 and twice in the blind judge, takes each look once, runs each learner once and judges each item once', async () => {
    const services = await booted
    const rid = randomUUID() // fresh per run: the test leaves its run failed, so a fixed id never starts again on a reused database
    fixtureRuns.push(rid)
    const { simRunConfigs, simCheckoutHead, pinSimRun, plannedRunCalls, SIM_JUDGE_LEARNER } = await import('@learner/core/lib/learning/learning-sim-run.js')
    const { judgeSample } = await import('@learner/core/lib/learning/learning-sim-judge.js')
    const configs = simRunConfigs({ runId: rid, arms: ['on', 'off'], lanes: ['fast'], perArm: () => 6, sessions: 2, turns: 2, models: { learner: 'stub:low', agent: 'stub:low' },
      transport: 'stub', maxCalls: null, gradingReplicates: 2, sequential: true, looks: [2, 4, 6], commit: simCheckoutHead() })
    const input = { runId: rid, concurrency: 4, configs }
    const scratch = mkdtempSync(join(tmpdir(), 'sim-experiment-'))
    const env = { SIM_START: JSON.stringify({ workflow: 'learningSimExperimentWorkflow', input }), SIM_TEST: JSON.stringify({ looks: [2, 4, 6], continueLooks: true }),
      LEARNER_LLM_ATTEMPT_DIR: join(scratch, 'attempts'), LEARNER_ATTEMPT_POLL_MS: '100' }
    const JUDGED = '{"states":"yes"}'
    // judge:3 and judge:5 go through the fake slow CLI, in every worker (a resumed call adopts its child's answer).
    const codex = fakeCli(scratch, 'judge', JUDGED, 3_000), viaCli = { ...codex.env, SIM_CODEX_KEY: 'judge:3,judge:5' }
    const judgeRows = async () => (await services.db.query<{ call_key: string; attempts: number; output: { text?: string; invocations?: number } }>(
      `SELECT call_key, attempts, output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 ORDER BY call_key`, [rid, SIM_JUDGE_LEARNER])).rows
    const lookEntry = async (k: number) => ((await services.db.query<{ entry: string }>('SELECT entry::text AS entry FROM learning_sim_looks WHERE run_id=$1 AND look=$2', [rid, k])).rows[0]?.entry)
    const experiment = async () => (await services.db.query<{ status: string; output: { integrityOk: boolean; markdown: string } }>(`SELECT status, output::jsonb AS output FROM learner_workflow_runs
      WHERE workflow='learningSimExperimentWorkflow' AND input::jsonb->>'runId'=$1`, [rid])).rows
    const block1 = configs.filter((c) => c.pair! < 2).map((c) => c.learnerId), block2 = configs.filter((c) => c.pair! >= 2 && c.pair! < 4).map((c) => c.learnerId)
    const workers: ReturnType<typeof simWorker>[] = []
    try {
      const first = simWorker(scratch, env); workers.push(first)
      await until(async () => Number(((await services.db.query(`SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1 AND learner_id = ANY($2::text[])`, [rid, block2])).rows[0] as { n: number }).n) > 0, 400_000, 'a block-2 call', first)
      await first.stop('SIGKILL')
      expect(await lookEntry(2)).toBeUndefined()
      const look1 = (await lookEntry(1))!
      expect(JSON.parse(look1)).toMatchObject({ look: 1, plannedPairs: 2, decision: 'continue', failedChecks: [], forced: true, learners: [...block1].sort() })

      const second = simWorker(scratch, { ...env, ...viaCli }); workers.push(second)
      await until(() => codex.calls() === 1, 600_000, 'judge call judge:3 to reach the CLI', second)
      await second.stop('SIGKILL')
      // The judge runs only after every look: all three are recorded, and judge:3 is reserved and counted, not received.
      expect((await services.db.query(`SELECT count(*)::int n FROM learning_sim_looks WHERE run_id=$1`, [rid])).rows).toEqual([{ n: 3 }])
      expect((await judgeRows()).find((r) => r.call_key === 'judge:3')).toMatchObject({ attempts: 0, output: { pending: true, invocations: 1 } })
      const third = simWorker(scratch, { ...env, ...viaCli }); workers.push(third)
      await until(() => codex.calls() === 2, 300_000, 'judge call judge:5 to reach the CLI', third)
      third.proc.kill('SIGTERM')
      expect(await Promise.race([third.proc.exited, Bun.sleep(90_000).then(() => 'still running')])).toBe(0)
      const fourth = simWorker(scratch, { ...env, ...viaCli }); workers.push(fourth)
      await until(async () => (await experiment())[0]?.status === 'completed', 600_000, 'the experiment run to complete', fourth)
      await fourth.stop('SIGTERM')
      // Each item of the blind sample judged once: one receipt per index, none pending; each killed call adopted.
      const sample = judgeSample(rid, await loadSimRun(rid))
      expect(plannedRunCalls(configs).byRole.judge).toBe(156)
      expect(sample.items.length).toBeGreaterThan(5)
      expect(sample.items.length).toBeLessThanOrEqual(156)
      const judged = await judgeRows()
      expect(judged.map((r) => r.call_key).sort()).toEqual(sample.items.map((x) => `judge:${x.index}`).sort())
      expect(judged.filter((r) => r.output.text === undefined)).toEqual([])
      for (const key of ['judge:3', 'judge:5']) expect(judged.find((r) => r.call_key === key)!.output.text).toBe(JUDGED)
      expect(codex.calls()).toBe(2)
      const [run] = await experiment()
      expect((await experiment()).length).toBe(1)
      for (const w of [second, third, fourth]) expect(w.log()).not.toContain('STARTED')
      expect(run!.output.markdown).toStartWith('#')
      expect(await lookEntry(1)).toBe(look1)
      expect(JSON.parse((await lookEntry(2))!).learners).toEqual([...block1, ...block2].sort())
      expect((await services.db.query(`SELECT look FROM learning_sim_looks WHERE run_id=$1 ORDER BY look`, [rid])).rows).toEqual([{ look: 1 }, { look: 2 }, { look: 3 }])
      const learnerRuns = (await services.db.query(`SELECT input::jsonb->>'learnerId' AS id, count(*)::int n, bool_and(status='completed') done FROM learner_workflow_runs
        WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1 GROUP BY 1 ORDER BY 1`, [rid])).rows
      // One run per learner: a sibling settling replays the wave, and a waiting child step must not start a second
      // child (the claim rule in transport.ts; without it 6 of 12 learners ran 2-4 times).
      expect(learnerRuns).toEqual(configs.map((c) => c.learnerId).sort().map((id) => ({ id, n: 1, done: true })))
      // Each learner's 4 turns and 2 blind probes (session 2 and the end), once each; nothing pending; the record pinned on every learner.
      const calls = (await services.db.query(`SELECT learner_id, count(*) FILTER (WHERE role='learner')::int turns, count(*) FILTER (WHERE NOT output ? 'text' AND NOT output ? 'failed')::int pending
        FROM learning_sim_calls WHERE run_id=$1 AND learner_id<>$2 GROUP BY 1`, [rid, SIM_JUDGE_LEARNER])).rows as Array<{ turns: number; pending: number }>
      expect(calls.length).toBe(configs.length)
      expect(calls.every((r) => r.turns === 6 && r.pending === 0)).toBe(true)
      expect((await services.db.query(`SELECT DISTINCT config->'run' AS run FROM learning_sim_learners WHERE run_id=$1`, [rid])).rows).toEqual([{ run: configs[0]!.run }])
      // The run is pinned: another experiment run of it is refused, and so is a different design.
      await expect(pinSimRun(input, 'another-run', { looks: [2, 4, 6] })).rejects.toThrow('is live or completed')
      await services.db.query(`UPDATE learner_workflow_runs SET status='failed' WHERE workflow='learningSimExperimentWorkflow' AND input::jsonb->>'runId'=$1`, [rid])
      await expect(pinSimRun({ ...input, configs: configs.map((c) => ({ ...c, turns: 3 })) }, 'another-run', { looks: [2, 4, 6] })).rejects.toThrow('with a different configuration')
    } finally {
      // A worker left running by a timeout would hold the role fence and stall the next run.
      for (const w of workers) if (w.proc.exitCode === null && w.proc.signalCode === null) await w.stop('SIGKILL')
      await services.db.query(`DROP SCHEMA IF EXISTS ${CRASH_SCHEMA} CASCADE`)
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 1_900_000)

  // The never-learns control (SIM_PREREGISTRATION.negativeControl) runs the same workflow with arm on: budget 0, so no
  // sheet is offered and nothing is delivered; capacity 0, so every notebook is empty and every exam scores 0.
  test('the never-learns control (lane none) runs the same workflow, is taught nothing and keeps nothing', async () => {
    const services = await booted
    const rid = randomUUID()
    fixtureRuns.push(rid)
    const c = { ...learner('on', 'none', 1, 2), runId: rid, learnerId: 'l0001' }
    expect(c.factBudget).toBe(0)
    const [out] = await runBatch([c])
    expect(out!.exams.map((e) => e.total)).toEqual([0, 0, 0])
    const rows = (await services.db.query(`SELECT role, text, meta FROM learning_sim_messages WHERE run_id=$1`, [rid])).rows as Array<{ role: string; text: string; meta: Record<string, any> }>
    expect(rows.filter((m) => m.role === 'notebook').map((m) => m.text)).toEqual(['', ''])
    const agent = rows.filter((m) => m.role === 'agent')
    expect(agent.length).toBe(4)
    expect(agent.every((m) => m.meta.sheets.length === 0 && m.meta.statedFactIds.length === 0)).toBe(true)
    // Arm on: its turns went through the live hook, as every Learner arm's do.
    const feedback = (await services.db.query(`SELECT count(*)::int n FROM learning_live_feedback_turns WHERE user_id LIKE $1`, [`sim-${rid.slice(0, 8)}-%`])).rows[0]
    expect(feedback).toEqual({ n: 4 })
    const report = analyzeSimRun(await loadSimRun(rid), { integrity: { ok: true, detail: 'test' } })
    // Revision 10: the control's gate is its mastery part only (its exam is structurally 0, checked above).
    expect(report.checks.neverLearns).toMatchObject({ n: 1, ok: true })
    expect(report.mechanism).toEqual({})
  }, 250_000)

  // Revision 10 (D.9): the probe series on one probe user per learner, at the main batch's k = 1. A pair (arms off and
  // anchor, pair 0) of 5 sessions answers 5 probes each, A / B / A / B / A, graded after the last session in session
  // order. The second and third gradings of A find the earlier reading as their cached prior, and each is still a
  // prior-blind counted measurement (the prompt carries no prior), so the product's masteryChanges reads the series.
  test('the probe series: one probe user per learner, 5 probes A/B/A/B/A graded after the last session, each prior-blind and counted at k = 1 (D.9)', async () => {
    const services = await booted
    const rid = 'e2e00000-0000-4000-8000-0000000000b6'
    fixtureRuns.push(rid)
    await deleteSimRun(rid)
    const pair = (['off', 'anchor'] as const).map((arm, i) => ({ ...learner(arm, 'medium', 10 + i, 0), runId: rid, pair: 0, sessions: 5, turns: 2, taskOrder: williamsRow(0) }))
    const { updatedAt: _, ...policy } = await loadLearningPolicy()
    await saveLearningPolicy({ ...policy, gradingReplicates: 1 }, 'simulated-learner-test')
    try { await runBatch(pair) } finally { await saveLearningPolicy({ ...policy, gradingReplicates: 2 }, 'simulated-learner-test') }
    const rows = (await services.db.query(`SELECT learner_id, call_key, created_at FROM learning_sim_calls WHERE run_id=$1`, [rid])).rows as Array<{ learner_id: string; call_key: string; created_at: Date }>
    // The pair shares its draws (one key, so one uniform u per probe key); each learner's A and B are that u applied to
    // its OWN delivered set. The two sets can differ in size (off and anchor deliver differently), so the rank need not match.
    expect(simPairKey(pair[0]!)).toBe(simPairKey(pair[1]!))
    for (const c of pair) {
      const mine = rows.filter((r) => r.learner_id === c.learnerId)
      const asked = mine.filter((r) => /^s\d+:probe:/.test(r.call_key)).map((r) => r.call_key).sort()
      const concepts = asked.map((k) => k.split(':probe:')[1]!)
      expect(asked.map((k) => k.split(':')[0])).toEqual(['s2', 's3', 's4', 's5', 's6'])
      const [a, b] = concepts
      expect(concepts).toEqual([a, b, a, b, a])
      // A: the pair's draw u2 = draw(`${runId}|${pairKey}|probe2`) on this learner's own sorted session-1 concepts; B: u3 on
      // its concepts of sessions 1-2 other than A (A when there is none).
      const taught = async (by: number) => [...new Set(((await services.db.query(`SELECT jsonb_array_elements_text(meta->'statedFactIds') id FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND session<=$3 AND role='agent'`,
        [rid, c.learnerId, by])).rows as Array<{ id: string }>).map((d) => `halyard-core--${d.id.replace(/-f\d+$/, '')}`))].sort()
      const [s1, rest] = [await taught(1), (await taught(2)).filter((x) => x !== a)]
      const [u2, u3] = [2, 3].map((s) => draw(`${rid}|${simPairKey(c)}|probe${s}`))
      expect(a).toBe(s1[Math.floor(u2! * s1.length)])
      expect(b).toBe(rest.length ? rest[Math.floor(u3! * rest.length)] : a)
      // One grading per probe, k = 1, as planned; all after the last session (after the end probe, its last action).
      const grades = mine.filter((r) => /^p\d+:grade:/.test(r.call_key))
      expect(grades.map((r) => r.call_key).sort()).toEqual(asked.map((k) => `p${k.slice(1, k.indexOf(':'))}:grade:${k.split(':probe:')[1]}`).sort())
      expect(mine.filter((r) => r.call_key.startsWith('s') && r.call_key.includes(':grade:')).length + grades.length).toBe(plannedCalls(c, 1).grader)
      const lastSession = Math.max(...mine.filter((r) => !/^p\d+:/.test(r.call_key)).map((r) => r.created_at.getTime()))
      expect(Math.min(...grades.map((r) => r.created_at.getTime()))).toBeGreaterThanOrEqual(lastSession)
      // One probe user, never the learner's; every grading prior-blind (no prior in its prompt) and counted.
      const runs = (await services.db.query(`SELECT r.user_id, r.request_id, r.snapshot->'prior' AS prior, d.prior_percent, ${BLIND_COUNTED('m')} AS counted, m.blind_gradings
        FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_run_digests d USING (run_id) JOIN learning_mastery_readings m USING (run_id)
        WHERE r.request_id LIKE $1 ORDER BY r.request_id`, [`sim:${rid}:${c.learnerId}:p%`])).rows as Array<{ user_id: string; request_id: string; prior: unknown; prior_percent: string | null; counted: boolean; blind_gradings: number }>
      expect(runs.length).toBe(5)
      expect([...new Set(runs.map((r) => r.user_id))]).toEqual([simProbeUserId(c)])
      expect(runs.map((r) => [r.prior_percent, r.counted, r.blind_gradings])).toEqual(runs.map(() => [null, true, 1]))
      // The repeat is a real one: the later gradings of A had the earlier reading as their cached prior.
      expect(runs.filter((r) => r.request_id.endsWith(`:${a}`) && !r.request_id.includes(':p2:')).every((r) => r.prior !== null)).toBe(true)
      // The product's own report on the probe user: A read 3 times, B twice (when B is not A).
      const changes = await masteryChanges(services.db.query.bind(services.db) as never, simProbeUserId(c), { sinceDays: null })
      expect(changes.concepts.map((x) => [x.conceptId, x.readings]).sort()).toEqual((a === b ? [[a, 5]] : [[a, 3], [b, 2]]).sort())
    }
    // Verdict 2a reads these series: each change pairs with its two probes (truth from the exams), none unpaired.
    const tracking = probeChangeTracking(await loadSimRun(rid))
    expect(tracking.unmatched).toBe(0)
    expect(tracking.changes).toBeGreaterThanOrEqual(2)
  }, live ? 3_600_000 : 400_000)

  test('a batch: the budget enforced at the channel, no baseline exam, a simulated calendar, only arm on grades through the product workflow, memory rules recorded, lanes in order, receipts reused, the call cap', async () => {
    const services = await booted
    const configs = [learner('off', 'slow', 1, 0), learner('off', 'medium', 2, 0), learner('off', 'fast', 3, 0), learner('on', 'medium', 4, 1), learner('anchor', 'medium', 5, 1)]
    const learners = await runBatch(configs)
    expect(learners.map((l) => l.learnerId)).toEqual(configs.map((c) => c.learnerId))
    for (const [i, out] of learners.entries()) {
      const n = Object.fromEntries(out.calls.map((c) => [c.role, c.n]))
      // The baseline is an empty notebook's 0, never a model call.
      expect(out.exams.map((e) => e.timepoint)).toEqual([0, 1, 2])
      expect(out.exams[0]!.total).toBe(0)
      expect(Object.keys(n).filter((role) => !['learner', 'agent-reply', 'agent-match', 'grader'].includes(role))).toEqual([])
      expect(n['agent-match'] ?? 0).toBe(configs[i]!.arm === 'on' ? 4 : 0)
    }
    // Design C.1: arm anchor has no Learner, so its calls are those of its lane's off learner, role by role.
    const callsOf = (c: SimLearnerConfig) => Object.fromEntries(learners[configs.indexOf(c)]!.calls.map((x) => [x.role, x.n]))
    expect(callsOf(configs[4]!)).toEqual(callsOf(configs[1]!))
    // Only arm on grades (its injection reads the grader), never after the last session, and each grading ran the
    // product's assessment workflow once per assessment run, with its planned prior-blind replicate.
    const graded = (await services.db.query(`SELECT learner_id, call_key, output->>'text' AS text FROM learning_sim_calls WHERE run_id=$1 AND role='grader' AND call_key LIKE 's%'`, [runId])).rows as Array<{ learner_id: string; call_key: string; text: string }>
    expect(graded.length).toBeGreaterThan(0)
    expect(graded.every((g) => g.learner_id === configs[3]!.learnerId && g.call_key.startsWith('s1:'))).toBe(true)
    const main = graded.filter((g) => !/:r\d+$/.test(g.call_key)).map((g) => (JSON.parse(g.text) as { assessmentRunId: string }).assessmentRunId)
    expect(graded.filter((g) => g.call_key.endsWith(':r2')).length).toBe(main.length)
    const flows = (await services.db.query(`SELECT count(*)::int n, min(status) status FROM learner_workflow_runs
      WHERE workflow='learningConceptAssessmentWorkflow' AND input::jsonb->>'runId' = ANY($1::text[]) GROUP BY input::jsonb->>'runId'`, [main])).rows as Array<{ n: number; status: string }>
    expect(flows.length).toBe(main.length)
    expect(flows.every((r) => r.n === 1 && r.status === 'completed')).toBe(true)
    // B6, revision 10 (D.9): every learner, in every arm, answered a blind probe before session 2 about a concept
    // delivered in session 1 and the end probe (session 3) about the same concept, both graded (main + replicate)
    // after its last session under its one probe user, never the learner's.
    const probeRows = (await services.db.query(`SELECT learner_id, call_key FROM learning_sim_calls WHERE run_id=$1 AND (call_key LIKE 's%:probe:%' OR call_key LIKE 'p%:grade:%') ORDER BY learner_id, call_key`, [runId])).rows as Array<{ learner_id: string; call_key: string }>
    for (const c of configs) {
      const keys = probeRows.filter((p) => p.learner_id === c.learnerId).map((p) => p.call_key)
      const concept = keys.find((k) => k.startsWith('s2:probe:'))?.split(':probe:')[1]
      expect(keys).toEqual([`p2:grade:${concept}`, `p2:grade:${concept}:r2`, `p3:grade:${concept}`, `p3:grade:${concept}:r2`, `s2:probe:${concept}`, `s3:probe:${concept}`])
      const delivered = (await services.db.query(`SELECT jsonb_array_elements_text(meta->'statedFactIds') id FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND session=1 AND role='agent'`, [runId, c.learnerId])).rows as Array<{ id: string }>
      expect(delivered.some((d) => concept === `halyard-core--${d.id.replace(/-f\d+$/, '')}`)).toBe(true)
    }
    const probeUsers = (await services.db.query(`SELECT DISTINCT user_id FROM learning_concept_assessment_runs WHERE request_id LIKE $1 ORDER BY user_id`, [`sim:${runId}:%:p%`])).rows as Array<{ user_id: string }>
    expect(probeUsers.map((u) => u.user_id)).toEqual(configs.map(simProbeUserId).sort())
    // The agent turns of the Learner arms went through the live feedback tables under the Halyard catalog; arm off's
    // agent saw no hook text.
    const feedback = (await services.db.query(`SELECT count(*)::int n, count(DISTINCT catalog_version)::int versions, min(catalog_version) version FROM learning_live_feedback_turns WHERE user_id LIKE $1`, [`sim-${runId.slice(0, 8)}-%`])).rows[0]
    expect(feedback).toMatchObject({ n: 4 * configs.filter((c) => c.arm === 'on').length, versions: 1, version: HALYARD_CATALOG.version })
    const anchorTurns = (await services.db.query('SELECT count(*)::int n FROM learning_live_feedback_turns WHERE user_id=$1', [`sim-${runId.slice(0, 8)}-${configs[4]!.learnerId}`])).rows[0]
    expect(anchorTurns).toEqual({ n: 0 })
    // The budget at the channel: the facts the matcher finds in what the learner READ are within budget per session,
    // and every one was on a sheet offered that turn (the stub states sheet facts verbatim).
    const agent = (await services.db.query(`SELECT learner_id, session, seq, text, meta FROM learning_sim_messages WHERE run_id=$1 AND role='agent' ORDER BY seq`, [runId])).rows as Array<{ learner_id: string; session: number; seq: number; text: string; meta: { statedFactIds: string[]; statedFacts: StatedFact[]; sheets: string[]; plan?: string[]; redacted: number; claimedFactIds: string[]; overBudgetFacts: string[]; attributedFacts: string[]; withheldFacts: string[]; budgetLeft: number } }>
    // Revision 10 (A2): every arm and every turn with budget left is offered every sheet; none once it is spent.
    expect(new Set(agent.map((m) => configs.find((c) => c.learnerId === m.learner_id)!.arm))).toEqual(new Set(['off', 'on', 'anchor']))
    // Design C.1: each anchor turn with budget left carried the session's plan from the facts held after the previous
    // session (none in session 1), and the reply followed it (the stub states a TEACHING PLAN's facts first): the
    // turn's first delivery is the plan's first fact. No other arm has a plan.
    for (const m of agent) {
      if (configs.find((c) => c.learnerId === m.learner_id)!.arm !== 'anchor') { expect(m.meta.plan).toBeUndefined(); continue }
      const c = configs[4]!, task = HALYARD_TASKS[c.taskOrder[m.session - 1]!]!
      const held = m.session === 1 ? {} : (await services.db.query(`SELECT meta->'held' AS held FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND role='notebook' AND session=$3`, [runId, c.learnerId, m.session - 1])).rows[0].held
      const stated = agent.filter((x) => x.learner_id === m.learner_id && x.session === m.session && x.seq < m.seq).flatMap((x) => x.meta.statedFactIds)
      expect(m.meta.plan).toEqual(anchorPlan({ named: task.named, heldOut: c.heldOut, held, budgetLeft: c.factBudget }).filter((id) => !stated.includes(id)).slice(0, m.meta.budgetLeft))
      if (m.meta.plan!.length) expect(m.meta.statedFactIds[0]).toBe(m.meta.plan![0])
    }
    for (const m of agent) expect(m.meta.sheets).toEqual(m.meta.budgetLeft ? [...SIM_SHEETS] : [])
    let overClaimSessions = 0, attributedSessions = 0, unverifiedSessions = 0
    for (const c of configs) for (const session of [1, 2]) {
      const turns = agent.filter((m) => m.learner_id === c.learnerId && m.session === session)
      const stated = turns.flatMap((m) => m.meta.statedFactIds)
      expect(stated.length).toBeGreaterThan(0)
      expect(stated.length).toBeLessThanOrEqual(c.factBudget!)
      const read = new Set(turns.flatMap((m) => factsBySentence(m.text).flatMap((x) => x.facts)))
      expect([...read].every((id) => stated.includes(id))).toBe(true)
      expect(stated.every((id) => turns.some((m) => m.meta.sheets.some((sheet) => factSheet(sheet).facts.some((f) => f.id === id))))).toBe(true)
      // The stub claims two facts beyond the budget: one stated verbatim (redacted over budget) and one only alluded
      // to (revision 10, A3: verified at 0.4 or withheld with its sentence). Neither is ever counted as delivered.
      const overClaimed = turns.flatMap((m) => m.meta.claimedFactIds).filter((id) => !stated.includes(id))
      if (turns.some((m) => m.meta.overBudgetFacts.some((id) => m.meta.claimedFactIds.includes(id)))) overClaimSessions++
      expect(turns.flatMap((m) => [...m.meta.overBudgetFacts, ...m.meta.withheldFacts])).toEqual(expect.arrayContaining(overClaimed))
      // Every delivery records its path (review B4), in delivery order, from the text and the claims alone.
      for (const m of turns) {
        expect(m.meta.statedFacts.map((x) => x.factId)).toEqual(m.meta.statedFactIds)
        // Review rev10-p2 B1, the converse of `read` above: every delivery is stated in the text this turn's learner read.
        expect({ seq: m.seq, unread: unread(m.text, m.meta.statedFacts) }).toEqual({ seq: m.seq, unread: [] })
        for (const x of m.meta.statedFacts) expect(x.path).toBe(!m.meta.claimedFactIds.includes(x.factId) ? 'matched' : m.meta.attributedFacts.includes(x.factId) ? 'attributed' : 'matched-claimed')
      }
      if (turns.some((m) => m.meta.statedFacts.some((x) => x.path === 'attributed'))) attributedSessions++
      if (turns.some((m) => m.meta.attributedFacts.some((id) => m.meta.withheldFacts.includes(id)))) unverifiedSessions++
      expect(turns.every((m) => m.meta.attributedFacts.every((id) => m.meta.claimedFactIds.includes(id)))).toBe(true)
    }
    // Every path is exercised, not vacuous: an over-budget claim redacted, a claim the matcher missed verified and
    // delivered as attributed, one it could not verify withheld, and all three delivery paths taken.
    expect(overClaimSessions).toBeGreaterThan(0)
    expect(attributedSessions).toBeGreaterThan(0)
    expect(unverifiedSessions).toBeGreaterThan(0)
    expect(new Set(agent.flatMap((m) => m.meta.statedFacts.map((x) => x.path)))).toEqual(new Set(['matched', 'matched-claimed', 'attributed']))
    // The calendar: session 2 is dayGap days after session 1, in the past, for messages and live turns alike.
    const at = (await services.db.query(`SELECT session, min(created_at) AS at FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 GROUP BY session ORDER BY session`, [runId, configs[3]!.learnerId])).rows as Array<{ at: Date }>
    expect(Math.round((at[1]!.at.getTime() - at[0]!.at.getTime()) / 86_400_000)).toBe(SIM_DAY_GAP)
    expect(at[1]!.at.getTime()).toBeLessThan(Date.now())
    const turns = (await services.db.query(`SELECT session_id, min(created_at) AS at, min(submitted_at) AS submitted FROM learning_live_feedback_turns WHERE user_id=$1 GROUP BY session_id ORDER BY 2`, [`sim-${runId.slice(0, 8)}-${configs[3]!.learnerId}`])).rows as Array<{ at: Date; submitted: Date }>
    expect(turns.length).toBe(2)
    expect(Math.round((turns[1]!.at.getTime() - turns[0]!.at.getTime()) / 86_400_000)).toBe(SIM_DAY_GAP)
    expect(Math.abs(turns[0]!.submitted.getTime() - turns[0]!.at.getTime())).toBeLessThan(3_600_000)
    // The memory rule's state is stored with each notebook (held fact id -> strength) with its counters, and every
    // learner's exams are its replayed deliveries, under either arm label (revision 10, A1).
    const notebookRows = async () => (await services.db.query(`SELECT learner_id, session, text, meta FROM learning_sim_messages WHERE run_id=$1 AND role='notebook' ORDER BY 1, 2`, [runId])).rows as Array<{ meta: Record<string, unknown> }>
    const notebooks = await notebookRows()
    expect(notebooks.length).toBe(configs.length * 2)
    expect(notebooks.every((n) => typeof n.meta.held === 'object' && typeof n.meta.unabsorbed === 'number' && typeof n.meta.overCapacity === 'number')).toBe(true)
    // Not vacuous: every learner outside the slow lane holds a fact. The slow one (capacity 100) need not: here it takes
    // up one fact a session (the second does not fit) and loses each to the prerequisite draw, which is the rule working.
    const finals = await replayIsIdentity(runId)
    expect(finals.filter((f) => f.lane !== 'slow').map((f) => f.items > 0)).toEqual(configs.filter((c) => c.lane !== 'slow').map(() => true))
    // The stored paths reach the replay: dropping the attributed deliveries lowers some learner's exams.
    expect(finals.some((f) => f.dropChanges)).toBe(true)
    const data = await loadSimRun(runId)
    const report = analyzeSimRun(data, { integrity: { ok: true, detail: 'test' }, mainPerArm: 1 })
    // The lanes' order on arm off's final item-mean (revision 10: read from the loaded exams; the lane-order row is gone).
    const offFinal = (lane: string) => data.find((d) => d.config.arm === 'off' && d.config.lane === lane)!.exams.at(-1)!.items
    expect(offFinal('slow')).toBeLessThan(offFinal('fast'))
    expect(report.checks.heldOutTargeted).toBe(0)
    expect(report.checks.incomplete).toEqual([])
    expect(report.readingsBySession[configs[3]!.learnerId]!.length).toBe(1)
    // The channel gate (revision 8) on the real channel and loader: every claim accounted, nothing over budget read.
    expect(report.gates.channel).toMatchObject({ claimedUnaccounted: 0, overBudgetKept: 0, ok: true })
    expect(report.claim2!.gradings).toBe(main.length)
    // B5's echo measure: one value per learner message that follows an agent reply (turn 2 of each of 2 sessions).
    expect(report.echo.all.n).toBe(2 * configs.length)
    // Two probes per learner (session 2 and the end), each paired with the exam after the session before it.
    expect(report.claim2!.blindProbes.n).toBe(2 * configs.length)
    const planned = configs.reduce((n, c) => n + Object.values(plannedCalls(c, 2)).reduce((x, y) => x + y, 0), 0)
    expect(report.cost.calls).toBeGreaterThan(0)
    expect(report.cost.calls).toBeLessThanOrEqual(planned)

    // A second run of the same learners is free: every model call is answered from its receipt, and no grading
    // starts the product workflow again.
    const count = async () => (await services.db.query('SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1', [runId])).rows[0] as { n: number }
    const before = await count()
    // Adopting completed runs would prove nothing: start new runs of the same learners.
    const rpc = rpcService.getContextRPCService(services, {}, false)
    for (const c of configs) expect((await settle((await services.workflowService.startWorkflow('learningSimLearnerWorkflow', c, { type: 'internal' }, rpc)).runId, 250_000)).status).toBe('completed')
    expect(await count()).toEqual(before)
    expect(await notebookRows()).toEqual(notebooks)
    const flowsAfter = (await services.db.query(`SELECT count(*)::int n FROM learner_workflow_runs WHERE workflow='learningConceptAssessmentWorkflow' AND input::jsonb->>'runId' = ANY($1::text[])`, [main])).rows[0]
    expect(flowsAfter).toEqual({ n: main.length })

    // The hard cap counts paid invocations, not call keys (S1): a call that needed a capacity retry uses 2 of the cap.
    // At the cap a stored receipt still answers, and no new call starts.
    const { simCall, simCallsUsed, stubTransport, SimCallBudgetExhausted } = await import('@learner/core/lib/learning/learning-sim-model.js')
    // Revision 8: a 429 is never an attempt, never a paid invocation and never a failure; it is counted on the receipt.
    {
      const before429 = await simCallsUsed(runId)
      // The plain object _spawnCLI throws, not an Error (review 7 B1).
      let limited = 2
      const spec = { model: 'stub', effort: 'low', timeoutSec: 30, runId: runId, learnerId: configs[0]!.learnerId, role: 'learner' as const, prompt: '429 probe', callKey: 'rate-limited' }
      const busy = Object.assign(async (s: Parameters<ReturnType<typeof stubTransport>>[0]) => { if (limited-- > 0) throw { type: 'llm_error', message: 'codex CLI exited with code 1: ERROR: exceeded retry limit, last status: 429 Too Many Requests', retryable: false }; return stubTransport()(s) }, { backend: stubTransport().backend })
      const waits: number[] = []
      expect((await simCall(spec, busy, async (ms) => { waits.push(ms) })).attempts).toBe(1)
      expect(waits).toEqual([5_000, 5_000])
      expect(await simCallsUsed(runId)).toBe(before429 + 1)
      const row = (await services.db.query(`SELECT output FROM learning_sim_calls WHERE run_id=$1 AND call_key='rate-limited'`, [runId])).rows[0] as { output: { invocations: number; rateLimited: number } }
      expect(row.output).toMatchObject({ invocations: 1, rateLimited: 2 })
      expect((await loadSimRun(runId)).flatMap((d) => d.calls).reduce((n, c) => n + (c.rateLimited ?? 0), 0)).toBe(2)
    }
    // The cap is the run's record in the database (pinSimRun writes it): set on every learner of the run, removed after.
    const setCap = (max: number | null) => services.db.query(max === null ? `UPDATE learning_sim_learners SET config = config - 'run' WHERE run_id=$1`
      : `UPDATE learning_sim_learners SET config = config || jsonb_build_object('run', jsonb_build_object('commit','test','maxCalls',$2::int,'gradingReplicates',2,'sequential',false,'arms','[]'::jsonb,'lanes','[]'::jsonb,'perArm','{}'::jsonb,'looks','[]'::jsonb)) WHERE run_id=$1`,
    max === null ? [runId] : [runId, max])
    const used = await simCallsUsed(runId)
    await setCap(used + 2)
    try {
      const learnerId = configs[0]!.learnerId
      const spec = { model: 'stub', effort: 'low', timeoutSec: 30, runId: runId, learnerId, role: 'learner' as const, prompt: 'cap probe' }
      const stored = (await services.db.query(`SELECT call_key FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND role='learner' LIMIT 1`, [runId, learnerId])).rows[0] as { call_key: string }
      expect((await simCall({ ...spec, callKey: stored.call_key }, stubTransport())).reused).toBe(true)
      let failures = 1
      const flaky = Object.assign(async (s: Parameters<ReturnType<typeof stubTransport>>[0]) => { if (failures-- > 0) throw { type: 'llm_error', message: 'codex CLI exited with code 1: 503 UNAVAILABLE', retryable: false }; return stubTransport()(s) }, { backend: stubTransport().backend })
      expect((await simCall({ ...spec, callKey: 'cap-retry' }, flaky, async () => {})).attempts).toBe(2)
      expect(await simCallsUsed(runId)).toBe(used + 2)
      await expect(simCall({ ...spec, callKey: 'cap-probe' }, stubTransport())).rejects.toBeInstanceOf(SimCallBudgetExhausted)
      // Review 7 S3: a retry is a further paid invocation and is checked too. With room for one call, a call that
      // needs a capacity retry is refused at the retry, not paid past the cap.
      await setCap((await simCallsUsed(runId)) + 1)
      let once = 1
      const flakyOnce = Object.assign(async (s: Parameters<ReturnType<typeof stubTransport>>[0]) => { if (once-- > 0) throw { type: 'llm_error', message: 'codex CLI exited with code 1: 503 UNAVAILABLE', retryable: false }; return stubTransport()(s) }, { backend: stubTransport().backend })
      const usedBefore = await simCallsUsed(runId)
      await expect(simCall({ ...spec, callKey: 'cap-retry-refused' }, flakyOnce, async () => {})).rejects.toBeInstanceOf(SimCallBudgetExhausted)
      expect(await simCallsUsed(runId)).toBe(usedBefore + 1)
      // Revision 8.2: a grading whose receipt records a validator repair is two paid invocations in the ledger.
      const repaired = { ...configs[0]!, runId: randomUUID() }
      fixtureRuns.push(repaired.runId)
      const grader = { run: async () => ({ status: 'completed', model: { model: 'gpt-5.6-luna', effort: 'xhigh' },
        receipt: { status: 'completed', durationMs: 1, validatorRetry: { kind: 'quote', recovered: true, firstError: 'non-exact quote' } } }) }
      const { recordSimGrade } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
      // Review 8 S5: a grading re-run after its worker died (one lease takeover) is one more paid invocation.
      const assessmentRunId = randomUUID()
      await services.db.query(`INSERT INTO learning_llm_attempt_leases(attempt_key,backend,repeat_free,owner,takeovers) VALUES($1,'codex',true,'e2e',1)`, [`assessment:${assessmentRunId}`])
      await recordSimGrade({ config: repaired, session: 1, conceptId: 'c' } as never, assessmentRunId, grader as never)
      // Review 9 N6: 2 per takeover (the dead worker may have paid its call and a repair), + 2 for this repair.
      expect(await simCallsUsed(repaired.runId)).toBe(4)
      expect((await services.db.query(`SELECT attempts, output->'invocations' AS invocations FROM learning_sim_calls WHERE run_id=$1`, [repaired.runId])).rows).toEqual([{ attempts: 4, invocations: 4 }])
      // Review 8 S3: a grading's worst case (2k) is checked AND reserved in the ledger before it starts, so concurrent
      // gradings and a resume see it. At the final (ungraded) session, the first concept with new evidence:
      const { prepareSimGrade, reserveSimGrading } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
      const reserve = 2 * (await loadLearningPolicy()).gradingReplicates
      const on = configs[3]!
      const atCap = (await simCallsUsed(runId)) + reserve
      await setCap(atCap - 1)
      let refused: string | undefined
      for (const { id } of HALYARD_CATALOG.concepts) {
        const r = await prepareSimGrade({ config: on, session: on.sessions, conceptId: id }, services.learningConceptAssessment).then(() => null, (e: unknown) => e)
        if (r) { expect(r).toBeInstanceOf(SimCallBudgetExhausted); refused = id; break }
      }
      expect(refused).toBeDefined()
      await setCap(atCap)
      expect((await prepareSimGrade({ config: on, session: on.sessions, conceptId: refused! }, services.learningConceptAssessment)).assessmentRunId).toBeTruthy()
      expect(await simCallsUsed(runId)).toBe(atCap)
      // Review 9 S-C: the reservation is not a call (no retry share, health call count or cost model), but the health
      // look shows it and the loader keeps it as a reading in status `reserved` (S-A: the gate fails on it if left).
      const loaded = (await loadSimRun(runId)).find((d) => d.config.learnerId === on.learnerId)!
      expect(loaded.calls.some((x) => x.model === 'reserved')).toBe(false)
      expect(loaded.readings.filter((r) => r.status === 'reserved').map((r) => r.conceptId)).toEqual([refused!])
      const { simHealth } = await import('@learner/core/lib/learning/learning-sim-health.js')
      expect(simHealth([loaded], {}).reservedGradings).toBe(1)
      // A replayed prepare finds its own reservation: nothing more is reserved, even at the cap.
      await reserveSimGrading(on, `s${on.sessions}:grade:${refused}`, reserve)
      expect(await simCallsUsed(runId)).toBe(atCap)
      // Review 9 S-B: the check and the reservation are atomic per run. Room for 2 reservations, 5 at once: exactly 2.
      await setCap((await simCallsUsed(runId)) + 2 * reserve)
      const raced = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => reserveSimGrading(on, `race:${i}`, reserve)))
      expect(raced.filter((x) => x.status === 'fulfilled').length).toBe(2)
      expect(raced.every((x) => x.status === 'fulfilled' || x.reason instanceof SimCallBudgetExhausted)).toBe(true)
      expect(await simCallsUsed(runId)).toBe(atCap + 2 * reserve)
      // Review 10 S5 (X3): the lock is held, on the reservation's own connection, from the check to the insert: while
      // the first reservation sits between them, another client cannot take the run's lock, and a second reservation
      // for the last slot waits for it and then sees it (refused), whatever the scheduling.
      const { SIM_CAP_LOCK } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
      await setCap((await simCallsUsed(runId)) + reserve)
      let second: Promise<unknown> | undefined, secondDone = false
      await reserveSimGrading(on, 'held:1', reserve, async () => {
        const probe = await services.db.query<{ ok: boolean }>('SELECT pg_try_advisory_xact_lock($1, hashtext($2)) AS ok', [SIM_CAP_LOCK, runId])
        expect(probe.rows[0]!.ok).toBe(false)
        second = reserveSimGrading(on, 'held:2', reserve).then(() => 'reserved', (e: unknown) => e).finally(() => { secondDone = true })
        await Bun.sleep(1500)
        expect(secondDone).toBe(false)
      })
      expect(await second).toBeInstanceOf(SimCallBudgetExhausted)
      expect(await simCallsUsed(runId)).toBe(atCap + 3 * reserve)
      // Review 10 S2: a look is a row (run, look), recorded once and never revised, whatever a later start computes.
      const { readLooks, recordLook } = await import('@learner/core/lib/learning/learning-sim-looks.js')
      const lookRun = randomUUID(); fixtureRuns.push(lookRun)
      const look1 = await recordLook(lookRun, { look: 1, plannedPairs: 10, decision: 'continue', failedChecks: [], learners: ['l3001'] })
      expect(await recordLook(lookRun, { look: 1, plannedPairs: 10, decision: 'efficacy', failedChecks: ['x'], learners: [] })).toEqual(look1)
      expect(await readLooks(lookRun)).toEqual([look1])
      expect(await readLooks(randomUUID())).toEqual([])
    } finally {
      await setCap(null)
    }
  }, live ? 3_600_000 : 300_000)

  /**
   * A whole run written as rows (no model call), read back by loadSimRun and analysed: the analysis path end to end, on
   * a FIXED run id, so every estimate is exact. Revision 10: fast lane, matched pairs (config.pair), one agent turn per
   * delivered fact with its path (`statedFacts`) and the fact stated in the turn's text; each notebook holds what the
   * replay of those deliveries holds, so the loaded exams are the replay (the identity the versions rest on). Arm off
   * delivers 8 facts of each session's brief (its own seeded order); arm anchor, and arm on when `onPlan` is 'plan', the
   * static plan of the brief's concepts; `drop` learners lose their last exam. The never-learns control is added.
   */
  type Plant = { id: string; onPlan: 'plan' | 'brief'; perArm?: number; drop?: (arm: string, pair: number) => boolean }
  const plantNotebook = async (rid: string, learnerId: string, t: number, held: string[]) => (await booted).db.query(`INSERT INTO learning_sim_messages(run_id,learner_id,session,seq,role,text,meta)
    VALUES($1,$2,$3,0,'notebook','planted',$4::jsonb)`, [rid, learnerId, t, JSON.stringify({ held: Object.fromEntries(held.map((id) => [id, 0])) })])
  const factText = (id: string) => EXAM_FACTS.find((f) => f.id === id)!.fact
  const hashed = (key: string, ids: string[]) => [...ids].sort((a, b) => createHash('sha256').update(`${key}|${a}`).digest('hex').localeCompare(createHash('sha256').update(`${key}|${b}`).digest('hex')))
  const plant = async ({ id: rid, onPlan, perArm = 12, drop = () => false }: Plant) => {
    await deleteSimRun(rid)
    fixtureRuns.push(rid)
    const services = await booted
    const G = new Map<string, { g: number; complete: boolean }>()
    for (const slot of simSlots(rid, ['fast'], (arm) => (arm === 'anchor' ? 10 : perArm), ['off', 'on', 'anchor'], 5)) {
      const learnerId = `l3${String(slot.index).padStart(3, '0')}`
      const config = SimLearnerConfigSchema.parse({ runId: rid, learnerId, arm: slot.arm, lane: 'fast', sessions: 5, turns: 3, transport: 'stub', learnerModel: model('low'), agentModel: model('low'),
        heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap, pair: slot.cellIndex })
      await services.db.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,$4,'fast',$5::jsonb)`, [rid, learnerId, `sim-${rid.slice(0, 8)}-${learnerId}`, slot.arm, JSON.stringify(config)])
      const planned = slot.taskOrder.map((t) => { const named = HALYARD_TASKS[t]!.named
        return slot.arm === 'anchor' || (slot.arm === 'on' && onPlan === 'plan') ? staticPlan(named, slot.heldOut, 8)
          : hashed(learnerId, EXAM_FACTS.filter((f) => named.includes(f.conceptId) && !slot.heldOut.includes(f.conceptId)).map((f) => f.id)).slice(0, 8) })
      const exams = replayExams(planned.map((s) => s.map((factId) => ({ factId, path: 'matched' as const }))), 'fast', simPairKey(config))
      const dropped = drop(slot.arm, slot.cellIndex)
      G.set(`${slot.arm}|${slot.cellIndex}`, { g: exams.reduce((n, e) => n + e.items, 0) / exams.length, complete: !dropped })
      for (const [s, facts] of planned.entries()) {
        for (const [k, factId] of facts.entries()) {
          const meta = { decision: 'none', conceptIds: [], statedFactIds: [factId], statedFacts: [{ factId, path: 'matched' }], claimedFactIds: [factId], attributedFacts: [], withheldFacts: [],
            sheets: [], budgetLeft: slot.factBudget, overBudget: 0, invalidFacts: 0, review: null, unofferedFacts: [], overBudgetFacts: [], redacted: 0 }
          await services.db.query(`INSERT INTO learning_sim_messages(run_id,learner_id,session,seq,role,text,meta) VALUES($1,$2,$3,$4,'agent',$5,$6::jsonb)`, [rid, learnerId, s + 1, k + 1, `Here is the plan. ${factText(factId)}`, JSON.stringify(meta)])
        }
        if (!(dropped && s === 4)) await plantNotebook(rid, learnerId, s + 1, Object.entries(exams[s]!.points).filter(([, x]) => x === 2).map(([id]) => id))
      }
    }
    // The never-learns control (lane none, arm on, budget 0), which the main batch includes: nothing delivered or held.
    const control = SimLearnerConfigSchema.parse({ runId: rid, learnerId: 'l0001', arm: 'on', lane: 'none', sessions: 5, turns: 3, transport: 'stub', learnerModel: model('low'), agentModel: model('low'),
      heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 0, dayGap: SIM_DAY_GAP })
    await services.db.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,'on','none',$4::jsonb)`, [rid, 'l0001', `sim-${rid.slice(0, 8)}-l0001`, JSON.stringify(control)])
    for (let t = 1; t <= 5; t++) await plantNotebook(rid, 'l0001', t, [])
    // The primary, computed here independently of the analysis code: the mean over complete pairs of G(on) - G(off),
    // G the mean of the 5 planted exams' item means.
    const pairs = Array.from({ length: perArm }, (_, k) => [G.get(`on|${k}`)!, G.get(`off|${k}`)!]).filter(([on, off]) => on.complete && off.complete)
    const data = await loadSimRun(rid)
    // The judge's answers: "no" to every planted false pair, "yes" otherwise (a judge that trusts every delivery).
    const judge = judgeSample(rid, data).items.map((x) => (x.kind === 'planted-false' ? 'no' : 'yes'))
    const report = analyzeSimRun(data, { integrity: { ok: true, detail: 'fixture' }, mainPerArm: perArm, judge })
    return { data, judge, report, text: renderSimReport(rid, report), expected: pairs.reduce((n, [on, off]) => n + on.g - off.g, 0) / pairs.length }
  }

  test('analysis (revision 10): exact estimates on fixed fixtures; supported, no effect and withheld readings', async () => {
    // Arm on delivers the static plan, arm off the brief: a large effect at 12 pairs.
    const effect = await plant({ id: 'e10f1a00-0000-4000-8000-000000000000', onPlan: 'plan' })
    const b = effect.report, o = b.outcome!
    expect(b.complete).toBe(35) // 12 + 12 + 10 and the never-learns control
    expect(b.checks.neverLearns).toMatchObject({ n: 1, ok: true })
    expect(b.checks.incompletionOk).toBe(true)
    expect(b.gates.channel.ok).toBe(true)
    // Exact: the paired AUC item-mean, as computed above from the planted exams.
    expect(o.primary.mean).toBeCloseTo(effect.expected, 9)
    expect(o.primary.pairs).toBe(12)
    expect(o.primaryLanes).toEqual(['fast'])
    // The loaded exams are the replay of the stored deliveries; every delivery is matched, so version (i) is the primary.
    expect(o.replayIdentity).toEqual({ learners: 24, reproduced: 24 })
    expect(o.matcherOnly).toEqual(o.primary)
    expect([o.reading, o.verdict, o.fired]).toEqual(['supported', 'supported', []])
    expect(effect.text).toContain('Verdict: supported')
    expect(effect.text).toContain(o.sentence)
    expect(effect.text.indexOf('Mechanism checks')).toBeLessThan(effect.text.indexOf('### 3. Outcome'))
    // The judge not run, or no verified record: withheld.
    expect(analyzeSimRun(effect.data, { integrity: { ok: true, detail: 'fixture' }, mainPerArm: 12 }).outcome!.verdict).toBe('withheld (judge: not run)')
    expect(analyzeSimRun(effect.data, { mainPerArm: 12, judge: effect.judge }).outcome!.verdict).toStartWith('withheld (frozen code and spec: not computable')

    // A null: both arms deliver 8 facts of the brief, each in its own seeded order (36 pairs); the 90% intervals of the
    // primary and of versions (i) and (ii) inside +-2, and the anchor confirmed: "no effect of 2 points or more".
    const flat = (await plant({ id: 'e20f1a00-0000-4000-8000-000000000000', onPlan: 'brief', perArm: 36 }))
    const f = flat.report.outcome!
    expect(f.primary.mean).toBeCloseTo(flat.expected, 9)
    expect(f.primary.lo90).toBeGreaterThanOrEqual(-2)
    expect(f.primary.hi90).toBeLessThanOrEqual(2)
    expect(f.anchorCheck.lo90).toBeGreaterThan(0)
    expect(f.verdict).toBe('no effect of 2 points or more')
    // N3: the rules that would have withheld a supported are listed on the null.
    expect(f.fired).toContain('sensitivity version (i) matcher-only: 95% lower bound ≤ 0')

    // Incompletion unbalanced (three on learners lost their last exam): the verdict is withheld, whatever the estimate.
    const lost = (await plant({ id: 'e40f1a00-0000-4000-8000-000000000000', onPlan: 'plan', drop: (arm, pair) => arm === 'on' && pair < 3 })).report
    expect(lost.checks.incompletionOk).toBe(false)
    expect(lost.outcome!.primary.pairs).toBe(9)
    expect(lost.outcome!.reading).toBe('supported')
    expect(lost.outcome!.verdict).toStartWith('withheld (incompletion balanced: failed')
  }, 180_000)
})
