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
    const graderRows = async () => (await services.db.query(`SELECT count(*)::int n FROM learning_sim_calls WHERE run_id=$1 AND role='grader'`, [c.runId])).rows[0]
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
      expect(await graderRows()).toEqual({ n: 0 })
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

  // B6 prior-blind: with 3 sessions most learners probe the same concept twice (sessions 2 and 3). Each probe is
  // graded under its own user, so the product's prepare finds no earlier reading: every probe's snapshot prior is
  // null, the repeat included. (One grading user per learner would anchor the second probe on the first.)
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
    const agent = (await services.db.query(`SELECT learner_id, session, seq, text, meta FROM learning_sim_messages WHERE run_id=$1 AND role='agent' ORDER BY seq`, [runId])).rows as Array<{ learner_id: string; session: number; text: string; meta: { statedFactIds: string[]; sheets: string[]; redacted: number; claimedFactIds: string[] } }>
    for (const c of configs) for (const session of [1, 2]) {
      const turns = agent.filter((m) => m.learner_id === c.learnerId && m.session === session)
      const stated = turns.flatMap((m) => m.meta.statedFactIds)
      expect(stated.length).toBeGreaterThan(0)
      expect(stated.length).toBeLessThanOrEqual(c.factBudget!)
      const read = new Set(turns.flatMap((m) => factsBySentence(m.text).flatMap((x) => x.facts)))
      expect([...read].every((id) => stated.includes(id))).toBe(true)
      expect(stated.every((id) => turns.some((m) => m.meta.sheets.some((sheet) => factSheet(sheet).facts.some((f) => f.id === id))))).toBe(true)
    }
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
    const used = await simCallsUsed(runId)
    setSimCallCap({ runId: runId, max: used + 2 })
    try {
      const learnerId = configs[0]!.learnerId
      const spec = { model: 'stub', effort: 'low', timeoutSec: 30, runId: runId, learnerId, role: 'learner' as const, prompt: 'cap probe' }
      const stored = (await services.db.query(`SELECT call_key FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 AND role='learner' LIMIT 1`, [runId, learnerId])).rows[0] as { call_key: string }
      expect((await simCall({ ...spec, callKey: stored.call_key }, stubTransport())).reused).toBe(true)
      let failures = 1
      const flaky = Object.assign(async (s: Parameters<ReturnType<typeof stubTransport>>[0]) => { if (failures-- > 0) throw new Error('503 UNAVAILABLE'); return stubTransport()(s) }, { backend: stubTransport().backend })
      expect((await simCall({ ...spec, callKey: 'cap-retry' }, flaky, async () => {})).attempts).toBe(2)
      expect(await simCallsUsed(runId)).toBe(used + 2)
      await expect(simCall({ ...spec, callKey: 'cap-probe' }, stubTransport())).rejects.toBeInstanceOf(SimCallBudgetExhausted)
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
    /** Learners who know one fact on the FINAL exam that the channel never delivered (knowledge that bypassed it). */
    leak?: (arm: string, cellIndex: number) => boolean }
  const plant = async ({ id: rid, sd: abilitySd, effect, drop, matched, leak }: Plant) => {
    await deleteSimRun(rid)
    fixtureRuns.push(rid)
    let state = 12345
    const r = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648 }
    const normal = () => Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r())
    const services = await booted
    const finals: Array<{ arm: string; lane: string; total: number; complete: boolean }> = []
    for (const slot of simSlots(rid, ['slow', 'medium'], () => 16, ['off', 'on', 'oracle'], 5)) {
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
    // The primary, computed here independently of the analysis code: the mean over lanes of the on - off difference
    // of complete-case final-exam means (the baseline is 0).
    const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const laneDiff = (lane: string) => m(finals.filter((x) => x.complete && x.arm === 'on' && x.lane === lane).map((x) => x.total)) - m(finals.filter((x) => x.complete && x.arm === 'off' && x.lane === lane).map((x) => x.total))
    const report = analyzeSimRun(await loadSimRun(rid), { integrity: { ok: true, detail: 'fixture' }, mainPerArm: 16 })
    return { report, text: renderSimReport(rid, report), expected: (laneDiff('slow') + laneDiff('medium')) / 2, medium: laneDiff('medium') }
  }

  test('analysis: exact estimates on fixed fixtures; supported, no effect, inconclusive and withheld readings', async () => {
    // An effect in the medium lane only, three times larger on held-out concepts; one incomplete learner per arm in slow.
    const effect = await plant({ id: 'e10f1a00-0000-4000-8000-000000000000', sd: 0.06, effect: (arm, lane, held) => (arm === 'on' && lane === 'medium' ? (held ? 0.3 : 0.1) : 0), drop: (_, lane, k) => lane === 'slow' && k === 0 })
    const b = effect.report
    expect(b.complete).toBe(93)
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
    const flat = (await plant({ id: 'e20f1a00-0000-4000-8000-000000000000', sd: 0.005, effect: () => 0, drop: () => false, matched: true })).report
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
    sh('echo changed > packages/core/src/lib/learning/other.ts')
    expect(frozenSimChanges(commit, repo)).toEqual([])
    sh('echo scored-differently >> packages/core/src/lib/learning/learning-sim-analysis.ts && echo x > packages/core/src/lib/learning/learning-sim-new.ts && echo d >> docs/specs/simulated-learner-experiment.md')
    expect(frozenSimChanges(commit, repo).sort()).toEqual(['docs/specs/simulated-learner-experiment.md', 'packages/core/src/lib/learning/learning-sim-analysis.ts', 'packages/core/src/lib/learning/learning-sim-new.ts'])
    sh('git add -A && git commit -qm later')
    expect(frozenSimChanges(commit, repo)).toHaveLength(3) // committed later still differs from the recorded commit
    expect(frozenSimChanges('0'.repeat(40), repo)).toEqual([`commit ${'0'.repeat(40)} not found`])
    // Under a git hook (GIT_DIR and GIT_INDEX_FILE exported, here at a second throwaway repository) the check still
    // reads `repo`, not the hook's repository.
    sh('git init -q --bare hook.git')
    const probe = Bun.spawnSync(['bun', '-e', `const { frozenSimChanges } = await import(${JSON.stringify(fileURLToPath(new URL('../src/sim-learners.ts', import.meta.url)))}); console.log(JSON.stringify(frozenSimChanges(${JSON.stringify(commit)}, ${JSON.stringify(repo)})))`],
      { env: { ...gitFreeEnv(), GIT_DIR: join(repo, 'hook.git'), GIT_INDEX_FILE: join(repo, 'hook.index') } })
    expect(JSON.parse(probe.stdout.toString())).toHaveLength(3) // the same three; the hook's repository says 'not found'
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
