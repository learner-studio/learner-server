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
 *  - something is stuck (concepts blocked at the breaker, concepts retrying unpaid failures, exhausted
 *    arrivals) and DUE arrivals that came after it got stuck have gone unserved (no reactive reading since):
 *    for REACTIVE_STALL_HOURS of accumulated due-arrival time, or for REACTIVE_UNSERVED_BACKSTOP_HOURS of
 *    wall-clock time (a light learner, round-4 S4). A due arrival is work a working grader would serve: a
 *    user message, an arrival routed to at least one concept, or one not yet routed (pending or held).
 *    Assistant replies and backfill that matched no concept are not due (round-4 S1). Active time adds each
 *    gap between consecutive due arrivals capped at REACTIVE_ACTIVE_GAP_MINUTES, so short sessions add up
 *    across days. A night with no due arrival adds at most one cap; each due arrival overnight (a
 *    concept-matching backfill, say) still adds up to one cap (review B1, round-2 N-B1, round-3 R3-B1).
 *    A retry of a stuck item is never an arrival, so it is never its own evidence (R3-S1). With assessment
 *    off no reading can be produced, so only exhausted routing holds can go red, served by routing instead
 *    (round-4 S2). A manual reading serves nothing (round-4 T9);
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
/**
 * The longest gap between two learner arrivals that still counts as active time. On dev (60 days, 52,292
 * gaps) 99.6% of gaps are 30 min or shorter; a longer one is a break, and counts only this much.
 */
export const REACTIVE_ACTIVE_GAP_MINUTES = 30
/**
 * Stuck items plus a due arrival unserved this long (wall clock) is red however little the learner worked:
 * one prompt a day otherwise takes ~11 days to reach REACTIVE_STALL_HOURS of active time (round-4 S4). It
 * cannot fire for an idle learner (it needs a due arrival after the last reading) or a partial stall.
 */
export const REACTIVE_UNSERVED_BACKSTOP_HOURS = 48
/**
 * Items needing an operator that stay a warning (a partial stall: other concepts still read) are shown to the
 * person once they have been stuck this long, then every 24 h by the hook (round-4 S3). Three days: longer
 * than a weekend away from the machine, so an item blocked on Friday is not announced before anyone could look,
 * and short of the 12 days the 10-30 stall went unseen; on dev a total stall goes red within 0.3-2.7 d, so an
 * item still only a warning after 3 d is a partial stall the red path will never announce.
 */
export const REACTIVE_OPERATOR_REMINDER_DAYS = 3

export type ReactiveGradingHealth = z.infer<typeof ReactiveGradingHealth>

/** Stall-check workflow schemas. */
const OwnerHealth = ReactiveGradingHealth.extend({ userId: z.string() })
export const StallCheckInput = z.object({ userId: z.string().optional() })
export const StallCheckMeasured = z.object({ owners: z.array(OwnerHealth) })
export const StallCheckResult = z.object({ checked: z.number(), status: z.enum(['ok', 'warning', 'error']), messages: z.array(z.string()) })

export type ReactiveGradingHealthInput = {
  now: Date; enabled: boolean; assessmentEnabled: boolean; routingError: string | null
  routing: { waiting: number; oldestWaitingAt: Date | null; lastRoutedAt: Date | null; held: number; exhausted: number; oldestExhaustedAt: Date | null
    /** The oldest DUE arrival newer than both the oldest stuck item and the last service (reading, or route with assessment off), and the due-arrival time since it. */
    unservedSince: Date | null; unservedActiveMinutes: number }
  grading: { waiting: number; oldestWaitingAt: Date | null; running: number; lastSettledAt: Date | null; settledInWindow: number; lastReadingAt: Date | null
    blocked: number; blockedUnpaid: number; oldestBlockedAt: Date | null; retryingUnpaid: number; oldestRetryingAt: Date | null; unverifiedPasses: number }
  /** Omitted inside the stall check itself and where schedules are off. */
  stallCheck?: { lastFinishedAt: Date | null; lastStatus: string | null; failing?: string | null; activatedAt?: Date | null } | null
}

