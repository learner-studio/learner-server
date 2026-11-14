import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { DurableCallPlan } from '@learner/llm/lib/cli/durable-cli-call.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { frozenSimChanges, gitFreeEnv, plannedRunCalls, SIM_JUDGE_LEARNER, simJudgeItem, simRunConfigs, simRunRefusal, type SimRunDesign } from './learning-sim-run.js'
import { assertSimCallBudget, callWithRetries, SimCallBudgetExhausted, simCall, simCallsUsed, stubTransport, type SimTransport } from './learning-sim-model.js'
import { judgeAccepts } from './learning-sim-judge.js'
import { memoryLeaseStore } from './testing/memory-lease-store.js'
import { plannedCalls } from './learning-sim-analysis.js'

const design = (o: Partial<SimRunDesign> = {}) => simRunConfigs({ runId: '00000000-0000-4000-8000-000000000001', arms: ['on', 'off'], lanes: ['fast'], perArm: () => 1, sessions: 2, turns: 2,
  models: { learner: 'm:low', agent: 'm:medium' }, transport: 'codex', maxCalls: 6600, gradingReplicates: 1, sequential: false, looks: [10, 20, 30], commit: 'c', ...o })

// Review 10 S5 (X1): both sides of what a database may run. Every route to learner_sim goes through this: a refusal
// of a legitimate real run would stop the experiment, an accepted stub or test wiring would mix stub data into it.
describe('simRunRefusal: learner_sim runs only a capped real run; a test database only stub learners', () => {
  test('a real run on learner_sim is accepted at the pre-registered cap and looks', () => {
    expect(simRunRefusal('learner_sim', design())).toBeNull()
  })
  test('learner_sim refuses no cap, a cap above the pre-registered one, stub learners and test wiring', () => {
    expect(simRunRefusal('learner_sim', design({ maxCalls: null }))).toContain('call cap of at most 6600')
    expect(simRunRefusal('learner_sim', design({ maxCalls: 6601 }))).toContain('call cap of at most 6600')
    expect(simRunRefusal('learner_sim', design({ transport: 'stub' }))).toContain('the run has stub learners')
    expect(simRunRefusal('learner_sim', design(), { looks: [10, 20, 30] })).toBe('test wiring never runs on learner_sim')
    expect(simRunRefusal('learner_sim', design({ looks: [2, 4, 6] }))).toContain('are not 10,20,30')
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
    expect(frozenSimChanges(commit, repo)).toEqual([])
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
    const probe = Bun.spawnSync(['bun', '-e', `const { frozenSimChanges } = await import(${JSON.stringify(join(import.meta.dir, 'learning-sim-run.ts'))}); console.log(JSON.stringify(frozenSimChanges(${JSON.stringify(commit)}, ${JSON.stringify(repo)})))`],
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
