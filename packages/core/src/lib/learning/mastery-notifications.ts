import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'

/**
 * Mastery notifications (docs/specs/mastery-notifications.md, S2–S4), computed on
 * read from `learning_mastery_readings` (migration 0015): no background state.
 *
 * Positive only: a notification is a first clear reading or a gain. A gain is
 * measured against the best earlier COUNTED reading (medium or high), not the
 * previous one, so recovering from a dip is never announced as progress and no
 * delta is ever negative. Declines stay visible in the readings themselves.
 */
export const GAIN_MIN_POINTS = 10
/** Confidence levels a reading needs to count toward a gain or a baseline. Low never counts. */
export const COUNTED_CONFIDENCE = ['medium', 'high'] as const
/** A concept's baseline is set by this many high (clear) readings, or MEDIUM_READINGS_FOR_BASELINE medium ones. */
export const HIGH_READINGS_FOR_BASELINE = 1
export const MEDIUM_READINGS_FOR_BASELINE = 2
export const PACE_WINDOW_DAYS = 14
/** Fewer days of readings than this and the pace is still a guess: daysLeft stays null. */
export const MIN_DAYS_FOR_PACE = 3

export const NOTIFICATION_ACTIONS = ['opened', 'nice', 'not_right', 'ignored'] as const
export type NotificationAction = (typeof NOTIFICATION_ACTIONS)[number]

export interface MasteryNotification {
  runId: string
  conceptId: string
  conceptName: string
  kind: 'first_clear' | 'gain'
  percent: number
  previousPercent: number | null
  /** Points above the best earlier counted reading; null when there is none or it is not above it. Never negative. */
  delta: number | null
  confidence: 'medium' | 'high'
  completedAt: string
  quote: string | null
}

/** Readings with the best counted value and whether a clear reading came before, per concept, in completion order. */
const HISTORY = `
  SELECT v.*,
    max(v.understanding_percent) FILTER (WHERE v.confidence IN ('medium','high')) OVER before AS previous_best,
    COALESCE(bool_or(v.confidence = 'high') OVER before, false) AS had_clear
  FROM learning_mastery_readings v
  WHERE v.user_id = $1
  WINDOW before AS (PARTITION BY v.concept_id ORDER BY v.completed_at, v.created_at, v.run_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`

export async function masteryNotifications(query: MetaPgQueryFn, userId: string, input: { since: string; limit: number }): Promise<MasteryNotification[]> {
  const rows = (await query<{ run_id: string; concept_id: string; title: string | null; understanding_percent: string; previous_best: string | null; had_clear: boolean; confidence: 'medium' | 'high'; completed_at: Date; quote: string | null }>(
    `WITH history AS (${HISTORY})
     SELECT h.run_id, h.concept_id, c.title, h.understanding_percent, h.previous_best, h.had_clear, h.confidence, h.completed_at,
       t.receipt #>> '{assessment,demonstrated,0,quote}' AS quote
     FROM history h
     JOIN learning_concept_assessment_receipts t USING (run_id)
     LEFT JOIN learning_concepts c ON c.id = h.concept_id
     WHERE h.completed_at > $2::timestamptz AND h.understanding_percent IS NOT NULL
       AND ((h.confidence = 'high' AND NOT h.had_clear)
         OR (h.confidence IN ('medium','high') AND h.previous_best IS NOT NULL AND h.understanding_percent - h.previous_best >= $3))
     ORDER BY h.completed_at DESC, h.run_id
     LIMIT $4`,
    [userId, input.since, GAIN_MIN_POINTS, input.limit])).rows
  return rows.map((row) => {
    const percent = Number(row.understanding_percent)
    const previous = row.previous_best === null ? null : Number(row.previous_best)
    const gain = previous === null ? null : percent - previous
    return {
      runId: row.run_id, conceptId: row.concept_id, conceptName: row.title ?? row.concept_id,
      kind: gain !== null && gain >= GAIN_MIN_POINTS ? 'gain' : 'first_clear',
      percent, previousPercent: previous, delta: gain !== null && gain > 0 ? gain : null,
      confidence: row.confidence, completedAt: row.completed_at.toISOString(), quote: row.quote,
    }
  })
}

