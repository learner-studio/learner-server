/**
 * The experiment run as one durable parent workflow (learningSimExperimentWorkflow, docs/specs/simulated-learner-experiment.md
 * "Durable workflows"): the configs a start builds, what the first step pins and refuses, the blocks and waves of
 * learners, the efficacy look after each block and the report. Every function here is a step body or pure.
 */
import { join } from 'node:path'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { loadLearningPolicy, saveLearningPolicy } from './learning-policy-settings.js'
import { SimLearnerConfig, SIM_ARMS, SIM_LANES, assertSimDatabase, pinSimLearner, transportFor, type SimServices, type SimTestWiring } from './learning-sim-experiment.js'
import { SIM_PREREGISTRATION, SIM_PREREGISTRATION_HASH, analyzeSimRun, loadSimRun, plannedCalls, renderSimReport, simRecordIntegrity, simRunDifferences, simRunRecord, simTransportRefusal, type SimLearnerData } from './learning-sim-analysis.js'
import { simSlots } from './learning-sim-design.js'
import { seeded } from './learning-sim-memory.js'
import { lookLearners, readLooks, recordLook, sequencePosition } from './learning-sim-looks.js'
import { isTerminalStatus, STOPPED_WORKFLOW_STATUSES } from '../workflow/workflow-runs.js'
import { SimCallFailed, simCall } from './learning-sim-model.js'
import { JUDGE_SCHEMA, SIM_JUDGE_CALLS, blindItem, judgeAccepts, judgePrompt, judgeSample, type JudgeAnswer } from './learning-sim-judge.js'

type Config = SimLearnerConfig
const PREREGISTERED = SIM_PREREGISTRATION.primary.sequential
/** Learners in flight at once (the waves of a block), and the worker's model-call slots. */
export const SIM_MAX_CONCURRENCY = 9

/** A start's choices; `perArm(arm, lane)` is the learners per arm in a lane. */
export type SimRunDesign = {
  runId: string; arms: Config['arm'][]; lanes: Config['lane'][]; perArm: (arm: string, lane: string) => number; sessions: number; turns: number
  models: { learner: string; agent: string }; transport: Config['transport']; maxCalls: number | null; gradingReplicates: number
  sequential: boolean; looks: readonly number[]; commit: string
  /** The revision-10 runs before this one (design C.6, E.3): the record's `after`. */
  after?: readonly string[]
}

/** The learners of a run, each carrying the run's record (review 10 B1, S2): learner l<lane 0-3><index in lane>; arm,
 * holdout and task order from the seeded design. Throws on a design the pre-registration does not allow. */
