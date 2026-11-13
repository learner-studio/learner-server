import { z } from 'zod'
import { ReactiveGradingHealth } from '@learner/contract/learning/learning-grading-health.js'
export { ReactiveGradingHealth }
import { metaDbQuery as defaultQuery, type MetaPgQueryFn } from '../db-metadata/_shared.js'
import { UNPAID_FAILURE_MARKER } from './learning-archive-coordinator.js'
import { ATTEMPT_LEASE_MS, MAX_ATTEMPT_TAKEOVERS } from './llm-attempt-lease.js'

/**
 * Is reactive grading moving? 2026-10-30..11-11 no reading was produced for twelve
 * days while every surface looked quiet: routing failed into a log, and blocked
 * concepts showed as a count nobody read. Red (`error`, which fails the scheduled
 * stall-check run and reaches the learner's CLI sessions) when:
 *  - work has WAITED longer than REACTIVE_STALL_HOURS and nothing in that stage completed for as long, counted
 *    from the later of its last completion and the last switch-on: a backlog left from while Learning or
 *    assessment was off is not a stall the moment it is back (round-6 S1);
 *  - something is stuck (concepts blocked at the breaker, concepts retrying unpaid failures, exhausted
 *    arrivals) and DUE arrivals that came after it got stuck have gone unserved (no reactive reading and no
 *    settled pass since) for REACTIVE_STALL_HOURS of accumulated due-arrival time. A due arrival is one routed
 *    to at least one concept, or not yet routed (pending or held) under the current revision. A message that
 *    matched no concept is not grading work, whoever wrote it (round-4 S1, round-5 B1). Active time adds each
 *    gap between consecutive due arrivals capped at REACTIVE_ACTIVE_GAP_MINUTES, so short sessions add up
 *    across days. A night with no due arrival adds at most one cap; each due arrival overnight (a
 *    concept-matching backfill, say) still adds up to one cap (review B1, round-2 N-B1, round-3 R3-B1).
 *    A retry of a stuck item is never an arrival, so it is never its own evidence (R3-S1). With assessment
 *    off no reading can be produced, so only exhausted routing holds can go red, served by routing instead
 *    (round-4 S2). A manual reading serves nothing (round-4 T9). Service is floored at when Learning or
 *    assessment was last switched on, so switching it back on does not read old arrivals as unserved (round-5 S1);
 *  - the light-learner backstop (round-4 S4, keyed in round 5 B1): the oldest unserved arrival that is itself
 *    the stuck items' work (unrouted or held, or routed to a concept that is blocked or retrying) is
 *    REACTIVE_UNSERVED_BACKSTOP_HOURS old, AND the learner came back: another such arrival at least
 *    REACTIVE_BACKSTOP_RETURN_HOURS later has itself gone REACTIVE_STALL_HOURS unserved. An arrival at the end
 *    of a session is not evidence on its own: its pass can legitimately publish nothing, and nobody is
 *    waiting on it while the learner is away. A partial stall (other concepts still grade) goes red too when
 *    nothing at all was served in the window: one blocked concept that the learner's only prompts touched is
 *    genuinely ungraded work (round-6 nit N1);
 *  - passes keep settling (REACTIVE_NO_READING_MIN_SETTLED in the window) but no reading has been produced for REACTIVE_NO_READING_ERROR_HOURS (review S8);
 *  - the stall check itself has not reached a verdict for REACTIVE_STALL_CHECK_WATCHDOG_MINUTES (a dead worker,
 *    review S2), or its latest run crashed without one (round-2 review N-S1).
 * An idle pipeline (nothing waiting) is green. A warning (never red) when routing has matched no concept for
 * REACTIVE_NO_MATCH_HOURS over at least REACTIVE_NO_MATCH_MIN_ROUTED routes, against a history that matched (a
 * catalog/bank embedding mismatch, a threshold change, empty hits: readings stop and nothing waits or sticks;
 * round-6 S3). Not covered here: the hook not submitting, or the indexer down, produce no arrivals at all and
 * read idle (see the runbook).
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
 * The stuck items' own work unserved this long (wall clock) is red however little the learner worked: one
 * prompt a day otherwise takes ~11 days to reach REACTIVE_STALL_HOURS of active time (round-4 S4). Keyed to
 * arrivals the stuck items hold (round-5 B1): a message that matched nothing, or a matched one whose pass
 * published nothing, is the normal end of a session, and red from it read 38 h, 77 h and 7.5 d of false
 * alarm on dev history. Needs the learner to have come back (REACTIVE_BACKSTOP_RETURN_HOURS), so an idle
 * learner, however long away, never reads red from it; nor does a partial stall while any reading or settled
 * pass lands in the window (round-6 nit N1).
 */
