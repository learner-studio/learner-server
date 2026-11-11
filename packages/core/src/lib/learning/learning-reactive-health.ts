import { z } from 'zod'
import { ReactiveGradingHealth } from '@learner/contract/learning/learning-grading-health.js'
export { ReactiveGradingHealth }
import { metaDbQuery as defaultQuery, type MetaPgQueryFn } from '../db-metadata/_shared.js'

/**
 * Is reactive grading moving? 2026-10-30..11-11 no reading was produced for twelve
 * days while every surface looked quiet: routing failed once a minute into a log,
 * and blocked concepts showed as a count nobody read. This signal turns red when
 * work has been WAITING longer than REACTIVE_STALL_HOURS and nothing in that stage
 * completed for as long. An idle pipeline (nothing waiting) is green.
 */
export const REACTIVE_STALL_HOURS = 6

export type ReactiveGradingHealth = z.infer<typeof ReactiveGradingHealth>

/** Stall-check workflow schemas. */
const OwnerHealth = ReactiveGradingHealth.extend({ userId: z.string() })
export const StallCheckInput = z.object({ userId: z.string().optional() })
export const StallCheckMeasured = z.object({ owners: z.array(OwnerHealth) })
export const StallCheckResult = z.object({ checked: z.number(), status: z.enum(['ok', 'warning', 'error']), messages: z.array(z.string()) })

export type ReactiveGradingHealthInput = {
  now: Date; enabled: boolean; assessmentEnabled: boolean; routingError: string | null
  routing: { waiting: number; oldestWaitingAt: Date | null; lastRoutedAt: Date | null; held: number; exhausted: number }
  grading: { waiting: number; oldestWaitingAt: Date | null; running: number; lastSettledAt: Date | null; lastReadingAt: Date | null; blocked: number; blockedUnpaid: number }
}

const iso = (d: Date | null) => d?.toISOString() ?? null
const hoursAgo = (now: Date, d: Date) => Math.round((now.getTime() - d.getTime()) / 36e5)

export function deriveReactiveGradingHealth(input: ReactiveGradingHealthInput, stallHours = REACTIVE_STALL_HOURS): ReactiveGradingHealth {
  const cutoff = input.now.getTime() - stallHours * 36e5
  const stale = (d: Date | null) => d === null || d.getTime() < cutoff
  const errors: string[] = [], warnings: string[] = []
  if (input.enabled) {
    const r = input.routing
    if (r.waiting > 0 && r.oldestWaitingAt && r.oldestWaitingAt.getTime() < cutoff && stale(r.lastRoutedAt))
      errors.push(`Routing stalled: ${r.waiting} indexed arrivals waiting since ${r.oldestWaitingAt.toISOString()}, no batch routed in ${r.lastRoutedAt ? hoursAgo(input.now, r.lastRoutedAt) : 'any'} h${input.routingError ? ` (${input.routingError})` : ''}.`)
    const g = input.grading
    if (input.assessmentEnabled && g.waiting > 0 && g.oldestWaitingAt && g.oldestWaitingAt.getTime() < cutoff && stale(g.lastSettledAt))
      errors.push(`Grading stalled: ${g.waiting} concepts waiting since ${g.oldestWaitingAt.toISOString()}, no pass settled in ${g.lastSettledAt ? hoursAgo(input.now, g.lastSettledAt) : 'any'} h (last reading ${iso(g.lastReadingAt) ?? 'never'}).`)
    if (r.exhausted) warnings.push(`${r.exhausted} arrivals exhausted their routing retries; inspect getLearningReactiveConsolidation holds, then releaseLearningReactiveHolds.`)
    if (g.blocked) warnings.push(`${g.blocked} concepts blocked at the retry breaker (${g.blockedUnpaid} failed before any paid call); run the reactive recovery.`)
    if (input.routingError && !errors.length) warnings.push(`Last routing error: ${input.routingError}`)
  }
  return {
    status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok',
    checkedAt: input.now.toISOString(), stallHours, enabled: input.enabled, assessmentEnabled: input.assessmentEnabled,
    routing: { ...input.routing, oldestWaitingAt: iso(input.routing.oldestWaitingAt), lastRoutedAt: iso(input.routing.lastRoutedAt), error: input.routingError },
    grading: { ...input.grading, oldestWaitingAt: iso(input.grading.oldestWaitingAt), lastSettledAt: iso(input.grading.lastSettledAt), lastReadingAt: iso(input.grading.lastReadingAt) },
    messages: [...errors, ...warnings],
  }
}