export function simRunConfigs(d: SimRunDesign): Config[] {
  for (const arm of d.arms) if (!SIM_ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`)
  for (const lane of d.lanes) if (!(lane in SIM_LANES)) throw new Error(`Unknown lane ${lane}`)
  const model = (spec: string, timeoutSec: number) => { const [m, effort] = spec.split(':'); return { model: m!, effort: effort ?? 'medium', timeoutSec } }
  const run = { commit: d.commit, maxCalls: d.maxCalls, gradingReplicates: d.gradingReplicates, sequential: d.sequential, arms: d.arms, lanes: d.lanes,
    perArm: Object.fromEntries(d.lanes.map((lane) => [lane, Object.fromEntries(d.arms.map((arm) => [arm, d.perArm(arm, lane)]))])), looks: [...d.looks],
    ...(d.after ? { after: [...d.after] } : {}), prereg: SIM_PREREGISTRATION_HASH }
  const configs = simSlots(d.runId, d.lanes, (arm, lane) => d.perArm(arm, lane), d.arms, d.sessions).map((slot) => SimLearnerConfig.parse({
    runId: d.runId, learnerId: `l${(['none', 'slow', 'medium', 'fast'] as const).indexOf(slot.lane)}${String(slot.index).padStart(3, '0')}`,
    arm: slot.arm, lane: slot.lane, sessions: d.sessions, turns: d.turns, transport: d.transport,
    learnerModel: model(d.models.learner, 300), agentModel: model(d.models.agent, 420),
    heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap, pair: slot.cellIndex, run }))
  simBlocks(configs)
  return configs
}

const primaryLanes = (cs: Config[]) => new Set(cs.filter((c) => c.arm === 'on' && c.lane !== 'none').map((c) => c.lane))
/** Review 7 S2: whether a primary lane has the first look's pairs (the main batch, which runs only sequentially). */
const reachesFirstLook = (cs: Config[], looks: readonly number[]) => [...primaryLanes(cs)]
  .some((lane) => (['on', 'off'] as const).every((arm) => cs.filter((c) => c.lane === lane && c.arm === arm).length >= looks[0]!))

/** Design D.6: the blind judge runs for a main batch only (a primary lane at the first look, which `simRunRefusal`
 * runs only sequentially), never a pilot. */
export function simJudgeRuns(configs: Config[]) {
  const run = simRunRecord(configs)
  return run ? reachesFirstLook(configs, run.looks) : false
}
/** The run's planned call keys (K, design D.4): every learner's `plannedCalls` by role, plus the judge's 156 for a main
 * batch. `--dry-run` prints it. */
export function plannedRunCalls(configs: Config[]) {
  const byRole: Record<string, number> = {}
  for (const c of configs) for (const [role, n] of Object.entries(plannedCalls(c, c.run?.gradingReplicates))) byRole[role] = (byRole[role] ?? 0) + n
  if (simJudgeRuns(configs)) byRole.judge = SIM_JUDGE_CALLS
  return { total: Object.values(byRole).reduce((x, y) => x + y, 0), byRole }
}

/**
 * Revision 8, the sequential blocks, from the record: arms on and off of a primary lane go by pair (looks[b] pairs
 * by the end of block b); every other learner is in block 1. Within a block the order is a seeded shuffle, so neither
 * arm is systematically started first. A run that is not sequential is one block.
 */
export function simBlocks(configs: Config[]): Config[][] {
  const run = simRunRecord(configs)
  if (!run) throw new Error('the learners carry no common run record')
  const lanes = primaryLanes(configs)
  const blockOf = (c: Config) => run.sequential && lanes.has(c.lane) && (c.arm === 'on' || c.arm === 'off') ? Math.max(0, run.looks.findIndex((n) => (c.pair ?? 0) < n)) : 0
  const blocks = Array.from({ length: run.sequential ? run.looks.length : 1 }, (_, b) => {
    const r = seeded(`${configs[0]!.runId}|block${b}`), xs = configs.filter((c) => blockOf(c) === b)
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!] }
    return xs
  })
  if (run.sequential) {
    const sizes = run.looks.map((n, b) => n - (b ? run.looks[b - 1]! : 0))
    for (const lane of lanes) for (const arm of ['on', 'off'] as const) blocks.forEach((xs, b) => {
      const k = xs.filter((c) => c.lane === lane && c.arm === arm).length
      if (k !== sizes[b]) throw new Error(`a sequential run needs ${run.looks.at(-1)} learners per arm in lane ${lane}: block ${b + 1} has ${k} ${arm} learners, not ${sizes[b]}`)
    })
  }
  return blocks
}

/**
 * Why a run may not run in this database (null: it may), from the learners alone. learner_sim takes only a real run:
 * codex learners, a call cap of at most the pre-registered one, the pre-registered looks, and sequential once a
 * primary lane reaches the first look. A learner_sim_test database takes only stub learners, at the test wiring's
 * looks. Test wiring never runs on learner_sim.
 */
export function simRunRefusal(database: string, configs: Config[], test?: SimTestWiring): string | null {
  const real = database === 'learner_sim'
  if (!real && !/^learner_sim_test(_[a-z0-9]{8})?$/.test(database)) return `${database} is not a sim database`
  if (real && test) return 'test wiring never runs on learner_sim'
  const transport = simTransportRefusal(configs.map((c) => c.transport), !real)
  if (transport) return transport
  const run = simRunRecord(configs)
  if (!configs.length || !run) return 'the learners carry no common run record'
  if (real && (run.maxCalls === null || run.maxCalls > PREREGISTERED.hardCallCap)) return `a real run needs a call cap of at most ${PREREGISTERED.hardCallCap} (the pre-registered cap)`
  // Stats review RC2: the record pins the pre-registration this code holds (its hash is written once, at the start).
  if (real && run.prereg !== SIM_PREREGISTRATION_HASH) return `the record's pre-registration sha256 ${run.prereg ?? '(none)'} is not this code's ${SIM_PREREGISTRATION_HASH}`
  // The cap floor (a lower bound only): a paid run's cap covers its planned call keys plus the 5% margin, ceil(K x 1.05),
  // so a run cannot stop on its cap by design. The ceiling is the hard cap above. Rounded to 1e-6 before the ceiling,
  // so K x 1.05 on an integer is not pushed up by float error.
  if (run.maxCalls !== null && configs.some((c) => c.transport === 'codex')) {
    const K = plannedRunCalls(configs).total, factor = PREREGISTERED.capFloor.factor
    const floor = Math.ceil(Math.round(K * factor * 1e6) / 1e6)
    if (run.maxCalls < floor) return `a call cap of ${run.maxCalls} is below the floor ceil(${K} × ${factor}) = ${floor} (the planned call keys plus the pre-registered margin)`
  }
  const looks = test?.looks ?? PREREGISTERED.looks
  if (JSON.stringify(run.looks) !== JSON.stringify(looks)) return `the record's looks (${run.looks.join(',')}) are not ${looks.join(',')}`
  if (reachesFirstLook(configs, looks) && !run.sequential) return `${looks[0]} or more pairs in a primary lane is the main batch; it runs sequentially`
  return null
}

/** The frozen tree (review 3 B1, review 7 S7): every package, the root manifests and the spec. */
export const SIM_FROZEN_PATHS = ['packages', 'package.json', 'bun.lock', 'docs/specs/simulated-learner-experiment.md']
const REPO = join(import.meta.dirname, '../../../../..')
/** The environment without GIT_* variables: a git hook exports GIT_DIR and GIT_INDEX_FILE, which would point `git -C`
 * at the hook's repository instead of `cwd` (a pre-commit test once committed its fixture to the real branch). */
export const gitFreeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) as Record<string, string>
/** Whether the frozen tree at `cwd` could be compared with a commit: the paths that differ, or why git cannot say. */
export type FrozenState = { ok: true; files: string[] } | { ok: false; error: string }
/** The frozen paths that differ in the checkout at `cwd` from `commit` (tracked changes, committed or not, and new
 * untracked files). `files` empty means the code and spec are those the run recorded. Review RC1: a commit that is
 * empty, not a commit of this checkout (or `cwd` is no checkout), or a tree git cannot read is `ok: false`, and every
 * caller refuses on it: it is never a file name a scope list could allow. */
