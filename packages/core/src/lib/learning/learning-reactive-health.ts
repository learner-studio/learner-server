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
 *    long AND work was due with no reading for that long: the learner has been active (arrivals with gaps
 *    shorter than the bound) since before the window with no reading since, or work has waited past the
 *    bound (review B1). An idle learner is not evidence: a quiet night with blocked concepts stays a
 *    warning (round-2 review N-B1), and so does the first activity of the morning;
 *  - passes keep settling (REACTIVE_NO_READING_MIN_SETTLED in the window) but no reading has been produced for REACTIVE_NO_READING_ERROR_HOURS (review S8);
 *  - the stall check itself has not reached a verdict for REACTIVE_STALL_CHECK_WATCHDOG_MINUTES (a dead worker,
 *    review S2), or its latest run crashed without one (round-2 review N-S1).
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
  routing: { waiting: number; oldestWaitingAt: Date | null; lastRoutedAt: Date | null; held: number; exhausted: number; oldestExhaustedAt: Date | null
    /** Start of the current run of arrivals (gaps shorter than the bound, the last within it) with no reading since. */
    activeWithoutReadingSince: Date | null }
  grading: { waiting: number; oldestWaitingAt: Date | null; running: number; lastSettledAt: Date | null; settledInWindow: number; lastReadingAt: Date | null
    blocked: number; blockedUnpaid: number; oldestBlockedAt: Date | null; retryingUnpaid: number; oldestRetryingAt: Date | null; unverifiedPasses: number }
  /** Omitted inside the stall check itself and where schedules are off. */
  stallCheck?: { lastFinishedAt: Date | null; lastStatus: string | null; failing?: string | null } | null
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
      r.exhausted ? `${r.exhausted} arrivals exhausted their routing retries (inspect getLearningReactiveConsolidation holds; accept chunks flagged as having text with acceptLearningVectorlessChunks, then run the reactive recovery or releaseLearningReactiveHolds)` : '',
      g.blockedUnpaid ? `${g.blockedUnpaid} concepts blocked before any paid call (run the reactive recovery)` : '',
      g.blocked - g.blockedUnpaid ? `${g.blocked - g.blockedUnpaid} concepts blocked after a paid call (review their paid receipts, then retryLearningReactiveTarget)` : '',
      g.retryingUnpaid ? `${g.retryingUnpaid} concepts failing before any paid call ${REACTIVE_STUCK_UNPAID_FAILURES}+ times in a row (read their last_failure; they retry every hour)` : '',
    ].filter(Boolean)
    const stuckSince = oldest(r.exhausted ? r.oldestExhaustedAt : null, g.blocked ? g.oldestBlockedAt : null, g.retryingUnpaid ? g.oldestRetryingAt : null)
    // Evidence that work was due for the whole window: the learner kept producing arrivals with no reading
    // since, or work waited past the bound. Arrivals stop overnight, so a quiet night is no evidence (N-B1).
    const dueSince = oldest(r.activeWithoutReadingSince, r.waiting ? r.oldestWaitingAt : null, input.assessmentEnabled && g.waiting ? g.oldestWaitingAt : null)
    if (actions.length) {
      // Cause C alone (every concept at the breaker, routing healthy, the learner active) must still fail the stall check.
      if (stuckSince && stuckSince.getTime() < cutoff && dueSince && dueSince.getTime() < cutoff && stale(g.lastReadingAt))
        errors.push(`Grading stuck since ${stuckSince.toISOString()}: work due since ${dueSince.toISOString()} with no reading in ${stallHours} h (${lastReading}): ${actions.join('; ')}.`)
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
  if (input.stallCheck?.failing) errors.push(`The reactive stall check itself is failing: ${input.stallCheck.failing.slice(0, 300)}`)
  if (input.stallCheck && stale(input.stallCheck.lastFinishedAt, input.now.getTime() - REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000))
    errors.push(`No reactive stall check has finished in ${REACTIVE_STALL_CHECK_WATCHDOG_MINUTES} min (last ${iso(input.stallCheck.lastFinishedAt) ?? 'never'}): the learner worker or its scheduler is down or stuck.`)
  return {
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok',
    checkedAt: input.now.toISOString(), stallHours, enabled: input.enabled, assessmentEnabled: input.assessmentEnabled,
    routing: { ...r, oldestWaitingAt: iso(r.oldestWaitingAt), lastRoutedAt: iso(r.lastRoutedAt), oldestExhaustedAt: iso(r.oldestExhaustedAt), activeWithoutReadingSince: iso(r.activeWithoutReadingSince), error: input.routingError },
    grading: { ...g, oldestWaitingAt: iso(g.oldestWaitingAt), lastSettledAt: iso(g.lastSettledAt), lastReadingAt: iso(g.lastReadingAt), oldestBlockedAt: iso(g.oldestBlockedAt), oldestRetryingAt: iso(g.oldestRetryingAt) },
    stallCheck: input.stallCheck ? { lastFinishedAt: iso(input.stallCheck.lastFinishedAt), lastStatus: input.stallCheck.lastStatus, failing: input.stallCheck.failing ?? null } : null,
    messages: [...errors, ...warnings],
  }
}