export const REACTIVE_UNSERVED_BACKSTOP_HOURS = 48
/**
 * The backstop's "came back": a later stuck-item arrival at least this long after the oldest one (another
 * session, not the tail of the same one), itself unserved for REACTIVE_STALL_HOURS. Replayed on dev
 * 09-08..11-11 with every matched arrival counted as a stuck item's (the worst case): without it, 2 false
 * episodes; with it, none, and the 10-30 stall still red at 10-31 02:30.
 */
export const REACTIVE_BACKSTOP_RETURN_HOURS = 12
/**
 * Routing that matches nothing (round-6 S3): a warning when this owner's routes in the last REACTIVE_NO_MATCH_HOURS
 * number at least REACTIVE_NO_MATCH_MIN_ROUTED and none matched a concept, while the
 * REACTIVE_NO_MATCH_BASELINE_DAYS before them number at least as many and matched at least
 * REACTIVE_NO_MATCH_BASELINE_SHARE of the time. Replayed on dev 09-08..11-11 by route time: no warning for any
 * minimum of 10, 20 or 50 routes and any baseline share of 5, 10 or 20%; the lowest matched share of any 24 h
 * window with 20+ routes was 10.8% (10-23), and the longest run of unmatched routes 399. With every route made
 * to match nothing from 10-21, 10-27 or 11-10 12:00, it warns 23.0, 20.8 and 13.2 h later. The baseline is 30
 * days, not 7, because the 10-30 outage left a week with no routes at all.
 */
export const REACTIVE_NO_MATCH_HOURS = 24
export const REACTIVE_NO_MATCH_MIN_ROUTED = 20
export const REACTIVE_NO_MATCH_BASELINE_DAYS = 30
export const REACTIVE_NO_MATCH_BASELINE_SHARE = 0.05
/** The no-match warning starts with this; the alerts reader finds it by it (round-7 R7-S1). */
const NO_MATCH_PREFIX = 'Routing matched no concept: '
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
    /** The oldest DUE arrival newer than both the oldest stuck item and the last service (reading or settled pass, or route with assessment off), and the due-arrival time since it. */
    unservedSince: Date | null; unservedActiveMinutes: number
    /** Of those, the oldest that is the stuck items' own work, and the newest such one at least the stall bound old (the backstop). */
    stuckUnservedSince: Date | null; stuckReturnedAt: Date | null }
  grading: { waiting: number; oldestWaitingAt: Date | null; running: number; lastSettledAt: Date | null; settledInWindow: number; lastReadingAt: Date | null
    blocked: number; blockedUnpaid: number; oldestBlockedAt: Date | null; retryingUnpaid: number; oldestRetryingAt: Date | null; unverifiedPasses: number; stoppedAttempts: number }
  /** When Learning or assessment was last switched on: the waiting rules count no stall from before it (round-6 S1). */
  switchedOnAt?: Date | null
  /** This owner's routes in the last REACTIVE_NO_MATCH_HOURS and in the baseline before them, and how many matched a concept (round-6 S3). */
  matching?: { routed: number; matched: number; baselineRouted: number; baselineMatched: number } | null
  /** Omitted inside the stall check itself and where schedules are off. */
  stallCheck?: { lastFinishedAt: Date | null; lastStatus: string | null; failing?: string | null; activatedAt?: Date | null } | null
}