export function frozenSimState(commit: string, cwd = REPO): FrozenState {
  if (!commit) return { ok: false, error: 'no commit recorded' }
  const git = (args: string[]) => { try { return Bun.spawnSync(['git', '-C', cwd, ...args], { env: gitFreeEnv() }) } catch { return null } }
  const known = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${commit}^{commit}`])
  if (!known || known.exitCode !== 0) return { ok: false, error: `commit ${commit} is not in this checkout` }
  const diff = git(['diff', '--name-only', commit, '--', ...SIM_FROZEN_PATHS])
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...SIM_FROZEN_PATHS])
  if (!diff || diff.exitCode !== 0 || !untracked || untracked.exitCode !== 0)
    return { ok: false, error: `git cannot read the frozen paths against ${commit} (${(diff?.exitCode ? diff : untracked)?.stderr.toString().trim().split('\n')[0] ?? 'git did not run'})` }
  return { ok: true, files: [...diff.stdout.toString().split('\n'), ...untracked.stdout.toString().split('\n')].filter(Boolean) }
}
/** The frozen-path differences as text for a refusal or the integrity line; the state's error when git cannot say. */
const frozenProblem = (x: FrozenState) => (x.ok ? (x.files.length ? x.files.join(', ') : null) : `the frozen tree cannot be checked: ${x.error}`)
export const simCheckoutHead = (cwd = REPO) => Bun.spawnSync(['git', '-C', cwd, 'rev-parse', 'HEAD'], { env: gitFreeEnv() }).stdout.toString().trim()

const LEARNING = 'packages/core/src/lib/learning/'
/** Design C.6 and R4, what pilot iteration 2 may change. Tests (`*.test.ts`, packages/runtime-pikku/tests/) always may. */
export const SIM_ITERATION_SCOPE = {
  /** After a C.2 failure: the anchor directive's presentation (its prompt wording and format) or the pre-declared
   * K6/cap800 rung (the lane's parameters and the design), nothing else. */
  anchorPresentation: ['learning-sim-prompts.ts', 'learning-sim-memory.ts', 'learning-sim-design.ts'].map((f) => LEARNING + f),
  /** After a C.5 failure, out of scope for its code fix: the memory rules, the matcher, the exam, the anchor
   * directive's fact choice, the hook and the prompts, and (stats review RC2) the analysis and the sequential test.
   * A fix that needs one fails iteration 2. */
  outOfScope: [...['learning-sim-memory.ts', 'learning-sim-matcher.ts', 'learning-sim-facts.ts', 'learning-sim-halyard.ts', 'learning-sim-ceiling.ts', 'learning-sim-prompts.ts',
    'learning-sim-analysis.ts', 'learning-sim-sequential.ts', 'learning-teaching-default.ts', 'learning-live-turn.ts', 'learning-live-hook.ts', 'learning-hook-context.ts', 'learning-policy-settings.ts', 'learning-live-feedback.ts'].map((f) => LEARNING + f),
    'packages/contract/src/learning/learning-live-hook.ts'],
}
const isTest = (f: string) => f.endsWith('.test.ts') || f.startsWith('packages/runtime-pikku/tests/')
/** A revision-10 run before this one, from the database: its record's commit and pre-registration hash, whether it was
 * the main batch, and the pilot gates it failed (each with its clause). */
export type SimPriorRun = { runId: string; commit: string; prereg: string; main: boolean; failed: Array<{ gate: string; clause: string }> }
/** The run being started, from its record: the main batch or a pilot, and the pre-registration hash it was pinned with. */
export type SimIterationSelf = { main: boolean; prereg: string }
/**
 * Design C.6, the iteration rule, for a new run after `prior` (in creation order). `changed(commit)`: the frozen paths
 * this tree changes from that commit (frozenSimState; a state git cannot read refuses). Null: the run may start. One main batch; 2 pilot iterations
 * in total; a dose failure (C.4) in either stops claim 1; any gate failure in iteration 2 stops it; iteration 2 runs
 * only after a failed iteration 1, and changes only what its failed gates allow (R4); the main batch runs only after a
 * passing pilot, on a tree with no non-test change to any frozen file since it (review RC5); every run after the first
 * carries the pre-registration hash of the run before it (stats review RC2).
 */
export function simIterationRefusal(prior: readonly SimPriorRun[], self: SimIterationSelf, changed: (commit: string) => FrozenState): string | null {
  const { main } = self
  const done = prior.find((p) => p.main)
  if (done) return `the main batch already ran (run ${done.runId}); revision 10 has one`
  const dose = prior.find((p) => p.failed.some((f) => f.clause === 'C.4'))
  if (dose) return `pilot ${dose.runId} failed the dose gate (C.4): claim 1 stops, no iteration and no main batch may follow`
  const last = prior.at(-1)
  // Review RC1: the scope is read against the last pilot's commit; when git cannot read it, nothing is admitted.
  const state = last ? changed(last.commit) : null
  if (state && !state.ok) return `the frozen tree since run ${last!.runId} cannot be checked (${state.error}): the start is refused until it can`
  // Stats review RC2: SIM_PREREGISTRATION is fixed at the first pilot; a run whose hash differs from the last run's never starts.
  if (last && last.prereg !== self.prereg) return `the pre-registration (sha256 ${self.prereg || '(none)'}) differs from run ${last.runId}'s (${last.prereg || '(none)'}): it is fixed at the first pilot and never changes`
  const outOfScope = (_: string, allowed: (f: string) => boolean) => (state?.ok ? state.files : []).filter((f) => !isTest(f) && !allowed(f))
  if (main) {
    if (!last) return 'the main batch runs only after a pilot that passed every gate'
    if (last.failed.length) return `the last pilot (${last.runId}) failed ${last.failed.map((f) => `${f.gate} (${f.clause})`).join(', ')}: the main batch runs only after a pilot that passed every gate`
    // Review RC5 (lead's decision): zero non-test changes to any frozen file since the passing pilot.
    const moved = outOfScope(last.commit, () => false)
    return moved.length ? `the main batch changes ${moved.join(', ')} since the passing pilot ${last.runId}; it runs that pilot's frozen tree unchanged (design C.6: the estimand, the thresholds and the main design never change)` : null
  }
  if (prior.length >= 2) return `2 pilot iterations in total have run (${prior.map((p) => p.runId).join(', ')}); ${prior[1]!.failed.length ? 'iteration 2 failed a gate: claim 1 stops' : 'the next run is the main batch'}`
  if (!last) return null
  if (!last.failed.length) return `pilot ${last.runId} passed every gate: the next run is the main batch, not a second pilot`
  const c2 = last.failed.some((f) => f.clause === 'C.2'), c5 = last.failed.some((f) => f.clause === 'C.5')
  const allowed = (f: string) => (c2 && SIM_ITERATION_SCOPE.anchorPresentation.includes(f)) || (c5 && !SIM_ITERATION_SCOPE.outOfScope.includes(f))
  const moved = outOfScope(last.commit, allowed)
  return moved.length ? `iteration 2 after ${last.failed.map((f) => `${f.gate} (${f.clause})`).join(', ')} may not change ${moved.join(', ')} (design C.6, R4): iteration 2 fails, claim 1 stops` : null
}