/** Unpaid failures carry this marker in last_failure (learning-archive-coordinator.ts). */
export const UNPAID_FAILURE_MARKER = 'before any paid model call'

type Num = string | number | null
export async function readReactiveGradingHealth(userId: string, q: MetaPgQueryFn = defaultQuery, now = new Date()) {
  const setting = (await q<{ enabled: boolean; config: { assessmentEnabled?: boolean }; revision: string; activated_at: Date; last_error: string | null }>(
    'SELECT enabled,config,revision,activated_at,last_error FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  const zero = { waiting: 0, oldestWaitingAt: null, lastRoutedAt: null, held: 0, exhausted: 0 }
  if (!setting) return deriveReactiveGradingHealth({ now, enabled: false, assessmentEnabled: false, routingError: null, routing: zero,
    grading: { waiting: 0, oldestWaitingAt: null, running: 0, lastSettledAt: null, lastReadingAt: null, blocked: 0, blockedUnpaid: 0 } })
  const routing = (await q<{ waiting: Num; oldest: Date | null; routed: Date | null; held: Num; exhausted: Num }>(`SELECT
      (SELECT count(*) FROM learning_vector_arrivals a WHERE a.created_at>=$2
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$1 AND r.event_id=a.event_id AND r.revision=$3)
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND h.event_id=a.event_id AND h.revision=$3)) AS waiting,
      (SELECT min(a.created_at) FROM learning_vector_arrivals a WHERE a.created_at>=$2
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$1 AND r.event_id=a.event_id AND r.revision=$3)
        AND NOT EXISTS(SELECT 1 FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND h.event_id=a.event_id AND h.revision=$3)) AS oldest,
      (SELECT max(routed_at) FROM learning_reactive_routes WHERE user_id=$1) AS routed,
      (SELECT count(*) FROM learning_reactive_route_holds WHERE user_id=$1 AND revision=$3 AND next_attempt_at IS NOT NULL) AS held,
      (SELECT count(*) FROM learning_reactive_route_holds WHERE user_id=$1 AND revision=$3 AND next_attempt_at IS NULL) AS exhausted`,
    [userId, setting.activated_at, setting.revision])).rows[0]!
  const grading = (await q<{ waiting: Num; oldest: Date | null; running: Num; settled: Date | null; blocked: Num; unpaid: Num }>(`SELECT
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts<3) AS waiting,
      min(last_notified_at) FILTER(WHERE requested_generation>captured_generation AND attempts<3) AS oldest,
      count(*) FILTER(WHERE run_id IS NOT NULL) AS running,
      max(last_finished_at) AS settled,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts>=3) AS blocked,
      count(*) FILTER(WHERE requested_generation>captured_generation AND attempts>=3 AND last_failure LIKE '%'||$2||'%') AS unpaid
    FROM learning_reactive_admission WHERE user_id=$1`, [userId, UNPAID_FAILURE_MARKER])).rows[0]!
  const reading = (await q<{ at: Date | null }>('SELECT max(completed_at) AS at FROM learning_mastery_readings WHERE user_id=$1', [userId])).rows[0]?.at ?? null
  const date = (d: Date | string | null) => d === null ? null : new Date(d)
  return deriveReactiveGradingHealth({
    now, enabled: setting.enabled, assessmentEnabled: setting.config.assessmentEnabled === true, routingError: setting.last_error,
    routing: { waiting: Number(routing.waiting), oldestWaitingAt: date(routing.oldest), lastRoutedAt: date(routing.routed), held: Number(routing.held), exhausted: Number(routing.exhausted) },
    grading: { waiting: Number(grading.waiting), oldestWaitingAt: date(grading.oldest), running: Number(grading.running), lastSettledAt: date(grading.settled),
      lastReadingAt: date(reading), blocked: Number(grading.blocked), blockedUnpaid: Number(grading.unpaid) },
  })
}
