import type { WorkflowRun, WorkflowRunService } from '../../runtime/types.js'
import type { WorkflowService } from '../../runtime/types.js'

const TERMINAL_WORKFLOW_STATUSES = new Set(['completed', 'failed', 'cancelled'])
const WORKFLOW_STATUSES = ['running', 'suspended', 'completed', 'failed', 'cancelled'] as const
/** The only statuses `isRunActive` can ever return true for. */
const NON_TERMINAL_WORKFLOW_STATUSES = WORKFLOW_STATUSES.filter(
  (status) => !TERMINAL_WORKFLOW_STATUSES.has(status),
)

/**
 * How long a `running` run may go without progress before it is presumed dead.
 *
 * A run is only "in progress" while the process that owns it is alive. Nothing
 * transitions a `running` row when that process dies, so an interrupted run
 * stays `running` forever — and every dedup check in this codebase reads
 * non-terminal status as "already running" and refuses to start a new one. One
 * orphan therefore blocks its feature PERMANENTLY. That is not hypothetical:
 * an extraction run orphaned by an API restart sat `running` for four hours
 * and every later deduplicated request attached to it. There is no way out from the UI either —
 * cancelWorkflowRun scopes to the CALLER, while these runs are owned by the
 * module owner, so the actor who triggered it gets `{found: false}`.
 *
 * `run.updatedAt` is NOT a progress heartbeat, though this comment once claimed
 * it was. `KyselyWorkflowService` writes `learner_workflow_runs` on exactly three
 * occasions — insert, status change, and `setState` — while every step write
 * touches `learner_workflow_steps` only, and no workflow here calls `setState`. Measured
 * 2026-08-18: a run with 11 succeeded steps spanning 76s had
 * `updated_at - created_at = 0`, as did all 43 in-flight runs, while all 6,150
 * settled ones had advanced it (settling IS a status change). So a bare run-row
 * read measures AGE SINCE START. Callers that can supply the run's real step
 * activity should pass it as `lastStepActivityAt`; the framework's own
 * `findStalledRunIds` compensates the same way, pairing its run-row test with
 * "no step touched since `before`".
 *
 * THE THRESHOLD IS MEASURED, NOT GUESSED, AND ONLY SUCCESSES SET IT. A step or
 * run that FAILED after an hour says nothing about how long healthy work needs,
 * so failures are excluded from the bound entirely. Measured 2026-08-18 over
 * 6,365 settled runs and 15,052 settled steps, with the 43 restart-orphans
 * excluded (their spans are days and would poison every percentile):
 *
 *   succeeded steps (14,299):  p99 135s   max 24.6min   3 over 15min
 *   completed runs  (5,611):   p99 316s   max 26.4min   5 over 15min
 *   longest FAILED step 74.2min / run 74.8min — no bound, excluded
 *
 * 30 minutes clears the longest real success (26.4min run, 24.6min step) with
 * modest headroom. The previous value was TWO HOURS, which nothing had ever
 * come close to — no run in recorded history exceeded 2h, and only one
 * exceeded 1h (a failure). It was a formality, not a bound.
 *
 * DO NOT LOWER THIS TO A PRODUCT TARGET. "No run should take longer than 15
 * minutes" is a legitimate goal, but it belongs in alerting: enforcing it here
 * would declare the 5 runs that legitimately exceed it dead WHILE THEY WORK,
 * which now surfaces as a false "finished" in the UI (the activity badge clears
 * and the caller reloads) on top of the duplicate work. Make those runs faster,
 * then lower this to match what they actually measure.
 *
 * The threshold is a BACKSTOP, not the primary defence. Interrupted runs are
 * replayed at process start by `recoverInterruptedRuns` (see
 * `run-recovery.ts`), which needs no threshold because it compares against boot
 * time.
 */
export const STALE_RUNNING_RUN_MS = 30 * 60 * 1000

/**
 * Whether a run should still block a new one from starting.
 *
 * `suspended` is deliberately exempt from the staleness bound: a suspended run
 * is idle BY DESIGN, waiting on an external resume, so idleness says nothing
 * about whether it is alive.
 */