/** The record's integrity at a look or the report: this worker's code against the record's commit (a test run's
 * code is the working tree, not checked). */
async function integrityOf(data: SimLearnerData[]) {
  const real = (await assertSimDatabase()) === 'learner_sim'
  const commit = simRunRecord(data.map((d) => d.config))?.commit ?? ''
  const state = real ? frozenSimState(commit) : { ok: true as const, files: [] }
  return simRecordIntegrity(data, { stub: !real, changed: state.ok ? state.files : [], unreadable: state.ok ? undefined : state.error, head: simCheckoutHead() })
}

/** Design E.3: the runs created after revision 9's first learner with an `anchor` or `on` learner, by the
 * pre-registered query verbatim, oldest first. */
export async function simIterationRuns(query = q) {
  return (await query<{ run_id: string; min: Date; string_agg: string }>(SIM_PREREGISTRATION.iterationLogQuery)).rows
    .map((x) => ({ runId: x.run_id, firstAt: new Date(x.min), arms: x.string_agg })).sort((a, b) => a.firstAt.getTime() - b.firstAt.getTime() || a.runId.localeCompare(b.runId))
}
/** Why a run's declared earlier runs (`run.after`) are not the runs the query finds; null when they are. */
export function simDeclaration(found: readonly string[], after: readonly string[]): string | null {
  const undeclared = found.filter((id) => !after.includes(id)), unknown = after.filter((id) => !found.includes(id))
  return [...(undeclared.length ? [`runs since revision 9 not declared in --after: ${undeclared.join(', ')}`] : []),
    ...(unknown.length ? [`--after names runs the iteration-log query does not find: ${unknown.join(', ')}`] : [])].join('; ') || null
}
/** A run's experiment workflow state (review RC2): `completed` when one of its experiment runs completed (its report
 * step ran), `live` when one has not ended, `stopped` when every one ended without completing, `none` when it has none. */
