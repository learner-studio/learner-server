/**
 * Simulated-learner experiment runner (docs/specs/simulated-learner-experiment.md).
 *
 *   bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts \
 *     [--run-id UUID] [--per-arm 1] [--arms on,off,control,randomized,frozen] [--lanes medium] [--sessions 5] [--turns 4]
 *     [--retests 2] [--concurrency 4] [--max-calls N] [--stub] [--dry-run] [--analyze-only]
 *
 * --per-arm is a count for every arm, or per arm: `on=6,off=6,control=1,frozen=2` (learners per arm PER LANE);
 * --per-arm-fast overrides it for the fast lane (batch 2's small fast cell).
 * --design v2 runs batch 2 (docs/specs/simulated-learner-experiment.md, "Batch 2"): arm randomized within lane, each
 * learner's own stratified holdout and Williams-design task order, the fact-sheet channel under a per-session budget
 * enforced by an arm-blind matcher, the batch-2 memory rules, 3 turns by default, and the pre-registration written
 * once into config.json before the first model call (a resume that differs is refused; --analyze-only verifies it). Learners are started in an
 * interleaved order (cell index, then lane, then arm), so a run stopped by --max-calls stays balanced across arms.
 * --max-calls is the run's hard cap on model calls (every role, the grader included): no new call starts once
 * the run has stored that many; a learner that hits it fails and resumes later with every receipt kept.
 *
 * Runs ONLY on the learner_sim database (derived from DATABASE_URL; the live `learner` DB and :3010 are never
 * touched): every learner is one learningSimLearnerWorkflow run on this process's own queue workers. Passing an
 * existing --run-id resumes: completed learners are skipped, failed ones are restarted and every model call that
 * already has a receipt is free. Results go to /var/lib/learner/sim/<runId>/.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({ options: {
  'run-id': { type: 'string' }, 'per-arm': { type: 'string', default: '1' }, arms: { type: 'string', default: 'on,off,control,randomized,frozen' }, lanes: { type: 'string', default: 'medium' },
  sessions: { type: 'string', default: '5' }, 'max-calls': { type: 'string' }, turns: { type: 'string' }, retests: { type: 'string', default: '2' }, concurrency: { type: 'string', default: '4' }, 'grading-replicates': { type: 'string', default: '1' },
  'learner-model': { type: 'string', default: 'gpt-5.6-luna:low' }, 'agent-model': { type: 'string', default: 'gpt-5.6-luna:medium' }, 'scorer-model': { type: 'string', default: 'gpt-5.6-luna:medium' },
  design: { type: 'string', default: 'v1' }, 'per-arm-fast': { type: 'string' },
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
const { plannedCalls, loadSimRun, analyzeSimRun, renderSimReport, BATCH2_PREREGISTRATION } = await import('@learner/core/lib/learning/learning-sim-analysis.js')
const { batch2Slots } = await import('@learner/core/lib/learning/learning-sim-design.js')
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
// A learner's id is fixed by (lane, arm, index): l<lane 1-3><arm 0-4><index 01-99>, e.g. l1001 is the first `on`
// learner of the slow lane. So a smaller run (a smoke) is the first learners of a larger one with the same run id,
// and growing --per-arm later only adds learners. The leakage probe (a grader check that needs no learner) runs on
// the first learner of each arm and lane only.
if (!['v1', 'v2'].includes(a.design!)) throw new Error('--design is v1 or v2')
// Batch 2 pre-registers 3 turns per session; batch 1 ran 4.
const turns = Number(a.turns ?? (a.design === 'v2' ? 3 : 4))
const common = { runId, sessions: Number(a.sessions), turns, transport: a.stub ? 'stub' : 'codex',
  learnerModel: model(a['learner-model']!, 300), agentModel: model(a['agent-model']!, 420), scorerModel: model(a['scorer-model']!, 420) } as const
const configs: Config[] = []
if (a.design === 'v2') {
  // Batch 2: learner l<lane><index in lane>; arm, holdout and task order from the seeded design (no retests or leakage probes).
  const slots = batch2Slots(runId, lanes, (arm, lane) => perArm(arm, lane), arms, Number(a.sessions))
    .sort((x, y) => x.cellIndex - y.cellIndex || lanes.indexOf(x.lane) - lanes.indexOf(y.lane) || arms.indexOf(x.arm as Config['arm']) - arms.indexOf(y.arm as Config['arm']))
  for (const slot of slots) configs.push(SimLearnerConfig.parse({ ...common, learnerId: `l${(['slow', 'medium', 'fast'] as const).indexOf(slot.lane) + 1}${String(slot.index).padStart(3, '0')}`,
    arm: slot.arm, lane: slot.lane, retests: 0, leakageProbe: false, design: 'v2', heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap }))
} else {
  for (const lane of lanes) for (const arm of arms) for (let i = 0; i < perArm(arm, lane); i++) configs.push(SimLearnerConfig.parse({ ...common,
    learnerId: `l${(['slow', 'medium', 'fast'] as const).indexOf(lane) + 1}${SIM_ARMS.indexOf(arm)}${String(i + 1).padStart(2, '0')}`, arm, lane,
    retests: Number(a.retests), leakageProbe: i === 0,
  }))
}

// The policy's gradingReplicates (k), set in learner_sim before the run: every Learner arm's grading runs the product
// assessment workflow, which grades each reading k times (k - 1 prior-blind replicates).
const gradingReplicates = Number(a['grading-replicates'])
if (!(Number.isInteger(gradingReplicates) && gradingReplicates >= 1)) throw new Error('--grading-replicates must be a positive integer')
const totals: Record<string, number> = {}
for (const c of configs) for (const [role, n] of Object.entries(plannedCalls(c, gradingReplicates))) totals[role] = (totals[role] ?? 0) + n
const planned = Object.values(totals).reduce((x, y) => x + y, 0)
console.log(JSON.stringify({ runId, database: 'learner_sim', design: a.design, learners: configs.length, arms, lanes, sessions: Number(a.sessions), turns, gradingReplicates, plannedCalls: planned, maxCalls, byRole: totals,
  callsPerLearnerSession: +(planned / configs.reduce((n, c) => n + c.sessions, 0)).toFixed(1), note: 'grader calls are an upper bound: a concept with no new evidence is not regraded' }, null, 2))
if (a['dry-run']) process.exit(0)

// Batch 2's tamper-evident record: written once before the first model call, refused if a later invocation differs.
// It pins the design (arms, lanes, per-arm counts, sessions, turns, models, k, the learners' configs) and the code
// that defines the estimands (the sha256 of the analysis, design, prompt, matcher and memory modules).
const { createHash } = await import('node:crypto')
const { readFile } = await import('node:fs/promises')
const PINNED_MODULES = ['learning-sim-analysis', 'learning-sim-design', 'learning-sim-prompts', 'learning-sim-matcher', 'learning-sim-memory']
const moduleHashes = async () => Object.fromEntries(await Promise.all(PINNED_MODULES.map(async (m) =>
  [m, createHash('sha256').update(await readFile(`${import.meta.dir}/../../core/src/lib/learning/${m}.ts`)).digest('hex')] as const)))
const git = (args: string[]) => { const r = Bun.spawnSync(['git', '-C', import.meta.dir, ...args]); return r.stdout.toString().trim() }
const record = async () => ({ runId, design: a.design, arms, lanes, perArm: Object.fromEntries(lanes.map((lane) => [lane, Object.fromEntries(arms.map((arm) => [arm, perArm(arm, lane)]))])),
  sessions: Number(a.sessions), turns, gradingReplicates, maxCalls, models: { learner: a['learner-model'], agent: a['agent-model'], scorer: a['scorer-model'] },
  commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain', '--', '../../core/src/lib/learning']).length > 0, modules: await moduleHashes(),
  preregistration: BATCH2_PREREGISTRATION, configs })
const pinnedKeys = ['runId', 'design', 'arms', 'lanes', 'perArm', 'sessions', 'turns', 'gradingReplicates', 'models', 'modules', 'preregistration', 'configs'] as const
const differences = (x: Record<string, unknown>, y: Record<string, unknown>) => pinnedKeys.filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]))

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
  // Batch 2: verify the record of the run against the code and the learners stored in the database.
  let integrity: { ok: boolean; detail: string } | null = null
  if (data.some((d) => d.config.design === 'v2')) {
    const stored = await readFile(`${a.out}/${runId}/config.json`, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null)
    if (!stored) integrity = { ok: false, detail: 'no config.json for this run' }
    else {
      const hashes = await moduleHashes()
      const changed = Object.entries(stored.modules as Record<string, string>).filter(([m, h]) => hashes[m] !== h).map(([m]) => m)
      const storedLearners = new Map((stored.configs as Config[]).map((c) => [c.learnerId, JSON.stringify(c)]))
      const mismatched = data.filter((d) => storedLearners.get(d.config.learnerId) !== JSON.stringify(SimLearnerConfig.parse(d.config))).map((d) => d.config.learnerId)
      integrity = { ok: !changed.length && !mismatched.length && stored.dirty === false,
        detail: `recorded at ${String(stored.commit).slice(0, 8)}${stored.dirty ? ' with uncommitted sim modules' : ''}; analysed at ${git(['rev-parse', 'HEAD']).slice(0, 8)}; modules changed since: ${changed.join(', ') || 'none'}; learners differing from the record: ${mismatched.join(', ') || 'none'}` }
    }
  }
  const r = analyzeSimRun(data, { integrity })
  const out = `${a.out}/${runId}`
  await mkdir(out, { recursive: true })
  await writeFile(`${out}/results.json`, JSON.stringify({ runId, report: r, data }, null, 2))
  await writeFile(`${out}/results.md`, renderSimReport(runId, r))
  console.log(renderSimReport(runId, r))
  await handle.close()
  process.exit(0)
}
const { rpcService } = await import('@pikku/core/rpc')
// A sim step that grades waits on the product assessment workflow it started, holding its queue slot meanwhile:
// leave room for every learner's wait plus that workflow's own jobs.
process.env.LEARNER_WORKFLOW_CONCURRENCY ??= String(Math.max(8, 2 * Number(a.concurrency) + 4))
const { createConfig } = await import('../src/config.js')
const { createSingletonServices } = await import('../src/services.js')
const services = await createSingletonServices(await createConfig())
const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: the runner writes only to learner_sim')
// Simulated calls are recorded in learning_sim_calls; they never reach the
// owner's Langfuse traces.
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

const report = async () => {
  const data = await loadSimRun(runId)
  // The verdict of record comes from --analyze-only, which verifies config.json; this end-of-run report withholds it.
  const r = analyzeSimRun(data, { integrity: a.design === 'v2' ? { ok: false, detail: 'not verified: run --analyze-only' } : null })
  await writeFile(`${dir}/results.json`, JSON.stringify({ runId, report: r, data }, null, 2))
  await writeFile(`${dir}/results.md`, renderSimReport(runId, r))
  console.log(renderSimReport(runId, r))
}

// Written before the first model call. Batch 2: the pre-registration of record, written once; a resume must match it.
if (a.design === 'v2') {
  const now = await record()
  const stored = await readFile(`${dir}/config.json`, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null)
  if (stored) {
    const diff = differences(stored, now)
    if (diff.length) throw new Error(`Refusing: config.json of run ${runId} differs from this invocation in ${diff.join(', ')}; the pre-registration is written once`)
  } else {
    if (now.dirty && !a.stub) throw new Error('Refusing: the sim modules have uncommitted changes; the record must name a commit')
    await writeFile(`${dir}/config.json`, JSON.stringify({ ...now, startedAt: new Date().toISOString(), argv: process.argv.slice(2), plannedCalls: planned }, null, 2), { flag: 'wx' })
  }
} else {
  await writeFile(`${dir}/config.json`, JSON.stringify({ runId, startedAt: new Date().toISOString(), argv: process.argv.slice(2), design: a.design, plannedCalls: planned, maxCalls, configs }, null, 2))
}
const jobs = services.backgroundJobs
if (!jobs) throw new Error("No background job runner in this runtime")
await jobs.start()
const rpc = rpcService.getContextRPCService(services, {}, false)
const terminal = ['completed', 'failed', 'cancelled']
const existing = async (c: Config) => (await services.db.query<{ workflow_run_id: string; status: string }>(
  `SELECT workflow_run_id,status FROM learner_workflow_runs WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1 AND input::jsonb->>'learnerId'=$2 ORDER BY created_at DESC LIMIT 1`, [c.runId, c.learnerId])).rows[0]
const started = Date.now()
const runOne = async (c: Config) => {
  const prior = await existing(c)
  if (prior?.status === 'completed') return { learnerId: c.learnerId, status: 'completed', resumed: true }
  // A run still in flight from an earlier invocation is resumed by this process's workers; a failed one restarts.
  const id = prior && !terminal.includes(prior.status) ? prior.workflow_run_id : (await services.workflowService.startWorkflow('learningSimLearnerWorkflow', c, { type: 'internal' }, rpc)).runId
  for (;;) {
    const run = await services.workflowRunService.getRun(id)
    if (run && terminal.includes(run.status)) { console.log(JSON.stringify({ learnerId: c.learnerId, arm: c.arm, status: run.status, minutes: +((Date.now() - started) / 60000).toFixed(1) })); return { learnerId: c.learnerId, status: run.status } }
    await Bun.sleep(5000)
  }
}
// Bounded concurrency over learners; LLM_CLI_MAX_CONCURRENT bounds the Codex processes underneath.
const queue = [...configs]
const outcomes: Array<{ learnerId: string; status: string }> = []
await Promise.all(Array.from({ length: Math.min(Number(a.concurrency), queue.length) }, async () => { for (let c = queue.shift(); c; c = queue.shift()) outcomes.push(await runOne(c)) }))
await writeFile(`${dir}/outcomes.json`, JSON.stringify({ runId, minutes: (Date.now() - started) / 60000, outcomes }, null, 2))
await report()
// Stopping the job runner closes the shared pool, so it is the last database use.
await jobs.stop()
process.exit(outcomes.every((o) => o.status === 'completed') ? 0 : 1)
