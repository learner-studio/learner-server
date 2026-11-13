/**
 * The simulated-learner experiment's trigger (docs/specs/simulated-learner-experiment.md "Running it"). It decides
 * nothing: the run is learningSimExperimentWorkflow, executed by the sim worker (src/bin/sim-worker.ts) on learner_sim.
 *
 *   start (prints the plan; --dry-run stops there and opens no database):
 *     bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts --run-id UUID --max-calls N
 *       [--per-arm 1 | on=6,off=6] [--per-arm-fast ..] [--per-arm-none ..] [--arms on,off,oracle,blind] [--lanes medium]
 *       [--sessions 5] [--turns 3] [--grading-replicates 1] [--concurrency 6] [--sequential] [--dry-run]
 *       [--learner-model gpt-5.6-luna:low] [--agent-model gpt-5.6-luna:medium] [--scorer-model gpt-5.6-luna:medium]
 *   resume a failed run with its pinned input:   ... sim-experiment.ts --resume --run-id UUID
 *   the arm-blind health look (read-only):       ... sim-experiment.ts --health --run-id UUID
 *   the report of record (the run's last step):  ... sim-experiment.ts --report --run-id UUID
 *
 * A start validates the design and puts it in the run's input (learner configs carrying the record: the commit, the
 * cap, k, the looks); the workflow's first step refuses what the database or the code may not run, and pins it.
 * After the start nothing here is read again: --resume, --health and --report take the run id alone.
 */
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({ options: {
  'run-id': { type: 'string' }, resume: { type: 'boolean', default: false }, health: { type: 'boolean', default: false }, report: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false },
  'per-arm': { type: 'string', default: '1' }, 'per-arm-fast': { type: 'string' }, 'per-arm-none': { type: 'string' }, arms: { type: 'string', default: 'on,off,oracle,blind' }, lanes: { type: 'string', default: 'medium' },
  sessions: { type: 'string', default: '5' }, turns: { type: 'string', default: '3' }, 'max-calls': { type: 'string' }, concurrency: { type: 'string', default: '6' }, sequential: { type: 'boolean', default: false },
  'grading-replicates': { type: 'string', default: '1' },
  'learner-model': { type: 'string', default: 'gpt-5.6-luna:low' }, 'agent-model': { type: 'string', default: 'gpt-5.6-luna:medium' }, 'scorer-model': { type: 'string', default: 'gpt-5.6-luna:medium' },
} })
const fail = (message: string): never => { console.error(`Refusing: ${message}`); process.exit(7) }
const runId = a['run-id'] ?? fail('--run-id is required (a lowercase UUID)')
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(runId)) fail('--run-id must be a lowercase UUID')
const { simEnvironment } = await import('../src/sim-environment.js')
await simEnvironment({ readOnly: a.health || a.report || a['dry-run'] })
const { SIM_MAX_CONCURRENCY, simCheckoutHead, frozenSimChanges, simRunConfigs, simLearnerStatuses } = await import('@learner/core/lib/learning/learning-sim-run.js')
const { SIM_PREREGISTRATION, loadSimRun, plannedCalls } = await import('@learner/core/lib/learning/learning-sim-analysis.js')
const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
const { metaDbQuery: q } = await import('@learner/core/lib/db-metadata/_shared.js')
type ExperimentRun = { id: string; status: string; input: unknown; output: { markdown?: string } | null }
const experimentRuns = async () => (await q<ExperimentRun>(`SELECT workflow_run_id AS id, status, input::jsonb AS input, output::jsonb AS output FROM learner_workflow_runs
  WHERE workflow='learningSimExperimentWorkflow' AND input::jsonb->>'runId'=$1 ORDER BY created_at`, [runId])).rows

if (a.health || a.report) {
  const { bindDatabase, createDatabase } = await import('@learner/core/db/handle.js')
  const handle = bindDatabase(createDatabase(process.env.DATABASE_URL!, { max: 2, applicationName: 'learner-sim-read' }))
  if (await assertSimDatabase() !== 'learner_sim') fail('this reads only learner_sim')
  const runs = await experimentRuns()
  if (a.report) {
    const done = runs.find((r) => r.status === 'completed')
    if (!done?.output?.markdown) { console.error(`No report: run ${runId} has not completed (${runs.map((r) => r.status).join(', ') || 'never started'}); read --health`); await handle.close(); process.exit(6) }
    console.log(done.output.markdown)
  } else {
    const { simHealth, renderSimHealth } = await import('@learner/core/lib/learning/learning-sim-health.js')
    console.log(`experiment runs of ${runId}: ${runs.map((r) => `${r.id} ${r.status}`).join('; ') || 'none'}`)
    console.log(renderSimHealth(runId, simHealth(await loadSimRun(runId), await simLearnerStatuses(runId))))
  }
  await handle.close()
  process.exit(0)
}

