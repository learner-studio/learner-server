import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { DurableCallPlan } from '@learner/llm/lib/cli/durable-cli-call.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { frozenSimState, gitFreeEnv, plannedRunCalls, SIM_ITERATION_SCOPE, SIM_JUDGE_LEARNER, simDeclaration, simFrozenDiff, simIterationCheck, simIterationLog, simIterationRefusal, simIterationRuns, type SimRunStatus, simJudgeItem, simJudgeReceipts, simRunConfigs, simRunRefusal, simRunStatus, type SimRunDesign } from './learning-sim-run.js'
import type { SimRung } from './learning-sim-memory.js'
import { assertSimCallBudget, callWithRetries, SimCallBudgetExhausted, simCall, simCallsUsed, stubTransport, type SimTransport } from './learning-sim-model.js'
import { judgeAccepts } from './learning-sim-judge.js'
import { memoryLeaseStore } from './testing/memory-lease-store.js'
import { plannedCalls, SIM_PREREGISTRATION, SIM_PREREGISTRATION_HASH } from './learning-sim-analysis.js'
import { canon, paidTransport } from './learning-sim-experiment.js'

const design = (o: Partial<SimRunDesign> = {}) => simRunConfigs({ runId: '00000000-0000-4000-8000-000000000001', arms: ['on', 'off'], lanes: ['fast'], perArm: () => 1, sessions: 2, turns: 2,
  models: { learner: 'm:low', agent: 'm:medium' }, transport: 'codex', maxCalls: 6600, gradingReplicates: 1, sequential: false, looks: [12, 24, 36], commit: 'c', ...o })

// Rev10 N5: a paid (codex) model call runs only on learner_sim, so the iteration-log query over learner_sim sees every
// paid run. The test databases are admitted by assertSimDatabase; the paid transport refuses them before any call.
describe('paidTransport: the codex transport refuses every database but learner_sim', () => {
  const spec = { role: 'learner', callKey: 'k', prompt: 'p', model: 'm', effort: 'low', timeoutSec: 1 } as never
  test('learner_sim_test and learner_sim_test_<checkout> refuse before the model is called; learner_sim calls it', async () => {
    let calls = 0
    const llm = { callLLM: async () => { calls++; return 'ok' } }
    for (const db of ['learner_sim_test', 'learner_sim_test_ab12cd34']) {
      const t = paidTransport(llm, async () => db)
      expect(t.backend).toBe('codex')
      await expect(t(spec)).rejects.toThrow(`a paid (codex) model call runs only on learner_sim, not ${db}`)
    }
    expect(calls).toBe(0)
    expect((await paidTransport(llm, async () => 'learner_sim')(spec)).text).toBe('ok')
    expect(calls).toBe(1)
  })
})

// Review 10 S5 (X1): both sides of what a database may run. Every route to learner_sim goes through this: a refusal
// of a legitimate real run would stop the experiment, an accepted stub or test wiring would mix stub data into it.
describe('simRunRefusal: learner_sim runs only a capped real run; a test database only stub learners', () => {
  test('a real run on learner_sim is accepted at the pre-registered cap and looks', () => {
    expect(simRunRefusal('learner_sim', design())).toBeNull()
    // Stats review RC2: the record pins this code's pre-registration hash (simRunConfigs writes it).
    expect(design()[0]!.run!.prereg).toBe(SIM_PREREGISTRATION_HASH)
    // Stats review RC3: the rung is a run parameter; it sets the fast lane's budget and is recorded, nothing else moves.
    const rung = design({ rung: 'K6/cap800', lanes: ['fast', 'none'] }), base = design({ lanes: ['fast', 'none'] })
    expect(rung.map((c) => [c.lane, c.factBudget])).toEqual(base.map((c) => [c.lane, c.lane === 'fast' ? 6 : c.factBudget]))
    expect(base.filter((c) => c.lane === 'fast').map((c) => c.factBudget)).toContain(8)
    expect(rung[0]!.run!.rung).toBe('K6/cap800')
    expect(base[0]!.run!.rung).toBeUndefined()
    expect(rung.map((c) => ({ ...c, factBudget: 0, run: { ...c.run, rung: undefined } }))).toEqual(base.map((c) => ({ ...c, factBudget: 0, run: { ...c.run, rung: undefined } })))
    expect(() => design({ rung: 'K7/cap900' as never })).toThrow()
    const repinned = design().map((c) => ({ ...c, run: { ...c.run!, prereg: '0'.repeat(64) } }))
    expect(simRunRefusal('learner_sim', repinned)).toBe(`the record's pre-registration sha256 ${'0'.repeat(64)} is not this code's ${SIM_PREREGISTRATION_HASH}`)
    expect(simRunRefusal('learner_sim_test', repinned.map((c) => ({ ...c, transport: 'stub' as const })))).toBeNull()
  })
  test('learner_sim refuses no cap, a cap above the pre-registered one, stub learners and test wiring', () => {
    expect(simRunRefusal('learner_sim', design({ maxCalls: null }))).toContain('call cap of at most 6600')
    expect(simRunRefusal('learner_sim', design({ maxCalls: 6601 }))).toContain('call cap of at most 6600')
    expect(simRunRefusal('learner_sim', design({ transport: 'stub' }))).toContain('the run has stub learners')
    expect(simRunRefusal('learner_sim', design(), { looks: [12, 24, 36] })).toBe('test wiring never runs on learner_sim')
    expect(simRunRefusal('learner_sim', design({ looks: [2, 4, 6] }))).toContain('are not 12,24,36')
  })
  test('a test database takes stub learners at the wiring\'s looks, never codex; no other database is a sim database', () => {
    const stub = design({ transport: 'stub', maxCalls: null, looks: [2, 4, 6] })
    expect(simRunRefusal('learner_sim_test_ab12cd34', stub, { looks: [2, 4, 6] })).toBeNull()
    expect(simRunRefusal('learner_sim_test', design({ maxCalls: null, looks: [2, 4, 6] }), { looks: [2, 4, 6] })).toContain('the run has codex learners')
    expect(simRunRefusal('learner', stub, { looks: [2, 4, 6] })).toBe('learner is not a sim database')
    // Pairs that reach the first look are the main batch: sequential only.
    expect(simRunRefusal('learner_sim_test', design({ transport: 'stub', maxCalls: null, looks: [1, 2, 3] }), { looks: [1, 2, 3] })).toContain('runs sequentially')
  })
})

