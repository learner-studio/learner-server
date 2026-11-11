import { z } from 'zod'
import { ReactiveGradingHealth } from '@learner/contract/learning/learning-grading-health.js'
export { ReactiveGradingHealth }
import { metaDbQuery as defaultQuery, type MetaPgQueryFn } from '../db-metadata/_shared.js'
import { UNPAID_FAILURE_MARKER } from './learning-archive-coordinator.js'

/**
 * Is reactive grading moving? 2026-10-30..11-11 no reading was produced for twelve
 * days while every surface looked quiet: routing failed into a log, and blocked
 * concepts showed as a count nobody read. Red (`error`, which fails the scheduled
 * stall-check run and reaches the learner's CLI sessions) when:
 *  - work has WAITED longer than REACTIVE_STALL_HOURS and nothing in that stage completed for as long;
 *  - concepts blocked at the breaker, retrying unpaid failures, or exhausted arrivals have been stuck that
 *    long and no reading was produced in that window (the "needs an operator" states, review B1);
 *  - passes keep settling (REACTIVE_NO_READING_MIN_SETTLED in the window) but no reading has been produced for REACTIVE_NO_READING_ERROR_HOURS (review S8);
 *  - the stall check itself has not finished for REACTIVE_STALL_CHECK_WATCHDOG_MINUTES (a dead worker, review S2).
 * An idle pipeline (nothing waiting) is green.
 */
export const REACTIVE_STALL_HOURS = 6
export const REACTIVE_NO_READING_ERROR_HOURS = 24
export const REACTIVE_STALL_CHECK_WATCHDOG_MINUTES = 60
/** Settled passes in the window before "no reading" counts: a pass with no new evidence legitimately publishes nothing. */
export const REACTIVE_NO_READING_MIN_SETTLED = 5
/** A concept whose unpaid failures reach this count is reported as stuck (it keeps retrying at the capped backoff). */
export const REACTIVE_STUCK_UNPAID_FAILURES = 3

export type ReactiveGradingHealth = z.infer<typeof ReactiveGradingHealth>

/** Stall-check workflow schemas. */
const OwnerHealth = ReactiveGradingHealth.extend({ userId: z.string() })
export const StallCheckInput = z.object({ userId: z.string().optional() })
export const StallCheckMeasured = z.object({ owners: z.array(OwnerHealth) })
export const StallCheckResult = z.object({ checked: z.number(), status: z.enum(['ok', 'warning', 'error']), messages: z.array(z.string()) })

export type ReactiveGradingHealthInput = {
  now: Date; enabled: boolean; assessmentEnabled: boolean; routingError: string | null
  routing: { waiting: number; oldestWaitingAt: Date | null; lastRoutedAt: Date | null; held: number; exhausted: number; oldestExhaustedAt: Date | null }
  grading: { waiting: number; oldestWaitingAt: Date | null; running: number; lastSettledAt: Date | null; settledInWindow: number; lastReadingAt: Date | null
    blocked: number; blockedUnpaid: number; oldestBlockedAt: Date | null; retryingUnpaid: number; oldestRetryingAt: Date | null; unverifiedPasses: number }
  /** Omitted inside the stall check itself and where schedules are off. */
  stallCheck?: { lastFinishedAt: Date | null; lastStatus: string | null } | null
}

const iso = (d: Date | null) => d?.toISOString() ?? null
const hoursAgo = (now: Date, d: Date) => Math.round((now.getTime() - d.getTime()) / 36e5)
const oldest = (...dates: Array<Date | null>) => dates.filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null