const iso = (d: Date | null) => d?.toISOString() ?? null
const hoursAgo = (now: Date, d: Date) => Math.round((now.getTime() - d.getTime()) / 36e5)
const oldest = (...dates: Array<Date | null>) => dates.filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null
const latest = (...dates: Array<Date | null>) => dates.filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
/** When the oldest item needing an operator got stuck; null when nothing is stuck. */
export const stuckSinceOf = (r: Pick<ReactiveGradingHealthInput['routing'], 'exhausted' | 'oldestExhaustedAt'>, g: Pick<ReactiveGradingHealthInput['grading'], 'blocked' | 'oldestBlockedAt' | 'retryingUnpaid' | 'oldestRetryingAt'>) =>
  oldest(r.exhausted ? r.oldestExhaustedAt : null, g.blocked ? g.oldestBlockedAt : null, g.retryingUnpaid ? g.oldestRetryingAt : null)
/**
 * The stuck items that can go red. With assessment off no reading can ever be produced, so blocked and
 * retrying concepts are left-overs that would read red forever; only exhausted routing holds count, served
 * by routing (round-4 S2).
 */
export const redStuckSinceOf = (assessmentEnabled: boolean, r: Parameters<typeof stuckSinceOf>[0], g: Parameters<typeof stuckSinceOf>[1]) =>
  assessmentEnabled ? stuckSinceOf(r, g) : (r.exhausted ? r.oldestExhaustedAt : null)

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
    const stuckSince = redStuckSinceOf(input.assessmentEnabled, r, g)
    if (actions.length) {
      // Due arrivals after the item got stuck; red once they went the bound of active time, or the backstop of wall clock, unserved.
      const backstop = r.unservedSince !== null && r.unservedSince.getTime() <= input.now.getTime() - REACTIVE_UNSERVED_BACKSTOP_HOURS * 36e5
      if (stuckSince && r.unservedSince && (r.unservedActiveMinutes >= stallHours * 60 || backstop))
        errors.push(`Grading stuck since ${stuckSince.toISOString()}: due arrivals since ${r.unservedSince.toISOString()} (${hoursAgo(input.now, r.unservedSince)} h ago) unserved for ${Math.round(r.unservedActiveMinutes / 6) / 10} h of active time (${input.assessmentEnabled ? lastReading : `assessment off, last route ${iso(r.lastRoutedAt) ?? 'never'}`}): ${actions.join('; ')}.`)
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
  // The watchdog runs from the later of the last verdict and the alarm's activation: a fresh install is not "unmonitored" (R3-N1).
  if (input.stallCheck && stale(latest(input.stallCheck.lastFinishedAt, input.stallCheck.activatedAt ?? null), input.now.getTime() - REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000))
    errors.push(`No reactive stall check has finished in ${REACTIVE_STALL_CHECK_WATCHDOG_MINUTES} min (last ${iso(input.stallCheck.lastFinishedAt) ?? 'never'}): the learner worker or its scheduler is down or stuck.`)
  return {
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok',
    checkedAt: input.now.toISOString(), stallHours, enabled: input.enabled, assessmentEnabled: input.assessmentEnabled,
    routing: { ...r, oldestWaitingAt: iso(r.oldestWaitingAt), lastRoutedAt: iso(r.lastRoutedAt), oldestExhaustedAt: iso(r.oldestExhaustedAt), unservedSince: iso(r.unservedSince), unservedActiveMinutes: r.unservedActiveMinutes, error: input.routingError },
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
/** Run errors are stored as `{"message":"…"}` (or plain text): both forms, matched at the START of the message only, in SQL and here (R3-N4). */
const VERDICT_PATTERNS = [`{"message":"${STALL_VERDICT_PREFIX}%`, `${STALL_VERDICT_PREFIX}%`]
const isVerdictError = (raw: string | null) => raw !== null && (raw.startsWith(`{"message":"${STALL_VERDICT_PREFIX}`) || raw.startsWith(STALL_VERDICT_PREFIX))
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
  const last = (await q<{ status: string; at: Date; error: string | null }>(`SELECT status,updated_at AS at,error FROM learner_workflow_runs
    WHERE workflow=$1 AND status IN ('completed','failed') ORDER BY created_at DESC LIMIT 1`, [STALL_CHECK_WORKFLOW])).rows[0]
  const verdict = (await q<{ at: Date }>(`SELECT updated_at AS at FROM learner_workflow_runs WHERE workflow=$1
    AND (status='completed' OR (status='failed' AND (error LIKE $2 OR error LIKE $3))) ORDER BY created_at DESC LIMIT 1`, [STALL_CHECK_WORKFLOW, ...VERDICT_PATTERNS])).rows[0]
  const message = runErrorMessage(last?.error ?? null)
  const crashed = last?.status === 'failed' && !isVerdictError(last.error)
  return { lastFinishedAt: verdict ? new Date(verdict.at) : null, lastStatus: last?.status ?? null, lastRunAt: last ? new Date(last.at) : null,
    error: message, failing: crashed ? message ?? 'failed with no error recorded' : null }
}

export async function readReactiveGradingHealth(userId: string, q: MetaPgQueryFn = defaultQuery, options: ReadOptions | Date = {}) {
  const { now = new Date(), stallCheck = false, stallHours = REACTIVE_STALL_HOURS } = options instanceof Date ? { now: options } : options
  const setting = (await q<{ enabled: boolean; config: { assessmentEnabled?: boolean }; revision: string; activated_at: Date; last_error: string | null }>(
    'SELECT enabled,config,revision,activated_at,last_error FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  const watchdog = stallCheck && setting?.enabled ? await readStallCheckState(q) : null
  const zero = { waiting: 0, oldestWaitingAt: null, lastRoutedAt: null, held: 0, exhausted: 0, oldestExhaustedAt: null, unservedSince: null, unservedActiveMinutes: 0 }
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
      -- A concept retrying unpaid failures is reported as stuck, not as waiting work: its own retries are never evidence (R3-S1).
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures<$4) AS waiting,
      min(COALESCE(waiting_since,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures<$4) AS oldest,
      count(*) FILTER(WHERE run_id IS NOT NULL) AS running,
      max(last_finished_at) AS settled,
      count(*) FILTER(WHERE last_finished_at>=$3) AS settled_recent,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts>=3) AS blocked,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts>=3 AND last_failure LIKE '%'||$2||'%') AS unpaid,
      min(COALESCE(last_failed_at,waiting_since,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts>=3) AS blocked_at,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures>=$4) AS retrying,
      min(COALESCE(waiting_since,last_notified_at)) FILTER(WHERE requested_generation>captured_generation AND attempts<3 AND unpaid_failures>=$4) AS retrying_at
    FROM learning_reactive_admission WHERE user_id=$1`, [userId, UNPAID_FAILURE_MARKER, windowStart, REACTIVE_STUCK_UNPAID_FAILURES])).rows[0]!
  // A manual reading is not reactive grading moving: it never serves a due arrival (round-4 T9).
  const reading = (await q<{ at: Date | null }>("SELECT max(completed_at) AS at FROM learning_mastery_readings WHERE user_id=$1 AND origin<>'manual'", [userId])).rows[0]?.at ?? null
  const unverified = (await q<{ n: Num }>(`SELECT count(*) AS n FROM learning_vector_turn_experiments WHERE user_id=$1 AND created_at>=$2
      AND config->>'purpose'='live' AND unverified_chunks>0`, [userId, windowStart])).rows[0]?.n ?? 0
  const date = (d: Date | string | null) => d === null ? null : new Date(d)
  const routingIn = { waiting: Number(routing.waiting), oldestWaitingAt: date(routing.oldest), lastRoutedAt: date(routing.routed), held: Number(routing.held), exhausted: Number(routing.exhausted), oldestExhaustedAt: date(routing.exhausted_at) }
  const gradingIn = { waiting: Number(grading.waiting), oldestWaitingAt: date(grading.oldest), running: Number(grading.running), lastSettledAt: date(grading.settled), settledInWindow: Number(grading.settled_recent),
    lastReadingAt: date(reading), blocked: Number(grading.blocked), blockedUnpaid: Number(grading.unpaid), oldestBlockedAt: date(grading.blocked_at),
    retryingUnpaid: Number(grading.retrying), oldestRetryingAt: date(grading.retrying_at), unverifiedPasses: Number(unverified) }
  const assessmentEnabled = setting.config.assessmentEnabled === true
  const served = latest(new Date(setting.activated_at), assessmentEnabled ? gradingIn.lastReadingAt : routingIn.lastRoutedAt)
  const unserved = await readUnservedArrivals(userId, redStuckSinceOf(assessmentEnabled, routingIn, gradingIn), served, q, now)
  return deriveReactiveGradingHealth({
    now, enabled: setting.enabled, assessmentEnabled, routingError: setting.last_error,
    routing: { ...routingIn, ...unserved }, grading: gradingIn,
    stallCheck: watchdog ? { lastFinishedAt: watchdog.lastFinishedAt, lastStatus: watchdog.lastStatus, failing: watchdog.failing, activatedAt: new Date(setting.activated_at) } : null,
  }, stallHours)
}

/**
 * Due work for stuck items: DUE arrivals newer than both the oldest stuck item and `lastServed` (the last
 * reactive reading, the last route with assessment off, or the alarm's activation), so every one is unserved.
 * An arrival is due when it is a user message, was routed to at least one of this owner's concepts, or has
 * not been routed for this owner (pending or held); an assistant reply or a backfill that matched nothing is
 * not (round-4 S1). Active time adds each gap between consecutive due arrivals, and the time since the last
 * one, capped at REACTIVE_ACTIVE_GAP_MINUTES. A retry of a stuck item writes no arrival, so it never counts.
 * User messages and unrouted arrivals carry no owner: on a multi-owner install they count for every owner.
 */
// LEAST ignores NULL, so the first arrival's NULL gap would count a whole cap: the FILTER is load-bearing.
export async function readUnservedArrivals(userId: string, stuckSince: Date | null, lastServed: Date | null, q: MetaPgQueryFn = defaultQuery, now = new Date()) {
  if (!stuckSince) return { unservedSince: null, unservedActiveMinutes: 0 }
  const row = (await q<{ since: Date | null; last: Date | null; gaps: string | number | null }>(`WITH a AS (
      SELECT a.created_at,a.created_at-lag(a.created_at) OVER(ORDER BY a.created_at) AS gap FROM learning_vector_arrivals a WHERE a.created_at>$1
        AND (EXISTS(SELECT 1 FROM learning_semantic_index_messages m WHERE m.message_id=a.message_id AND m.role='user')
          OR EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$3 AND r.event_id=a.event_id AND jsonb_array_length(COALESCE(r.matches->'conceptIds','[]'::jsonb))>0)
          OR NOT EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$3 AND r.event_id=a.event_id)))
    SELECT min(created_at) AS since,max(created_at) AS last,
      COALESCE(extract(epoch FROM sum(LEAST(gap,$2*interval '1 minute')) FILTER(WHERE gap IS NOT NULL)),0) AS gaps FROM a`, [latest(stuckSince, lastServed), REACTIVE_ACTIVE_GAP_MINUTES, userId])).rows[0]
  if (!row?.since || !row.last) return { unservedSince: null, unservedActiveMinutes: 0 }
  const tail = Math.min(Math.max(0, now.getTime() - new Date(row.last).getTime()) / 60_000, REACTIVE_ACTIVE_GAP_MINUTES)
  return { unservedSince: new Date(row.since), unservedActiveMinutes: Math.round(Number(row.gaps) / 60 + tail) }
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
/**
 * Splits "Reactive grading stalled: u1: m | u1: m | u2: m" into this owner's parts. A part starts only at a
 * segment naming a known owner, so a ` | ` inside a part (a routing cause such as `a | Error: x`) stays in it (round-4 N6).
 */
function ownParts(message: string, userId: string, owners: readonly string[]) {
  const parts: string[] = []
  const startsPart = (segment: string) => owners.some(owner => segment.startsWith(`${owner}: `))
  for (const segment of message.slice(STALL_VERDICT_PREFIX.length).split(' | ')) {
    if (startsPart(segment) || !parts.length) parts.push(segment)
    else parts[parts.length - 1] += ` | ${segment}`
  }
  return parts.filter(m => m.startsWith(`${userId}: `)).map(m => m.slice(userId.length + 2))
}

/**
 * What the learner's CLI sessions are told (as a user-visible hook system message)
 * while reactive grading is red: the last finished stall check failed for this
 * owner, the check itself is crashing (round-2 N-S1), or (where schedules run) no
 * check has reached a verdict within the watchdog window (review S2). Also, while
 * not red, items that have needed an operator for REACTIVE_OPERATOR_REMINDER_DAYS
 * (a partial stall that never goes red, round-4 S3). `key` names each state and when
 * it began (the first failed run since the last completed one; the oldest stuck item),
 * so the hook shows each state once, then every 24 h, instead of on every prompt
 * (round-2 N-S3).
 */
export async function readReactiveGradingAlerts(userId: string, schedulesEnabled: boolean, q: MetaPgQueryFn = defaultQuery, now = new Date()): Promise<ReactiveGradingAlerts> {
  const setting = (await q<{ enabled: boolean; activated_at: Date | null }>('SELECT enabled,activated_at FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  if (!setting?.enabled) return { alerts: [], key: null }
  const state = await readStallCheckState(q)
  const alerts: string[] = [], keys: string[] = []
  const footer = ' See the Learning page and docs/operations/reactive-grading-runbook.md.'
  const owners = (await q<{ user_id: string }>('SELECT user_id FROM learning_reactive_settings')).rows.map(o => o.user_id)
  let red = false
  if (state.lastStatus === 'failed') {
    const began = (await q<{ at: Date | null }>(`SELECT min(updated_at) AS at FROM learner_workflow_runs WHERE workflow=$1 AND status='failed'
      AND created_at>COALESCE((SELECT max(created_at) FROM learner_workflow_runs WHERE workflow=$1 AND status='completed'),'-infinity')`, [STALL_CHECK_WORKFLOW])).rows[0]?.at
    const since = iso(began ? new Date(began) : state.lastRunAt)
    if (state.failing) {
      alerts.push(`Reactive grading stall check is failing (last run at ${iso(state.lastRunAt)}, failing since ${since}): ${state.failing}`.slice(0, ALERT_LIMIT) + footer)
      keys.push(`failing:${since}`)
    } else {
      const own = ownParts(state.error ?? '', userId, owners)
      if (own.length) {
        red = true
        alerts.push(`Reactive grading alarm (stall check at ${iso(state.lastRunAt)}, red since ${since}): ${own.join(' ')}`.slice(0, ALERT_LIMIT) + footer)
        keys.push(`alarm:${since}`)
      }
    }
  }
  if (!red) {
    // A partial stall stays a warning forever; tell the person once it has lasted, keyed by the oldest stuck item.
    const health = await readReactiveGradingHealth(userId, q, now)
    const date = (d: string | null) => d === null ? null : new Date(d)
    const stuckSince = stuckSinceOf({ exhausted: health.routing.exhausted, oldestExhaustedAt: date(health.routing.oldestExhaustedAt) },
      { blocked: health.grading.blocked, oldestBlockedAt: date(health.grading.oldestBlockedAt), retryingUnpaid: health.grading.retryingUnpaid, oldestRetryingAt: date(health.grading.oldestRetryingAt) })
    const needs = health.messages.find(m => m.startsWith('Needs an operator: '))
    if (stuckSince && needs && now.getTime() - stuckSince.getTime() > REACTIVE_OPERATOR_REMINDER_DAYS * 864e5) {
      alerts.push(`Reactive grading has needed an operator since ${stuckSince.toISOString()} (${Math.floor((now.getTime() - stuckSince.getTime()) / 864e5)} d; other concepts may still be graded): ${needs.slice('Needs an operator: '.length)}`.slice(0, ALERT_LIMIT) + footer)
      keys.push(`stuck:${stuckSince.toISOString()}`)
    }
  }
  const watchedSince = latest(state.lastFinishedAt, setting.activated_at ? new Date(setting.activated_at) : null)
  if (schedulesEnabled && (!watchedSince || now.getTime() - watchedSince.getTime() > REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000)) {
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