export type SimRunStatus = 'completed' | 'live' | 'stopped' | 'none'
export async function simRunStatus(runId: string, query = q): Promise<SimRunStatus> {
  const rows = (await query<{ status: string }>(`SELECT status FROM learner_workflow_runs WHERE workflow='learningSimExperimentWorkflow' AND input::jsonb->>'runId'=$1`, [runId])).rows
  if (rows.some((r) => r.status === 'completed')) return 'completed'
  if (rows.some((r) => !STOPPED_WORKFLOW_STATUSES.includes(r.status))) return 'live'
  return rows.length ? 'stopped' : 'none'
}
/** When this run's first learner was pinned (any arm), or null before its first pin. The pin step writes learners only
 * after the iteration decision passed, so a pinned run is one whose decision was taken (review RC3). */
export async function simPinnedAt(runId: string, query = q): Promise<Date | null> {
  const at = (await query<{ at: Date | string | null }>('SELECT min(created_at) AS at FROM learning_sim_learners WHERE run_id=$1', [runId])).rows[0]?.at
  return at ? new Date(at) : null
}
/** Review RC3: the runs created before this run, by the query's first anchor/on learner time against this run's first
 * pinned learner (strictly earlier: this run itself never counts); every run when this run has no learner yet. */
export function simRunsBefore<T extends { runId: string; firstAt: Date }>(runs: readonly T[], pinnedAt: Date | null): T[] {
  return pinnedAt ? runs.filter((x) => x.firstAt.getTime() < pinnedAt.getTime()) : [...runs]
}
export type SimIterationDeps = { query?: typeof q; prior?: (runId: string) => Promise<SimPriorRun>; changed?: (commit: string) => FrozenState; status?: (runId: string) => Promise<SimRunStatus> }
/**
 * The pin step's learner_sim checks (design C.6, E.3; review RC2-RC4), null when the run may start:
 * - the runs before this one (simRunsBefore) are exactly the record's `run.after`;
 * - on a resume (this run already has pinned learners) the iteration decision is the one its first execution took
 *   before it pinned them: it is replayed, not re-read, so a later run, or a prior run's later rows, cannot change it;
 * - otherwise every prior run must have completed (a live or stopped one refuses: its gates are not final, and the
 *   dose gate is never computed on partial deliveries), and the iteration rule reads their gates.
 */
export async function simIterationCheck(input: SimExperimentInput, deps: SimIterationDeps = {}): Promise<string | null> {
  const { query = q, prior = simPriorRun, changed = frozenSimState, status = (id: string) => simRunStatus(id, query) } = deps
  const run = simRunRecord(input.configs)
  if (!run) return 'the learners carry no common run record'
  const pinnedAt = await simPinnedAt(input.runId, query)
  const found = simRunsBefore(await simIterationRuns(query), pinnedAt).map((x) => x.runId)
  const declared = simDeclaration(found, run.after ?? [])
  if (declared) return declared
  if (pinnedAt) return null
  for (const id of found) {
    const s = await status(id)
    if (s !== 'completed') return `run ${id} has ${s === 'live' ? 'not finished (an experiment run of it is live)' : s === 'stopped' ? 'no completed experiment run (it failed or was cancelled; resume it to its report first)' : 'no experiment run'}: its gates are not final, so no later run may start`
  }
  return simIterationRefusal(await Promise.all(found.map((id) => prior(id))), { main: simJudgeRuns(input.configs), prereg: run.prereg ?? '' }, changed)
}
/** A run's iteration summary from its rows: commit, main or pilot, the pilot gates it failed, its anchor and dose gates. */
export async function simPriorRun(runId: string) {
  const data = await loadSimRun(runId)
  const a = analyzeSimRun(data), run = simRunRecord(data.map((d) => d.config))
  return { runId, commit: run?.commit ?? '', prereg: run?.prereg ?? '', main: !a.pilot, failed: a.gateFailures, anchor: a.gates.anchor, dose: a.gates.dose }
}
/** `git diff` of the frozen paths between two recorded commits. */
export function simFrozenDiff(from: string, to: string, cwd = REPO) {
  const r = Bun.spawnSync(['git', '-C', cwd, 'diff', from, to, '--', ...SIM_FROZEN_PATHS], { env: gitFreeEnv() })
  return r.exitCode === 0 ? r.stdout.toString() : null
}
type PriorRun = Awaited<ReturnType<typeof simPriorRun>>
/**
 * The report's iteration log (design E.3, C.6): every run the query finds, oldest first, with its gates, its anchor
 * estimate with interval and its dose, read from its rows; a run this run's record does not declare is flagged. Then the
 * full `git diff` of the frozen paths between each two consecutive runs' commits (R4: a reworded anchor directive or a
 * C.5 fix is printed in full).
 */
