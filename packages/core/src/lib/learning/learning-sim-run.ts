/**
 * The experiment run as one durable parent workflow (learningSimExperimentWorkflow, docs/specs/simulated-learner-experiment.md
 * "Durable workflows"): the configs a start builds, what the first step pins and refuses, the blocks and waves of
 * learners, the efficacy look after each block and the report. Every function here is a step body or pure.
 */
import { join } from 'node:path'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { loadLearningPolicy, saveLearningPolicy } from './learning-policy-settings.js'
import { SimLearnerConfig, SIM_ARMS, SIM_LANES, assertSimDatabase, pinSimLearner, type SimTestWiring } from './learning-sim-experiment.js'
import { SIM_PREREGISTRATION, analyzeSimRun, loadSimRun, renderSimReport, simRecordIntegrity, simRunDifferences, simRunRecord, simTransportRefusal, type SimLearnerData } from './learning-sim-analysis.js'
import { simSlots } from './learning-sim-design.js'
import { seeded } from './learning-sim-memory.js'
import { lookLearners, readLooks, recordLook, sequencePosition } from './learning-sim-looks.js'

type Config = SimLearnerConfig
const PREREGISTERED = SIM_PREREGISTRATION.primary.sequential
/** Learners in flight at once (the waves of a block), and the worker's model-call slots. */
export const SIM_MAX_CONCURRENCY = 9

/** A start's choices; `perArm(arm, lane)` is the learners per arm in a lane. */
export type SimRunDesign = {
  runId: string; arms: Config['arm'][]; lanes: Config['lane'][]; perArm: (arm: string, lane: string) => number; sessions: number; turns: number
  models: { learner: string; agent: string; scorer: string }; transport: Config['transport']; maxCalls: number | null; gradingReplicates: number
  sequential: boolean; looks: readonly number[]; commit: string
}

/** The learners of a run, each carrying the run's record (review 10 B1, S2): learner l<lane 0-3><index in lane>; arm,
 * holdout and task order from the seeded design. Throws on a design the pre-registration does not allow. */
export function simRunConfigs(d: SimRunDesign): Config[] {
  for (const arm of d.arms) if (!SIM_ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`)
  for (const lane of d.lanes) if (!(lane in SIM_LANES)) throw new Error(`Unknown lane ${lane}`)
  const model = (spec: string, timeoutSec: number) => { const [m, effort] = spec.split(':'); return { model: m!, effort: effort ?? 'medium', timeoutSec } }
  const run = { commit: d.commit, maxCalls: d.maxCalls, gradingReplicates: d.gradingReplicates, sequential: d.sequential, arms: d.arms, lanes: d.lanes,
    perArm: Object.fromEntries(d.lanes.map((lane) => [lane, Object.fromEntries(d.arms.map((arm) => [arm, d.perArm(arm, lane)]))])), looks: [...d.looks] }
  const configs = simSlots(d.runId, d.lanes, (arm, lane) => d.perArm(arm, lane), d.arms, d.sessions).map((slot) => SimLearnerConfig.parse({
    runId: d.runId, learnerId: `l${(['none', 'slow', 'medium', 'fast'] as const).indexOf(slot.lane)}${String(slot.index).padStart(3, '0')}`,
    arm: slot.arm, lane: slot.lane, sessions: d.sessions, turns: d.turns, transport: d.transport,
    learnerModel: model(d.models.learner, 300), agentModel: model(d.models.agent, 420), scorerModel: model(d.models.scorer, 420),
    heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap, pair: slot.cellIndex, run }))
  simBlocks(configs)
  return configs
}

const primaryLanes = (cs: Config[]) => new Set(cs.filter((c) => c.arm === 'on' && c.lane !== 'none').map((c) => c.lane))
/** Review 7 S2: whether a primary lane has the first look's pairs (the main batch, which runs only sequentially). */
const reachesFirstLook = (cs: Config[], looks: readonly number[]) => [...primaryLanes(cs)]
  .some((lane) => (['on', 'off'] as const).every((arm) => cs.filter((c) => c.lane === lane && c.arm === arm).length >= looks[0]!))

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
/** The frozen paths that differ in the checkout at `cwd` from `commit` (tracked changes, committed or not, and new
 * untracked files). Empty means the code and spec are those the run recorded; an unknown commit reads as changed. */
export function frozenSimChanges(commit: string, cwd = REPO): string[] {
  const git = (args: string[]) => Bun.spawnSync(['git', '-C', cwd, ...args], { env: gitFreeEnv() })
  const diff = git(['diff', '--name-only', commit, '--', ...SIM_FROZEN_PATHS])
  if (diff.exitCode !== 0) return [`commit ${commit || '(none)'} not found`]
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...SIM_FROZEN_PATHS])
  return [...diff.stdout.toString().split('\n'), ...untracked.stdout.toString().split('\n')].filter(Boolean)
}
export const simCheckoutHead = (cwd = REPO) => Bun.spawnSync(['git', '-C', cwd, 'rev-parse', 'HEAD'], { env: gitFreeEnv() }).stdout.toString().trim()

/** The record's integrity at a look or the report: this worker's code against the record's commit (a test run's
 * code is the working tree, not checked). */
async function integrityOf(data: SimLearnerData[]) {
  const real = (await assertSimDatabase()) === 'learner_sim'
  const commit = simRunRecord(data.map((d) => d.config))?.commit ?? ''
  return simRecordIntegrity(data, { stub: !real, changed: real ? frozenSimChanges(commit) : [], head: simCheckoutHead() })
}

export type SimExperimentInput = { runId: string; concurrency: number; configs: Config[] }
const ENDED = ['completed', 'failed', 'cancelled']

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
  const changed = database === 'learner_sim' ? frozenSimChanges(run.commit) : []
  if (changed.length) throw new Error(`Refusing run ${input.runId}: the sim code or spec differs from commit ${run.commit.slice(0, 8)} (${changed.join(', ')}); the record must name the code that runs`)
  const other = (await q<{ id: string }>(`SELECT workflow_run_id AS id FROM learner_workflow_runs WHERE workflow='learningSimExperimentWorkflow' AND input::jsonb->>'runId'=$1
    AND workflow_run_id<>$2 AND status NOT IN ('failed','cancelled','compensated','compensation_failed') LIMIT 1`, [input.runId, workflowRunId])).rows[0]
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
  while (primary.some((d) => d.config.pair === n) && primary.filter((d) => d.config.pair === n).every((d) => ENDED.includes(status[d.config.learnerId] ?? ''))) n++
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
  const report = analyzeSimRun(data, { integrity, looks, endedPairs: ended, stoppedBy: run?.sequential && position.stopped ? position.by : undefined })
  return { runId, integrityOk: report.checks.integrityOk === true, markdown: renderSimReport(runId, report) }
}