// Review 2, N3: the run's code is checked against the commit it recorded; any change to a frozen path (every package,
// the root manifests, the spec) is reported, any other change is not.
test('frozen sim code and spec: changed, new and spec files are reported against the recorded commit; others are not', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'sim-frozen-'))
  try {
    const sh = (cmd: string) => { const r = Bun.spawnSync(['bash', '-c', cmd], { cwd: repo, env: gitFreeEnv() }); if (r.exitCode) throw new Error(r.stderr.toString()) }
    sh(`git init -q && git config user.email t@t && git config user.name t && mkdir -p packages/core/src/lib/learning docs/specs
      echo a > packages/core/src/lib/learning/learning-sim-analysis.ts && echo b > packages/core/src/lib/learning/other.ts && echo c > docs/specs/simulated-learner-experiment.md
      git add -A && git commit -qm base`)
    const commit = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD'], { env: gitFreeEnv() }).stdout.toString().trim()
    const files = (c: string, cwd = repo) => { const r = frozenSimState(c, cwd); if (!r.ok) throw new Error(r.error); return r.files }
    expect(files(commit)).toEqual([])
    sh('echo changed > README.md')
    expect(files(commit)).toEqual([])
    sh('echo changed > packages/core/src/lib/learning/other.ts')
    expect(files(commit)).toEqual(['packages/core/src/lib/learning/other.ts'])
    sh('echo scored-differently >> packages/core/src/lib/learning/learning-sim-analysis.ts && echo x > packages/core/src/lib/learning/learning-sim-new.ts && echo d >> docs/specs/simulated-learner-experiment.md')
    expect(files(commit).sort()).toEqual(['docs/specs/simulated-learner-experiment.md', 'packages/core/src/lib/learning/learning-sim-analysis.ts', 'packages/core/src/lib/learning/learning-sim-new.ts', 'packages/core/src/lib/learning/other.ts'])
    sh('git add -A && git commit -qm later')
    expect(files(commit)).toHaveLength(4) // committed later still differs from the recorded commit
    // Review RC1: every way git cannot answer is an outcome of its own, never a file name in the list.
    const missing = '0'.repeat(40)
    expect(frozenSimState(missing, repo)).toEqual({ ok: false, error: `commit ${missing} is not in this checkout` })
    expect(frozenSimState('', repo)).toEqual({ ok: false, error: 'no commit recorded' })
    expect(frozenSimState('HEAD~0; rm', repo)).toEqual({ ok: false, error: 'commit HEAD~0; rm is not in this checkout' })
    const bare = mkdtempSync(join(tmpdir(), 'sim-nogit-'))
    try { expect(frozenSimState(commit, bare)).toEqual({ ok: false, error: `commit ${commit} is not in this checkout` }) } finally { rmSync(bare, { recursive: true, force: true }) }
    expect(frozenSimState(commit, join(repo, 'no-such-dir'))).toMatchObject({ ok: false })
    // An unreadable index: git cannot list the tree's state, so nothing can be said about it.
    sh('cp .git/index index.bak && printf garbage > .git/index')
    expect(frozenSimState(commit, repo)).toMatchObject({ ok: false, error: expect.stringContaining('cannot read the frozen paths') })
    sh('mv index.bak .git/index')
    expect(files(commit)).toHaveLength(4)
    // Under a git hook (GIT_DIR and GIT_INDEX_FILE exported, here at a second throwaway repository) the check still
    // reads `repo`, not the hook's repository.
    sh('git init -q --bare hook.git')
    const probe = Bun.spawnSync(['bun', '-e', `const { frozenSimState } = await import(${JSON.stringify(join(import.meta.dir, 'learning-sim-run.ts'))}); console.log(JSON.stringify(frozenSimState(${JSON.stringify(commit)}, ${JSON.stringify(repo)}).files))`],
      { env: { ...gitFreeEnv(), GIT_DIR: join(repo, 'hook.git'), GIT_INDEX_FILE: join(repo, 'hook.index') } })
    expect(JSON.parse(probe.stdout.toString())).toHaveLength(4) // the same four; the hook's repository would say 'not found'
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

// Rev10 P6 (design D.4, D.6): the blind judge's 156 calls are planned for a main batch only, beside the learners' keys.
test('plannedRunCalls: the learners\' planned keys by role, plus judge 156 for a main batch only', () => {
  const run = (o: Partial<SimRunDesign>) => design({ lanes: ['fast', 'none'], perArm: (arm, lane) => (lane === 'none' ? (arm === 'on' ? 2 : 0) : 36), sequential: true, looks: [12, 24, 36], ...o })
  const main = run({})
  const learners = main.reduce((n, c) => n + Object.values(plannedCalls(c)).reduce((x, y) => x + y, 0), 0)
  const planned = plannedRunCalls(main)
  expect(planned.byRole.judge).toBe(156)
  expect(planned.total).toBe(learners + 156)
  // A pilot (no primary lane reaches the first look; a main batch is refused unless sequential) plans no judge.
  expect(plannedRunCalls(run({ sequential: false, perArm: (arm, lane) => (lane === 'none' ? (arm === 'on' ? 2 : 0) : arm === 'on' ? 3 : 12) })).byRole.judge).toBeUndefined()
  expect(plannedRunCalls(design()).byRole.judge).toBeUndefined()
})

// Review rev10-p6 R2, re-review B1, C1, C2: only a FINAL failure (the cap reached, a codex run with no cap, a reply
// refused after its one re-ask, a claim refused for its takeover budget) is the item's durable output, unanswered
// (judge incomplete). An unknown outcome (a dead CLI wrapper: durable.lost) and every other transport error (a timeout,
// a reset, a non-zero exit, capacity) throws, so the step's retry runs it again under the lease, as the product
// grader does (restart-recovery.test.ts, the control-group stop; paid-step-retries.test.ts). Every case below goes
// through the real callWithRetries; the durable ones through the real simCall on a fake table and in-memory leases.
const jItem = (index: number) => ({ runId: '00000000-0000-4000-8000-000000000001', index, sentence: 'S.', fact: 'F.', model: { model: 'm', effort: 'low', timeoutSec: 1 }, transport: 'codex' as const })
const codex = (fn: (durable: DurableCallPlan) => Promise<string>) => {
  const t = Object.assign(async (_spec: unknown, durable?: DurableCallPlan) => { t.calls++; return { text: await fn(durable!), model: 'm', inputTokens: null, outputTokens: null } }, { backend: 'codex', calls: 0 })
  return t
}
const says = (...texts: string[]) => { let k = 0; return codex(async () => texts[Math.min(k++, texts.length - 1)]!) }
const s = { simTransport: stubTransport() } as never
type Spec = Parameters<typeof callWithRetries>[0]
/** simJudgeItem's call, as simCall makes it minus the table: the real callWithRetries under one durable plan. */
const chain = (t: SimTransport, plan: DurableCallPlan, invoked: () => Promise<unknown> = async () => {}, specs: Spec[] = []) =>
  (async (spec: Spec) => { specs.push(spec); const { result } = await callWithRetries(spec, t, plan, async () => {}, invoked, async () => {}); return { json: JSON.parse(result.text) } }) as never
const fresh = (): DurableCallPlan => ({ lost: false, next: () => '' })

test('simJudgeItem: an unknown outcome (dead wrapper) or a retryable transport error throws for the step\'s retry; it is never recorded', async () => {
  const plan = fresh()
  const died = codex(async (durable) => { durable.lost = true; throw { type: 'cli_agent.wrapper_died', message: 'durable call wrapper in /x ended without a result', retryable: true } })
  await expect(simJudgeItem(s, jItem(7), chain(died, plan))).rejects.toThrow('ended without a result')
  expect(plan.lost).toBe(true)
  for (const message of ['codex CLI timed out after 180s and did not close after forced kill', 'connection reset', 'codex exited with code 1', 'high demand'])
    await expect(simJudgeItem(s, jItem(7), chain(codex(async () => { throw new Error(message) }), fresh()))).rejects.toThrow(message)
  // A wrapper that died and then met a final failure in the same step (the cap, at its capacity retry) is still unknown.
  const lostThenCap = fresh()
  let n = 0
  const capAfterLoss = async () => { if (n++) throw new SimCallBudgetExhausted(jItem(7).runId, 10, 10) }
  await expect(simJudgeItem(s, jItem(7), chain(codex(async (d) => { d.lost = true; throw new Error('high demand') }), lostThenCap, capAfterLoss))).rejects.toThrow('call cap reached')
})

test('simJudgeItem: a final failure is the item\'s output (states null); the call carries the judge\'s accept check', async () => {
  const specs: Spec[] = []
  expect(await simJudgeItem(s, jItem(4), chain(says('{"states":"maybe"}'), fresh(), undefined, specs))).toMatchObject({ index: 4, states: null, failed: expect.stringContaining('unparseable or refused JSON from judge') })
  expect(specs[0]!.accept).toBe(judgeAccepts)
  // Without the accept check a "Yes" would parse and be returned as the answer (re-review C2).
  expect(await simJudgeItem(s, jItem(4), chain(says('{"states":"Yes"}'), fresh()))).toMatchObject({ index: 4, states: null })
  let k = 0
  const capAtReask = async () => { if (k++) throw new SimCallBudgetExhausted(jItem(4).runId, 10, 10) }
  expect(await simJudgeItem(s, jItem(4), chain(says('{"states":"maybe"}'), fresh(), capAtReask))).toEqual({ index: 4, states: null, failed: `call cap reached for run ${jItem(4).runId}: 10 of 10 calls used` })
  const noCap = (async () => ({ rows: [{ max: null, codex: true }], rowCount: 1 })) as never
  expect(await simJudgeItem(s, jItem(4), chain(says('{"states":"yes"}'), fresh(), () => assertSimCallBudget(jItem(4).runId, 0, noCap)))).toMatchObject({ states: null, failed: expect.stringContaining('never paid uncapped') })
  expect(await simJudgeItem(s, jItem(4), chain(says('{"states":"no"}'), fresh()))).toEqual({ index: 4, states: 'no' })
})

/** learning_sim_calls and learning_sim_learners on PGlite, from the shipped migration, so every statement simCall and the
 * cap check send runs as written (review 3 RC1: a substring fake table could not see the SQL). The run is capped (100). */
async function simCallsTable() {
  // PGlite's wasm start-up sets process.exitCode to 99 (as in learning-telemetry-outbox-integration.test.ts): restore it.
  const pg = new PGlite()
  const exitCode = process.exitCode
  await pg.waitReady
  if (process.exitCode === 99) process.exitCode = exitCode ?? 0
  await pg.exec(await readFile(new URL('../../../../server/src/db/migrations/0027_simulated_learner.sql', import.meta.url), 'utf8'))
  await pg.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config) VALUES($1,'l1','u1','on','fast',$2::jsonb)`, [jItem(0).runId, JSON.stringify({ transport: 'codex', run: { maxCalls: 100 } })])
  const query = (async (sql: string, p?: ReadonlyArray<unknown>) => { const r = await pg.query(sql, p as unknown[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length } }) as MetaPgQueryFn
  const where = `run_id=$1 AND learner_id=$2 AND call_key=$3`
  const key = (index: number) => [jItem(index).runId, SIM_JUDGE_LEARNER, `judge:${index}`]
  return {
    query,
    row: async (index: number) => (await pg.query<{ output: Record<string, unknown> }>(`SELECT output FROM learning_sim_calls WHERE ${where}`, key(index))).rows[0]?.output,
    /** Another owner's write landing on the row mid-call (a race the lease makes rare, never impossible). */
    write: (index: number, output: Record<string, unknown>) => pg.query(`UPDATE learning_sim_calls SET output=$4::jsonb WHERE ${where}`, [...key(index), JSON.stringify(output)]),
    used: () => simCallsUsed(jItem(0).runId, query),
    close: () => pg.close(),
  }
}

test('simJudgeItem through simCall (real SQL): a final failure is durable in its row, so a resume re-asks nothing; a dead wrapper is not, and the retry takes it over', async () => {
  const db = await simCallsTable()
  const leases = memoryLeaseStore()
  const via = (sp: Spec, t: SimTransport) => simCall(sp, t, async () => {}, { query: db.query, leases })
  // Refused twice: two paid invocations, the reason in the row (pending gone, invocations kept), and a resume (a new
  // workflow run) pays nothing more. The cap's count equals the transport calls.
  const refuses = says('{"states":"maybe"}')
  const refused = await simJudgeItem({ simTransport: refuses } as never, jItem(3), ((sp: Spec) => via(sp, refuses)) as never)
  // (bun's toMatchObject writes its asymmetric matchers into the received object, so the reason is read first.)
  const reason3 = String(refused.failed)
  expect(reason3).toStartWith('unparseable or refused JSON from judge')
  expect(refused).toEqual({ index: 3, states: null, failed: reason3 })
  expect(await db.row(3)).toEqual({ invocations: 2, failed: reason3 })
  const resumed = says('{"states":"yes"}')
  expect(await simJudgeItem(s, jItem(3), ((sp: Spec) => via(sp, resumed)) as never)).toEqual(refused)
  expect([refuses.calls, resumed.calls]).toEqual([2, 0])
  expect(await db.row(3)).toEqual({ invocations: 2, failed: reason3 })
  expect(await db.used()).toBe(2)
  // A dead wrapper throws and leaves the row open; the step's retry takes the call over and records the answer.
  const died = codex(async (durable) => { durable.lost = true; throw { type: 'cli_agent.wrapper_died', message: 'durable call wrapper in /x ended without a result', retryable: true } })
  await expect(simJudgeItem(s, jItem(6), ((sp: Spec) => via(sp, died)) as never)).rejects.toThrow()
  expect(await db.row(6)).toEqual({ pending: true, invocations: 1 })
  const retried = says('{"states":"yes"}')
  expect(await simJudgeItem(s, jItem(6), ((sp: Spec) => via(sp, retried)) as never)).toEqual({ index: 6, states: 'yes' })
  expect(await db.used()).toBe(refuses.calls + died.calls + retried.calls)
  // A claim refused for its takeover budget: final, durable, no call (it counts 1 by the floor: over, never under).
  await db.query(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,$2,$3,'judge','m','low',0,0,'{"pending":true}'::jsonb)`, [jItem(5).runId, SIM_JUDGE_LEARNER, 'judge:5'])
  leases.state.leases.set(`sim:${jItem(5).runId}:${SIM_JUDGE_LEARNER}:judge:5`, { owner: 'gone', repeatFree: true, takeovers: 3, stale: true, heartbeatAt: -Infinity })
  const never = says('{"states":"yes"}')
  const out5 = await simJudgeItem(s, jItem(5), ((sp: Spec) => via(sp, never)) as never)
  const reason5 = String(out5.failed)
  expect(reason5).toContain('taken over 3 times')
  expect(out5).toEqual({ index: 5, states: null, failed: reason5 })
  expect(never.calls).toBe(0)
  expect(await db.row(5)).toEqual({ failed: reason5 })
  // Review 3 N1: another owner records while this one is refused twice. The marker never lands on the receipt, and the
  // step's output is that receipt, so the row and the step agree.
  const raced = codex(async () => { await db.write(8, { text: '{"states":"no"}', invocations: 1 }); return '{"states":"maybe"}' })
  expect(await simJudgeItem(s, jItem(8), ((sp: Spec) => via(sp, raced)) as never)).toEqual({ index: 8, states: 'no' })
  expect(await db.row(8)).toEqual({ text: '{"states":"no"}', invocations: 1 })
  // The mirror race (mutant H): another owner's final failure lands mid-call; this owner's answer never overwrites it.
  const other = { invocations: 1, failed: 'another owner: refused' }
  const late = codex(async () => { await db.write(9, other); return '{"states":"yes"}' })
  expect(await simJudgeItem(s, jItem(9), ((sp: Spec) => via(sp, late)) as never)).toEqual({ index: 9, states: null, failed: other.failed })
  expect(await db.row(9)).toEqual(other)
  await db.close()
})

