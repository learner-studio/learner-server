/**
 * Simulated-learner experiment runner (docs/specs/simulated-learner-experiment.md).
 *
 *   bun --env-file=/etc/learner/db.env packages/runtime-pikku/scripts/sim-experiment.ts \
 *     [--run-id UUID] [--per-arm 1] [--arms on,off,oracle,blind] [--lanes medium] [--sessions 5] [--turns 3]
 *     [--max-calls N] [--grading-replicates 1] [--concurrency 6] [--stall-minutes 45] [--stub] [--dry-run] [--analyze-only]
 *     [--sequential] [--accept-failed] [--health]
 *
 * --per-arm is a count for every arm, or per arm: `on=6,off=6` (learners per arm PER LANE); --per-arm-fast overrides
 * it for the fast lane, --per-arm-none for the never-learns control (lane none: notebook capacity 0, budget 0). Arms are randomized within lane, each learner gets its own stratified holdout and
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
 *
 * Revision 8 (SIM_PREREGISTRATION.primary.sequential):
 * --concurrency N (default 6, at most 9): model-call slots and workflow concurrency. A 429 pauses every slot with
 *   backoff and jitter (never a learner outcome) and two in a row drop one slot (not below 2).
 * --sequential: the main batch in blocks of 10 matched pairs (block 1 also carries every learner outside the primary
 *   arms); after each block the efficacy look is taken by code and only "continue" starts the next block. The runner
 *   prints the decision only, never an interim estimate. Restart with the same --run-id: ended learners are adopted.
 *   A learner that failed is restarted (twice per block per process); if one still fails, the look is not taken
 *   (exit 5) unless --accept-failed, which counts it incomplete.
 * --health: the arm-blind health look (ids and counts only), read-only, safe while a batch runs.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({ options: {
  'run-id': { type: 'string' }, 'per-arm': { type: 'string', default: '1' }, 'per-arm-fast': { type: 'string' }, 'per-arm-none': { type: 'string' }, arms: { type: 'string', default: 'on,off,oracle,blind' }, lanes: { type: 'string', default: 'medium' },
  sessions: { type: 'string', default: '5' }, turns: { type: 'string', default: '3' }, 'max-calls': { type: 'string' }, concurrency: { type: 'string', default: '6' }, sequential: { type: 'boolean', default: false }, 'accept-failed': { type: 'boolean', default: false }, health: { type: 'boolean', default: false }, 'grading-replicates': { type: 'string', default: '1' }, 'stall-minutes': { type: 'string', default: '45' },
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
  const perArmSpec = (lane === 'fast' && a['per-arm-fast']) || (lane === 'none' && a['per-arm-none']) || a['per-arm']!
  if (/^\d+$/.test(perArmSpec)) return Number(perArmSpec)
  const entry = perArmSpec.split(',').map((x) => x.split('=')).find(([k]) => k === arm)
  if (!entry || !/^\d+$/.test(entry[1] ?? '')) throw new Error(`--per-arm has no count for arm ${arm}`)
  return Number(entry[1])
}
const concurrency = Number(a.concurrency)
if (!(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 9)) throw new Error('--concurrency must be an integer from 1 to 9')
const maxCalls = a['max-calls'] ? Number(a['max-calls']) : null
if (maxCalls !== null && !(Number.isInteger(maxCalls) && maxCalls > 0)) throw new Error('--max-calls must be a positive integer')
const common = { runId, sessions: Number(a.sessions), turns: Number(a.turns), transport: a.stub ? 'stub' : 'codex',
  learnerModel: model(a['learner-model']!, 300), agentModel: model(a['agent-model']!, 420), scorerModel: model(a['scorer-model']!, 420) } as const
// Learner l<lane 0-3 (0: the never-learns control)><index in lane>; arm, holdout and task order from the seeded design.
const configs: Config[] = simSlots(runId, lanes, (arm, lane) => perArm(arm, lane), arms, Number(a.sessions))
  .map((slot) => SimLearnerConfig.parse({ ...common, learnerId: `l${(['none', 'slow', 'medium', 'fast'] as const).indexOf(slot.lane)}${String(slot.index).padStart(3, '0')}`,
    arm: slot.arm, lane: slot.lane, heldOut: slot.heldOut, taskOrder: slot.taskOrder, factBudget: slot.factBudget, dayGap: slot.dayGap, pair: slot.cellIndex }))

// Revision 8, the sequential blocks: arm on and off of a lane that has arm on go by pair (10 pairs a block); every
// other learner (oracle, slow and medium off, the never-learns control) is in block 0. Within a block the start order
// is a seeded shuffle, so neither arm is systematically started first.
const LOOKS = SIM_PREREGISTRATION.primary.sequential.looks
const primaryLanesOf = new Set(configs.filter((c) => c.arm === 'on' && c.lane !== 'none').map((c) => c.lane))
const blockOf = (c: Config) => a.sequential && primaryLanesOf.has(c.lane) && (c.arm === 'on' || c.arm === 'off') ? Math.max(0, LOOKS.findIndex((n) => (c.pair ?? 0) < n)) : 0
const { seeded } = await import('@learner/core/lib/learning/learning-sim-memory.js')
const blocks: Config[][] = Array.from({ length: a.sequential ? LOOKS.length : 1 }, (_, b) => {
  const r = seeded(`${runId}|block${b}`), xs = configs.filter((c) => blockOf(c) === b)
  for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [xs[i], xs[j]] = [xs[j]!, xs[i]!] }
  return xs
})
if (a.sequential) {
  const sizes = LOOKS.map((n, b) => n - (b ? LOOKS[b - 1]! : 0))
  for (const lane of primaryLanesOf) for (const arm of ['on', 'off'] as const) blocks.forEach((xs, b) => {
    const k = xs.filter((c) => c.lane === lane && c.arm === arm).length
    if (k !== sizes[b]) throw new Error(`--sequential needs ${LOOKS.at(-1)} learners per arm in lane ${lane}: block ${b + 1} has ${k} ${arm} learners, not ${sizes[b]}`)
  })
}

// The policy's gradingReplicates (k), set in learner_sim before the run: arm on's grading runs the product assessment
// workflow, which grades each reading k times (k - 1 prior-blind replicates).
const gradingReplicates = Number(a['grading-replicates'])
if (!(Number.isInteger(gradingReplicates) && gradingReplicates >= 1)) throw new Error('--grading-replicates must be a positive integer')
const totals: Record<string, number> = {}
for (const c of configs) for (const [role, n] of Object.entries(plannedCalls(c, gradingReplicates))) totals[role] = (totals[role] ?? 0) + n
const planned = Object.values(totals).reduce((x, y) => x + y, 0)
console.log(JSON.stringify({ runId, database: 'learner_sim', concurrency, sequential: a.sequential ? blocks.map((xs) => xs.length) : false, learners: configs.length, arms, lanes, sessions: Number(a.sessions), turns: Number(a.turns), gradingReplicates, plannedCalls: planned, maxCalls, byRole: totals,
  callsPerLearnerSession: +(planned / configs.reduce((n, c) => n + c.sessions, 0)).toFixed(1), note: 'grader calls are an upper bound: a concept with no new evidence is not regraded' }, null, 2))
if (a['dry-run']) process.exit(0)
// --health opens its pool read-only (pg reads PGOPTIONS): it cannot write, whatever it runs.
if (a.health) process.env.PGOPTIONS = '-c default_transaction_read_only=on'

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
// Verify the record of the run against the code and the learners stored in the database (--analyze-only and every
// sequential look).
const verifyIntegrity = async (data: Awaited<ReturnType<typeof loadSimRun>>): Promise<{ ok: boolean; detail: string }> => {
  const stored = await readFile(`${a.out}/${runId}/config.json`, 'utf8').then((t) => JSON.parse(t) as Record<string, unknown>).catch(() => null)
  if (!stored) return { ok: false, detail: 'no config.json for this run' }
  const changed = frozenSimChanges(String(stored.commit ?? ''), repo)
  const storedLearners = new Map((stored.configs as Config[]).map((c) => [c.learnerId, JSON.stringify(c)]))
  const mismatched = data.filter((d) => storedLearners.get(d.config.learnerId) !== JSON.stringify(SimLearnerConfig.parse(d.config))).map((d) => d.config.learnerId)
  return { ok: !changed.length && !mismatched.length,
    detail: `recorded at ${String(stored.commit).slice(0, 8)}; analysed at ${head.slice(0, 8)}; frozen paths changed since: ${changed.join(', ') || 'none'}; learners differing from the record: ${mismatched.join(', ') || 'none'}` }
}
// Each learner's latest workflow status in this run, by learner id.
const learnerStatuses = async (query: (text: string, params: unknown[]) => Promise<{ rows: Array<{ learner_id: string; status: string }> }>) =>
  Object.fromEntries((await query(`SELECT DISTINCT ON (input::jsonb->>'learnerId') input::jsonb->>'learnerId' AS learner_id, status FROM learner_workflow_runs
    WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1 ORDER BY input::jsonb->>'learnerId', created_at DESC`, [runId])).rows.map((r) => [r.learner_id, r.status]))
// Pairs (by index, from 0) whose primary learners have all ended: the most a look may read (analyzeSimRun endedPairs).
const endedPairs = (data: Awaited<ReturnType<typeof loadSimRun>>, status: Record<string, string>) => {
  const lanesWithOn = new Set(data.filter((d) => d.config.arm === 'on' && d.config.lane !== 'none').map((d) => d.config.lane))
  const primary = data.filter((d) => lanesWithOn.has(d.config.lane) && (d.config.arm === 'on' || d.config.arm === 'off'))
  let n = 0
  while (primary.some((d) => d.config.pair === n) && primary.filter((d) => d.config.pair === n).every((d) => ['completed', 'failed', 'cancelled'].includes(status[d.config.learnerId] ?? ''))) n++
  return primary.some((d) => d.config.pair === undefined) ? undefined : n
}
if (a.health) {
  const { bindDatabase, createDatabase } = await import('@learner/core/db/handle.js')
  const handle = bindDatabase(createDatabase(url.toString(), { max: 2, applicationName: 'learner-sim-health' }))
  const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
  if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: the health look reads only learner_sim')
  const { simHealth, renderSimHealth } = await import('@learner/core/lib/learning/learning-sim-health.js')
  console.log(renderSimHealth(runId, simHealth(await loadSimRun(runId), await learnerStatuses(handle.query as never))))
  await handle.close()
  process.exit(0)
}
if (a['analyze-only']) {
  const { bindDatabase, createDatabase } = await import('@learner/core/db/handle.js')
  const handle = bindDatabase(createDatabase(url.toString(), { max: 4, applicationName: 'learner-sim-analysis' }))
  const { assertSimDatabase } = await import('@learner/core/lib/learning/learning-sim-experiment.js')
  if (await assertSimDatabase() !== 'learner_sim') throw new Error('Refusing: the runner reads only learner_sim')
  const data = await loadSimRun(runId)
  const integrity = await verifyIntegrity(data)
  const r = analyzeSimRun(data, { integrity, endedPairs: endedPairs(data, await learnerStatuses(handle.query as never)) })
  const out = `${a.out}/${runId}`
  await mkdir(out, { recursive: true })
  await writeFile(`${out}/results.json`, JSON.stringify({ runId, report: r, ...(r.outcome ? { data } : {}) }, null, 2)) // a pilot's file carries no raw per-learner data to compute the withheld outcome from
  await writeFile(`${out}/results.md`, renderSimReport(runId, r))
  console.log(renderSimReport(runId, r))
  await handle.close()
  process.exit(0)
}
process.env.LEARNER_WORKFLOW_CONCURRENCY = String(concurrency)
process.env.LLM_CLI_MAX_CONCURRENT = String(concurrency)
const { enableCliGovernor, cliGovernorState } = await import('@learner/llm/lib/llm/llm-limits.js')
enableCliGovernor({ max: concurrency, min: Math.min(2, concurrency) })
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
const { bootSimRunner, startSimLearners, watchSimRun, SimRunStalled } = await import('../src/sim-learners.js')
const stallMinutes = Number(a['stall-minutes'])
const allIds: string[] = []
let boot: Awaited<ReturnType<typeof bootSimRunner>> | undefined
const watch = (ids: string[]) => watchSimRun({
  pollMs: 10_000, stallMs: stallMinutes * 60_000, log: (line) => console.log(line),
  poll: async () => ({ statuses: await Promise.all(ids.map(async (id) => (await services.workflowRunService.getRun(id))?.status ?? 'missing')),
    progress: Number((await services.db.query<{ n: string }>(`SELECT (SELECT count(*) FROM learning_sim_calls WHERE run_id=$1 AND output ? 'text') + (SELECT count(*) FROM learning_sim_messages WHERE run_id=$1) AS n`, [runId])).rows[0]!.n) }),
}).catch(async (error: Error) => {
  if (!(error instanceof SimRunStalled)) throw error
  console.error(`[sim] ALARM run ${runId} stalled: ${error.message}; start the runner again with --run-id ${runId} to recover`)
  await services.backgroundJobs!.stop(); process.exit(3)
})
let statuses: string[] = []
let stoppedBy = 'all blocks ran'
for (let b = 0; b < blocks.length; b++) {
  // The learners of every block so far: started, or adopted when a previous process started them.
  const upTo = blocks.slice(0, b + 1).flat()
  if (!boot) {
    boot = await bootSimRunner(services, upTo).catch((error: Error) => {
      if (!/already active/.test(error.message)) throw error
      console.error('[sim] another runner holds learner_sim (the worker fence): stop it, or wait for it to end'); process.exit(2)
    })
    console.log(JSON.stringify({ recovered: boot.recovered, retriedSteps: boot.retriedSteps, learners: boot.ids.length, block: b + 1 }))
    allIds.splice(0, allIds.length, ...boot.ids)
  } else {
    allIds.splice(0, allIds.length, ...await startSimLearners(services, upTo))
    console.log(JSON.stringify({ block: b + 1, learners: allIds.length }))
  }
  statuses = await watch(allIds)
  // A failed learner (a capacity or rate-limit failure that outlived its step retries) is restarted, never read
  // as an outcome: startSimLearners starts a fresh run for it, which reuses every receipt it has.
  for (let retry = 0; retry < 2 && statuses.some((x) => x !== 'completed'); retry++) {
    console.log(`[sim] block ${b + 1}: ${statuses.filter((x) => x !== 'completed').length} learner(s) did not complete; restarting them (${retry + 1}/2); slots ${cliGovernorState().max}, 429s ${cliGovernorState().rateLimited}`)
    allIds.splice(0, allIds.length, ...await startSimLearners(services, upTo))
    statuses = await watch(allIds)
  }
  if (!a.sequential) break
  if (statuses.some((x) => x !== 'completed') && !a['accept-failed']) {
    console.error(`[sim] block ${b + 1}: ${statuses.filter((x) => x !== 'completed').length} learner(s) still not complete; the look is NOT taken. Start the runner again with --run-id ${runId} to retry them, or add --accept-failed to count them incomplete.`)
    await services.backgroundJobs!.stop(); process.exit(5)
  }
  // The efficacy look, by code. Only the decision is printed; no interim estimate leaves this process.
  const data = await loadSimRun(runId)
  const look = analyzeSimRun(data, { integrity: await verifyIntegrity(data), endedPairs: LOOKS[b] }).sequential
  const decision = look?.decisions.at(-1)
  if (!look || !decision || decision.plannedPairs !== LOOKS[b]) throw new Error(`[sim] look ${b + 1} could not be taken (${look ? look.scheduledPairs : 0} pairs scheduled); the sequence is stopped`)
  console.log(`[sim] LOOK ${decision.look} at ${decision.plannedPairs} pairs: ${decision.decision}${look.failedChecks.length ? `; checks failing: ${look.failedChecks.join('; ')}` : ''}`)
  if (look.failedChecks.length) { stoppedBy = `a pre-registered check failed at look ${decision.look}`; break }
  if (decision.decision !== 'continue') { stoppedBy = `look ${decision.look}: ${decision.decision}`; break }
}
console.log(`[sim] the batch ended: ${stoppedBy}; slots ${cliGovernorState().max}/${concurrency}, 429s ${cliGovernorState().rateLimited}, slot drops ${cliGovernorState().stepDowns}`)
const status = statuses.every((x) => x === 'completed') ? 'completed' : 'incomplete'
// The verdict of record comes from --analyze-only, which verifies config.json; this end-of-run report withholds it.
const r = analyzeSimRun(await loadSimRun(runId), { integrity: { ok: false, detail: 'not verified: run --analyze-only' } })
await writeFile(`${dir}/results.json`, JSON.stringify({ runId, report: r }, null, 2))
await writeFile(`${dir}/results.md`, renderSimReport(runId, r))
console.log(renderSimReport(runId, r))
// Stopping the job runner closes the shared pool, so it is the last database use.
await services.backgroundJobs!.stop()
process.exit(status === 'completed' ? 0 : 1)
