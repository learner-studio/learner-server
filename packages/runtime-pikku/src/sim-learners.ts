import { rpcService } from '@pikku/core/rpc'
import { acquireRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import type { SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import { recoverInterruptedRuns } from './recovery.js'
import type { createSingletonServices } from './services.js'

type Services = Awaited<ReturnType<typeof createSingletonServices>>

/** The simulated-learner experiment's runs: one learningSimLearnerWorkflow per (run id, learner id). A learner whose
 * latest run did not fail or get cancelled is adopted, never started twice, so the runner, the test and the crash
 * worker resume a batch by its run id alone. (Not a batch workflow: a parallel fan-out of child runs restarts
 * still-running siblings on @pikku/core 0.12.102.) Callers hold the worker fence (`bootSimRunner`). */
export async function startSimLearners(services: Services, configs: SimLearnerConfig[]): Promise<string[]> {
  const rpc = rpcService.getContextRPCService(services, {}, false)
  const ids: string[] = []
  for (const c of configs) {
    const prior = (await services.db.query<{ workflow_run_id: string; status: string }>(`SELECT workflow_run_id,status FROM learner_workflow_runs
      WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1 AND input::jsonb->>'learnerId'=$2 ORDER BY created_at DESC LIMIT 1`, [c.runId, c.learnerId])).rows[0]
    ids.push(prior && !['failed', 'cancelled'].includes(prior.status) ? prior.workflow_run_id
      : (await services.workflowService.startWorkflow('learningSimLearnerWorkflow', c, { type: 'internal' }, rpc)).runId)
  }
  return ids
}

/**
 * Boots a process as THE executor of the sim database's runs, as bin/worker.ts boots the worker: it takes the
 * worker's singleton fence on that database (an advisory lock held by its own connection, so a killed holder loses
 * it at once), and only then recovers every run a dead executor left `running`, starts the queue workers and starts
 * or adopts the learners' runs. No process list is read: a second runner waits for the fence (`waitMs`, 0 = refuse),
 * and a look-alike process cannot stop recovery. With the fence held no other process executes these runs, so a
 * step can only be orphaned by its holder dying, which the next holder recovers at its boot.
 */
export async function bootSimRunner(services: Services, configs: SimLearnerConfig[], { waitMs = 0 }: { waitMs?: number } = {}) {
  await acquireRuntimeRole({ waitMs, retryMs: 500 })
  const recovery = await recoverInterruptedRuns(services.workflowRunService, services.workflowService, { bootedAt: Date.now(), logger: services.logger })
  if (recovery.failed.length) throw new Error(`Failed to recover ${recovery.failed.length} interrupted workflow run(s)`)
  await services.backgroundJobs!.start()
  return { recovered: recovery.recovered.length, retriedSteps: recovery.retriedSteps.length, ids: await startSimLearners(services, configs) }
}

export class SimRunStalled extends Error {}
const TERMINAL = ['completed', 'failed', 'cancelled']
/**
 * Waits for the learners' runs to end. `poll` reads their statuses and a progress count (rows the run has written);
 * when neither changes for `stallMs` it throws SimRunStalled, so a run that cannot heal ends the runner with a non-zero
 * exit and an alarm instead of polling forever. Logs each change of the status counts.
 */
export async function watchSimRun({ poll, pollMs, stallMs, log }: {
  poll: () => Promise<{ statuses: string[]; progress: number }>; pollMs: number; stallMs: number; log: (line: string) => void
}) {
  const started = Date.now()
  let last = '', changedAt = started
  for (;;) {
    const { statuses, progress } = await poll()
    const counts = JSON.stringify(Object.fromEntries([...new Set(statuses)].sort().map((x) => [x, statuses.filter((y) => y === x).length])))
    const state = `${counts}|${progress}`
    if (state !== last) {
      if (counts !== last.split('|')[0]) log(JSON.stringify({ learners: JSON.parse(counts), minutes: +((Date.now() - started) / 60000).toFixed(1) }))
      last = state
      changedAt = Date.now()
    }
    if (statuses.every((x) => TERMINAL.includes(x))) return statuses
    if (Date.now() - changedAt >= stallMs) throw new SimRunStalled(`no progress for ${Math.round(stallMs / 60000)} min (${counts}, ${progress} rows written)`)
    await Bun.sleep(pollMs)
  }
}

/** What pins a run's analysis (N3): every sim module (scoring, exam, design, prompts, matcher, memory, facts, catalog,
 * analysis), the runner, the runner module, the sim's function and workflow wiring, and the spec. */
export const SIM_FROZEN_PATHS = [':(glob)packages/core/src/lib/learning/learning-sim-*', 'packages/runtime-pikku/scripts/sim-experiment.ts', 'packages/runtime-pikku/src/sim-learners.ts',
  'packages/server/src/functions/learning/learning-sim-experiment.function.ts', 'packages/server/src/wirings/learning-sim-learner.workflow.ts', 'docs/specs/simulated-learner-experiment.md']
/**
 * The frozen paths that differ in the checkout at `cwd` from `commit` (tracked changes, committed or not, and new
 * untracked files). Empty means the code and spec are those the run recorded; an unknown commit reads as changed.
 */
/** The environment without GIT_* variables: a git hook exports GIT_DIR and GIT_INDEX_FILE, which would point `git -C`
 * at the hook's repository instead of `cwd` (a pre-commit test once committed its fixture to the real branch). */
export const gitFreeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))) as Record<string, string>
export function frozenSimChanges(commit: string, cwd: string): string[] {
  const git = (args: string[]) => Bun.spawnSync(['git', '-C', cwd, ...args], { env: gitFreeEnv() })
  const diff = git(['diff', '--name-only', commit, '--', ...SIM_FROZEN_PATHS])
  if (diff.exitCode !== 0) return [`commit ${commit || '(none)'} not found`]
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', ...SIM_FROZEN_PATHS])
  return [...diff.stdout.toString().split('\n'), ...untracked.stdout.toString().split('\n')].filter(Boolean)
}