// Design C.6 (B2) and R4: the iteration rule, pure, from the earlier runs' gates and the tree's changes since them.
describe('simIterationRefusal: 2 pilot iterations, a dose failure is terminal, iteration 2 changes only what its failed gate allows', () => {
  const pilot = (runId: string, ...failed: Array<[string, string]>) => ({ runId, commit: `c-${runId}`, prereg: H, rung: null as SimRung | null, main: false, failed: failed.map(([gate, clause]) => ({ gate, clause })) })
  const H = SIM_PREREGISTRATION_HASH, M = { main: true, prereg: H, rung: null }, P = { main: false, prereg: H, rung: null }
  const none = () => ({ ok: true as const, files: [] as string[] })
  const touches = (...files: string[]) => () => ({ ok: true as const, files })
  const L = 'packages/core/src/lib/learning/'
  test('the first pilot may start; the main batch only after a pilot that passed', () => {
    expect(simIterationRefusal([], P, none)).toBeNull()
    expect(simIterationRefusal([], M, none)).toContain('only after a pilot that passed every gate')
    expect(simIterationRefusal([pilot('p1')], M, none)).toBeNull()
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2'])], M, none)).toContain('the last pilot (p1) failed anchor (C.2)')
    // Review RC5 (lead's decision): the main batch runs the passing pilot's frozen tree exactly. No non-test change to
    // any frozen file, the pre-registration (learning-sim-analysis.ts) included; tests may change.
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2']), pilot('p2')], M, touches(`${L}learning-sim-analysis.ts`)))
      .toBe('the main batch changes packages/core/src/lib/learning/learning-sim-analysis.ts since the passing pilot p2; it runs that pilot\'s frozen tree unchanged (design C.6: the estimand, the thresholds and the main design never change)')
    expect(simIterationRefusal([pilot('p1')], M, touches(`${L}learning-sim-matcher.ts`))).toContain('changes packages/core/src/lib/learning/learning-sim-matcher.ts since the passing pilot p1')
    expect(simIterationRefusal([pilot('p1')], M, touches('docs/specs/simulated-learner-experiment.md', 'bun.lock'))).toContain('changes docs/specs/simulated-learner-experiment.md, bun.lock since')
    expect(simIterationRefusal([pilot('p1')], M, touches(`${L}learning-sim-rules.test.ts`, 'packages/runtime-pikku/tests/simulated-learner.test.ts'))).toBeNull()
    expect(simIterationRefusal([pilot('p1'), { ...pilot('m'), main: true }], P, none)).toContain('the main batch already ran (run m)')
    expect(simIterationRefusal([pilot('p1'), { ...pilot('m'), main: true }], M, none)).toContain('the main batch already ran')
  })
  test('a dose failure (C.4) in iteration 1 forbids iteration 2 and the main batch; any failure in iteration 2 stops claim 1', () => {
    const dose = [pilot('p1', ['dose', 'C.4'])]
    expect(simIterationRefusal(dose, P, none)).toBe('pilot p1 failed the dose gate (C.4): claim 1 stops, no iteration and no main batch may follow')
    expect(simIterationRefusal(dose, M, none)).toContain('failed the dose gate (C.4)')
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2']), pilot('p2', ['dose', 'C.4'])], M, none)).toContain('pilot p2 failed the dose gate')
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2']), pilot('p2', ['channel', 'C.5'])], P, none)).toContain('iteration 2 failed a gate: claim 1 stops')
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2']), pilot('p2', ['channel', 'C.5'])], M, none)).toContain('the last pilot (p2) failed channel (C.5)')
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2']), pilot('p2')], P, none)).toContain('2 pilot iterations in total')
    expect(simIterationRefusal([pilot('p1')], P, none)).toContain('pilot p1 passed every gate: the next run is the main batch')
  })
  test('stats review RC3: the K6/cap800 rung only in iteration 2 after C.2, and the main batch runs what passed', () => {
    const K = { rung: 'K6/cap800' as const }
    expect(simIterationRefusal([], { ...P, ...K }, none)).toBe('the first pilot runs the base configuration; the K6/cap800 rung is pilot iteration 2\'s, after an anchor-gate (C.2) failure only')
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2'])], { ...P, ...K }, none)).toBeNull()
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2'], ['channel', 'C.5'])], { ...P, ...K }, none)).toBeNull()
    expect(simIterationRefusal([pilot('p1', ['channel', 'C.5'])], { ...P, ...K }, none)).toBe('the K6/cap800 rung is allowed only after an anchor-gate (C.2) failure; pilot p1 failed channel (C.5)')
    const passedOnRung = [pilot('p1', ['anchor', 'C.2']), { ...pilot('p2'), ...K }]
    expect(simIterationRefusal(passedOnRung, { ...M, ...K }, none)).toBeNull()
    expect(simIterationRefusal(passedOnRung, M, none)).toBe('the main batch selects the base configuration; the passing pilot p2 ran K6/cap800, and the main batch runs that')
    expect(simIterationRefusal([pilot('p1')], { ...M, ...K }, none)).toContain('the main batch selects K6/cap800; the passing pilot p1 ran the base configuration')
  })
  test('stats review RC2: every run after the first carries the pre-registration hash of the run before it', () => {
    const other = { ...pilot('p1'), prereg: 'f'.repeat(64) }
    expect(simIterationRefusal([other], M, none)).toBe(`the pre-registration (sha256 ${H}) differs from run p1's (${'f'.repeat(64)}): it is fixed at the first pilot and never changes`)
    expect(simIterationRefusal([{ ...other, failed: [{ gate: 'anchor', clause: 'C.2' }] }], P, none)).toContain('differs from run p1\'s')
    expect(simIterationRefusal([{ ...pilot('p1'), prereg: '' }], M, none)).toContain('differs from run p1\'s ((none))')
    expect(simIterationRefusal([pilot('p1')], { ...M, prereg: '' }, none)).toContain('the pre-registration (sha256 (none)) differs')
    // Canonical: the same object with its keys in another order has the same hash; any value change gives another.
    const reversed = (x: unknown): unknown => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).reverse().map(([k, v]) => [k, reversed(v)])) : x)
    const sha = (x: unknown) => new Bun.CryptoHasher('sha256').update(canon(x)).digest('hex')
    expect(sha(reversed(SIM_PREREGISTRATION))).toBe(H)
    expect(sha({ ...SIM_PREREGISTRATION, primary: { ...SIM_PREREGISTRATION.primary, smallestEffectOfInterest: 3 } })).not.toBe(H)
    expect(H).toMatch(/^[0-9a-f]{64}$/)
  })
  test('R4: after C.2 only the anchor presentation or the K6/cap800 rung; after C.5 nothing out of scope; tests always', () => {
    const c2 = [pilot('p1', ['anchor', 'C.2'])], c5 = [pilot('p1', ['channel', 'C.5'])], both = [pilot('p1', ['anchor', 'C.2'], ['channel', 'C.5'])]
    for (const f of SIM_ITERATION_SCOPE.anchorPresentation) expect(simIterationRefusal(c2, P, touches(f))).toBeNull()
    expect(simIterationRefusal(c2, P, touches(`${L}learning-sim-analysis.ts`))).toContain('may not change packages/core/src/lib/learning/learning-sim-analysis.ts')
    expect(simIterationRefusal(c2, P, touches(`${L}learning-sim-matcher.ts`))).toContain('iteration 2 fails, claim 1 stops')
    // Stats review RC2: a C.5 fix never touches the analysis or the sequential test (both in the deny list); health may change.
    expect(simIterationRefusal(c5, P, touches(`${L}learning-sim-health.ts`))).toBeNull()
    for (const f of ['analysis', 'sequential']) expect(SIM_ITERATION_SCOPE.outOfScope).toContain(`${L}learning-sim-${f}.ts`)
    for (const f of SIM_ITERATION_SCOPE.outOfScope) expect(simIterationRefusal(c5, P, touches(f))).toContain(`may not change ${f}`)
    // Both failed: the C.2 file is allowed, the rest of the deny list is not. Stats review RC3: the rung is a run
    // parameter, so after C.2 the memory module and the design are out of scope too.
    expect(SIM_ITERATION_SCOPE.anchorPresentation).toEqual([`${L}learning-sim-prompts.ts`])
    expect(simIterationRefusal(both, P, touches(`${L}learning-sim-prompts.ts`))).toBeNull()
    for (const f of ['memory', 'design']) expect(simIterationRefusal(c2, P, touches(`${L}learning-sim-${f}.ts`))).toContain(`may not change ${L}learning-sim-${f}.ts`)
    expect(simIterationRefusal(both, P, touches(`${L}learning-sim-matcher.ts`))).toContain('learning-sim-matcher.ts')
    expect(simIterationRefusal(c2, P, touches(`${L}learning-sim-matcher.test.ts`, 'packages/runtime-pikku/tests/simulated-learner.test.ts'))).toBeNull()
    // A file under packages/runtime-pikku/tests/ that is not a *.test.ts is a test too (review R5).
    expect(simIterationRefusal(c2, P, touches('packages/runtime-pikku/tests/sim-worker.fixture.ts'))).toBeNull()
    expect(simIterationRefusal(c2, P, touches('packages/runtime-pikku/src/sim-worker.fixture.ts'))).toContain('may not change packages/runtime-pikku/src/sim-worker.fixture.ts')
  })
  test('RC1: a prior commit git cannot read refuses, for the main batch and both iteration-2 scopes, never passes the deny list', () => {
    const broken = () => ({ ok: false as const, error: 'commit c-p1 is not in this checkout' })
    const refusal = 'the frozen tree since run p1 cannot be checked (commit c-p1 is not in this checkout): the start is refused until it can'
    expect(simIterationRefusal([pilot('p1')], M, broken)).toBe(refusal)
    expect(simIterationRefusal([pilot('p1', ['channel', 'C.5'])], P, broken)).toBe(refusal)
    expect(simIterationRefusal([pilot('p1', ['anchor', 'C.2'])], P, broken)).toBe(refusal)
    // The first pilot reads no prior commit, so git is not asked.
    expect(simIterationRefusal([], P, broken)).toBeNull()
  })
  test('the record declares the runs the query finds', () => {
    expect(simDeclaration([], [])).toBeNull()
    expect(simDeclaration(['a', 'b'], ['b', 'a'])).toBeNull()
    expect(simDeclaration(['a', 'b'], ['a'])).toBe('runs since revision 9 not declared in --after: b')
    expect(simDeclaration(['a'], ['a', 'z'])).toBe('--after names runs the iteration-log query does not find: z')
  })
})