/** Unpaid failures carry this marker in last_failure; the coordinator writes it (one definition, review S10). */
export { UNPAID_FAILURE_MARKER }

type Num = string | number | null
type ReadOptions = { now?: Date; stallCheck?: boolean; stallHours?: number }
const STALL_CHECK_WORKFLOW = 'learningReactiveStallCheckWorkflow'

/** The assert step's thrown message starts with this: a failed run carrying it reached a verdict (the alarm); any other failure is a crash. */
export const STALL_VERDICT_PREFIX = 'Reactive grading stalled: '
const runErrorMessage = (error: string | null) => {
  if (!error) return null
  try { return String(JSON.parse(error)?.message ?? error) } catch { return error }
}

/**
 * The scheduled check's state. Read by the API, never by the check itself, so a dead worker is visible.
 * `lastFinishedAt` counts only runs that reached a verdict: a run that crashed (a missing column, a DB
 * timeout) checked nothing, so it neither feeds the watchdog nor stays silent; it is `failing` (round-2 N-S1).
 */
export async function readStallCheckState(q: MetaPgQueryFn = defaultQuery) {
  const latest = (await q<{ status: string; at: Date; error: string | null }>(`SELECT status,updated_at AS at,error FROM learner_workflow_runs
    WHERE workflow=$1 AND status IN ('completed','failed') ORDER BY created_at DESC LIMIT 1`, [STALL_CHECK_WORKFLOW])).rows[0]
  const verdict = (await q<{ at: Date }>(`SELECT updated_at AS at FROM learner_workflow_runs WHERE workflow=$1
    AND (status='completed' OR (status='failed' AND error LIKE $2)) ORDER BY created_at DESC LIMIT 1`, [STALL_CHECK_WORKFLOW, `%${STALL_VERDICT_PREFIX}%`])).rows[0]
  const message = runErrorMessage(latest?.error ?? null)
  const crashed = latest?.status === 'failed' && !message?.startsWith(STALL_VERDICT_PREFIX)
  return { lastFinishedAt: verdict ? new Date(verdict.at) : null, lastStatus: latest?.status ?? null, lastRunAt: latest ? new Date(latest.at) : null,
    error: message, failing: crashed ? message ?? 'failed with no error recorded' : null }
}

