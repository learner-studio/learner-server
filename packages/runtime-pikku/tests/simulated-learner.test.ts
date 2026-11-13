import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeCli, spawnCrashable, until } from '@learner/llm/lib/cli/testing/crash-harness.js'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { rpcService } from '@pikku/core/rpc'
import { acquireRuntimeRole, releaseRuntimeRole, setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { SimLearnerConfig as SimLearnerConfigSchema, deleteSimRun, examResult, simStubGrader, type SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { simSlots, factBudget, SIM_DAY_GAP, stratifiedHoldout, williamsRow } from '@learner/core/lib/learning/learning-sim-design.js'
import { factsBySentence } from '@learner/core/lib/learning/learning-sim-matcher.js'
import { HALYARD_FACT_EXAM, factSheet } from '@learner/core/lib/learning/learning-sim-facts.js'
import { loadLearningPolicy, saveLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { analyzeSimRun, loadSimRun, plannedCalls, renderSimReport } from '@learner/core/lib/learning/learning-sim-analysis.js'
import { HALYARD_CATALOG } from '@learner/core/lib/learning/learning-sim-halyard.js'

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
  /** A batch as the runner runs it: one learner run per config, started or adopted; their summaries, in config order. */
  const runBatch = async (configs: SimLearnerConfig[]) => {
    const services = await booted
    const { startSimLearners } = await import('../src/sim-learners.js')
    const runs = []
    for (const id of await startSimLearners(services, configs)) runs.push(await settle(id, live ? 3_500_000 : 250_000))
    expect(runs.map((r) => r.status)).toEqual(configs.map(() => 'completed'))
    return runs.map((r) => r.output as { learnerId: string; arm: string; exams: Array<{ timepoint: number; total: number }>; calls: Array<{ role: string; n: number }> })
  }

  // The design (docs/specs/simulated-learner-experiment.md): arm off in every lane, on, oracle and blind in medium.
  // `k` picks the holdout block and Williams row; the three off learners share one, so only the lane differs.
  const learner = (arm: SimLearnerConfig['arm'], lane: SimLearnerConfig['lane'], i: number, k: number): SimLearnerConfig => SimLearnerConfigSchema.parse({
    runId: runId, learnerId: `l${lane === 'slow' ? 1 : lane === 'medium' ? 2 : 3}${String(i).padStart(3, '0')}`, arm, lane, sessions: 2, turns: 2,
    transport: live ? 'codex' : 'stub', learnerModel: model('low'), agentModel: model('low'), scorerModel: model('low'),
    heldOut: stratifiedHoldout(k, 'e2e'), taskOrder: williamsRow(k).slice(0, 2), factBudget: factBudget(lane), dayGap: SIM_DAY_GAP,
  })

  // Restart safety (docs/operations/restart-safety.md), on the shared crash harness: a one-learner run in a worker
  // process (sim-crash.fixture.ts) killed twice, at two different writes, resumes by run id with every effect exactly
  // once. First SIGKILL while a learner turn's CLI child is running (reservation written, no receipt; the child is
  // the fake slow `codex`, which counts every paid invocation). A second worker takes that call over and ADOPTS the
  // detached child's result, then is stopped with SIGTERM inside a grading (the product workflow settled, the grading
  // rows not yet written); this process recovers that. Nothing lost, nothing doubled, nothing pending, no CLI call
  // paid twice, and no grading runs the product workflow twice.
  test('a run killed mid-session (SIGKILL in a model call, then SIGTERM in a grading) resumes by run id with every effect once and no call paid twice', async () => {
    const services = await booted
    const c = { ...learner('on', 'medium', 7, 1), runId: randomUUID() }
    fixtureRuns.push(c.runId)
    const KEY = 's1t2:learner', ANSWER = 'I will check the epoch before I change anything, then ask about the twins.'
    const scratch = mkdtempSync(join(tmpdir(), 'sim-crash-'))
    const codex = fakeCli(scratch, 'learner', ANSWER, 3_000)
    const worker = (hang: string) => spawnCrashable(['bun', fileURLToPath(new URL('./sim-crash.fixture.ts', import.meta.url)), JSON.stringify(c)], {
      env: { ...process.env, ...codex.env, SIM_CODEX_KEY: KEY, SIM_HANG: hang, LEARNER_LLM_ATTEMPT_DIR: join(scratch, 'attempts'), LEARNER_ATTEMPT_POLL_MS: '100',
        LEARNER_PIKKU_PGBOSS_SCHEMA: 'learner_pikku_boss_test_sim_crash' } })
    const call = async (key: string) => (await services.db.query('SELECT attempts, output FROM learning_sim_calls WHERE run_id=$1 AND call_key=$2', [c.runId, key])).rows[0] as { attempts: number; output: { text?: string } }
    const graderRows = async () => (await services.db.query(`SELECT count(*) FILTER (WHERE output ? 'text')::int recorded, count(*) FILTER (WHERE output->>'pending' = 'true' AND (output->>'invocations')::int = 4)::int reserved
      FROM learning_sim_calls WHERE run_id=$1 AND role='grader'`, [c.runId])).rows[0] as { recorded: number; reserved: number }
    try {
      const first = worker('')
      await until(() => codex.calls() === 1, 120_000, 'the learner call to reach the CLI', first)
      await first.stop('SIGKILL')
      // Paid but not recorded: the invocation is counted toward the cap before the CLI ran (S1).
      expect(await call(KEY)).toEqual({ attempts: 0, output: { pending: true, invocations: 1 } })
      // A look-alike of the runner (its script name on the command line) must not stop the next one's recovery.
      const lookalike = Bun.spawn(['bash', '-c', 'exec -a "bun packages/runtime-pikku/scripts/sim-experiment.ts --run-id lookalike" sleep 600'])
      const second = worker('record')
      await until(() => second.log().includes('HUNG'), 200_000, 'a grading to settle', second).finally(() => lookalike.kill())
      // The second worker holds the fence: another runner on this database is refused, not run alongside it.
      await expect(acquireRuntimeRole({ waitMs: 0 })).rejects.toThrow('Runtime role already active')
      second.proc.kill('SIGTERM')
      expect(await Promise.race([second.proc.exited, Bun.sleep(90_000).then(() => 'still running')])).toBe(0)
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
      const { recoverInterruptedRuns } = await import('../src/recovery.js')
      expect((await recoverInterruptedRuns(services.workflowRunService, services.workflowService, { bootedAt: Date.now(), logger: services.logger })).recovered.length).toBeGreaterThan(0)
      const ids = ((await services.db.query(`SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1`, [c.runId])).rows as Array<{ workflow_run_id: string }>).map((r) => r.workflow_run_id)
      expect(ids).toHaveLength(1)
      const run = await settle(ids[0]!, 200_000)
      expect(run.status).toBe('completed')
      expect(codex.calls()).toBe(1)
      const calls = (await services.db.query(`SELECT role, count(*)::int n, count(*) FILTER (WHERE NOT output ? 'text')::int pending FROM learning_sim_calls WHERE run_id=$1 GROUP BY role`, [c.runId])).rows as Array<{ role: string; n: number; pending: number }>
      const n = Object.fromEntries(calls.map((r) => [r.role, r.n]))
      expect(calls.every((r) => r.pending === 0)).toBe(true)
      expect([n.learner, n['agent-reply'], n['agent-match'], n.notebook, n['exam-answer']]).toEqual([5, 4, 4, 2, 2])
      // 4 turns and the blind probe before session 2. The key (session, seq, role) rules out a duplicate message; none
      // lost: 2 sessions x (2 learner + 2 agent) + 2 notebooks (the probe is a receipt, not a message).
      expect((await services.db.query('SELECT count(*)::int n FROM learning_sim_messages WHERE run_id=$1', [c.runId])).rows[0]).toEqual({ n: 10 })
      expect((run.output as { exams: Array<{ timepoint: number }> }).exams.map((e) => e.timepoint)).toEqual([0, 1, 2])
      // Every settled grading recorded once (main + replicate), each by exactly one product workflow run.
      const assessments = (await services.db.query(`SELECT run_id::text AS id FROM learning_concept_assessment_runs WHERE request_id LIKE $1`, [`sim:${c.runId}:%`])).rows as Array<{ id: string }>
      expect(n.grader).toBe(2 * assessments.length)
      const flows = (await services.db.query(`SELECT input::jsonb->>'runId' AS run, count(*)::int n FROM learner_workflow_runs WHERE workflow='learningConceptAssessmentWorkflow' AND input::jsonb->>'runId' = ANY($1::text[]) GROUP BY 1`, [assessments.map((a) => a.id)])).rows as Array<{ n: number }>
      expect(flows.length).toBe(assessments.length)
      expect(flows.every((f) => f.n === 1)).toBe(true)
    } finally {
      await releaseRuntimeRole()
      await services.db.query('DROP SCHEMA IF EXISTS learner_pikku_boss_test_sim_crash CASCADE')
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 400_000)

  // Review 7 R2-S1: the sequential runner's own restart path (sim-experiment.ts, not its helpers): a stub batch at
  // looks of 2, 4 and 6 pairs is SIGKILLed while block 2 runs, then started again with the same run id. Look 1 must be
  // adopted, not re-taken (its file is byte-identical and no block-1 learner gets a second workflow run); the batch
  // resumes at block 2 and ends with exit 0.
  test('the sequential runner, killed mid-block 2 and restarted, adopts look 1 and never restarts block 1 (review 7 R2-S1)', async () => {
    const services = await booted
    // The stub learners have no arm effect, so --stub-continue records looks 1 and 2 as continue (marked forced).
    const rid = 'e2e00000-0000-4000-8000-0000000000c1'
    fixtureRuns.push(rid)
    const out = mkdtempSync(join(tmpdir(), 'sim-runner-'))
    const script = fileURLToPath(new URL('../scripts/sim-experiment.ts', import.meta.url))
    const args = ['--run-id', rid, '--stub', '--stub-continue', '--sequential', '--looks', '2,4,6', '--lanes', 'fast', '--arms', 'on,off', '--per-arm', '6', '--sessions', '2', '--turns', '2',
      '--grading-replicates', '2', '--concurrency', '4', '--stall-minutes', '10', '--out', out]
    const env = { ...process.env, SIM_STUB_DATABASE_URL: simUrl!, DATABASE_URL: simUrl!, LEARNER_POOL_MAX: '4', LEARNER_BOSS_POOL_MAX: '3' }
    const dir = join(out, rid)
    const runsOf = async (ids: string[]) => Object.fromEntries(((await services.db.query(`SELECT input::jsonb->>'learnerId' AS id, count(*)::int n FROM learner_workflow_runs
      WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1 GROUP BY 1`, [rid])).rows as Array<{ id: string; n: number }>).filter((r) => ids.includes(r.id)).map((r) => [r.id, r.n]))
    try {
      const first = spawnCrashable(['bun', script, ...args], { env })
      await until(() => first.log().includes('"block":2'), 400_000, 'block 2 to start', first)
      const configs = JSON.parse(await Bun.file(join(dir, 'config.json')).text()).configs as SimLearnerConfig[]
      const block1 = configs.filter((c) => (c.pair ?? 0) < 2).map((c) => c.learnerId), block2 = configs.filter((c) => c.pair! >= 2 && c.pair! < 4).map((c) => c.learnerId)
      expect([block1.length, block2.length]).toEqual([4, 4])
      // Mid-block: some block-2 call recorded, and block 2 not ended.
      await until(async () => Number(((await services.db.query(`SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1 AND learner_id = ANY($2::text[])`, [rid, block2])).rows[0] as { n: number }).n) > 0, 200_000, 'a block-2 call', first)
      expect(first.log()).not.toContain('LOOK 2')
      await first.stop('SIGKILL')
      const look1 = await Bun.file(join(dir, 'look-1.json')).text()
      expect(JSON.parse(look1)).toMatchObject({ look: 1, plannedPairs: 2, decision: 'continue', failedChecks: [], forced: true })
      expect(JSON.parse(look1).learners).toEqual([...block1].sort())
      expect(await runsOf(block1)).toEqual(Object.fromEntries(block1.map((id) => [id, 1])))

      const second = spawnCrashable(['bun', script, ...args], { env })
      const code = await Promise.race([second.proc.exited, Bun.sleep(600_000).then(() => 'timeout')])
      const log = second.log()
      expect(code, log.slice(-3000)).toBe(0)
      expect(log).toContain('recorded looks adopted: look 1 continue')
      expect(log).not.toContain('"block":1')
      expect(log).toContain('"block":2')
      expect(log).not.toContain('LOOK 1 ')
      // Look 1 was never re-taken: the same bytes; no block-1 learner ran again.
      expect(await Bun.file(join(dir, 'look-1.json')).text()).toBe(look1)
      expect(await runsOf(block1)).toEqual(Object.fromEntries(block1.map((id) => [id, 1])))
      // Block 2 was resumed (its interrupted runs recovered or adopted), and look 2 read blocks 1 and 2 only.
      const look2 = JSON.parse(await Bun.file(join(dir, 'look-2.json')).text())
      expect(look2.learners).toEqual([...block1, ...block2].sort())
      // A third start adopts the recorded stop, runs nothing and exits 0 (no Restart=on-failure loop).
      const third = spawnCrashable(['bun', script, ...args], { env })
      expect(await Promise.race([third.proc.exited, Bun.sleep(180_000).then(() => 'timeout')]), third.log().slice(-3000)).toBe(0)
      expect(third.log()).not.toMatch(/"block":\d/)
      expect(third.log()).toContain('the batch ended:')
    } finally {
      await services.db.query('DROP SCHEMA IF EXISTS learner_pikku_boss_sim CASCADE')
      rmSync(out, { recursive: true, force: true })
    }
  }, 1_300_000)

  // Review 9 B1': no stub-only seam is decided from a caller-controlled file or flag. A --stub process opens only a
  // learner_sim_test database; whether a run is a stub run is read from its learners in the database, never from --out.
  test('the runner: --stub never reaches learner_sim, and a run is judged by its database record, not --out (review 9 B1\')', async () => {
    const services = await booted
    const script = fileURLToPath(new URL('../scripts/sim-experiment.ts', import.meta.url))
    const out = mkdtempSync(join(tmpdir(), 'sim-trust-'))
    const env = { ...process.env, SIM_STUB_DATABASE_URL: simUrl!, DATABASE_URL: simUrl!, LEARNER_POOL_MAX: '2' }
    const run = (args: string[], e: Record<string, string | undefined> = env) => {
      const p = Bun.spawnSync(['bun', script, ...args, '--out', out], { env: e })
      return { code: p.exitCode, err: p.stderr.toString(), out: p.stdout.toString() }
    }
    const real = { ...learner('on', 'fast', 1, 0), runId: 'e2e00000-0000-4000-8000-0000000000c2', transport: 'codex' as const }
    fixtureRuns.push(real.runId)
    try {
      // 1. --stub needs SIM_STUB_DATABASE_URL naming a learner_sim_test database: unset, or learner_sim, is refused.
      const { SIM_STUB_DATABASE_URL: _, ...unset } = env
      const toSim = Object.assign(new URL(simUrl!), { pathname: '/learner_sim' }).toString()
      for (const e of [unset, { ...env, SIM_STUB_DATABASE_URL: toSim }]) {
        const r = run(['--stub', '--analyze-only', '--run-id', real.runId], e)
        expect([r.code, r.err.includes('--stub needs SIM_STUB_DATABASE_URL')], r.err).toEqual([7, true])
      }
      // 3. A codex run in the database, --out an empty directory: --stub on --analyze-only, --health or a start is
      // refused, and no report is printed.
      await services.db.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,'on','fast',$4::jsonb)`,
        [real.runId, real.learnerId, `sim-${real.learnerId}`, JSON.stringify(real)])
      for (const mode of [['--analyze-only'], ['--health'], ['--lanes', 'fast', '--arms', 'on', '--per-arm', '1', '--sessions', '2', '--turns', '2']]) {
        const r = run(['--stub', '--run-id', real.runId, ...mode])
        expect([r.code, r.err.includes('has codex learners'), r.out.includes('# ')], r.err).toEqual([7, true, false])
      }
      // A stub run whose learners reach the first look (2 pairs at --looks 2,4,6): with no record under --out it is
      // refused; with a record that says "not sequential" it is still sequential (from the database) and, with no
      // look recorded, refused until it stops.
      const stubRun = 'e2e00000-0000-4000-8000-0000000000c3'
      fixtureRuns.push(stubRun)
      const pairs = (['on', 'off'] as const).flatMap((arm) => [0, 1].map((pair) => ({ ...learner(arm, 'fast', arm === 'on' ? 10 + pair : 20 + pair, pair), runId: stubRun, pair })))
      for (const c of pairs) await services.db.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,$4,'fast',$5::jsonb)`,
        [stubRun, c.learnerId, `sim-${c.learnerId}`, c.arm, JSON.stringify(c)])
      const noRecord = run(['--stub', '--analyze-only', '--looks', '2,4,6', '--run-id', stubRun])
      expect([noRecord.code, noRecord.err.includes('no config.json')], noRecord.err).toEqual([7, true])
      mkdirSync(join(out, stubRun))
      writeFileSync(join(out, stubRun, 'config.json'), JSON.stringify({ configs: pairs, sequential: false }))
      const notStopped = run(['--stub', '--analyze-only', '--looks', '2,4,6', '--run-id', stubRun])
      expect([notStopped.code, notStopped.err.includes('is sequential and has not stopped')], notStopped.err).toEqual([6, true])
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  }, 300_000)

  // B6 prior-blind: with 3 sessions most learners probe the same concept twice (sessions 2 and 3). Each probe is
  // graded under its own user, so the product's prepare finds no earlier reading: every probe's snapshot prior is
  // null, the repeat included. (One grading user per learner would anchor the second probe on the first.)
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
    expect(report.checks.neverLearns).toMatchObject({ n: 1, examOk: true })
    expect(report.mechanism).toEqual({})
  }, 250_000)

  test('a concept probed twice is graded prior-blind both times (B6)', async () => {
    const services = await booted
    const rid = 'e2e00000-0000-4000-8000-0000000000b6'
    fixtureRuns.push(rid)
    await deleteSimRun(rid)
    const configs = Array.from({ length: 8 }, (_, i) => ({ ...learner('off', 'medium', 10 + i, i), runId: rid, sessions: 3, turns: 2, taskOrder: williamsRow(i).slice(0, 3) }))
    await runBatch(configs)
    const runs = (await services.db.query(`SELECT user_id, concept_id, request_id, snapshot->'prior' AS prior FROM learning_concept_assessment_runs WHERE request_id LIKE $1`, [`sim:${rid}:%:p%`])).rows as Array<{ user_id: string; concept_id: string; request_id: string; prior: unknown }>
    expect(runs.length).toBe(2 * configs.length)
    const repeated = configs.filter((c) => { const mine = runs.filter((r) => r.request_id.startsWith(`sim:${rid}:${c.learnerId}:`)); return new Set(mine.map((r) => r.concept_id)).size < mine.length })
    expect(repeated.length).toBeGreaterThan(0)
    expect(runs.every((r) => r.prior === null)).toBe(true)
    expect(new Set(runs.map((r) => r.user_id)).size).toBe(runs.length)
  }, live ? 3_600_000 : 300_000)

  // The runner's alarm: a run whose statuses and written rows stop changing ends the wait with SimRunStalled (the
  // runner exits 3) instead of polling forever; one that keeps writing is waited for until every run ends.
  test('the runner raises a stall alarm when a run stops progressing, and waits while it progresses', async () => {
    const { watchSimRun, SimRunStalled } = await import('../src/sim-learners.js')
    const lines: string[] = []
    // The poll gives up after 2 s of polls, so a watcher that never alarms fails here instead of hanging the file.
    let polls = 0
    const stuck = watchSimRun({ pollMs: 20, stallMs: 200, log: (l) => lines.push(l), poll: async () => {
      if (++polls > 100) throw new Error('no alarm after 100 polls')
      return { statuses: ['running', 'completed'], progress: 7 }
    } })
    await expect(stuck).rejects.toBeInstanceOf(SimRunStalled)
    expect(lines).toHaveLength(1)
    let n = 0
    const moving = await watchSimRun({ pollMs: 20, stallMs: 200, log: () => {}, poll: async () => (++n < 30 ? { statuses: ['running'], progress: n } : { statuses: ['completed'], progress: n }) })
    expect(moving).toEqual(['completed'])
    expect(n).toBe(30) // 30 polls x 20 ms = 600 ms, past stallMs, without an alarm: progress resets the clock
  })

  test('a batch: the budget enforced at the channel, no baseline exam, a simulated calendar, only arm on grades through the product workflow, memory rules recorded, lanes in order, receipts reused, the call cap', async () => {
    const services = await booted
    const configs = [learner('off', 'slow', 1, 0), learner('off', 'medium', 2, 0), learner('off', 'fast', 3, 0), learner('on', 'medium', 4, 1), learner('oracle', 'medium', 5, 1), learner('blind', 'medium', 6, 1)]
    const learners = await runBatch(configs)
    expect(learners.map((l) => l.learnerId)).toEqual(configs.map((c) => c.learnerId))
    for (const [i, out] of learners.entries()) {
      const n = Object.fromEntries(out.calls.map((c) => [c.role, c.n]))
      // The baseline is an empty notebook's 0, never a model call.
      expect(out.exams.map((e) => e.timepoint)).toEqual([0, 1, 2])
      expect(out.exams[0]!.total).toBe(0)
      expect(n['exam-answer']).toBe(2)
      expect(n['agent-match'] ?? 0).toBe(configs[i]!.arm === 'off' ? 0 : 4)
    }
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
    // B6: every learner, in every arm, answered one blind probe before session 2 about a concept delivered in session 1,
    // graded (main + replicate) after its last session under its own grading user, never the learner's.
    const probeRows = (await services.db.query(`SELECT learner_id, call_key FROM learning_sim_calls WHERE run_id=$1 AND (call_key LIKE 's%:probe:%' OR call_key LIKE 'p%:grade:%') ORDER BY learner_id, call_key`, [runId])).rows as Array<{ learner_id: string; call_key: string }>
    for (const c of configs) {
      const keys = probeRows.filter((p) => p.learner_id === c.learnerId).map((p) => p.call_key)
      const concept = keys.find((k) => k.startsWith('s2:probe:'))?.split(':probe:')[1]
      expect(keys).toEqual([`p2:grade:${concept}`, `p2:grade:${concept}:r2`, `s2:probe:${concept}`])
      const delivered = (await services.db.query(`SELECT jsonb_array_elements_text(meta->'statedFactIds') id FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 AND session=1 AND role='agent'`, [runId, c.learnerId])).rows as Array<{ id: string }>
      expect(delivered.some((d) => concept === `halyard-core--${d.id.replace(/-f\d+$/, '')}`)).toBe(true)
    }
    const probeUsers = (await services.db.query(`SELECT DISTINCT user_id FROM learning_concept_assessment_runs WHERE request_id LIKE $1`, [`sim:${runId}:%:p2:%`])).rows as Array<{ user_id: string }>
    expect(probeUsers.length).toBe(configs.length)
    expect(probeUsers.every((u) => u.user_id.endsWith('-probe-s2'))).toBe(true)
    // The agent turns of the Learner arms went through the live feedback tables under the Halyard catalog; arm off's
    // agent saw no hook text.
    const feedback = (await services.db.query(`SELECT count(*)::int n, count(DISTINCT catalog_version)::int versions, min(catalog_version) version FROM learning_live_feedback_turns WHERE user_id LIKE $1`, [`sim-${runId.slice(0, 8)}-%`])).rows[0]
    expect(feedback).toMatchObject({ n: 4 * configs.filter((c) => c.arm !== 'off').length, versions: 1, version: HALYARD_CATALOG.version })
    // The budget at the channel: the facts the matcher finds in what the learner READ are within budget per session,
    // and every one was on a sheet offered that turn (the stub states sheet facts verbatim).
    const agent = (await services.db.query(`SELECT learner_id, session, seq, text, meta FROM learning_sim_messages WHERE run_id=$1 AND role='agent' ORDER BY seq`, [runId])).rows as Array<{ learner_id: string; session: number; text: string; meta: { statedFactIds: string[]; sheets: string[]; redacted: number; claimedFactIds: string[]; overBudgetFacts: string[]; attributedFacts: string[]; budgetLeft: number } }>
    let overClaimSessions = 0, attributedSessions = 0
    for (const c of configs) for (const session of [1, 2]) {
      const turns = agent.filter((m) => m.learner_id === c.learnerId && m.session === session)
      const stated = turns.flatMap((m) => m.meta.statedFactIds)
      expect(stated.length).toBeGreaterThan(0)
      expect(stated.length).toBeLessThanOrEqual(c.factBudget!)
      const read = new Set(turns.flatMap((m) => factsBySentence(m.text).flatMap((x) => x.facts)))
      expect([...read].every((id) => stated.includes(id))).toBe(true)
      expect(stated.every((id) => turns.some((m) => m.meta.sheets.some((sheet) => factSheet(sheet).facts.some((f) => f.id === id))))).toBe(true)
      // The stub claims one fact beyond the budget that the matcher cannot find: the claim is believed, so its sentence
      // is redacted and the fact is never counted as delivered. It over-claims only when its offered facts outrun the
      // budget left (revision 8's sheets hold 2-6 facts, and a restated fact costs nothing), so not in every session.
      const overClaimed = turns.flatMap((m) => m.meta.claimedFactIds).filter((id) => !stated.includes(id))
      if (overClaimed.length) overClaimSessions++
      expect(turns.flatMap((m) => m.meta.overBudgetFacts)).toEqual(expect.arrayContaining(overClaimed))
      const attributed = turns.flatMap((m) => m.meta.attributedFacts)
      if (attributed.length) attributedSessions++
      expect(turns.every((m) => m.meta.attributedFacts.every((id) => m.meta.claimedFactIds.includes(id)))).toBe(true)
    }
    // Both paths are exercised, not vacuous: an over-budget claim redacted, a claim the matcher missed attributed.
    expect(overClaimSessions).toBeGreaterThan(0)
    expect(attributedSessions).toBeGreaterThan(0)
    // The calendar: session 2 is dayGap days after session 1, in the past, for messages and live turns alike.
    const at = (await services.db.query(`SELECT session, min(created_at) AS at FROM learning_sim_messages WHERE run_id=$1 AND learner_id=$2 GROUP BY session ORDER BY session`, [runId, configs[3]!.learnerId])).rows as Array<{ at: Date }>
    expect(Math.round((at[1]!.at.getTime() - at[0]!.at.getTime()) / 86_400_000)).toBe(SIM_DAY_GAP)
    expect(at[1]!.at.getTime()).toBeLessThan(Date.now())
    const turns = (await services.db.query(`SELECT session_id, min(created_at) AS at, min(submitted_at) AS submitted FROM learning_live_feedback_turns WHERE user_id=$1 GROUP BY session_id ORDER BY 2`, [`sim-${runId.slice(0, 8)}-${configs[3]!.learnerId}`])).rows as Array<{ at: Date; submitted: Date }>
    expect(turns.length).toBe(2)
    expect(Math.round((turns[1]!.at.getTime() - turns[0]!.at.getTime()) / 86_400_000)).toBe(SIM_DAY_GAP)
    expect(Math.abs(turns[0]!.submitted.getTime() - turns[0]!.at.getTime())).toBeLessThan(3_600_000)
    // The memory rules' state is stored with each notebook (spacing strengths).
    const notebooks = (await services.db.query(`SELECT meta FROM learning_sim_messages WHERE run_id=$1 AND role='notebook'`, [runId])).rows as Array<{ meta: Record<string, unknown> }>
    expect(notebooks.length).toBe(configs.length * 2)
    expect(notebooks.every((n) => typeof n.meta.strengths === 'object' && typeof n.meta.unabsorbed === 'number')).toBe(true)
    const report = analyzeSimRun(await loadSimRun(runId), { integrity: { ok: true, detail: 'test' }, mainPerArm: 1 })
    const lanes = report.checks.laneOrder.off!.map((l) => l.finalExam)
    expect(lanes[0]!).toBeLessThan(lanes[2]!)
    expect(report.checks.heldOutTargeted).toBe(0)
    expect(report.checks.incomplete).toEqual([])
    expect(report.readingsBySession[configs[3]!.learnerId]!.length).toBe(1)
    // The channel gate (revision 8) on the real channel and loader: every claim accounted, nothing over budget read.
    expect(report.gates.channel).toMatchObject({ claimedUnaccounted: 0, overBudgetKept: 0, ok: true })
    expect(report.claim2!.gradings).toBe(main.length)
    // B5's echo measure: one value per learner message that follows an agent reply (turn 2 of each of 2 sessions).
    expect(report.echo.all.n).toBe(2 * configs.length)
    expect(report.claim2!.blindProbes.n).toBe(configs.length)
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
    const flowsAfter = (await services.db.query(`SELECT count(*)::int n FROM learner_workflow_runs WHERE workflow='learningConceptAssessmentWorkflow' AND input::jsonb->>'runId' = ANY($1::text[])`, [main])).rows[0]
    expect(flowsAfter).toEqual({ n: main.length })

    // The hard cap counts paid invocations, not call keys (S1): a call that needed a capacity retry uses 2 of the cap.
    // At the cap a stored receipt still answers, and no new call starts.
    const { setSimCallCap, simCall, simCallsUsed, stubTransport, SimCallBudgetExhausted } = await import('@learner/core/lib/learning/learning-sim-model.js')
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
    const used = await simCallsUsed(runId)
    setSimCallCap({ runId: runId, max: used + 2 })
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
      setSimCallCap({ runId: runId, max: (await simCallsUsed(runId)) + 1 })
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
      setSimCallCap({ runId: runId, max: atCap - 1 })
      let refused: string | undefined
      for (const { id } of HALYARD_CATALOG.concepts) {
        const r = await prepareSimGrade({ config: on, session: on.sessions, conceptId: id }, services.learningConceptAssessment).then(() => null, (e: unknown) => e)
        if (r) { expect(r).toBeInstanceOf(SimCallBudgetExhausted); refused = id; break }
      }
      expect(refused).toBeDefined()
      setSimCallCap({ runId: runId, max: atCap })
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
      setSimCallCap({ runId: runId, max: (await simCallsUsed(runId)) + 2 * reserve })
      const raced = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => reserveSimGrading(on, `race:${i}`, reserve)))
      expect(raced.filter((x) => x.status === 'fulfilled').length).toBe(2)
      expect(raced.every((x) => x.status === 'fulfilled' || x.reason instanceof SimCallBudgetExhausted)).toBe(true)
      expect(await simCallsUsed(runId)).toBe(atCap + 2 * reserve)
    } finally {
      setSimCallCap(null)
    }
  }, live ? 3_600_000 : 300_000)

  /**
   * A whole run written as rows (no model call), read back by loadSimRun and analysed: the analysis path end
   * to end, on a FIXED run id, so every estimate is exact. Each learner knows fact f at exam t when its fixed draw
   * u(f) < p(t) = t/5 x (base + ability + effect), so exams 3, 4 and 5 differ; the agent's turns deliver exactly the
   * facts known, so nothing is unbudgeted. `effect(arm, lane, heldOut)` is added per concept, so the planted effect
   * can differ between lanes and between held-out and other concepts. `drop` learners lose their last exam.
   */
  type Plant = { id: string; sd: number; effect: (arm: string, lane: string, heldOut: boolean) => number; drop: (arm: string, lane: string, cellIndex: number) => boolean; matched?: boolean
    /** Learners per arm and lane (default 16, the fixture's main size). */
    perArm?: number
    /** Learners who know one fact on the FINAL exam that the channel never delivered (knowledge that bypassed it). */
    leak?: (arm: string, cellIndex: number) => boolean }
  const plant = async ({ id: rid, sd: abilitySd, effect, drop, matched, leak, perArm = 16 }: Plant) => {
    await deleteSimRun(rid)
    fixtureRuns.push(rid)
    let state = 12345
    const r = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 }
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r())
    const services = await booted
    const finals: Array<{ arm: string; lane: string; total: number; complete: boolean }> = []
    for (const slot of simSlots(rid, ['slow', 'medium'], () => perArm, ['off', 'on', 'oracle'], 5)) {
      const learnerId = `l${slot.lane === 'slow' ? 1 : 2}${String(slot.index).padStart(3, '0')}`
      const config = SimLearnerConfigSchema.parse({ runId: rid, learnerId, arm: slot.arm, lane: slot.lane, sessions: 5, turns: 3, transport: 'stub', learnerModel: model('low'), agentModel: model('low'), scorerModel: model('low'),
        heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap })
      await services.db.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [rid, learnerId, `sim-${rid.slice(0, 8)}-${learnerId}`, slot.arm, slot.lane, JSON.stringify(config)])
      const ability = 0.2 + abilitySd * normal() + (slot.lane === 'medium' ? 0.1 : 0)
      // matched: the k-th learners of every arm in a lane share their fact draws (only ability and effect differ).
      const u = Object.fromEntries(HALYARD_FACT_EXAM.map((q) => [q.id, matched ? parseInt(createHash('sha256').update(`${slot.lane}|${slot.cellIndex}|${q.id}`).digest('hex').slice(0, 8), 16) / 2 ** 32 : r()]))
      const dropped = drop(slot.arm, slot.lane, slot.cellIndex)
      let before = new Set<string>()
      for (let t = 1; t <= 5; t++) {
        const known = new Set(HALYARD_FACT_EXAM.filter((q) => u[q.id]! < (t / 5) * (ability + effect(slot.arm, slot.lane, slot.heldOut.includes(q.conceptId)))).map((q) => q.id))
        const leaked = t === 5 && leak?.(slot.arm, slot.cellIndex) ? HALYARD_FACT_EXAM.find((q) => !known.has(q.id))?.id : undefined
        const scores = HALYARD_FACT_EXAM.map((q) => ({ id: q.id, points: known.has(q.id) || q.id === leaked ? 2 : 0, note: 'planted' }))
        if (!(dropped && t === 5)) await services.db.query(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,$2,$3,'exam-score','planted','low',0,1,$4::jsonb)`, [rid, learnerId, `exam${t}:score`, JSON.stringify({ text: JSON.stringify({ scores }) })])
        if (t === 5) finals.push({ arm: slot.arm, lane: slot.lane, total: examResult(5, Object.fromEntries(scores.map((x) => [x.id, x.points]))).total, complete: !dropped })
        const fresh = [...known].filter((id) => !before.has(id))
        before = known
        const meta = { decision: slot.arm === 'off' ? 'none' : 'influence', conceptIds: slot.arm === 'off' ? [] : [HALYARD_CATALOG.concepts.find((c) => !slot.heldOut.includes(c.id))!.id], statedFactIds: fresh, claimedFactIds: fresh,
          sheets: [], lookups: [], budgetLeft: slot.factBudget, overBudget: 0, invalidFacts: 0, review: null, unofferedFacts: [], overBudgetFacts: [], redacted: 0 }
        await services.db.query(`INSERT INTO learning_sim_messages(run_id,learner_id,session,seq,role,text,meta) VALUES($1,$2,$3,1,'agent','planted',$4::jsonb)`, [rid, learnerId, t, JSON.stringify(meta)])
      }
    }
    // The never-learns control (lane none, arm on, budget 0), which the main batch includes: every exam 0.
    const control = SimLearnerConfigSchema.parse({ runId: rid, learnerId: 'l0001', arm: 'on', lane: 'none', sessions: 5, turns: 3, transport: 'stub', learnerModel: model('low'), agentModel: model('low'), scorerModel: model('low'),
      heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 0, dayGap: SIM_DAY_GAP })
    await services.db.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,$2,$3,'on','none',$4::jsonb)`, [rid, 'l0001', `sim-${rid.slice(0, 8)}-l0001`, JSON.stringify(control)])
    for (let t = 1; t <= 5; t++) await services.db.query(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,'l0001',$2,'exam-score','planted','low',0,1,$3::jsonb)`,
      [rid, `exam${t}:score`, JSON.stringify({ text: JSON.stringify({ scores: HALYARD_FACT_EXAM.map((q) => ({ id: q.id, points: 0, note: 'planted' })) }) })])
    // The primary, computed here independently of the analysis code: the mean over lanes of the on - off difference
    // of complete-case final-exam means (the baseline is 0).
    const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const laneDiff = (lane: string) => m(finals.filter((x) => x.complete && x.arm === 'on' && x.lane === lane).map((x) => x.total)) - m(finals.filter((x) => x.complete && x.arm === 'off' && x.lane === lane).map((x) => x.total))
    const report = analyzeSimRun(await loadSimRun(rid), { integrity: { ok: true, detail: 'fixture' }, mainPerArm: perArm })
    return { report, text: renderSimReport(rid, report), expected: (laneDiff('slow') + laneDiff('medium')) / 2, medium: laneDiff('medium') }
  }

  test('analysis: exact estimates on fixed fixtures; supported, no effect, inconclusive and withheld readings', async () => {
    // An effect in the medium lane only, three times larger on held-out concepts; one incomplete learner per arm in slow.
    const effect = await plant({ id: 'e10f1a00-0000-4000-8000-000000000000', sd: 0.06, effect: (arm, lane, held) => (arm === 'on' && lane === 'medium' ? (held ? 0.3 : 0.1) : 0), drop: (_, lane, k) => lane === 'slow' && k === 0 })
    const b = effect.report
    expect(b.complete).toBe(94) // 93 and the never-learns control
    expect(b.checks.neverLearns).toMatchObject({ n: 1, examOk: true, masteryOk: true })
    expect(b.checks.incompletion.slow).toEqual({ off: { assigned: 16, incomplete: 1 }, on: { assigned: 16, incomplete: 1 }, oracle: { assigned: 16, incomplete: 1 } })
    expect(b.checks.incompletionOk).toBe(true)
    expect(b.checks.unbudgetedOk).toBe(true)
    // Every known fact was delivered, so scoring on delivered facts only changes nothing.
    expect(b.outcome.sensitivityDelivered.mean).toBeCloseTo(b.outcome.primary.mean, 9)
    // Exact: the mean of per-lane differences over both lanes, whole exam, final exam (not exam 3 or 4, not medium only).
    expect(b.outcome.primary.mean).toBeCloseTo(effect.expected, 9)
    expect(Math.abs(b.outcome.primary.mean - effect.medium)).toBeGreaterThan(3)
    expect(b.outcome.primaryLanes).toEqual(['slow', 'medium'])
    expect(b.outcome.verdict).toBe('supported')
    expect(b.mechanism.on!.targetedDose).toBeGreaterThan(0)
    expect(effect.text).toContain('Verdict: supported')
    expect(effect.text.indexOf('Mechanism checks')).toBeLessThan(effect.text.indexOf('### 3. Outcome'))

    // A null with little noise (matched fact draws): the 90% interval inside +-2 is the pre-registered "no effect of 2 points or more".
    // 32 per arm: on the 64-item exam (revision 8) each fact weighs more, so 16 per arm leaves the unpaired interval near +-2.3.
    const flat = (await plant({ id: 'e20f1a00-0000-4000-8000-000000000000', sd: 0.005, effect: () => 0, drop: () => false, matched: true, perArm: 32 })).report
    expect(flat.outcome.primary.lo90).toBeGreaterThanOrEqual(-2)
    expect(flat.outcome.primary.hi90).toBeLessThanOrEqual(2)
    expect(flat.outcome.verdict).toBe('no effect of 2 points or more')

    // A small effect (1.5 points) whose point estimate is above 0 but whose interval covers 0 and passes +2:
    // inconclusive, never supported on the sign of the mean.
    const noisy = await plant({ id: 'e30f1a00-0000-4000-8000-000000000000', sd: 0.04, effect: (arm) => (arm === 'on' ? 0.015 : 0), drop: () => false, matched: true })
    expect(noisy.report.outcome.primary.mean).toBeCloseTo(noisy.expected, 9)
    expect(noisy.report.outcome.primary.mean).toBeGreaterThan(0)
    expect(noisy.report.outcome.primary.lo).toBeLessThan(0)
    expect(noisy.report.outcome.primary.hi90).toBeGreaterThan(2)
    expect(noisy.report.outcome.verdict).toBe('inconclusive')

    // Incompletion unbalanced (three on learners of the medium lane lost): the verdict is withheld, whatever the estimate.
    const lost = (await plant({ id: 'e40f1a00-0000-4000-8000-000000000000', sd: 0.06, effect: (arm) => (arm === 'on' ? 0.3 : 0), drop: (arm, lane, k) => arm === 'on' && lane === 'medium' && k < 3 })).report
    expect(lost.checks.incompletionOk).toBe(false)
    expect(lost.outcome.reading).toBe('supported')
    expect(lost.outcome.verdict).toStartWith('withheld')
    // B2: a quarter of arm on's learners know one undelivered fact on the final exam only. Every arm is under 0.5 per
    // learner and the earlier exams are clean, but the arms differ by 0.25 > 0.2: withheld. The delivered-only
    // sensitivity drops the leaked facts, so it sits below the primary.
    const leaky = (await plant({ id: 'e50f1a00-0000-4000-8000-000000000000', sd: 0.06, effect: () => 0, drop: () => false, leak: (arm, k) => arm === 'on' && k % 4 === 0 })).report
    expect(leaky.checks.unbudgetedPrimary.on).toBeCloseTo(0.25, 9)
    expect(leaky.checks.unbudgetedPrimary.on).toBeLessThanOrEqual(0.5)
    expect(leaky.checks.unbudgetedArmGap).toBeCloseTo(0.25, 9)
    expect(leaky.checks.unbudgetedOk).toBe(false)
    expect(leaky.outcome.verdict).toContain('unbudgeted knowledge about 0 and balanced: failed')
    expect(leaky.outcome.sensitivityDelivered.mean).toBeLessThan(leaky.outcome.primary.mean)
    // Without a verified config.json the verdict is withheld too.
    expect(analyzeSimRun(await loadSimRun('e20f1a00-0000-4000-8000-000000000000'), { mainPerArm: 16 }).outcome!.verdict).toStartWith('withheld (frozen code and spec: not computable')
  }, 180_000)
})

// Review 2, N3: the analysis and a resume read the checkout against the commit the run recorded; any change to a frozen
// path (a sim module, a new one, the runner or the spec) is reported, any other change is not.
test('frozen sim code and spec: changed, new and spec files are reported against the recorded commit; others are not', async () => {
  const { frozenSimChanges, gitFreeEnv } = await import('../src/sim-learners.js')
  const repo = mkdtempSync(join(tmpdir(), 'sim-frozen-'))
  try {
    const sh = (cmd: string) => { const r = Bun.spawnSync(['bash', '-c', cmd], { cwd: repo, env: gitFreeEnv() }); if (r.exitCode) throw new Error(r.stderr.toString()) }
    sh(`git init -q && git config user.email t@t && git config user.name t && mkdir -p packages/core/src/lib/learning docs/specs
      echo a > packages/core/src/lib/learning/learning-sim-analysis.ts && echo b > packages/core/src/lib/learning/other.ts && echo c > docs/specs/simulated-learner-experiment.md
      git add -A && git commit -qm base`)
    const commit = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD'], { env: gitFreeEnv() }).stdout.toString().trim()
    expect(frozenSimChanges(commit, repo)).toEqual([])
    // Review 3, B1: the whole of packages/ is frozen (the product code the run executes and analyses with); a file
    // outside packages/, the root manifests and the spec is not.
    sh('echo changed > README.md')
    expect(frozenSimChanges(commit, repo)).toEqual([])
    sh('echo changed > packages/core/src/lib/learning/other.ts')
    expect(frozenSimChanges(commit, repo)).toEqual(['packages/core/src/lib/learning/other.ts'])
    sh('echo scored-differently >> packages/core/src/lib/learning/learning-sim-analysis.ts && echo x > packages/core/src/lib/learning/learning-sim-new.ts && echo d >> docs/specs/simulated-learner-experiment.md')
    expect(frozenSimChanges(commit, repo).sort()).toEqual(['docs/specs/simulated-learner-experiment.md', 'packages/core/src/lib/learning/learning-sim-analysis.ts', 'packages/core/src/lib/learning/learning-sim-new.ts', 'packages/core/src/lib/learning/other.ts'])
    sh('git add -A && git commit -qm later')
    expect(frozenSimChanges(commit, repo)).toHaveLength(4) // committed later still differs from the recorded commit
    expect(frozenSimChanges('0'.repeat(40), repo)).toEqual([`commit ${'0'.repeat(40)} not found`])
    // Under a git hook (GIT_DIR and GIT_INDEX_FILE exported, here at a second throwaway repository) the check still
    // reads `repo`, not the hook's repository.
    sh('git init -q --bare hook.git')
    const probe = Bun.spawnSync(['bun', '-e', `const { frozenSimChanges } = await import(${JSON.stringify(fileURLToPath(new URL('../src/sim-learners.ts', import.meta.url)))}); console.log(JSON.stringify(frozenSimChanges(${JSON.stringify(commit)}, ${JSON.stringify(repo)})))`],
      { env: { ...gitFreeEnv(), GIT_DIR: join(repo, 'hook.git'), GIT_INDEX_FILE: join(repo, 'hook.index') } })
    expect(JSON.parse(probe.stdout.toString())).toHaveLength(4) // the same four; the hook's repository would say 'not found'
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