let input: { runId: string; concurrency: number; configs: unknown[] } | undefined
if (!a.resume) {
  const perArm = (arm: string, lane: string): number => {
    const spec = (lane === 'fast' && a['per-arm-fast']) || (lane === 'none' && a['per-arm-none']) || a['per-arm']!
    if (/^\d+$/.test(spec)) return Number(spec)
    const entry = spec.split(',').map((x) => x.split('=')).find(([k]) => k === arm)
    return entry && /^\d+$/.test(entry[1] ?? '') ? Number(entry[1]) : fail(`--per-arm has no count for arm ${arm}`)
  }
  const int = (name: string, min: number, max = Infinity) => { const n = Number(a[name as keyof typeof a]); return Number.isInteger(n) && n >= min && n <= max ? n : fail(`--${name} must be an integer from ${min} to ${max}`) }
  const maxCalls = a['dry-run'] && a['max-calls'] === undefined ? null : int('max-calls', 1, SIM_PREREGISTRATION.primary.sequential.hardCallCap)
  const concurrency = int('concurrency', 1, SIM_MAX_CONCURRENCY)
  const configs = simRunConfigs({ runId, arms: a.arms!.split(',') as never, lanes: a.lanes!.split(',') as never, perArm, sessions: int('sessions', 1), turns: int('turns', 2),
    models: { learner: a['learner-model']!, agent: a['agent-model']!, scorer: a['scorer-model']! }, transport: 'codex', maxCalls, gradingReplicates: int('grading-replicates', 1),
    sequential: a.sequential!, looks: SIM_PREREGISTRATION.primary.sequential.looks, commit: simCheckoutHead() })
  const byRole: Record<string, number> = {}
  for (const c of configs) for (const [role, n] of Object.entries(plannedCalls(c, c.run!.gradingReplicates))) byRole[role] = (byRole[role] ?? 0) + n
  console.log(JSON.stringify({ runId, concurrency, learners: configs.length, record: configs[0]!.run, plannedCalls: Object.values(byRole).reduce((x, y) => x + y, 0), byRole,
    note: 'grader calls are an upper bound: a concept with no new evidence is not regraded' }, null, 2))
  if (a['dry-run']) process.exit(0)
  const changed = frozenSimChanges(configs[0]!.run!.commit)
  if (changed.length) fail(`the checkout differs from HEAD in frozen paths (${changed.join(', ')}); the record must name the code that runs`)
  input = { runId, concurrency, configs }
}
// The services only enqueue the run on the sim worker's queue schema: this process consumes no queue.
const { setRuntimeRole } = await import('@learner/core/lib/learning/learning-worker-runtime.js')
setRuntimeRole('learning-worker')
await import('../.pikku/pikku-bootstrap.gen.js')
const { createConfig } = await import('../src/config.js')
const { createSingletonServices } = await import('../src/services.js')
const services = await createSingletonServices(await createConfig())
if (await assertSimDatabase() !== 'learner_sim') fail('the experiment runs only on learner_sim')
const runs = await experimentRuns()
if (input && runs.length) fail(`run ${runId} was started already; --health reads it, --resume restarts it after a failure`)
const last = runs.at(-1)
if (!input && (!last || !['failed', 'cancelled'].includes(last.status))) fail(`--resume takes a run whose last experiment run failed (${last ? last.status : 'never started'})`)
const { rpcService } = await import('@pikku/core/rpc')
const started = await services.workflowService.startWorkflow('learningSimExperimentWorkflow', input ?? last!.input, { type: 'internal' }, rpcService.getContextRPCService(services, {}, false))
console.log(`[sim] run ${runId}: experiment run ${started.runId} started; the sim worker executes it (--health to follow)`)
await services.backgroundJobs!.stop()
process.exit(0)