export async function readReactiveGradingHealth(userId: string, q: MetaPgQueryFn = defaultQuery, options: ReadOptions | Date = {}) {
  const { now = new Date(), stallCheck = false, stallHours = REACTIVE_STALL_HOURS } = options instanceof Date ? { now: options } : options
  const setting = (await q<{ enabled: boolean; config: { assessmentEnabled?: boolean }; revision: string; activated_at: Date; last_error: string | null }>(
    'SELECT enabled,config,revision,activated_at,last_error FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  const watchdog = stallCheck && setting?.enabled ? await readStallCheckState(q) : null
  const zero = { waiting: 0, oldestWaitingAt: null, lastRoutedAt: null, held: 0, exhausted: 0, oldestExhaustedAt: null, activeWithoutReadingSince: null }
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
      min(COALESCE(last_failed_at,waiting_since,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts>=3) AS blocked_at,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures>=$4) AS retrying,
      min(COALESCE(waiting_since,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures>=$4) AS retrying_at
    FROM learning_reactive_admission WHERE user_id=$1`, [userId, UNPAID_FAILURE_MARKER, windowStart, REACTIVE_STUCK_UNPAID_FAILURES])).rows[0]!
  const reading = (await q<{ at: Date | null }>('SELECT max(completed_at) AS at FROM learning_mastery_readings WHERE user_id=$1', [userId])).rows[0]?.at ?? null
  // The current run of arrivals since the last reading: it starts at the latest arrival that follows a gap of at least the bound.
  const activity = (await q<{ streak: Date | null; last: Date | null }>(`WITH a AS (SELECT created_at,created_at-lag(created_at) OVER(ORDER BY created_at) AS gap
      FROM learning_vector_arrivals WHERE created_at>=$1 AND created_at>COALESCE($2::timestamptz,'-infinity'))
    SELECT max(created_at) FILTER(WHERE gap IS NULL OR gap>=$3*interval '1 hour') AS streak,max(created_at) AS last FROM a`,
    [setting.activated_at, reading, stallHours])).rows[0]
  const activeSince = activity?.last && new Date(activity.last).getTime() >= windowStart.getTime() ? activity.streak : null
  const unverified = (await q<{ n: Num }>(`SELECT count(*) AS n FROM learning_vector_turn_experiments WHERE user_id=$1 AND created_at>=$2
      AND config->>'purpose'='live' AND unverified_chunks>0`, [userId, windowStart])).rows[0]?.n ?? 0
  const date = (d: Date | string | null) => d === null ? null : new Date(d)
  return deriveReactiveGradingHealth({
    now, enabled: setting.enabled, assessmentEnabled: setting.config.assessmentEnabled === true, routingError: setting.last_error,
    routing: { waiting: Number(routing.waiting), oldestWaitingAt: date(routing.oldest), lastRoutedAt: date(routing.routed), held: Number(routing.held), exhausted: Number(routing.exhausted), oldestExhaustedAt: date(routing.exhausted_at),
      activeWithoutReadingSince: date(activeSince ?? null) },
    grading: { waiting: Number(grading.waiting), oldestWaitingAt: date(grading.oldest), running: Number(grading.running), lastSettledAt: date(grading.settled), settledInWindow: Number(grading.settled_recent),
      lastReadingAt: date(reading), blocked: Number(grading.blocked), blockedUnpaid: Number(grading.unpaid), oldestBlockedAt: date(grading.blocked_at),
      retryingUnpaid: Number(grading.retrying), oldestRetryingAt: date(grading.retrying_at), unverifiedPasses: Number(unverified) },
    stallCheck: watchdog ? { lastFinishedAt: watchdog.lastFinishedAt, lastStatus: watchdog.lastStatus, failing: watchdog.failing } : null,
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
export type ReactiveGradingAlerts = { alerts: string[]; key: string | null }
/** Splits "Reactive grading stalled: u1: m | u1: m | u2: m" into this owner's parts; a ` | ` inside a part (a routing cause) stays in it. */
function ownParts(message: string, userId: string) {
  const parts: string[] = []
  for (const segment of message.slice(STALL_VERDICT_PREFIX.length).split(' | ')) {
    if (/^\S+: /.test(segment) || !parts.length) parts.push(segment)
    else parts[parts.length - 1] += ` | ${segment}`
  }
  return parts.filter(m => m.startsWith(`${userId}: `)).map(m => m.slice(userId.length + 2))
}

/**
 * What the learner's CLI sessions are told (as a user-visible hook system message)
 * while reactive grading is red: the last finished stall check failed for this
 * owner, the check itself is crashing (round-2 N-S1), or (where schedules run) no
 * check has reached a verdict within the watchdog window (review S2). `key` names
 * the state and when it began (the first failed run since the last completed one),
 * so the hook shows each state once instead of on every prompt (round-2 N-S3).
 */
export async function readReactiveGradingAlerts(userId: string, schedulesEnabled: boolean, q: MetaPgQueryFn = defaultQuery, now = new Date()): Promise<ReactiveGradingAlerts> {
  const setting = (await q<{ enabled: boolean }>('SELECT enabled FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  if (!setting?.enabled) return { alerts: [], key: null }
  const state = await readStallCheckState(q)
  const alerts: string[] = [], keys: string[] = []
  const footer = ' See the Learning page and docs/operations/reactive-grading-runbook.md.'
  if (state.lastStatus === 'failed') {
    const began = (await q<{ at: Date | null }>(`SELECT min(updated_at) AS at FROM learner_workflow_runs WHERE workflow=$1 AND status='failed'
      AND created_at>COALESCE((SELECT max(created_at) FROM learner_workflow_runs WHERE workflow=$1 AND status='completed'),'-infinity')`, [STALL_CHECK_WORKFLOW])).rows[0]?.at
    const since = iso(began ? new Date(began) : state.lastRunAt)
    if (state.failing) {
      alerts.push(`Reactive grading stall check is failing (last run at ${iso(state.lastRunAt)}, failing since ${since}): ${state.failing}`.slice(0, ALERT_LIMIT) + footer)
      keys.push(`failing:${since}`)
    } else {
      const own = ownParts(state.error ?? '', userId)
      if (own.length) {
        alerts.push(`Reactive grading alarm (stall check at ${iso(state.lastRunAt)}, red since ${since}): ${own.join(' ')}`.slice(0, ALERT_LIMIT) + footer)
        keys.push(`alarm:${since}`)
      }
    }
  }
  if (schedulesEnabled && (!state.lastFinishedAt || now.getTime() - state.lastFinishedAt.getTime() > REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000)) {
    alerts.push(`Reactive grading is unmonitored: no stall check has reached a verdict since ${iso(state.lastFinishedAt) ?? 'ever'}; the learner worker or its scheduler is down or stuck.`)
    keys.push(`unmonitored:${iso(state.lastFinishedAt) ?? 'never'}`)
  }
  return { alerts, key: keys.length ? keys.join('|') : null }
}

/**
 * The begin-turn packet plus this owner's grading alerts, read in parallel. A failed
 * alert read never blocks or fails the turn: it is reported through `onError` and the
 * packet goes out with no alerts.
 */
export async function withGradingAlerts<T extends object>(packet: Promise<T>, read: () => Promise<ReactiveGradingAlerts>, onError: (error: unknown) => void) {
  const [value, alerts] = await Promise.all([packet, read().catch((error: unknown): ReactiveGradingAlerts => { onError(error); return { alerts: [], key: null } })])
  return { ...value, alerts: alerts.alerts, alertKey: alerts.key }
}