/** Idempotent: a replayed action keeps the first row and its time. False when the run is not one of this learner's live readings. */
export async function recordNotificationFeedback(query: MetaPgQueryFn, userId: string, input: { runId: string; action: NotificationAction }): Promise<{ recorded: boolean; at: string }> {
  const owned = (await query('SELECT 1 FROM learning_mastery_readings WHERE run_id = $1 AND user_id = $2', [input.runId, userId])).rowCount
  if (!owned) return { recorded: false, at: new Date().toISOString() }
  await query('INSERT INTO learning_notification_feedback(run_id, action) VALUES ($1, $2) ON CONFLICT (run_id, action) DO NOTHING', [input.runId, input.action])
  const row = (await query<{ at: Date }>('SELECT at FROM learning_notification_feedback WHERE run_id = $1 AND action = $2', [input.runId, input.action])).rows[0]!
  return { recorded: true, at: row.at.toISOString() }
}

export interface LearningBaseline { have: number; need: number; pacePerDay: number; daysOfData: number; daysLeft: number | null }

/** Pure: days left at the current pace, or null while the pace is unknown. */
export function daysLeft(remaining: number, pacePerDay: number, daysOfData: number): number | null {
  if (remaining <= 0) return 0
  if (daysOfData < MIN_DAYS_FOR_PACE || pacePerDay <= 0) return null
  return Math.ceil(remaining / pacePerDay)
}

/**
 * need: concepts of the current catalog this learner has been exposed to (a
 * reactive target routed from their conversations, or any live reading).
 * have: those tracking under the baseline rule. Pace: concepts that STARTED
 * tracking in the last 14 days, per day.
 */
export async function learningBaseline(query: MetaPgQueryFn, userId: string, now = new Date()): Promise<LearningBaseline> {
  const row = (await query<{ need: string; have: string; recent: string; first_at: Date | null }>(
    `WITH exposed AS (
       SELECT concept_id FROM learning_reactive_targets WHERE user_id = $1
       UNION SELECT concept_id FROM learning_mastery_readings WHERE user_id = $1
     ), counted AS (
       SELECT concept_id, completed_at,
         count(*) FILTER (WHERE confidence = 'high') OVER upto AS high,
         count(*) FILTER (WHERE confidence = 'medium') OVER upto AS medium
       FROM learning_mastery_readings WHERE user_id = $1
       WINDOW upto AS (PARTITION BY concept_id ORDER BY completed_at, created_at, run_id)
     ), tracking AS (
       SELECT concept_id, min(completed_at) AS since FROM counted WHERE high >= $2 OR medium >= $3 GROUP BY concept_id
     )
     SELECT (SELECT count(*) FROM exposed e JOIN learning_concepts c ON c.id = e.concept_id) AS need,
       (SELECT count(*) FROM tracking t JOIN learning_concepts c ON c.id = t.concept_id) AS have,
       (SELECT count(*) FROM tracking t JOIN learning_concepts c ON c.id = t.concept_id WHERE t.since > $4::timestamptz - make_interval(days => $5)) AS recent,
       (SELECT min(completed_at) FROM learning_mastery_readings WHERE user_id = $1) AS first_at`,
    [userId, HIGH_READINGS_FOR_BASELINE, MEDIUM_READINGS_FOR_BASELINE, now.toISOString(), PACE_WINDOW_DAYS])).rows[0]!
  const need = Number(row.need), have = Number(row.have)
  const daysOfData = row.first_at ? Math.floor((now.getTime() - row.first_at.getTime()) / 86_400_000) : 0
  const pacePerDay = Number(row.recent) / Math.min(PACE_WINDOW_DAYS, Math.max(daysOfData, 1))
  return { have, need, pacePerDay, daysOfData, daysLeft: daysLeft(need - have, pacePerDay, daysOfData) }
}

// --- Speaking Coach baseline (the habits database) ---