export function isRunActive(
  run: WorkflowRun,
  now: number = Date.now(),
  lastStepActivityAt?: Date | string | number | null,
): boolean {
  if (TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
    return false
  }
  if (run.status !== 'running') {
    return true
  }
  // The LATEST of the two clocks, because they report different things: the run
  // row moves only on a status change, the step rows only while work happens.
  // Either one being recent is proof of life; an unusable value is dropped
  // rather than allowed to drag the answer toward "dead".
  const clocks = [new Date(run.updatedAt ?? run.createdAt).getTime()]
  if (lastStepActivityAt !== undefined && lastStepActivityAt !== null) {
    clocks.push(new Date(lastStepActivityAt).getTime())
  }
  const usable = clocks.filter((value) => Number.isFinite(value))
  if (usable.length === 0) {
    return true
  }
  return now - Math.max(...usable) < STALE_RUNNING_RUN_MS
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function getRunUserId(run: WorkflowRun): string | null {
  if (typeof run.wire?.userId === 'string' && run.wire.userId.length > 0) {
    return run.wire.userId
  }
  if (isRecord(run.input) && typeof run.input.userId === 'string' && run.input.userId.length > 0) {
    return run.input.userId
  }
  return null
}

function getRunSiteId(run: WorkflowRun): string | null {
  if (isRecord(run.input) && typeof run.input.siteId === 'string' && run.input.siteId.length > 0) {
    return run.input.siteId
  }
  return null
}

async function listRunsByStatus(
  workflowRunService: WorkflowRunService,
  status: typeof WORKFLOW_STATUSES[number],
): Promise<WorkflowRun[]> {
  const runs: WorkflowRun[] = []
  let offset = 0

  for (;;) {
    const batch = await workflowRunService.listRuns({ status, limit: 100, offset })
    if (batch.length === 0) break
    runs.push(...batch)
    if (batch.length < 100) break
    offset += batch.length
  }

  return runs
}

async function listSiteRunsByStatuses(
  workflowRunService: WorkflowRunService,
  userId: string,
  siteId: string,
  statuses: readonly typeof WORKFLOW_STATUSES[number][],
): Promise<WorkflowRun[]> {
  const runs = (await Promise.all(statuses.map((status) => listRunsByStatus(workflowRunService, status)))).flat()
  return runs.filter((run) => getRunUserId(run) === userId && getRunSiteId(run) === siteId)
}

export async function listSiteWorkflowRunsForUser(
  workflowRunService: WorkflowRunService,
  userId: string,
  siteId: string,
  statuses: readonly typeof WORKFLOW_STATUSES[number][] = WORKFLOW_STATUSES,
): Promise<WorkflowRun[]> {
  return listSiteRunsByStatuses(workflowRunService, userId, siteId, statuses)
}

/**
 * List a user's own in-flight workflow runs that were started directly over
 * HTTP (wire.type === 'http'). Excludes child runs a parent workflow spawned
 * (wire.type === 'workflow') so the frontend Activity panel can rehydrate
 * after a page reload without flooding with per-extractor children.
 */
export async function listNonTerminalHttpRunsForUser(
  workflowRunService: WorkflowRunService,
  userId: string,
): Promise<WorkflowRun[]> {
  const [running, suspended] = await Promise.all([
    workflowRunService.listRuns({ status: 'running', limit: 200 }),
    workflowRunService.listRuns({ status: 'suspended', limit: 200 }),
  ])
  return [...running, ...suspended].filter(
    (run) => run.wire?.type === 'http' && getRunUserId(run) === userId,
  )
}

export async function listActiveHttpRunsForUser(
  workflowRunService: WorkflowRunService,
  userId: string,
): Promise<WorkflowRun[]> {
  return (await listNonTerminalHttpRunsForUser(workflowRunService, userId)).filter((run) => isRunActive(run))
}

/**
 * Count a user's active (non-terminal) site-workflow runs across the given
 * sites. Replaces the legacy jobQueue.getUserJobs "active site jobs" check that
 * intelligence holdGuard / marketing-summary used — jobs are durable workflows now.
 */
export async function countActiveSiteRuns(
  workflowRunService: WorkflowRunService,
  userId: string,
  siteIds: readonly string[],
): Promise<number> {
  if (siteIds.length === 0) {
    return 0
  }

  // Only NON-TERMINAL statuses, fetched ONCE for every site rather than per
  // site. This count sits on the READ path of the marketing summary, so its
  // cost is paid on every page load, and it used to ask for all five statuses
  // per site — paging `completed` and `failed` 100 rows at a time through the
  // whole table, then discarding every one of them, because `isRunActive` is
  // false for a terminal run by definition. Measured on dev at 11,298 runs
  // across 9 sites: ~1,000 queries and ~10.8s, against 0.12s for the AI
  // comparison beside it, which does not call this. The work was not merely
  // wasteful, it grew with retained history — so the surface got slower the
  // longer the instance ran.
  const wantedSiteIds = new Set(siteIds)
  const runs = (
    await Promise.all(
      NON_TERMINAL_WORKFLOW_STATUSES.map((status) =>
        listRunsByStatus(workflowRunService, status),
      ),
    )
  ).flat()

  // Same liveness bound as the dedup checks, and it matters MORE here: this
  // count feeds the intelligence holdGuard, so a single orphaned site run would
  // otherwise hold off every regeneration indefinitely.
  return runs.filter(
    (run) =>
      getRunUserId(run) === userId &&
      wantedSiteIds.has(getRunSiteId(run) as string) &&
      isRunActive(run),
  ).length
}

export async function cancelWorkflowRuns(
  workflowService: WorkflowService,
  runs: readonly WorkflowRun[],
): Promise<number> {
  let cancelled = 0
  for (const run of runs) {
    if (TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
      continue
    }
    await workflowService.updateRunStatus(run.id, 'cancelled', undefined, {
      name: 'CancelledError',
      message: 'Cancelled by user',
    } as never)
    cancelled += 1
  }
  return cancelled
}

/**
 * A workflow's non-terminal runs, oldest included. A singleton guard must read
 * these rather than "the latest N runs": a sweep that fires every minute pushes
 * an orphan out of any recency window within N minutes, where it can no longer
 * block, but also can never be settled.
 */
export async function listUnsettledRuns(
  workflowRunService: WorkflowRunService,
  workflowName: string,
): Promise<WorkflowRun[]> {
  const batches = await Promise.all(NON_TERMINAL_WORKFLOW_STATUSES.map((status) =>
    workflowRunService.listRuns({ workflowName, status, limit: 100 })))
  return batches.flat()
}

/**
 * The runs that still block a singleton, after settling the ones that are dead.
 *
 * A `running` run whose run row AND steps have not moved for
 * STALE_RUNNING_RUN_MS lost its executor. Skipping it in the guard is not
 * enough: it stays `running`, and the standalone engine's lease recovery
 * re-adopts any lapsed lease on the next worker boot, so a worker that is
 * stopped again before the step finishes (a gate run, a restart loop on a small
 * self-hosted box) abandons it again, forever. Settling it as `failed` takes it
 * out of every recovery query. A step reporting progress keeps the run alive
 * however old it is, so a slow live run is never stolen.
 */
export async function settleAbandonedRuns(
  workflowRunService: WorkflowRunService,
  workflowService: WorkflowService,
  runs: readonly WorkflowRun[],
  now: number = Date.now(),
): Promise<WorkflowRun[]> {
  const blocking: WorkflowRun[] = []
  for (const run of runs) {
    if (TERMINAL_WORKFLOW_STATUSES.has(run.status)) continue
    if (run.status !== 'running' || isRunActive(run, now)) {
      blocking.push(run)
      continue
    }
    const touched = (await workflowRunService.getRunSteps(run.id))
      .map((step) => new Date(step.updatedAt).getTime())
      .filter(Number.isFinite)
    if (isRunActive(run, now, touched.length ? Math.max(...touched) : null)) {
      blocking.push(run)
      continue
    }
    await workflowService.updateRunStatus(run.id, 'failed', undefined, {
      name: 'AbandonedRunError',
      message: `No progress for ${STALE_RUNNING_RUN_MS / 60_000} min; its executor is gone`,
    } as never)
  }
  return blocking
}

/**
 * Cancel one run on behalf of a user, enforcing ownership. A run that doesn't
 * exist OR belongs to someone else reports `found: false` (foreign runs are
 * indistinguishable from missing ones, so run ids can't be probed). A run
 * already in a terminal state is left untouched (`cancelled: false`).
 */
export async function cancelRunForUser(
  workflowRunService: WorkflowRunService,
  workflowService: WorkflowService,
  userId: string,
  runId: string,
): Promise<{ found: boolean; cancelled: boolean; status: string | null }> {
  const run = await workflowRunService.getRun(runId)
  if (!run || getRunUserId(run) !== userId) {
    return { found: false, cancelled: false, status: null }
  }
  if (TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
    return { found: true, cancelled: false, status: run.status }
  }
  const cancelled = await cancelWorkflowRuns(workflowService, [run])
  return { found: true, cancelled: cancelled > 0, status: 'cancelled' }
}

export async function deleteTerminalWorkflowRuns(
  workflowRunService: WorkflowRunService,
  runs: readonly WorkflowRun[],
): Promise<number> {
  let deleted = 0
  for (const run of runs) {
    if (!TERMINAL_WORKFLOW_STATUSES.has(run.status)) {
      continue
    }
    if (await workflowRunService.deleteRun(run.id)) {
      deleted += 1
    }
  }
  return deleted
}