export function deriveReactiveGradingHealth(input: ReactiveGradingHealthInput, stallHours = REACTIVE_STALL_HOURS): ReactiveGradingHealth {
  const cutoff = input.now.getTime() - stallHours * 36e5
  const stale = (d: Date | null, before = cutoff) => d === null || d.getTime() < before
  const errors: string[] = [], warnings: string[] = []
  const r = input.routing, g = input.grading
  const lastReading = `last reading ${iso(g.lastReadingAt) ?? 'never'}`
  if (input.enabled) {
    if (r.waiting > 0 && r.oldestWaitingAt && r.oldestWaitingAt.getTime() < cutoff && stale(r.lastRoutedAt))
      errors.push(`Routing stalled: ${r.waiting} indexed arrivals waiting since ${r.oldestWaitingAt.toISOString()}, no batch routed in ${r.lastRoutedAt ? hoursAgo(input.now, r.lastRoutedAt) : 'any'} h${input.routingError ? ` (${input.routingError})` : ''}.`)
    if (input.assessmentEnabled && g.waiting > 0 && g.oldestWaitingAt && g.oldestWaitingAt.getTime() < cutoff && stale(g.lastSettledAt))
      errors.push(`Grading stalled: ${g.waiting} concepts waiting since ${g.oldestWaitingAt.toISOString()}, no pass settled in ${g.lastSettledAt ? hoursAgo(input.now, g.lastSettledAt) : 'any'} h (${lastReading}).`)
    const actions = [
      r.exhausted ? `${r.exhausted} arrivals exhausted their routing retries (inspect getLearningReactiveConsolidation holds, then run the reactive recovery or releaseLearningReactiveHolds)` : '',
      g.blockedUnpaid ? `${g.blockedUnpaid} concepts blocked before any paid call (run the reactive recovery)` : '',
      g.blocked - g.blockedUnpaid ? `${g.blocked - g.blockedUnpaid} concepts blocked after a paid call (review their paid receipts, then retryLearningReactiveTarget)` : '',
      g.retryingUnpaid ? `${g.retryingUnpaid} concepts failing before any paid call ${REACTIVE_STUCK_UNPAID_FAILURES}+ times in a row (read their last_failure; they retry every hour)` : '',
    ].filter(Boolean)
    const stuckSince = oldest(r.exhausted ? r.oldestExhaustedAt : null, g.blocked ? g.oldestBlockedAt : null, g.retryingUnpaid ? g.oldestRetryingAt : null)
    if (actions.length) {
      // Stuck items are an error once they have been stuck past the bound with no reading in that window:
      // cause C alone (every concept at the breaker, routing healthy) must still fail the stall check.
      if (stuckSince && stuckSince.getTime() < cutoff && stale(g.lastReadingAt))
        errors.push(`Grading stuck since ${stuckSince.toISOString()} with no reading in ${stallHours} h (${lastReading}): ${actions.join('; ')}.`)
      else warnings.push(`Needs an operator: ${actions.join('; ')}.`)
    }
    if (input.assessmentEnabled && g.settledInWindow >= REACTIVE_NO_READING_MIN_SETTLED && stale(g.lastReadingAt)) {
      const message = `${g.settledInWindow} concepts settled in the last ${stallHours} h but no reading was produced (${lastReading}): passes are ending without a publishable estimate.`
      if (stale(g.lastReadingAt, input.now.getTime() - REACTIVE_NO_READING_ERROR_HOURS * 36e5)) errors.push(message)
      else warnings.push(message)
    }
    if (g.unverifiedPasses) warnings.push(`${g.unverifiedPasses} passes in the last ${stallHours} h graded without some indexed chunks the bank holds no vector for (their unverified chunk ids are in the pass snapshot, counts.unverifiedChunkIds).`)
    if (input.routingError && !errors.length) warnings.push(`Last routing error: ${input.routingError}`)
  }
  if (input.stallCheck && stale(input.stallCheck.lastFinishedAt, input.now.getTime() - REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000))
    errors.push(`No reactive stall check has finished in ${REACTIVE_STALL_CHECK_WATCHDOG_MINUTES} min (last ${iso(input.stallCheck.lastFinishedAt) ?? 'never'}): the learner worker or its scheduler is down or stuck.`)
  return {
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok',
    checkedAt: input.now.toISOString(), stallHours, enabled: input.enabled, assessmentEnabled: input.assessmentEnabled,
    routing: { ...r, oldestWaitingAt: iso(r.oldestWaitingAt), lastRoutedAt: iso(r.lastRoutedAt), oldestExhaustedAt: iso(r.oldestExhaustedAt), error: input.routingError },
    grading: { ...g, oldestWaitingAt: iso(g.oldestWaitingAt), lastSettledAt: iso(g.lastSettledAt), lastReadingAt: iso(g.lastReadingAt), oldestBlockedAt: iso(g.oldestBlockedAt), oldestRetryingAt: iso(g.oldestRetryingAt) },
    stallCheck: input.stallCheck ? { lastFinishedAt: iso(input.stallCheck.lastFinishedAt), lastStatus: input.stallCheck.lastStatus } : null,
    messages: [...errors, ...warnings],
  }
}

/** Unpaid failures carry this marker in last_failure; the coordinator writes it (one definition, review S10). */
export { UNPAID_FAILURE_MARKER }

type Num = string | number | null
type ReadOptions = { now?: Date; stallCheck?: boolean; stallHours?: number }
const STALL_CHECK_WORKFLOW = 'learningReactiveStallCheckWorkflow'