// Design E.3: the iteration log by its pre-registered query, verbatim, on PGlite with the shipped table; an undeclared
// run is listed and flagged, and R4's diff between the two pilots' frozen trees is printed in full.
test('the iteration log: the query lists every anchor/on run after revision 9 (an undeclared one flagged); the frozen-tree diff is printed', async () => {
  const pg = new PGlite()
  const exitCode = process.exitCode
  await pg.waitReady
  if (process.exitCode === 99) process.exitCode = exitCode ?? 0
  const repo = mkdtempSync(join(tmpdir(), 'sim-iteration-'))
  try {
    await pg.exec(await readFile(new URL('../../../../server/src/db/migrations/0027_simulated_learner.sql', import.meta.url), 'utf8'))
    const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString()
    const add = (runId: string, arm: string, min: number) => pg.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config,created_at) VALUES($1,$2,'u',$3,'fast','{}'::jsonb,$4)`, [runId, `l${arm}${min}`, arm, at(min)])
    const R9 = 'ccec88a3-652a-4d31-b88d-0d70ee4d9f1d', id = (k: number) => `00000000-0000-4000-8000-00000000010${k}`
    await add(id(0), 'on', 0) // before revision 9's first learner: not listed
    await add(R9, 'on', 5); await add(R9, 'off', 6)
    await add(id(1), 'off', 10); await add(id(1), 'on', 11); await add(id(1), 'anchor', 12) // pilot 1, declared; its first anchor/on learner at 11
    await add(id(2), 'off', 20) // off only: not listed
    await add(id(3), 'anchor', 30) // a run nobody declared
    await add(id(4), 'on', 40) // pilot 2, this run
    const query = (async (sql: string, p?: ReadonlyArray<unknown>) => { const r = await pg.query(sql, p as unknown[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length } }) as MetaPgQueryFn
    expect((await simIterationRuns(query)).map((x) => [x.runId, x.arms])).toEqual([[id(1), 'anchor,on'], [id(3), 'anchor'], [id(4), 'on']])
    // Two frozen trees: pilot 2's fix touches the matcher (out of scope after a C.5 failure).
    const sh = (cmd: string) => { const r = Bun.spawnSync(['bash', '-c', cmd], { cwd: repo, env: gitFreeEnv() }); if (r.exitCode) throw new Error(r.stderr.toString()); return r.stdout.toString().trim() }
    sh('git init -q && git config user.email t@t && git config user.name t && mkdir -p packages/core/src/lib/learning && echo "export const BAR = 0.6" > packages/core/src/lib/learning/learning-sim-matcher.ts && git add -A && git commit -qm p1')
    const c1 = sh('git rev-parse HEAD')
    sh('echo "export const BAR = 0.5" > packages/core/src/lib/learning/learning-sim-matcher.ts && git commit -qam p2')
    const c2 = sh('git rev-parse HEAD')
    const gates = (anchorOk: boolean) => ({ pairs: 12, ok: anchorOk, estimate: { pairs: 12, lanes: 1, mean: 2.5, se: 1, df: 11, t: 2.5, p: 0.01, lo: 0.3, hi: 4.7, lo90: 0.7, hi90: 4.3 } })
    const dose = { on: { delivered: 120, off: 30 }, off: { delivered: 118, off: 20 }, onLearners: 3, pairs: 3, diffPp: 8.051, ok: true }
    const prior = async (runId: string) => ({ runId, commit: runId === id(1) ? c1 : c2, prereg: runId === id(1) ? 'a1b2c3d4e5f6a7b8' : '', main: false, failed: runId === id(1) ? [{ gate: 'channel', clause: 'C.5' }] : [], anchor: gates(true), dose })
    const log = await simIterationLog(id(4), [id(1)], { query, prior: prior as never, diff: (a, b) => simFrozenDiff(a, b, repo) })
    const text = log.join('\n')
    expect(log[0]).toBe(`- ${id(1)}: first learner ${at(11)}, arms anchor,on; pilot at commit ${c1.slice(0, 12)}, pre-registration sha256 a1b2c3d4e5f6; gates failed: channel (C.5); anchor minus off 2.50 [95%: 0.30, 4.70], t 2.50 over 12 pairs; dose 8.1 pp (on 30/120, off 20/118)`)
    expect(log[1]).toContain(`${id(3)} **UNDECLARED: not in this run's record (run.after)**`)
    expect(log[2]).toContain(`${id(4)} (this run)`)
    expect(text).toContain(`Frozen-tree diff from ${id(1)} (${c1.slice(0, 12)}) to ${id(3)} (${c2.slice(0, 12)}):`)
    expect(text).toContain(`Frozen tree of ${id(4)}: the same commit as ${id(3)}.`)
    expect(text).toContain('-export const BAR = 0.6')
    expect(text).toContain('+export const BAR = 0.5')
    // The judge's receipts: a recorded answer, a final failure (unanswered) and an item with no row. Stored out of order:
    // the calls come back in call-key order (review: ORDER BY call_key).
    const judgeRow = (index: number, output: Record<string, unknown>) => pg.query(`INSERT INTO learning_sim_calls(run_id,learner_id,call_key,role,model,effort,duration_ms,attempts,output) VALUES($1,'judge',$2,'judge','m','low',1000,1,$3::jsonb)`, [id(4), `judge:${index}`, JSON.stringify(output)])
    await judgeRow(1, { failed: 'the cap is reached', invocations: 2 }); await judgeRow(3, { pending: true }); await judgeRow(0, { text: '{"states":"yes"}' })
    await pg.exec('SET enable_indexscan = off; SET enable_bitmapscan = off; SET enable_indexonlyscan = off') // read in stored order unless the query orders
    const receipts = await simJudgeReceipts(id(4), 4, query)
    expect(receipts.answers).toEqual(['yes', null, null, null])
    expect(receipts.calls.map((c) => [c.role, c.invocations])).toEqual([['judge', 1], ['judge', 2]])
    // The iteration rule reads the same: the fix touched the matcher, so iteration 2 is refused.
    expect(simIterationRefusal([{ runId: id(1), commit: c1, prereg: 'h', rung: null, main: false, failed: [{ gate: 'channel', clause: 'C.5' }] }], { main: false, prereg: 'h', rung: null }, (c) => frozenSimState(c, repo)))
      .toContain('may not change packages/core/src/lib/learning/learning-sim-matcher.ts')
  } finally { await pg.close(); rmSync(repo, { recursive: true, force: true }) }
})