const iso = (d: Date | null) => d?.toISOString() ?? null
const hoursAgo = (now: Date, d: Date) => Math.round((now.getTime() - d.getTime()) / 36e5)
const oldest = (...dates: Array<Date | null>) => dates.filter((d): d is Date => d !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null
const latest = (...dates: Array<Date | null>) => dates.filter((d): d is Date => d !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null
/** When the oldest item needing an operator got stuck; null when nothing is stuck. */
const stuckSinceOf = (r: Pick<ReactiveGradingHealthInput['routing'], 'exhausted' | 'oldestExhaustedAt'>, g: Pick<ReactiveGradingHealthInput['grading'], 'blocked' | 'oldestBlockedAt' | 'retryingUnpaid' | 'oldestRetryingAt'>) =>
  oldest(r.exhausted ? r.oldestExhaustedAt : null, g.blocked ? g.oldestBlockedAt : null, g.retryingUnpaid ? g.oldestRetryingAt : null)
/**
 * The stuck items that can go red. With assessment off no reading can ever be produced, so blocked and
 * retrying concepts are left-overs that would read red forever; only exhausted routing holds count, served
 * by routing (round-4 S2).
 */
const redStuckSinceOf = (assessmentEnabled: boolean, r: Parameters<typeof stuckSinceOf>[0], g: Parameters<typeof stuckSinceOf>[1]) =>
  assessmentEnabled ? stuckSinceOf(r, g) : (r.exhausted ? r.oldestExhaustedAt : null)

export function deriveReactiveGradingHealth(input: ReactiveGradingHealthInput, stallHours = REACTIVE_STALL_HOURS): ReactiveGradingHealth {
  const cutoff = input.now.getTime() - stallHours * 36e5
  const stale = (d: Date | null, before = cutoff) => d === null || d.getTime() < before
  const errors: string[] = [], warnings: string[] = []
  const r = input.routing, g = input.grading
  const lastReading = `last reading ${iso(g.lastReadingAt) ?? 'never'}`
  if (input.enabled) {
    // Counted from the later of the last completion and the last switch-on (round-6 S1).
    const floor = input.switchedOnAt ?? null
    if (r.waiting > 0 && r.oldestWaitingAt && r.oldestWaitingAt.getTime() < cutoff && stale(latest(r.lastRoutedAt, floor)))
      errors.push(`Routing stalled: ${r.waiting} indexed arrivals waiting since ${r.oldestWaitingAt.toISOString()}, no batch routed in ${r.lastRoutedAt ? hoursAgo(input.now, r.lastRoutedAt) : 'any'} h${input.routingError ? ` (${input.routingError})` : ''}.`)
    if (input.assessmentEnabled && g.waiting > 0 && g.oldestWaitingAt && g.oldestWaitingAt.getTime() < cutoff && stale(latest(g.lastSettledAt, floor)))
      errors.push(`Grading stalled: ${g.waiting} concepts waiting since ${g.oldestWaitingAt.toISOString()}, no pass settled in ${g.lastSettledAt ? hoursAgo(input.now, g.lastSettledAt) : 'any'} h (${lastReading}).`)
    const actions = [
      r.exhausted ? `${r.exhausted} arrivals exhausted their routing retries (inspect getLearningReactiveConsolidation holds; accept chunks flagged as having text with acceptLearningVectorlessChunks, then run the reactive recovery or releaseLearningReactiveHolds)` : '',
      g.blockedUnpaid ? `${g.blockedUnpaid} concepts blocked before any paid call (run the reactive recovery)` : '',
      g.blocked - g.blockedUnpaid ? `${g.blocked - g.blockedUnpaid} concepts blocked after a paid call (review their paid receipts, then retryLearningReactiveTarget)` : '',
      g.retryingUnpaid ? `${g.retryingUnpaid} concepts failing before any paid call ${REACTIVE_STUCK_UNPAID_FAILURES}+ times in a row (read their last_failure; they retry every hour)` : '',
      g.stoppedAttempts ? `${g.stoppedAttempts} model calls stopped for review after ${MAX_ATTEMPT_TAKEOVERS} takeovers (their worker died every time; read learning_llm_attempt_leases and learning_llm_attempt_reclaims)` : '',
    ].filter(Boolean)
    const stuckSince = redStuckSinceOf(input.assessmentEnabled, r, g)
    if (actions.length) {
      // Due arrivals after the item got stuck; red once they went the bound of active time unserved, or (the backstop)
      // the stuck items' own work went the wall-clock bound unserved and the learner came back to more of it.
      const backstop = r.stuckUnservedSince !== null && r.stuckReturnedAt !== null
        && r.stuckUnservedSince.getTime() <= input.now.getTime() - REACTIVE_UNSERVED_BACKSTOP_HOURS * 36e5
        && r.stuckReturnedAt.getTime() - r.stuckUnservedSince.getTime() >= REACTIVE_BACKSTOP_RETURN_HOURS * 36e5
      if (stuckSince && r.unservedSince && (r.unservedActiveMinutes >= stallHours * 60 || backstop))
        errors.push(`Grading stuck since ${stuckSince.toISOString()}: due arrivals since ${r.unservedSince.toISOString()} (${hoursAgo(input.now, r.unservedSince)} h ago) unserved for ${Math.round(r.unservedActiveMinutes / 6) / 10} h of active time${backstop ? `, the stuck items' own arrivals unserved since ${r.stuckUnservedSince!.toISOString()}` : ''} (${input.assessmentEnabled ? `${lastReading}, last settled pass ${iso(g.lastSettledAt) ?? 'never'}` : `assessment off, last route ${iso(r.lastRoutedAt) ?? 'never'}`}): ${actions.join('; ')}.`)
      else warnings.push(`Needs an operator: ${actions.join('; ')}.`)
    }
    if (input.assessmentEnabled && g.settledInWindow >= REACTIVE_NO_READING_MIN_SETTLED && stale(latest(g.lastReadingAt, floor))) {
      const message = `${g.settledInWindow} concepts settled in the last ${stallHours} h but no reading was produced (${lastReading}): passes are ending without a publishable estimate.`
      if (stale(latest(g.lastReadingAt, floor), input.now.getTime() - REACTIVE_NO_READING_ERROR_HOURS * 36e5)) errors.push(message)
      else warnings.push(message)
    }
    const m = input.matching
    if (m && m.routed >= REACTIVE_NO_MATCH_MIN_ROUTED && m.matched === 0 && m.baselineRouted >= REACTIVE_NO_MATCH_MIN_ROUTED
      && m.baselineMatched >= REACTIVE_NO_MATCH_BASELINE_SHARE * m.baselineRouted)
      warnings.push(`${NO_MATCH_PREFIX}${m.routed} arrivals routed in the last ${REACTIVE_NO_MATCH_HOURS} h, none to a concept, against ${Math.round(100 * m.baselineMatched / m.baselineRouted)}% of ${m.baselineRouted} in the ${REACTIVE_NO_MATCH_BASELINE_DAYS} d before (a catalog or bank embedding mismatch, a threshold change, or empty hits: no reading can follow).`)
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
    routing: { ...r, matching: input.matching ?? null, oldestWaitingAt: iso(r.oldestWaitingAt), lastRoutedAt: iso(r.lastRoutedAt), oldestExhaustedAt: iso(r.oldestExhaustedAt), unservedSince: iso(r.unservedSince), unservedActiveMinutes: r.unservedActiveMinutes,
      stuckUnservedSince: iso(r.stuckUnservedSince), stuckReturnedAt: iso(r.stuckReturnedAt), error: input.routingError },
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
  const setting = (await q<{ enabled: boolean; config: { assessmentEnabled?: boolean; switchedOnAt?: string; purgedLastSettledAt?: string | null; purgedLastReadingAt?: string | null }; revision: string; activated_at: Date; last_error: string | null }>(
    'SELECT enabled,config,revision,activated_at,last_error FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  const watchdog = stallCheck && setting?.enabled ? await readStallCheckState(q) : null
  const zero = { waiting: 0, oldestWaitingAt: null, lastRoutedAt: null, held: 0, exhausted: 0, oldestExhaustedAt: null, unservedSince: null, unservedActiveMinutes: 0, stuckUnservedSince: null, stuckReturnedAt: null }
  if (!setting) return deriveReactiveGradingHealth({ now, enabled: false, assessmentEnabled: false, routingError: null, routing: zero,
    grading: { waiting: 0, oldestWaitingAt: null, running: 0, lastSettledAt: null, settledInWindow: 0, lastReadingAt: null, blocked: 0, blockedUnpaid: 0, oldestBlockedAt: null, retryingUnpaid: 0, oldestRetryingAt: null, unverifiedPasses: 0, stoppedAttempts: 0 } }, stallHours)
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
  // A pass that only repeats the published one (LearningVectorTurnService.withoutRepeats) stores no reading, but it
  // republishes that estimate exactly as the 'unchanged' reading it replaced did: it counts as one. Only passes with
  // no part are read (small snapshots), back as far as the no-reading rule looks.
  const reading = (await q<{ at: Date | null }>(`SELECT GREATEST((SELECT max(completed_at) FROM learning_mastery_readings WHERE user_id=$1 AND origin<>'manual'),
      (SELECT max(e.finished_at) FROM learning_vector_turn_experiments e WHERE e.user_id=$1 AND e.config->>'purpose'='live' AND e.status='completed' AND e.created_at>=$2
        AND CASE WHEN NOT EXISTS(SELECT 1 FROM learning_vector_turn_assessments a WHERE a.experiment_id=e.run_id) THEN e.snapshot->'selections'->0 ? 'unchangedFrom' END)) AS at`,
    [userId, new Date(now.getTime() - Math.max(stallHours, REACTIVE_NO_READING_ERROR_HOURS) * 36e5)])).rows[0]?.at ?? null
  const unverified = (await q<{ n: Num }>(`SELECT count(*) AS n FROM learning_vector_turn_experiments WHERE user_id=$1 AND created_at>=$2
      AND config->>'purpose'='live' AND unverified_chunks>0`, [userId, windowStart])).rows[0]?.n ?? 0
  // The restart-safe lease's own "needs an operator" state (llm-attempt-lease.ts): an unfinished attempt whose takeover
  // budget is spent is never retried by itself. Live and repairable leases are not counted: they heal without anyone.
  // The last takeover's own owner holds takeovers=MAX for its whole call, so a spent lease counts only once its heartbeat
  // is older than the lease (the store's own `stale` test); a live owner beats every few seconds (R10-S1).
  // The second key part is the run id for 'assessment:' and 'replicate:' keys; a 'drift:<user>:…' key joins no run.
  const stopped = (await q<{ n: Num }>(`SELECT count(*) AS n FROM learning_llm_attempt_leases l JOIN learning_concept_assessment_runs r
      ON r.run_id=split_part(l.attempt_key,':',2) WHERE l.finished_at IS NULL AND l.takeovers>=$2 AND r.user_id=$1
      AND l.heartbeat_at < now() - make_interval(secs => $3::double precision / 1000)`,
    [userId, MAX_ATTEMPT_TAKEOVERS, ATTEMPT_LEASE_MS()])).rows[0]?.n ?? 0
  const date = (d: Date | string | null | undefined) => d === null || d === undefined ? null : new Date(d)
  const matchingRow = (await q<{ routed: Num; matched: Num; baseline_routed: Num; baseline_matched: Num }>(`SELECT
      count(*) FILTER(WHERE routed_at>$2) AS routed,
      count(*) FILTER(WHERE routed_at>$2 AND jsonb_array_length(COALESCE(matches->'conceptIds','[]'::jsonb))>0) AS matched,
      count(*) FILTER(WHERE routed_at<=$2) AS baseline_routed,
      count(*) FILTER(WHERE routed_at<=$2 AND jsonb_array_length(COALESCE(matches->'conceptIds','[]'::jsonb))>0) AS baseline_matched
    FROM learning_reactive_routes WHERE user_id=$1 AND routed_at>$3 AND routed_at<=$4`,
    [userId, new Date(now.getTime() - REACTIVE_NO_MATCH_HOURS * 36e5), new Date(now.getTime() - REACTIVE_NO_MATCH_HOURS * 36e5 - REACTIVE_NO_MATCH_BASELINE_DAYS * 864e5), now])).rows[0]
  const matching = { routed: Number(matchingRow?.routed ?? 0), matched: Number(matchingRow?.matched ?? 0), baselineRouted: Number(matchingRow?.baseline_routed ?? 0), baselineMatched: Number(matchingRow?.baseline_matched ?? 0) }
  const routingIn = { waiting: Number(routing.waiting), oldestWaitingAt: date(routing.oldest), lastRoutedAt: date(routing.routed), held: Number(routing.held), exhausted: Number(routing.exhausted), oldestExhaustedAt: date(routing.exhausted_at) }
  const gradingIn = { waiting: Number(grading.waiting), oldestWaitingAt: date(grading.oldest), running: Number(grading.running), lastSettledAt: latest(date(grading.settled), date(setting.config.purgedLastSettledAt)), settledInWindow: Number(grading.settled_recent),
    // A curriculum purge deletes the purged concepts' admission rows and readings; the latest of each is kept in the config (round-6 nit N4).
    lastReadingAt: latest(date(reading), date(setting.config.purgedLastReadingAt)), blocked: Number(grading.blocked), blockedUnpaid: Number(grading.unpaid), oldestBlockedAt: date(grading.blocked_at),
    retryingUnpaid: Number(grading.retrying), oldestRetryingAt: date(grading.retrying_at), unverifiedPasses: Number(unverified), stoppedAttempts: Number(stopped) }
  const assessmentEnabled = setting.config.assessmentEnabled === true
  // A settled pass is service too: one with no new evidence legitimately publishes nothing (round-5 B1; settling
  // without readings has its own rule). Floored at the last switch-on, so arrivals from while it was off are not owed (round-5 S1).
  const served = latest(switchedOnAt(setting), assessmentEnabled ? latest(gradingIn.lastReadingAt, gradingIn.lastSettledAt) : routingIn.lastRoutedAt)
  const unserved = await readUnservedArrivals(userId, { stuckSince: redStuckSinceOf(assessmentEnabled, routingIn, gradingIn), lastServed: served, revision: setting.revision, assessmentEnabled, graceHours: stallHours }, q, now)
  return deriveReactiveGradingHealth({
    now, enabled: setting.enabled, assessmentEnabled, routingError: setting.last_error, switchedOnAt: switchedOnAt(setting), matching,
    routing: { ...routingIn, ...unserved }, grading: gradingIn,
    stallCheck: watchdog ? { lastFinishedAt: watchdog.lastFinishedAt, lastStatus: watchdog.lastStatus, failing: watchdog.failing, activatedAt: new Date(setting.activated_at) } : null,
  }, stallHours)
}

/**
 * When Learning or assessment was last switched on: `configureReactive` stamps `config.switchedOnAt` on a
 * false→true flip of either; `activated_at` (the first insert) for a row never switched since (round-5 S1).
 */
export const switchedOnAt = (setting: { activated_at: Date | string; config: { switchedOnAt?: string } }) =>
  latest(new Date(setting.activated_at), setting.config.switchedOnAt ? new Date(setting.config.switchedOnAt) : null)

/** `graceHours`: how old the backstop's "came back" arrival must be (the caller's stall bound, REACTIVE_STALL_HOURS by default). */
type UnservedBounds = { stuckSince: Date | null; lastServed: Date | null; revision: string; assessmentEnabled: boolean; graceHours?: number }
const NOTHING_UNSERVED = { unservedSince: null, unservedActiveMinutes: 0, stuckUnservedSince: null, stuckReturnedAt: null }
/**
 * Due work for stuck items: DUE arrivals newer than both the oldest stuck item and `lastServed` (the last
 * reactive reading or settled pass, the last route with assessment off, or the last switch-on), so every one
 * is unserved. An arrival is due when it was routed to at least one of this owner's concepts, or has not been
 * routed for this owner under the current revision (pending or held); one that matched nothing is not grading
 * work, whoever wrote it (round-4 S1, round-5 B1). Active time adds each gap between consecutive due arrivals,
 * and the time since the last one, capped at REACTIVE_ACTIVE_GAP_MINUTES. A retry of a stuck item writes no
 * arrival, so it never counts. Unrouted arrivals carry no owner: on a multi-owner install they count for every owner.
 *
 * The backstop's pair (round-5 B1): of those, the oldest that is the stuck items' own work (unrouted or held,
 * or, with assessment on, routed to a concept whose admission row is blocked or retrying), and the newest such
 * one that is at least `graceHours` (the stall bound) old by `now`.
 */
// LEAST ignores NULL, so the first arrival's NULL gap would count a whole cap: the FILTER is load-bearing.
export async function readUnservedArrivals(userId: string, bounds: UnservedBounds, q: MetaPgQueryFn = defaultQuery, now = new Date()) {
  if (!bounds.stuckSince) return NOTHING_UNSERVED
  const row = (await q<{ since: Date | null; last: Date | null; gaps: string | number | null; stuck_since: Date | null; stuck_returned: Date | null }>(`WITH d AS (
      SELECT a.created_at,r.event_id IS NULL AS unrouted,COALESCE(r.matches->'conceptIds','[]'::jsonb) AS concepts FROM learning_vector_arrivals a
        LEFT JOIN LATERAL (SELECT r.event_id,r.matches FROM learning_reactive_routes r WHERE r.user_id=$3 AND r.event_id=a.event_id AND r.revision=$4 LIMIT 1) r ON true
      WHERE a.created_at>$1),
    due AS (SELECT created_at,unrouted OR ($6::boolean AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(concepts) c(id)
        JOIN learning_reactive_targets t ON t.user_id=$3 AND t.concept_id=c.id
        JOIN learning_reactive_admission ad ON ad.user_id=t.user_id AND ad.session_id=t.session_id
        WHERE ad.requested_generation>ad.captured_generation AND (ad.attempts>=3 OR ad.unpaid_failures>=$7::int))) AS stuck,
      created_at-lag(created_at) OVER(ORDER BY created_at) AS gap
      FROM d WHERE unrouted OR jsonb_array_length(concepts)>0)
    SELECT min(created_at) AS since,max(created_at) AS last,
      COALESCE(extract(epoch FROM sum(LEAST(gap,$2*interval '1 minute')) FILTER(WHERE gap IS NOT NULL)),0) AS gaps,
      min(created_at) FILTER(WHERE stuck) AS stuck_since,max(created_at) FILTER(WHERE stuck AND created_at<=$5) AS stuck_returned FROM due`,
    [latest(bounds.stuckSince, bounds.lastServed), REACTIVE_ACTIVE_GAP_MINUTES, userId, bounds.revision, new Date(now.getTime() - (bounds.graceHours ?? REACTIVE_STALL_HOURS) * 36e5), bounds.assessmentEnabled, REACTIVE_STUCK_UNPAID_FAILURES])).rows[0]
  if (!row?.since || !row.last) return NOTHING_UNSERVED
  const tail = Math.min(Math.max(0, now.getTime() - new Date(row.last).getTime()) / 60_000, REACTIVE_ACTIVE_GAP_MINUTES)
  const date = (d: Date | string | null) => d === null ? null : new Date(d)
  return { unservedSince: new Date(row.since), unservedActiveMinutes: Math.round(Number(row.gaps) / 60 + tail), stuckUnservedSince: date(row.stuck_since), stuckReturnedAt: date(row.stuck_returned) }
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
 * not red, items that have needed an operator for more than REACTIVE_OPERATOR_REMINDER_DAYS
 * (a partial stall that usually never goes red, round-4 S3; assessment-off left-overs too, they need an operator
 * as much), and routing that matches no concept (round-7 R7-S1), read from a stall-check measurement at most REACTIVE_STALL_CHECK_WATCHDOG_MINUTES old (round-5 S2). `key` names each state and when
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
    // A partial stall usually stays a warning; tell the person once it has lasted, keyed by the oldest stuck item.
    // Read from the stall check's latest measurement (every 15 min), not measured again on every prompt (~0.5 s on dev),
    // and only a fresh one: an old one may name items cleared since, and nothing else flags it where schedules are off (round-5 S2).
    const health = await readLatestMeasurement(userId, q, new Date(now.getTime() - REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000))
    const date = (d: string | null) => d === null ? null : new Date(d)
    const stuckSince = health && stuckSinceOf({ exhausted: health.routing.exhausted, oldestExhaustedAt: date(health.routing.oldestExhaustedAt) },
      { blocked: health.grading.blocked, oldestBlockedAt: date(health.grading.oldestBlockedAt), retryingUnpaid: health.grading.retryingUnpaid, oldestRetryingAt: date(health.grading.oldestRetryingAt) })
    const needs = health?.messages.find(m => m.startsWith('Needs an operator: '))
    if (health && stuckSince && needs && now.getTime() - stuckSince.getTime() > REACTIVE_OPERATOR_REMINDER_DAYS * 864e5) {
      alerts.push(`Reactive grading has needed an operator since ${stuckSince.toISOString()} (${((now.getTime() - stuckSince.getTime()) / 864e5).toFixed(1)} d; other concepts may still be graded): ${needs.slice('Needs an operator: '.length)}`.slice(0, ALERT_LIMIT) + footer)
      keys.push(`stuck:${stuckSince.toISOString()}`)
    }
    // A matcher that matches nothing stops every reading and never fails a check: tell the person at once, then
    // every 24 h while it lasts (the hook's reminder for an unchanged key). Round-7 R7-S1.
    const noMatch = health?.messages.find(m => m.startsWith(NO_MATCH_PREFIX))
    if (noMatch) {
      alerts.push(`Reactive grading: ${noMatch}`.slice(0, ALERT_LIMIT) + footer)
      keys.push('nomatch')
    }
  }
  const watchedSince = latest(state.lastFinishedAt, setting.activated_at ? new Date(setting.activated_at) : null)
  if (schedulesEnabled && (!watchedSince || now.getTime() - watchedSince.getTime() > REACTIVE_STALL_CHECK_WATCHDOG_MINUTES * 60_000)) {
    alerts.push(`Reactive grading is unmonitored: no stall check has reached a verdict since ${iso(state.lastFinishedAt) ?? 'ever'}; the learner worker or its scheduler is down or stuck.`)
    keys.push(`unmonitored:${iso(state.lastFinishedAt) ?? 'never'}`)
  }
  return { alerts, key: keys.length ? keys.join('|') : null }
}

/** The stall-check workflow's measure step (its name in learning-reactive-health.workflow.ts; a test pins the two). */
export const REACTIVE_MEASURE_STEP = 'Measure reactive grading progress'
/** This owner's health as the latest stall check started at or after `since` measured it (its measure step succeeded); null when none did. */
export async function readLatestMeasurement(userId: string, q: MetaPgQueryFn = defaultQuery, since: Date | null = null) {
  const row = (await q<{ result: string | null }>(`SELECT s.result FROM learner_workflow_runs r JOIN learner_workflow_steps s USING(workflow_run_id)
    WHERE r.workflow=$1 AND s.step_name=$2 AND s.status IN ('succeeded','completed') AND r.created_at>=COALESCE($3::timestamptz,'-infinity')
    ORDER BY r.created_at DESC LIMIT 1`, [STALL_CHECK_WORKFLOW, REACTIVE_MEASURE_STEP, since])).rows[0]
  if (!row?.result) return null
  let value: unknown
  try { value = JSON.parse(row.result) } catch { return null }
  const parsed = StallCheckMeasured.safeParse(value)
  return parsed.success ? parsed.data.owners.find(owner => owner.userId === userId) ?? null : null
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
