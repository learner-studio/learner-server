/**
 * Simulated-learner experiment runner (docs/specs/simulated-learner-experiment.md).
 *
 *   bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts \
 *     [--run-id UUID] [--per-arm 1] [--arms on,off,oracle,blind] [--lanes medium] [--sessions 5] [--turns 3]
 *     [--max-calls N] [--grading-replicates 1] [--concurrency 8] [--stall-minutes 45] [--stub] [--dry-run] [--analyze-only]
 *
 * --per-arm is a count for every arm, or per arm: `on=6,off=6` (learners per arm PER LANE); --per-arm-fast overrides
 * it for the fast lane. Arms are randomized within lane, each learner gets its own stratified holdout and
 * Williams-design task order, and the pre-registration is written once into config.json before the first model call
 * (a resume that differs is refused; --analyze-only verifies it and alone gives the verdict). --max-calls is the run's
 * hard cap on model calls (every role, the grader included).
 *
 * Runs ONLY on the learner_sim database (derived from DATABASE_URL; the live `learner` DB and :3010 are never
 * touched). The run is one learningSimLearnerWorkflow per learner, keyed by run id and learner id; this process is
 * THE worker for them (it holds the worker fence on learner_sim; a second runner exits 2) and holds no state of its
 * own. Kill it at any instant and start it again with the same --run-id: it recovers the interrupted steps and adopts
 * every learner's run, and every model call that already has a receipt is free. No progress for --stall-minutes
 * (default 45: twice the longest healthy model step with nothing else moving, 3 invocations x 420 s + 90 s of
 * backoff, about 22.5 min) exits 3 with an ALARM line. Results go to
 * /var/lib/learner/sim/<runId>/.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({ options: {
  'run-id': { type: 'string' }, 'per-arm': { type: 'string', default: '1' }, 'per-arm-fast': { type: 'string' }, arms: { type: 'string', default: 'on,off,oracle,blind' }, lanes: { type: 'string', default: 'medium' },
  sessions: { type: 'string', default: '5' }, turns: { type: 'string', default: '3' }, 'max-calls': { type: 'string' }, concurrency: { type: 'string', default: '8' }, 'grading-replicates': { type: 'string', default: '1' }, 'stall-minutes': { type: 'string', default: '45' },
  'learner-model': { type: 'string', default: 'gpt-5.6-luna:low' }, 'agent-model': { type: 'string', default: 'gpt-5.6-luna:medium' }, 'scorer-model': { type: 'string', default: 'gpt-5.6-luna:medium' },
  stub: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, 'analyze-only': { type: 'boolean', default: false }, out: { type: 'string', default: '/var/lib/learner/sim' },
} })

// The sim database, before anything opens a pool: every service of this process reads LEARNER_DATABASE_URL.
const base = process.env.DATABASE_URL
if (!base) throw new Error('DATABASE_URL is required: run with --env-file=/etc/learner/db.env')
const url = new URL(base); url.pathname = '/learner_sim'
process.env.LEARNER_DATABASE_URL = url.toString()
process.env.DATABASE_URL = url.toString()
// No product feature flag, schedule or other database reaches this process: automatic assessment, exposure
// drains or vector turns would add model calls and readings the experiment does not control.
for (const key of Object.keys(process.env)) if (/^LEARNING_|^LEARNER_SCHEDULES|^LEARNER_HINDSIGHT|^LEARNER_HABITS|^PG_BOSS_|^TEST_DATABASE/.test(key)) delete process.env[key]
process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_pikku_boss_sim'

const { SimLearnerConfig, SIM_ARMS, SIM_LANES } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
const { plannedCalls, loadSimRun, analyzeSimRun, renderSimReport, SIM_PREREGISTRATION } = await import('@learner/core/lib/learning/learning-sim-analysis.js')
const { simSlots } = await import('@learner/core/lib/learning/learning-sim-design.js')
type Config = import('@learner/core/lib/learning/learning-sim-experiment.js').SimLearnerConfig

const model = (spec: string, timeoutSec: number) => { const [m, effort] = spec.split(':'); return { model: m!, effort: effort ?? 'medium', timeoutSec } }
const runId = a['run-id'] ?? randomUUID()
const arms = a.arms!.split(',') as Config['arm'][]
const lanes = a.lanes!.split(',') as Config['lane'][]
for (const arm of arms) if (!SIM_ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`)
for (const lane of lanes) if (!(lane in SIM_LANES)) throw new Error(`Unknown lane ${lane}`)
const perArm = (arm: string, lane?: string): number => {
  const perArmSpec = lane === 'fast' && a['per-arm-fast'] ? a['per-arm-fast'] : a['per-arm']!
  if (/^\d+$/.test(perArmSpec)) return Number(perArmSpec)
  const entry = perArmSpec.split(',').map((x) => x.split('=')).find(([k]) => k === arm)
  if (!entry || !/^\d+$/.test(entry[1] ?? '')) throw new Error(`--per-arm has no count for arm ${arm}`)
  return Number(entry[1])
}
const maxCalls = a['max-calls'] ? Number(a['max-calls']) : null
if (maxCalls !== null && !(Number.isInteger(maxCalls) && maxCalls > 0)) throw new Error('--max-calls must be a positive integer')
const common = { runId, sessions: Number(a.sessions), turns: Number(a.turns), transport: a.stub ? 'stub' : 'codex',
  learnerModel: model(a['learner-model']!, 300), agentModel: model(a['agent-model']!, 420), scorerModel: model(a['scorer-model']!, 420) } as const
// Learner l<lane 1-3><index in lane>; arm, holdout and task order from the seeded design.
const configs: Config[] = simSlots(runId, lanes, (arm, lane) => perArm(arm, lane), arms, Number(a.sessions))
  .map((slot) => SimLearnerConfig.parse({ ...common, learnerId: `l${(['slow', 'medium', 'fast'] as const).indexOf(slot.lane) + 1}${String(slot.index).padStart(3, '0')}`,
    arm: slot.arm, lane: slot.lane, heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap }))

// The policy's gradingReplicates (k), set in learner_sim before the run: arm on's grading runs the product assessment
// workflow, which grades each reading k times (k - 1 prior-blind replicates).
const gradingReplicates = Number(a['grading-replicates'])
if (!(Number.isInteger(gradingReplicates) && gradingReplicates >= 1)) throw new Error('--grading-replicates must be a positive integer')
const totals: Record<string, number> = {}
for (const c of configs) for (const [role, n] of Object.entries(plannedCalls(c, gradingReplicates))) totals[role] = (totals[role] ?? 0) + n
const planned = Object.values(totals).reduce((x, y) => x + y, 0)
console.log(JSON.stringify({ runId, database: 'learner_sim', learners: configs.length, arms, lanes, sessions: Number(a.sessions), turns: Number(a.turns), gradingReplicates, plannedCalls: planned, maxCalls, byRole: totals,
  callsPerLearnerSession: +(planned / configs.reduce((n, c) => n + c.sessions, 0)).toFixed(1), note: 'grader calls are an upper bound: a concept with no new evidence is not regraded' }, null, 2))
if (a['dry-run']) process.exit(0)

// The tamper-evident record: written once before the first model call, refused if a later invocation differs.
// It pins the design (arms, lanes, per-arm counts, sessions, turns, models, k, the learners' configs) and the commit
// whose sim code and spec define the estimands (SIM_FROZEN_PATHS): a start, a resume and an analysis each refuse a
// checkout whose frozen paths differ from that commit, so no scoring or analysis choice moves after data exist.
const { readFile } = await import('node:fs/promises')
const { frozenSimChanges, gitFreeEnv } = await import('../src/sim-learners.js')
const repo = `${import.meta.dir}/../../..`
const head = Bun.spawnSync(['git', '-C', repo, 'rev-parse', 'HEAD'], { env: gitFreeEnv() }).stdout.toString().trim()
const record = () => ({ runId, arms, lanes, perArm: Object.fromEntries(lanes.map((lane) => [lane, Object.fromEntries(arms.map((arm) => [arm, perArm(arm, lane)]))])),
  sessions: Number(a.sessions), turns: Number(a.turns), gradingReplicates, maxCalls, models: { learner: a['learner-model'], agent: a['agent-model'], scorer: a['scorer-model'] },
  commit: head, preregistration: SIM_PREREGISTRATION, configs })
const pinnedKeys = ['runId', 'arms', 'lanes', 'perArm', 'sessions', 'turns', 'gradingReplicates', 'models', 'preregistration', 'configs'] as const
const differences = (x: Record<string, unknown>, y: Record<string, unknown>) => pinnedKeys.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))

// Stale codegen fails every session at runtime (a step kind the generated schemas do not know): refuse to start.
const { codegenFresh } = await import('./codegen-fresh.js')
if (!codegenFresh()) { console.error('Refusing: the framework codegen is older than the sources; run `bun run generate` in packages/runtime-pikku first'); process.exit(4) }
const { setRuntimeRole } = await import('@learner/core/lib/learning/learning-worker-runtime.js')
setRuntimeRole('learning-worker')
await import('../.pikku/pikku-bootstrap.gen.js')
// --analyze-only reads the database and nothing else: no runtime is booted, so no queue, recovery pass or policy
// write can touch a batch that is running meanwhile.
if (a['analyze-only']) {
  const { bindDatabase, createDatabase } = await import('@learner/core/db/handle.js')
  const handle = bindDatabase(createDatabase(url.toString(), { max: 4, applicationName: 'learner-sim-analysis' }))
  const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
  if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: the runner reads only learner_sim')
  const data = await loadSimRun(runId)
  // Verify the record of the run against the code and the learners stored in the database.
  let integrity: { ok: boolean; detail: string }
  {
    const stored = await readFile(`${a.out}/${runId}/config.json`, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null)
    if (!stored) integrity = { ok: false, detail: 'no config.json for this run' }
    else {
      const changed = frozenSimChanges(String(stored.commit ?? ''), repo)
      const storedLearners = new Map((stored.configs as Config[]).map((c) => [c.learnerId, JSON.stringify(c)]))
      const mismatched = data.filter((d) => storedLearners.get(d.config.learnerId) !== JSON.stringify(SimLearnerConfig.parse(d.config))).map((d) => d.config.learnerId)
      integrity = { ok: !changed.length && !mismatched.length,
        detail: `recorded at ${String(stored.commit).slice(0, 8)}; analysed at ${head.slice(0, 8)}; frozen paths changed since: ${changed.join(', ') || 'none'}; learners differing from the record: ${mismatched.join(', ') || 'none'}` }
    }
  }
  const r = analyzeSimRun(data, { integrity })
  const out = `${a.out}/${runId}`
  await mkdir(out, { recursive: true })
  await writeFile(`${out}/results.json`, JSON.stringify({ runId, report: r, ...(r.outcome ? { data } : {}) }, null, 2)) // a pilot's file carries no raw per-learner data to compute the withheld outcome from
  await writeFile(`${out}/results.md`, renderSimReport(runId, r))
  console.log(renderSimReport(runId, r))
  await handle.close()
  process.exit(0)
}
process.env.LEARNER_WORKFLOW_CONCURRENCY ??= a.concurrency!
const { createConfig } = await import('../src/config.js')
const { createSingletonServices } = await import('../src/services.js')
const services = await createSingletonServices(await createConfig())
const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: the runner writes only to learner_sim')
// Simulated calls are recorded in learning_sim_calls; they never reach the owner's Langfuse traces.
const { registerTelemetryOutbox } = await import('@learner/llm/lib/llm/learning-experiment-langfuse-transport.js')
registerTelemetryOutbox(undefined)
const { loadLearningPolicy, saveLearningPolicy } = await import('@learner/core/lib/learning/learning-policy-settings.js')
const { updatedAt: _, ...policy } = await loadLearningPolicy()
if (policy.gradingReplicates !== gradingReplicates) await saveLearningPolicy({ ...policy, gradingReplicates }, 'sim-experiment')
// A stub run grades on the stub model, through the product workflow too: the runtime's grader becomes the stub one.
if (a.stub) {
  const { simStubGrader } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
  ;(services as { learningConceptAssessment: unknown }).learningConceptAssessment = simStubGrader(services.learningCurriculumStore!)
}
const { setSimCallCap } = await import('@learner/core/lib/learning/learning-sim-model.js')
if (maxCalls !== null) setSimCallCap({ runId, max: maxCalls })
const dir = `${a.out}/${runId}`
await mkdir(dir, { recursive: true })

// Written before the first model call: the pre-registration of record, written once; a resume must match it.
const now = record()
const stored = await readFile(`${dir}/config.json`, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null)
const frozen = frozenSimChanges(String(stored?.commit ?? head), repo)
if (frozen.length && !a.stub) throw new Error(`Refusing: the sim code or spec differs from commit ${String(stored?.commit ?? head).slice(0, 8)} (${frozen.join(', ')}); the record must name the code that runs`)
if (stored) {
  const diff = differences(stored, now)
  if (diff.length) throw new Error(`Refusing: config.json of run ${runId} differs from this invocation in ${diff.join(', ')}; the pre-registration is written once`)
} else {
  await writeFile(`${dir}/config.json`, JSON.stringify({ ...now, startedAt: new Date().toISOString(), argv: process.argv.slice(2), plannedCalls: planned }, null, 2), { flag: 'wx' })
}
// The worker fence on learner_sim, then recovery of every run a dead runner left, then the learners' runs
// (src/sim-learners.ts). A second runner is refused (exit 2); a run that stops progressing ends this one (exit 3).
const { bootSimRunner, watchSimRun, SimRunStalled } = await import('../src/sim-learners.js')
const boot = await bootSimRunner(services, configs).catch((error: Error) => {
  if (!/already active/.test(error.message)) throw error
  console.error('[sim] another runner holds learner_sim (the worker fence): stop it, or wait for it to end'); process.exit(2)
})
console.log(JSON.stringify({ recovered: boot.recovered, retriedSteps: boot.retriedSteps, learners: boot.ids.length }))
const ids = boot.ids
const stallMinutes = Number(a['stall-minutes'])
const statuses = await watchSimRun({
  pollMs: 10_000, stallMs: stallMinutes * 60_000, log: (line) => console.log(line),
  poll: async () => ({ statuses: await Promise.all(ids.map(async (id) => (await services.workflowRunService.getRun(id))?.status ?? 'missing')),
    progress: Number((await services.db.query<{ n: string }>(`SELECT (SELECT count(*) FROM learning_sim_calls WHERE run_id=$1 AND output ? 'text') + (SELECT count(*) FROM learning_sim_messages WHERE run_id=$1) AS n`, [runId])).rows[0]!.n) }),
}).catch(async (error: Error) => {
  if (!(error instanceof SimRunStalled)) throw error
  console.error(`[sim] ALARM run ${runId} stalled: ${error.message}; start the runner again with --run-id ${runId} to recover`)
  await services.backgroundJobs!.stop(); process.exit(3)
})
const status = statuses.every((x) => x === 'completed') ? 'completed' : 'incomplete'
// The verdict of record comes from --analyze-only, which verifies config.json; this end-of-run report withholds it.
const r = analyzeSimRun(await loadSimRun(runId), { integrity: { ok: false, detail: 'not verified: run --analyze-only' } })
await writeFile(`${dir}/results.json`, JSON.stringify({ runId, report: r }, null, 2))
await writeFile(`${dir}/results.md`, renderSimReport(runId, r))
console.log(renderSimReport(runId, r))
// Stopping the job runner closes the shared pool, so it is the last database use.
await services.backgroundJobs!.stop()
process.exit(status === 'completed' ? 0 : 1)