export async function simIterationLog(runId: string, after: readonly string[], deps: { query?: typeof q; prior?: (runId: string) => Promise<PriorRun>; diff?: (from: string, to: string) => string | null } = {}) {
  const { query = q, prior = simPriorRun, diff = simFrozenDiff } = deps
  // Review RC3: this run and the runs created before it; a later run never enters this run's report.
  const pinnedAt = await simPinnedAt(runId, query), all = await simIterationRuns(query)
  const runs = all.filter((x) => x.runId === runId || simRunsBefore([x], pinnedAt).length)
  const rows = await Promise.all(runs.map(async (x) => ({ ...x, ...(await prior(x.runId)) })))
  const n = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a')
  const lines = rows.map((x) => {
    const anchor = x.anchor.estimate ? `anchor minus off ${n(x.anchor.estimate.mean)} [95%: ${n(x.anchor.estimate.lo)}, ${n(x.anchor.estimate.hi)}], t ${n(x.anchor.estimate.t)} over ${x.anchor.pairs} pairs` : 'anchor gate not computed (main batch)'
    const flag = x.runId === runId ? ' (this run)' : after.includes(x.runId) ? '' : ' **UNDECLARED: not in this run\'s record (run.after)**'
    return `- ${x.runId}${flag}: first learner ${x.firstAt.toISOString()}, arms ${x.arms}; ${x.main ? 'main batch' : 'pilot'} at commit ${x.commit.slice(0, 12) || '(none)'}, pre-registration sha256 ${x.prereg.slice(0, 12) || '(none)'}; ` +
      `gates failed: ${x.main ? 'n/a' : x.failed.map((f) => `${f.gate} (${f.clause})`).join(', ') || 'none'}; ${anchor}; dose ${n(x.dose.diffPp, 1)} pp (on ${x.dose.on.off}/${x.dose.on.delivered}, off ${x.dose.off.off}/${x.dose.off.delivered})`
  })
  const diffs = rows.slice(1).flatMap((x, i) => {
    const from = rows[i]!
    if (from.commit === x.commit) return [`Frozen tree of ${x.runId}: the same commit as ${from.runId}.`]
    const d = diff(from.commit, x.commit)
    return [`Frozen-tree diff from ${from.runId} (${from.commit.slice(0, 12)}) to ${x.runId} (${x.commit.slice(0, 12)}):`, '', '```diff', d === null ? '(not available: a commit is missing from this checkout)' : d.trimEnd() || '(no change)', '```']
  })
  return [...lines, ...(diffs.length ? ['', ...diffs] : [])]
}

/** The judge's answers by item index from its receipts (`judge:<index>`): the recorded "yes"/"no", or null for a final
 * failure (`failed`) or no row; and its calls in call-key order, for the cost table (a re-render is byte-identical). */
export async function simJudgeReceipts(runId: string, items: number, query = q) {
  const rows = (await query<{ call_key: string; model: string; effort: string; input_tokens: number | null; output_tokens: number | null; duration_ms: number; attempts: number; output: { text?: string; failed?: string; invocations?: number } }>(
    'SELECT call_key,model,effort,input_tokens,output_tokens,duration_ms,attempts,output FROM learning_sim_calls WHERE run_id=$1 AND learner_id=$2 ORDER BY call_key', [runId, SIM_JUDGE_LEARNER])).rows
  const byIndex = new Map(rows.map((x) => [Number(x.call_key.slice('judge:'.length)), x]))
  const answers = Array.from({ length: items }, (_, i) => { const t = byIndex.get(i)?.output.text; return t === undefined ? null : (JSON.parse(t) as { states: string }).states })
  const calls = rows.filter((x) => x.output.text !== undefined || x.output.failed !== undefined).map((x) => ({ role: 'judge', model: x.model, effort: x.effort, inputTokens: x.input_tokens, outputTokens: x.output_tokens,
    durationMs: x.duration_ms, attempts: x.attempts, invocations: Math.max(x.output.invocations ?? x.attempts, 1) }))
  return { answers, calls }
}

export type SimExperimentInput = { runId: string; concurrency: number; configs: Config[] }

/**
 * The run's first step: refuses a run this database or this code may not run, and pins it. Every learner is written
 * with the run's record into learning_sim_learners before any model call (a learner already there must be equal), the
 * policy's k is set, and no other experiment run of the run id may be live. Returns the blocks, each in waves of at
 * most `concurrency` learners.
 */