// Review RC2-RC4: the pin step's learner_sim block, with its database read from PGlite and its other inputs injected.
test('simIterationCheck: declared runs, a resume replays its decision, prior runs must have completed, main from the record', async () => {
  const pg = new PGlite()
  const exitCode = process.exitCode
  await pg.waitReady
  if (process.exitCode === 99) process.exitCode = exitCode ?? 0
  try {
    await pg.exec(await readFile(new URL('../../../../server/src/db/migrations/0027_simulated_learner.sql', import.meta.url), 'utf8'))
    const at = (min: number) => new Date(Date.UTC(2026, 10, 1, 0, min)).toISOString()
    const add = (runId: string, arm: string, min: number) => pg.query(`INSERT INTO learning_sim_learners(run_id,learner_id,user_id,arm,lane,config,created_at) VALUES($1,$2,'u',$3,'fast','{}'::jsonb,$4)`, [runId, `l${arm}${min}`, arm, at(min)])
    const query = (async (sql: string, p?: ReadonlyArray<unknown>) => { const r = await pg.query(sql, p as unknown[]); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length } }) as MetaPgQueryFn
    const R9 = 'ccec88a3-652a-4d31-b88d-0d70ee4d9f1d', id = (k: number) => `00000000-0000-4000-8000-00000000020${k}`
    await add(R9, 'on', 5)
    await add(id(1), 'off', 10); await add(id(1), 'anchor', 11) // pilot 1
    const sized = (fast: Record<string, number>, sequential: boolean) => (after: string[]) => ({ runId: id(4), concurrency: 6, configs: design({ runId: id(4), arms: ['off', 'on', 'anchor'], lanes: ['fast', 'none'], sessions: 5, turns: 3, sequential, maxCalls: 6600, after,
      perArm: (arm, lane) => (lane === 'none' ? (arm === 'on' ? 2 : 0) : fast[arm]!) }) })
    const main = sized({ off: 36, on: 36, anchor: 10 }, true), pilot2 = sized({ off: 12, on: 3, anchor: 12 }, false)
    let reads = 0, asked = 0
    const passed = async (runId: string) => { reads++; return { runId, commit: 'c1', prereg: SIM_PREREGISTRATION_HASH, rung: null, main: false, failed: [] } }
    const statuses: Record<string, SimRunStatus> = { [id(1)]: 'completed' }
    const deps = { query, prior: passed, changed: () => ({ ok: true as const, files: [] }), status: async (runId: string) => { asked++; return statuses[runId] ?? 'none' } }
    // First execution of the main batch after a completed, passing pilot: admitted. `main` is the record's (judge runs).
    expect(await simIterationCheck(main([id(1)]), deps)).toBeNull()
    expect(reads).toBe(1)
    // The same prior as a second pilot is refused: the record says which batch this is (R7).
    expect(await simIterationCheck(pilot2([id(1)]), deps)).toContain(`pilot ${id(1)} passed every gate: the next run is the main batch`)
    // The record must declare the run before it (R8), and only runs the query finds.
    expect(await simIterationCheck(main([]), deps)).toBe(`runs since revision 9 not declared in --after: ${id(1)}`)
    expect(await simIterationCheck(main([id(1), id(9)]), deps)).toContain(`--after names runs the iteration-log query does not find: ${id(9)}`)
    // RC2: a prior run still live, or ended without completing, refuses before any gate is read.
    reads = 0
    statuses[id(1)] = 'live'
    expect(await simIterationCheck(main([id(1)]), deps)).toBe(`run ${id(1)} has not finished (an experiment run of it is live): its gates are not final, so no later run may start`)
    statuses[id(1)] = 'stopped'
    expect(await simIterationCheck(main([id(1)]), deps)).toContain(`run ${id(1)} has no completed experiment run (it failed or was cancelled; resume it to its report first)`)
    delete statuses[id(1)]
    expect(await simIterationCheck(main([id(1)]), deps)).toContain('has no experiment run')
    expect(reads).toBe(0)
    statuses[id(1)] = 'completed'
    // RC1 through the check: an unreadable prior commit refuses.
    expect(await simIterationCheck(main([id(1)]), { ...deps, changed: () => ({ ok: false as const, error: 'commit c1 is not in this checkout' }) })).toContain('cannot be checked (commit c1 is not in this checkout)')
    // RC3, a resume: this run's learners are pinned (the decision passed), and later runs exist, one a smoke run.
    // Its first learner is an `on` one, so the query's first time for it equals its pin time: strictly before excludes it.
    await add(id(4), 'on', 40); await add(id(4), 'off', 41)
    await add(id(5), 'anchor', 50); await add(id(6), 'on', 60)
    reads = 0; asked = 0
    expect(await simIterationCheck(main([id(1)]), deps)).toBeNull() // neither itself nor a later run counts (R6)
    expect([reads, asked]).toEqual([0, 0]) // replayed: no prior gate and no status re-read
    statuses[id(1)] = 'stopped' // even a prior that changed since cannot change a taken decision
    expect(await simIterationCheck(main([id(1)]), deps)).toBeNull()
    expect(await simIterationCheck(main([]), deps)).toBe(`runs since revision 9 not declared in --after: ${id(1)}`) // the record still must match
    // RC3, the report: pilot 1's log lists pilot 1 alone; this run's lists pilot 1 and itself, never the later runs.
    const gates = { pairs: 12, ok: true, estimate: null }, dose = { on: { delivered: 1, off: 0 }, off: { delivered: 1, off: 0 }, onLearners: 1, pairs: 1, diffPp: 0, ok: true }
    const row = async (runId: string) => ({ runId, commit: 'c1', prereg: SIM_PREREGISTRATION_HASH, rung: null, main: false, failed: [], anchor: gates, dose })
    const listed = async (runId: string, after: string[]) => (await simIterationLog(runId, after, { query, prior: row as never, diff: () => '' })).filter((l) => l.startsWith('- ')).map((l) => l.slice(2, 38))
    expect(await listed(id(1), [])).toEqual([id(1)])
    expect(await listed(id(4), [id(1)])).toEqual([id(1), id(4)])
    // RC2, the status read itself: a completed experiment run wins; any run not ended is live; only ended ones is stopped.
    await pg.exec(`CREATE TABLE learner_workflow_runs (workflow_run_id text PRIMARY KEY, workflow text NOT NULL, status text NOT NULL, input text NOT NULL)`)
    const wf = (w: string, runId: string, status: string, workflow = 'learningSimExperimentWorkflow') => pg.query('INSERT INTO learner_workflow_runs VALUES($1,$2,$3,$4)', [w, workflow, status, JSON.stringify({ runId })])
    await wf('w1', id(1), 'failed'); await wf('w2', id(1), 'completed'); await wf('w3', id(5), 'failed'); await wf('w4', id(5), 'running'); await wf('w5', id(6), 'cancelled'); await wf('w6', id(6), 'failed')
    await wf('w7', id(7), 'completed', 'learningSimBlockWorkflow')
    expect(await Promise.all([1, 5, 6, 7].map((k) => simRunStatus(id(k), query)))).toEqual(['completed', 'live', 'stopped', 'none'])
  } finally { await pg.close() }
})

