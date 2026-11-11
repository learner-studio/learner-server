/**
 * Simulated-learner experiment runner (docs/specs/simulated-learner-experiment.md).
 *
 *   bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts \
 *     [--run-id UUID] [--per-arm 1] [--arms on,off,control,randomized,frozen] [--lanes medium] [--sessions 5] [--turns 4]
 *     [--retests 2] [--learners 1] [--concurrency 4] [--stub] [--dry-run] [--analyze-only]
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
  sessions: { type: 'string', default: '5' }, turns: { type: 'string', default: '4' }, retests: { type: 'string', default: '2' }, concurrency: { type: 'string', default: '4' },
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
const { plannedCalls, loadSimRun, analyzeSimRun, renderSimReport } = await import('@learner/core/lib/learning/learning-sim-analysis.js')
type Config = import('@learner/core/lib/learning/learning-sim-experiment.js').SimLearnerConfig

const model = (spec: string, timeoutSec: number) => { const [m, effort] = spec.split(':'); return { model: m!, effort: effort ?? 'medium', timeoutSec } }
const runId = a['run-id'] ?? randomUUID()
const arms = a.arms!.split(',') as Config['arm'][]
const lanes = a.lanes!.split(',') as Config['lane'][]
for (const arm of arms) if (!SIM_ARMS.includes(arm)) throw new Error(`Unknown arm ${arm}`)
for (const lane of lanes) if (!(lane in SIM_LANES)) throw new Error(`Unknown lane ${lane}`)
const perArm = Number(a['per-arm'])
// Learners are numbered in arm-major blocks per lane; the number is the learner's identity across resumes.
const configs: Config[] = []
for (const lane of lanes) for (const arm of arms) for (let i = 0; i < perArm; i++) configs.push(SimLearnerConfig.parse({
  runId, learnerId: `l${String(configs.length + 1).padStart(2, '0')}`, arm, lane, sessions: Number(a.sessions), turns: Number(a.turns),
  transport: a.stub ? 'stub' : 'codex', learnerModel: model(a['learner-model']!, 300), agentModel: model(a['agent-model']!, 420), scorerModel: model(a['scorer-model']!, 420),
  retests: Number(a.retests), leakageProbe: true,
}))

const totals: Record<string, number> = {}
for (const c of configs) for (const [role, n] of Object.entries(plannedCalls(c))) totals[role] = (totals[role] ?? 0) + n
const planned = Object.values(totals).reduce((x, y) => x + y, 0)
console.log(JSON.stringify({ runId, database: 'learner_sim', learners: configs.length, arms, lanes, sessions: Number(a.sessions), turns: Number(a.turns), plannedCalls: planned, byRole: totals,
  callsPerLearnerSession: +(planned / configs.reduce((n, c) => n + c.sessions, 0)).toFixed(1), note: 'grader calls are an upper bound: a concept with no new evidence is not regraded' }, null, 2))
if (a['dry-run']) process.exit(0)

const { setRuntimeRole } = await import('@learner/core/lib/learning/learning-worker-runtime.js')
setRuntimeRole('learning-worker')
await import('../.pikku/pikku-bootstrap.gen.js')
const { rpcService } = await import('@pikku/core/rpc')
const { createConfig } = await import('../src/config.js')
const { createSingletonServices } = await import('../src/services.js')
const services = await createSingletonServices(await createConfig())
const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: the runner writes only to learner_sim')
const dir = `${a.out}/${runId}`
await mkdir(dir, { recursive: true })

const report = async () => {
  const data = await loadSimRun(runId)
  const r = analyzeSimRun(data)
  await writeFile(`${dir}/results.json`, JSON.stringify({ runId, report: r, data }, null, 2))
  await writeFile(`${dir}/results.md`, renderSimReport(runId, r))
  console.log(renderSimReport(runId, r))
}
if (a['analyze-only']) { await report(); process.exit(0) }

await writeFile(`${dir}/config.json`, JSON.stringify({ runId, startedAt: new Date().toISOString(), argv: process.argv.slice(2), configs }, null, 2))
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