export const COACH_ARMS = ['baseline', 'caw_audio', 'haptic_vibe', 'pavlok_shock'] as const
export const COACH_TIMING_VERSION = 'confirmed_speech_span_v1'
/** Smallest difference in the 30 s breach rate the experiment must detect. */
export const COACH_DETECTABLE_DIFFERENCE = 0.10
/** Assumed baseline breach rate until the baseline arm has COACH_MIN_BASELINE_ROWS rows. */
export const COACH_PRIOR_BREACH_RATE = 0.35
export const COACH_MIN_BASELINE_ROWS = 50
/** (z_{α/2} + z_β)² for α = 0.05 two-sided and 80 % power: (1.96 + 0.84)². */
export const COACH_Z_SQUARED = 7.84

export interface CoachArmCount { arm: string; rows: number; breaches30: number; rowsLast14Days: number }
export interface CoachBaseline {
  arms: Array<{ arm: string; have: number; need: number }>
  baselineBreachRate: number
  baselineRateMeasured: boolean
  pacePerArmPerDay: number
  daysLeft: number | null
}

/** Per-arm sample size for a two-proportion test detecting a drop of d from p0. */
export function coachTargetPerArm(p0: number, d = COACH_DETECTABLE_DIFFERENCE): number {
  const p1 = Math.max(0, p0 - d)
  return Math.ceil(COACH_Z_SQUARED * (p0 * (1 - p0) + p1 * (1 - p1)) / (d * d))
}

/** Pure: the coach line from per-arm counts. Arms with no rows still count, at zero. */
export function coachBaseline(counts: readonly CoachArmCount[]): CoachBaseline {
  const byArm = new Map(counts.map((c) => [c.arm, c]))
  const base = byArm.get('baseline')
  const measured = !!base && base.rows >= COACH_MIN_BASELINE_ROWS
  const p0 = measured ? base!.breaches30 / base!.rows : COACH_PRIOR_BREACH_RATE
  const need = coachTargetPerArm(p0)
  const arms = COACH_ARMS.map((arm) => ({ arm, have: byArm.get(arm)?.rows ?? 0, need }))
  const last14 = COACH_ARMS.reduce((sum, arm) => sum + (byArm.get(arm)?.rowsLast14Days ?? 0), 0)
  const pace = last14 / PACE_WINDOW_DAYS / COACH_ARMS.length
  const slowest = Math.max(0, ...arms.map((a) => need - a.have))
  return { arms, baselineBreachRate: p0, baselineRateMeasured: measured, pacePerArmPerDay: pace, daysLeft: slowest <= 0 ? 0 : pace > 0 ? Math.ceil(slowest / pace) : null }
}

/** The coach rows that count: speech turns (never pavlok_intervention), current timing, eligible, not simulated, not suspect. */
export const COACH_ROW_FILTER = `habit_type = 'monologue_streak'
  AND metadata->>'timing_version' = '${COACH_TIMING_VERSION}'
  AND COALESCE(metadata->>'data_quality', 'unknown') = 'ok'
  AND metadata->>'simulated' = 'false'
  AND metadata->>'experiment_eligible' = 'true'
  AND call_category IN ('work', 'client', 'solo')
  AND session_id NOT LIKE 'session-%'`

export async function coachArmCounts(query: MetaPgQueryFn, now = new Date()): Promise<CoachArmCount[]> {
  const rows = (await query<{ arm: string; rows: string; breaches30: string; last14: string }>(
    `SELECT treatment_arm AS arm, count(*) AS rows, COALESCE(sum(breached_30s), 0) AS breaches30,
       count(*) FILTER (WHERE timestamp > $1::timestamptz - make_interval(days => $2)) AS last14
     FROM habit_events WHERE ${COACH_ROW_FILTER} GROUP BY treatment_arm`, [now.toISOString(), PACE_WINDOW_DAYS])).rows
  return rows.map((r) => ({ arm: r.arm, rows: Number(r.rows), breaches30: Number(r.breaches30), rowsLast14Days: Number(r.last14) }))
}