/** The scheduled check's last finished run. Read by the API, never by the check itself, so a dead worker is visible. */
export async function readStallCheckState(q: MetaPgQueryFn = defaultQuery) {
  const row = (await q<{ status: string; at: Date; error: string | null }>(`SELECT status,updated_at AS at,error FROM learner_workflow_runs
    WHERE workflow=$1 AND status IN ('completed','failed') ORDER BY created_at DESC LIMIT 1`, [STALL_CHECK_WORKFLOW])).rows[0]
  return { lastFinishedAt: row ? new Date(row.at) : null, lastStatus: row?.status ?? null, error: row?.error ?? null }
}

export async function readReactiveGradingHealth(userId: string, q: MetaPgQueryFn = defaultQuery, options: ReadOptions | Date = {}) {
  const { now = new Date(), stallCheck = false, stallHours = REACTIVE_STALL_HOURS } = options instanceof Date ? { now: options } : options
  const setting = (await q<{ enabled: boolean; config: { assessmentEnabled?: boolean }; revision: string; activated_at: Date; last_error: string | null }>(
    'SELECT enabled,config,revision,activated_at,last_error FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  const watchdog = stallCheck && setting?.enabled ? await readStallCheckState(q) : null
  const zero = { waiting: 0, oldestWaitingAt: null, lastRoutedAt: null, held: 0, exhausted: 0, oldestExhaustedAt: null }
  if (!setting) return deriveReactiveGradingHealth({ now, enabled: false, assessmentEnabled: false, routingError: null, routing: zero,
    grading: { waiting: 0, oldestWaitingAt: null, running: 0, lastSettledAt: null, settledInWindow: 0, lastReadingAt: null, blocked: 0, blockedUnpaid: 0, oldestBlockedAt: null, retryingUnpaid: 0, oldestRetryingAt: null, unverifiedPasses: 0 } }, stallHours)
  const routing = (await q<{ waiting: Num; oldest: Date | null; routed: Date | null; held: Num; exhausted: Num; exhausted_at: Date | null }>(`SELECT
      (SELECT count(*) FROM learning_vector_arrivals a WHERE a.created_at>=$2
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$1 AND r.event_id=a.event_id AND r.revision=$3)
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND h.event_id=a.event_id AND h.revision=$3)) AS waiting,
      (SELECT min(a.created_at) FROM learning_vector_arrivals a WHERE a.created_at>=$2
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$1 AND r.event_id=a.event_id AND r.revision=$3)
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND h.event_id=a.event_id AND h.revision=$3)) AS oldest,
      (SELECT max(routed_at) FROM learning_reactive_routes WHERE user_id=$1) AS routed,
      (SELECT count(*) FROM learning_reactive_route_holds WHERE user_id=$1 AND revision=$3 AND next_attempt_at IS NOT NULL) AS held,
      (SELECT count(*) FROM learning_reactive_route_holds WHERE user_id=$1 AND revision=$3 AND next_attempt_at IS NULL) AS exhausted,
      (SELECT min(last_attempt_at) FROM learning_reactive_route_holds WHERE user_id=$1 AND revision=$3 AND next_attempt_at IS NULL) AS exhausted_at`,
    [userId, setting.activated_at, setting.revision])).rows[0]!
  const windowStart = new Date(now.getTime() - stallHours * 36e5)
  const grading = (await q<{ waiting: Num; oldest: Date | null; running: Num; settled: Date | null; settled_recent: Num; blocked: Num; unpaid: Num; blocked_at: Date | null; retrying: Num; retrying_at: Date | null }>(`SELECT
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts<3) AS waiting,
      min(COALESCE(waiting_since,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts<3) AS oldest,
      count(*) FILTER(WHERE run_id IS NOT NULL) AS running,
      max(last_finished_at) AS settled,
      count(*) FILTER(WHERE last_finished_at>=$3) AS settled_recent,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts>=3) AS blocked,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts>=3 AND last_failure LIKE '%'||$2||'%') AS unpaid,
      min(COALESCE(last_failed_at,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts>=3) AS blocked_at,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures>=$4) AS retrying,
      min(COALESCE(waiting_since,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures>=$4) AS retrying_at
    FROM learning_reactive_admission WHERE user_id=$1`, [userId, UNPAID_FAILURE_MARKER, windowStart, REACTIVE_STUCK_UNPAID_FAILURES])).rows[0]!
  const reading = (await q<{ at: Date | null }>('SELECT max(completed_at) AS at FROM learning_mastery_readings WHERE user_id=$1', [userId])).rows[0]?.at ?? null
  const unverified = (await q<{ n: Num }>(`SELECT count(*) AS n FROM learning_vector_turn_experiments WHERE user_id=$1 AND created_at>=$2
      AND config->>'purpose'='live' AND unverified_chunks>0`, [userId, windowStart])).rows[0]?.n ?? 0
  const date = (d: Date | string | null) => d === null ? null : new Date(d)
  return deriveReactiveGradingHealth({
    now, enabled: setting.enabled, assessmentEnabled: setting.config.assessmentEnabled === true, routingError: setting.last_error,
    routing: { waiting: Number(routing.waiting), oldestWaitingAt: date(routing.oldest), lastRoutedAt: date(routing.routed), held: Number(routing.held), exhausted: Number(routing.exhausted), oldestExhaustedAt: date(routing.exhausted_at) },
    grading: { waiting: Number(grading.waiting), oldestWaitingAt: date(grading.oldest), running: Number(grading.running), lastSettledAt: date(grading.settled), settledInWindow: Number(grading.settled_recent),
      lastReadingAt: date(reading), blocked: Number(grading.blocked), blockedUnpaid: Number(grading.unpaid), oldestBlockedAt: date(grading.blocked_at),
      retryingUnpaid: Number(grading.retrying), oldestRetryingAt: date(grading.retrying_at), unverifiedPasses: Number(unverified) },
    stallCheck: watchdog ? { lastFinishedAt: watchdog.lastFinishedAt, lastStatus: watchdog.lastStatus } : null,
  }, stallHours)
}

/** A stall-check run untouched this long (run row and every step row) lost its job; it has two short steps. */
export const STALL_CHECK_RECLAIM_IDLE_MS = 10 * 60_000

/**
 * The scheduler's guard: start a stall check unless one is live. A live run idle
 * past STALL_CHECK_RECLAIM_IDLE_MS is cancelled first (review S3): before this a
 * single lost orchestrator job kept one run `running` forever and the schedule,
 * which starts nothing while one is live, never checked again. Cancel goes
 * through updateRunStatus, which refuses to leave a terminal state.
 */
export async function ensureStallCheckRun(start: () => Promise<string>, cancel: (runId: string) => Promise<void>, q: MetaPgQueryFn = defaultQuery, now = new Date()) {
  const live = (await q<{ workflow_run_id: string; touched: Date }>(`SELECT r.workflow_run_id,GREATEST(r.updated_at,COALESCE(max(s.updated_at),r.updated_at)) AS touched
    FROM learner_workflow_runs r LEFT JOIN learner_workflow_steps s USING(workflow_run_id)
    WHERE r.workflow=$1 AND r.status IN ('pending','running','suspended') GROUP BY r.workflow_run_id,r.updated_at`, [STALL_CHECK_WORKFLOW])).rows
  const reclaimed: string[] = []
  for (const run of live) {
    if (now.getTime() - new Date(run.touched).getTime() < STALL_CHECK_RECLAIM_IDLE_MS) return { started: null, live: run.workflow_run_id, reclaimed }
    await cancel(run.workflow_run_id)
    reclaimed.push(run.workflow_run_id)
  }
  return { started: await start(), live: null, reclaimed }
}

const ALERT_LIMIT = 700
/**
 * What the learner's CLI sessions are told (as a user-visible hook system message)
 * while reactive grading is red: the last finished stall check failed for this
 * owner, or (where schedules run) no stall check has finished within the watchdog
 * window. One indexed read; the full detail is on the Learning page (review S2).
 */
export async function readReactiveGradingAlerts(userId: string, schedulesEnabled: boolean, q: MetaPgQueryFn = defaultQuery, now = new Date()): Promise<string[]> {
  const setting = (await q<{ enabled: boolean }>('SELECT enabled FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  if (!setting?.enabled) return []
  const state = await readStallCheckState(q)
  const alerts: string[] = []
  if (state.lastStatus === 'failed' && state.error) {
    let message = state.error
    try { message = String(JSON.parse(state.error)?.message ?? state.error) } catch { /* plain text */ }
    const own = message.replace(/^Reactive grading stalled: /, '').split(' | ').filter(m => m.startsWith(`${userId}: `)).map(m => m.slice(userId.length + 2))
    if (own.length) alerts.push(`Reactive grading alarm (stall check at ${state.lastFinishedAt!.toISOString()}): ${own.join(' ')}`.slice(0, ALERT_LIMIT) + ' See the Learning page and docs/operations/reactive-grading-runbook.md.')
  }
  if (schedulesEnabled && (!state.lastFinishedAt || now.getTime() - state.lastFinishedAt.getTime() > REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000))
    alerts.push(`Reactive grading is unmonitored: no stall check has finished since ${iso(state.lastFinishedAt) ?? 'ever'}; the learner worker or its scheduler is down or stuck.`)
  return alerts
}