export async function pinSimRun(input: SimExperimentInput, workflowRunId: string, test?: SimTestWiring) {
  const database = await assertSimDatabase()
  if (input.configs.some((c) => c.runId !== input.runId)) throw new Error(`Refusing run ${input.runId}: a learner of another run is in its input`)
  const refusal = simRunRefusal(database, input.configs, test)
  if (refusal) throw new Error(`Refusing run ${input.runId} in ${database}: ${refusal}`)
  const run = simRunRecord(input.configs)!
  const changed = database === 'learner_sim' ? frozenProblem(frozenSimState(run.commit)) : null
  if (changed) throw new Error(`Refusing run ${input.runId}: the sim code or spec differs from commit ${run.commit.slice(0, 8)} (${changed}); the record must name the code that runs`)
  if (database === 'learner_sim') {
    // Design C.6, E.3: the runs before this one, by the iteration log's own query, are this run's iterations; the
    // record declares them (run.after), and the iteration rule reads their gates (simIterationCheck).
    const iteration = await simIterationCheck(input)
    if (iteration) throw new Error(`Refusing run ${input.runId}: ${iteration}`)
  }
  const other = (await q<{ id: string }>(`SELECT workflow_run_id AS id FROM learner_workflow_runs WHERE workflow='learningSimExperimentWorkflow' AND input::jsonb->>'runId'=$1
    AND workflow_run_id<>$2 AND status <> ALL($3::text[]) LIMIT 1`, [input.runId, workflowRunId, [...STOPPED_WORKFLOW_STATUSES]])).rows[0]
  if (other) throw new Error(`Refusing run ${input.runId}: experiment run ${other.id} of it is live or completed`)
  for (const c of input.configs) await pinSimLearner(c)
  const stored = (await q<{ config: Config }>('SELECT config FROM learning_sim_learners WHERE run_id=$1', [input.runId])).rows.map((r) => r.config)
  const diff = simRunDifferences(stored, input.configs)
  if (diff.length) throw new Error(`Refusing run ${input.runId}: its learners in ${database} differ in ${diff.join(', ')}; the pre-registration is written once`)
  const { updatedAt: _, ...policy } = await loadLearningPolicy()
  if (policy.gradingReplicates !== run.gradingReplicates) await saveLearningPolicy({ ...policy, gradingReplicates: run.gradingReplicates }, 'sim-experiment')
  const blocks = simBlocks(input.configs)
  return { blocks: blocks.map((learners, index) => ({ runId: input.runId, index, blocks: blocks.length,
    waves: Array.from({ length: Math.ceil(learners.length / input.concurrency) }, (_, w) => ({ learners: learners.slice(w * input.concurrency, (w + 1) * input.concurrency) })) })) }
}

/** Whether block `index` runs: every earlier block was looked at with "continue" and nothing stopped the sequence. A
 * block already looked at is never started again (review 7 B2). */
export async function simBlockOpen(runId: string, index: number, blocks: number) {
  const position = sequencePosition(await readLooks(runId), blocks)
  return { open: !position.stopped && position.block === index }
}

/**
 * The efficacy look after block `index`, by code, on the learners of blocks 1..index+1 only; recorded once
 * (learning_sim_looks) and never re-taken: a replay adopts the recorded look. A run that is not sequential takes none.
 */
export async function takeSimLook(runId: string, index: number, test?: SimTestWiring) {
  const all = await loadSimRun(runId)
  const run = simRunRecord(all.map((d) => d.config))
  if (!run?.sequential) return { decision: null }
  const recorded = (await readLooks(runId))[index]
  if (recorded) return { decision: recorded.decision }
  const data = lookLearners(all, simBlocks(all.map((d) => d.config)), index)
  // Under the test wiring's continueLooks the earlier looks were forced, so the sequence would not recompute to here:
  // this look is taken alone at its pair count (only the wiring is under test, not the decision).
  const look = analyzeSimRun(data, { integrity: await integrityOf(data), looks: test?.continueLooks ? [run.looks[index]!] : [...run.looks], endedPairs: run.looks[index] }).sequential
  const decision = look?.decisions.at(-1)
  if (!look || !decision || decision.plannedPairs !== run.looks[index]) throw new Error(`look ${index + 1} could not be taken (${look ? look.scheduledPairs : 0} pairs scheduled); the sequence is stopped`)
  const forced = Boolean(test?.continueLooks) && index < run.looks.length - 1
  const entry = await recordLook(runId, { look: index + 1, plannedPairs: decision.plannedPairs, decision: forced ? 'continue' : decision.decision,
    failedChecks: forced ? [] : look.failedChecks, learners: data.map((d) => d.config.learnerId).sort(), ...(forced ? { forced: true as const } : {}) })
  return { decision: entry.decision }
}