// Design D.4: K, the planned call keys of the two revision-10 designs (scripts/sim-experiment.ts header), as the
// pre-registration prints them.
test('K: the main batch plans 6,062 call keys (judge 156) and the pilot 1,495, as pre-registered', () => {
  const k = (fast: Record<string, number>, sequential: boolean) => plannedRunCalls(design({ arms: ['off', 'on', 'anchor'], lanes: ['fast', 'none'], sessions: 5, turns: 3, sequential,
    perArm: (arm, lane) => (lane === 'none' ? (arm === 'on' ? 2 : 0) : fast[arm]!) }))
  const main = k({ off: 36, on: 36, anchor: 10 }, true), pilot = k({ off: 12, on: 3, anchor: 12 }, false)
  expect(main).toEqual({ total: 6062, byRole: { learner: 1680, 'agent-reply': 1260, 'agent-match': 570, grader: 2396, judge: 156 } })
  expect(pilot).toEqual({ total: 1495, byRole: { learner: 580, 'agent-reply': 435, 'agent-match': 75, grader: 405 } })
  expect(SIM_PREREGISTRATION.primary.sequential.expectedCalls).toContain('6,062')
  expect(SIM_PREREGISTRATION.primary.sequential.expectedCalls).toContain('1,495')
  // The cap floor (lead's decision, option (a)), in the pin step's refusal: a paid run's --max-calls may not be below
  // ceil(K x 1.05), pilot or main; the hard cap 6,600 above is the ceiling (tested in simRunRefusal's tests).
  const at = (fast: Record<string, number>, sequential: boolean, maxCalls: number) => simRunRefusal('learner_sim', design({ arms: ['off', 'on', 'anchor'], lanes: ['fast', 'none'], sessions: 5, turns: 3, sequential, maxCalls,
    perArm: (arm, lane) => (lane === 'none' ? (arm === 'on' ? 2 : 0) : fast[arm]!) }))
  const mainAt = (cap: number) => at({ off: 36, on: 36, anchor: 10 }, true, cap), pilotAt = (cap: number) => at({ off: 12, on: 3, anchor: 12 }, false, cap)
  expect(mainAt(6365)).toBe('a call cap of 6365 is below the floor ceil(6062 × 1.05) = 6366 (the planned call keys plus the pre-registered margin)')
  expect(mainAt(6366)).toBeNull()
  // The pre-registered main cap at revision 9's r = 0.003 is accepted; above the hard cap is refused.
  expect(mainAt(6384)).toBeNull()
  expect(mainAt(6601)).toContain('call cap of at most 6600')
  expect(pilotAt(1569)).toContain('below the floor ceil(1495 × 1.05) = 1570')
  expect(pilotAt(1570)).toBeNull()
  // A stub run on a test database has no floor (no paid call).
  expect(simRunRefusal('learner_sim_test', design({ transport: 'stub', maxCalls: 1, looks: [2, 4, 6] }), { looks: [2, 4, 6] })).toBeNull()
})