/** Each learner's latest workflow status in this run, by learner id. */
export async function simLearnerStatuses(runId: string, query = q): Promise<Record<string, string>> {
  return Object.fromEntries((await query<{ learner_id: string; status: string }>(`SELECT DISTINCT ON (input::jsonb->>'learnerId') input::jsonb->>'learnerId' AS learner_id, status
    FROM learner_workflow_runs WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1 ORDER BY input::jsonb->>'learnerId', created_at DESC`, [runId])).rows.map((r) => [r.learner_id, r.status]))
}
/** Pairs (by index, from 0) whose primary learners have all ended: the most the report may read. */
function endedPairs(data: SimLearnerData[], status: Record<string, string>) {
  const lanes = primaryLanes(data.map((d) => d.config))
  const primary = data.filter((d) => lanes.has(d.config.lane) && (d.config.arm === 'on' || d.config.arm === 'off'))
  let n = 0
  while (primary.some((d) => d.config.pair === n) && primary.filter((d) => d.config.pair === n).every((d) => isTerminalStatus(status[d.config.learnerId] ?? ''))) n++
  return primary.some((d) => d.config.pair === undefined) ? undefined : n
}

/**
 * The run's last step: the analysis of record, verified against the record (the commit, and the recorded looks must
 * be what the data give now). The report is the experiment run's output; nothing else writes one.
 */
export async function simRunReport(runId: string) {
  const data = await loadSimRun(runId)
  const run = simRunRecord(data.map((d) => d.config))
  const looks = run?.looks ?? [...PREREGISTERED.looks]
  const recorded = run?.sequential ? await readLooks(runId) : []
  const position = sequencePosition(recorded, looks.length)
  const ended = endedPairs(data, await simLearnerStatuses(runId))
  const verified = await integrityOf(data)
  const recomputed = (analyzeSimRun(data, { looks, endedPairs: ended }).sequential?.decisions ?? []).map((l) => l.decision).join(',')
  const asRecorded = recorded.map((l) => l.decision).join(',')
  const integrity = !run?.sequential || recorded.some((l) => l.forced) || recomputed === asRecorded ? verified
    : { ok: false, detail: `${verified.detail}; recorded looks (${asRecorded}) differ from the data (${recomputed})` }
  const judge = simJudgeRuns(data.map((d) => d.config)) ? await simJudgeReceipts(runId, judgeSample(runId, data).items.length) : null
  const report = analyzeSimRun(data, { integrity, looks, endedPairs: ended, stoppedBy: run?.sequential && position.stopped ? position.by : undefined, judge: judge?.answers, judgeCalls: judge?.calls })
  return { runId, integrityOk: report.checks.integrityOk === true, markdown: renderSimReport(runId, report, await simIterationLog(runId, run?.after ?? [])) }
}

/** The judge's receipts (learning_sim_calls): one per item, under this learner id, keyed `judge:<index>`. */
export const SIM_JUDGE_LEARNER = 'judge'
/** The judge step after the stop (design D.6): its items, blind (the sentence window and the fact, by index), with the
 * run's agent model and transport. Empty unless the run is a main batch. Deterministic, so a re-run returns the same. */
export async function simJudgePlan(runId: string) {
  const data = await loadSimRun(runId)
  const configs = data.map((d) => d.config)
  if (!simJudgeRuns(configs)) return { items: [] }
  const { agentModel: model, transport } = configs[0]!
  return { items: judgeSample(runId, data).items.map((x) => ({ runId, ...blindItem(x), model, transport })) }
}
/** One judge call, a receipt keyed (run, item index) through `simCall`: inside the run's cap, never paid twice, and only
 * "yes" or "no" is recorded (review R1). Review R2, re-review B1: only a FINAL failure (SimCallFailed.final: the cap reached,
 * a codex run with no cap, a reply refused after its re-ask, a claim refused) is the item's output, `states: null`
 * (unanswered: "judge incomplete"), so the judge never blocks the report. It is also written into the call's row
 * (re-review C1), so a resumed run raises it again and pays nothing. A dead wrapper (an unknown outcome), a timeout,
 * any other transport error and a capacity error throw, so the step's retries apply and a restart never makes an
 * item final. */
export async function simJudgeItem(s: SimServices, item: { runId: string; index: number; sentence: string; fact: string; model: Config['agentModel']; transport: Config['transport'] }, call = simCall) {
  try {
    const r = await call({ ...item.model, runId: item.runId, learnerId: SIM_JUDGE_LEARNER, callKey: `judge:${item.index}`, role: 'judge', schema: JUDGE_SCHEMA, accept: judgeAccepts, recordFailure: true, prompt: judgePrompt(item) }, transportFor(s, item))
    return { index: item.index, states: (r.json as { states: JudgeAnswer }).states }
  } catch (error) {
    if (error instanceof SimCallFailed && error.final) return { index: item.index, states: null, failed: error.message }
    throw error
  }
}
