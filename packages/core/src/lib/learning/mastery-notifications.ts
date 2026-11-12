import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { graderNoise } from './grader-noise.js'
import { GRID_POINTS, SAME_TIME_RHO, WEEK_MS, Z_95_ONE_SIDED, evidenceNoise, measurementNoise, type CountedReading, type EvidenceNoise, type MeasurementNoise } from './mastery-change-statistics.js'

/**
 * Mastery notifications (docs/specs/mastery-notifications.md, S2–S4), computed on
 * read from `learning_mastery_readings` (migration 0015): no background state.
 *
 * Positive only: a notification is a first clear reading or a gain. A gain is a
 * PRIOR-BLIND measurement beyond noise above the MEAN of the concept's earlier
 * counted blind measurements (BLIND_GAIN; review S11), so no delta is ever
 * negative. Declines stay visible in the readings themselves.
 * Only a reading that cites a recent learner message newer than what was already shown is
 * announced (NEWS): a backfilled grading of an old conversation, a regrade, or an uncited
 * reading is not.
 */
/**
 * The FLOOR of the gain rule. A gain is measured on PRIOR-BLIND measurements only (BLIND_GAIN): the
 * live grader copies its prior and ratchets up with every grading (review B2), so a rise in live
 * scores says nothing. Against the mean of the concept's earlier blind measurements a gain must
 * exceed the one-sided 95 % bound on the difference (blind sd 6.7: +15.7 for one grading against
 * one), and never less than this floor.
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

/**
 * A learner's independent readings ($1 = user). An 'unchanged' receipt reuses an earlier
 * run's grade for identical evidence, and copies chain (a copy of a copy), so each reading's
 * ORIGIN is the fresh grading at the end of its reusedRunId chain. One reading per origin
 * counts, the first to go live: a copy of a live reading adds nothing, and a copy of a
 * grading that never went live (a comparison run) is that grade's first live reading.
 *
 * Review S8: the walk has no depth cap. A cap of 100 cut chains that are 128 deep on dev, and
 * every truncated walk named a copy as its origin (6 spurious counted readings, each a zero
 * change). The walk stops instead when it would revisit a run of its own path; such a chain has
 * no fresh grading at its end, so its origin is the least run id of the cycle, the same for every
 * run that reaches it.
 */
export const INDEPENDENT = `
  WITH RECURSIVE mine AS (SELECT * FROM learning_mastery_readings WHERE user_id = $1),
  chain AS (
    SELECT m.run_id, m.reused_run_id AS src, 0 AS depth, ARRAY[m.run_id, m.reused_run_id] AS path, m.reused_run_id = m.run_id AS cyc
    FROM mine m WHERE m.status = 'unchanged' AND m.reused_run_id IS NOT NULL
    UNION ALL
    SELECT c.run_id, t.receipt->>'reusedRunId', c.depth + 1, c.path || (t.receipt->>'reusedRunId'), (t.receipt->>'reusedRunId') = ANY(c.path)
    FROM chain c JOIN learning_concept_assessment_receipts t ON t.run_id = c.src
    WHERE NOT c.cyc AND t.receipt->>'status' = 'unchanged' AND t.receipt->>'reusedRunId' IS NOT NULL
  ), origin AS (
    SELECT DISTINCT ON (run_id) run_id,
      CASE WHEN cyc THEN (SELECT min(e) FROM unnest(path[array_position(path, src):cardinality(path) - 1]) e) ELSE src END AS src
    FROM chain ORDER BY run_id, depth DESC)
  SELECT DISTINCT ON (m.concept_id, COALESCE(o.src, m.run_id)) m.*
  FROM mine m LEFT JOIN origin o USING (run_id)
  ORDER BY m.concept_id, COALESCE(o.src, m.run_id), m.completed_at, m.created_at, m.run_id`

/**
 * A toast says "you improved just now": its cited evidence must be this recent when the reading
 * goes live (review finding 2). The grader works through old conversations (dev: 44–45 days
 * behind for 7 of the 13 readings the feed announced), and a first grading of an old conversation
 * is history, not progress. The statistics and the strip are retrospective and evidence-dated, so
 * they include everything.
 */
export const TOAST_RECENCY_DAYS = 7

/**
 * INDEPENDENT plus two facts read from each counted reading's own run (copies carry the same
 * evidence as their origin):
 * - `cited_learner_at`: the newest LEARNER message the assessment cites under `demonstrated`.
 *   Only a cited learner message can establish a gain (review finding 3): an uncited reading, or
 *   one citing only agent text, contributes a level but can neither be announced nor set the
 *   frontier that suppresses one.
 * - `dated_at`: the time the statistics use. A cited reading keeps `evidence_at` (its newest cited
 *   message). An uncited one (`evidence_set`) is dated by the 75th percentile of its learner
 *   messages, not the newest. Scored by scripts/uncited-dating-evaluation.ts on cited readings cut
 *   down to uncited shapes (review N7; dev 2026-11-11): median error 0.06 d, mean +1.45 d, against
 *   +8.2 d for the newest message (data/uncited-dating-evaluation.json, spec section A). `graded`
 *   readings keep the grading time.
 * - `blind_revision`: the run's grader prompt revision (its replicates run under it), for BLIND_BEFORE.
 */
export const READINGS = `
  SELECT v.*, ev.cited_learner_at, (SELECT d.prompt_revision FROM learning_concept_assessment_run_digests d WHERE d.run_id = v.run_id) AS blind_revision,
    CASE WHEN v.evidence_basis = 'evidence_set' THEN COALESCE(ev.learner_p75, v.evidence_at) ELSE v.evidence_at END AS dated_at
  FROM (${INDEPENDENT}) v
  LEFT JOIN LATERAL (
    SELECT max(e.at) FILTER (WHERE e.role = 'user' AND e.id = ANY(cid.ids)) AS cited_learner_at,
      percentile_disc(0.75) WITHIN GROUP (ORDER BY e.at) FILTER (WHERE e.role = 'user') AS learner_p75
    FROM (SELECT ARRAY(SELECT c->>'sourceId' FROM learning_concept_assessment_receipts t,
            jsonb_array_elements(CASE WHEN jsonb_typeof(t.receipt #> '{assessment,demonstrated}') = 'array' THEN t.receipt #> '{assessment,demonstrated}' ELSE '[]'::jsonb END) c
            WHERE t.run_id = v.run_id AND v.confidence IN ('medium','high')) AS ids) cid,
      LATERAL (SELECT m->>'id' AS id, m->>'role' AS role, (m->>'occurredAt')::timestamptz AS at
        FROM learning_concept_assessment_runs u,
          jsonb_array_elements(CASE WHEN jsonb_typeof(u.snapshot->'evidence') = 'array' THEN u.snapshot->'evidence' ELSE '[]'::jsonb END) m
        WHERE u.run_id = v.run_id AND v.confidence IN ('medium','high') AND v.understanding_percent IS NOT NULL
          AND m->>'occurredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') e
    WHERE e.at >= '1971-01-01'::timestamptz
  ) ev ON true`

/**
 * Two clocks (migration 0018). `completed_at` is when a reading went LIVE (the grader ran):
 * the feed pages by it, because a client can only be told about a reading once it exists.
 * `evidence_at` is when the learner said the newest thing the reading rests on.
 *
 * HISTORY is the feed's view, in completion order: for each reading, what the learner had
 * already been shown when it went live. `previous_best` and `had_clear` are over the counted
 * readings that were live before it (uncited ones included: a level is a level), so a
 * notification is a pure function of what existed when it was sent. `newest_cited_before` is the
 * newest cited learner message among the counted readings already live: see NEWS.
 */
/** A live reading (alias `a`) counts as a level: medium or high, with a percent. */
export const ANCHORED_COUNTED = (a: string) => `(${a}.confidence IN ('medium','high') AND ${a}.understanding_percent IS NOT NULL)`
/** A row (READINGS or MEASUREMENTS, alias `a`) carries a counted prior-blind measurement. */
export const BLIND_COUNTED = (a: string) => `(${a}.blind_gradings > 0 AND ${a}.blind_percent IS NOT NULL AND ${a}.blind_confidence IN ('medium','high'))`

/** k_eff of a measurement of `k` gradings from `runs` runs in SQL (`effectiveGradings`). */
const KEFF = (k: string, runs: string) => `(CASE WHEN ${k} <= 1 OR ${runs} <= 1 THEN GREATEST(${k}, 1)::numeric ELSE ${k}::numeric / (1 + (${k} - 1) * ${SAME_TIME_RHO}) END)`

/**
 * The window sums the gain rule needs over the concept's earlier counted blind measurements (alias
 * `v`, window `blind_before`): the gradings-weighted sum, k_before = Σk, Σk² and Σk²/k_eff (so that
 * Var(mean before) = (σ_e²·Σk² + σ_g²·Σk²/k_eff) / k_before², `blindGain(...).beyondNoise`), and Σk·t over their evidence
 * times `at` and their grading times `graded` (epoch seconds), for the drift rule's two gaps (`blindGain`). `blind_before` partitions by
 * concept AND `blind_revision`: a rise is measured against earlier measurements by the same grader
 * prompt only (strip review B-R2b), since the drift rule cannot cover a prompt change.
 */
export const BLIND_BEFORE = (v: string, runs: string, at: string, graded: string) => `
    sum(${v}.blind_percent * ${v}.blind_gradings) FILTER (WHERE ${BLIND_COUNTED(v)}) OVER blind_before AS blind_sum_before,
    sum(extract(epoch FROM ${at})::numeric * ${v}.blind_gradings) FILTER (WHERE ${BLIND_COUNTED(v)}) OVER blind_before AS blind_tk_before,
    sum(extract(epoch FROM ${graded})::numeric * ${v}.blind_gradings) FILTER (WHERE ${BLIND_COUNTED(v)}) OVER blind_before AS blind_gk_before,
    sum(${v}.blind_gradings) FILTER (WHERE ${BLIND_COUNTED(v)}) OVER blind_before AS blind_k_before,
    sum(${v}.blind_gradings::numeric ^ 2) FILTER (WHERE ${BLIND_COUNTED(v)}) OVER blind_before AS blind_kk_before,
    sum(${v}.blind_gradings::numeric ^ 2 / ${KEFF(`${v}.blind_gradings`, runs)}) FILTER (WHERE ${BLIND_COUNTED(v)}) OVER blind_before AS blind_kq_before`

/**
 * The gain rule's SQL parameters, in this order: σ_e², σ_g², replicate credit (1/0), and the grader
 * drift interval's low and high (points per week; both null while the drift is unmeasured).
 */
export const gainParams = (noise: MeasurementNoise, drift: [number, number] | null): [number, number, number, number | null, number | null] =>
  [noise.evidenceSd ** 2, noise.graderSd ** 2, noise.replicateCredit ? 1 : 0, drift?.[0] ?? null, drift?.[1] ?? null]

/** Names of the five `gainParams` placeholders. */
export interface GainPlaceholders { e2: string; g2: string; credit: string; driftLow: string; driftHigh: string }

/**
 * The gain rule in SQL over a row carrying BLIND_BEFORE (alias `a`; its runs in `runs`): its counted
 * prior-blind measurement exceeds the MEAN of the concept's earlier ones (review S11) by
 * max(floor, z·√(Var(now) + Var(mean before)) + the grid's continuity correction), with
 * Var = σ_e² + σ_g²/k_eff (review round 2 NB1, S-c; k_eff = 1 without replicate credit).
 * `p` names the three placeholders of `gainParams`. Its pure twin is `blindGain`.
 */
const BLIND_RISE = (a: string) => `(${a}.blind_percent - ${a}.blind_sum_before / ${a}.blind_k_before)`

/** The noise margin of the gain rule: z·√(Var(now) + Var(mean before)) + the grid's continuity correction. */
const BLIND_MARGIN = (p: GainPlaceholders, a: string, runs: string) => {
  const kNow = `(CASE WHEN ${p.credit}::int = 1 THEN ${KEFF(`${a}.blind_gradings`, runs)} ELSE 1 END)`
  const before = `(${p.e2}::numeric * ${a}.blind_kk_before + ${p.g2}::numeric * CASE WHEN ${p.credit}::int = 1 THEN ${a}.blind_kq_before ELSE ${a}.blind_kk_before END) / (${a}.blind_k_before::numeric ^ 2)`
  return `(${Z_95_ONE_SIDED}::numeric * sqrt(${p.e2}::numeric + ${p.g2}::numeric / ${kNow} + ${before})
    + CASE WHEN ${p.g2}::numeric > 0 THEN ${GRID_POINTS / 2}::numeric / lcm(${a}.blind_gradings::int, ${a}.blind_k_before::int) ELSE 0 END)`
}

/** Beyond grader noise only (`blindGain(...).beyondNoise`): not yet a gain, see BLIND_GAIN. */
export const BLIND_BEYOND_NOISE = (p: GainPlaceholders, floor: number, a: string, runs = '1') =>
  `(${BLIND_COUNTED(a)} AND COALESCE(${a}.blind_k_before, 0) > 0 AND ${BLIND_RISE(a)} >= GREATEST(${floor}::numeric, ${BLIND_MARGIN(p, a, runs)}))`

/**
 * The drift half of the rule (`blindGain`): rise − margin > max(0, low·gap, high·gap) over both gaps in
 * weeks, from the k-weighted mean time before to the row's, in evidence time (`at`) and grading time
 * (`graded`; review 5, S3). False while the drift is unmeasured.
 */
const BLIND_CLEARS_DRIFT = (p: GainPlaceholders, a: string, runs: string, at: string, graded: string) => {
  const gap = (t: string, sum: string) => `((extract(epoch FROM ${t})::numeric - ${a}.${sum} / ${a}.blind_k_before) / ${WEEK_MS / 1000}::numeric)`
  const band = [gap(at, 'blind_tk_before'), gap(graded, 'blind_gk_before')].flatMap((g) => [`${p.driftLow}::numeric * ${g}`, `${p.driftHigh}::numeric * ${g}`])
  // GREATEST ignores NULLs, so an unmeasured drift (null bounds) must be refused explicitly, not by COALESCE alone.
  return `COALESCE(${p.driftLow}::numeric IS NOT NULL AND ${p.driftHigh}::numeric IS NOT NULL
    AND ${BLIND_RISE(a)} - ${BLIND_MARGIN(p, a, runs)} > GREATEST(0::numeric, ${band.join(', ')}), false)`
}

/**
 * A GAIN (the strip's ▲, a gain notification; `blindGain(...).gain`): beyond grader noise AND clear
 * of the grader's drift over the gap. `at` and `graded` are the row's evidence and grading time columns.
 */
export const BLIND_GAIN = (p: GainPlaceholders, floor: number, a: string, runs: string, at: string, graded: string) =>
  `(${BLIND_BEYOND_NOISE(p, floor, a, runs)} AND ${BLIND_CLEARS_DRIFT(p, a, runs, at, graded)})`

/** `blindGain(...).withheldForDrift`: beyond grader noise, but the drift (or its absence) could produce it. */
export const BLIND_WITHHELD_FOR_DRIFT = (p: GainPlaceholders, floor: number, a: string, runs: string, at: string, graded: string) =>
  `(${BLIND_BEYOND_NOISE(p, floor, a, runs)} AND NOT ${BLIND_CLEARS_DRIFT(p, a, runs, at, graded)})`

export const HISTORY = `
  SELECT v.*,
    max(v.understanding_percent) FILTER (WHERE v.confidence IN ('medium','high')) OVER before AS previous_best,
    COALESCE(bool_or(v.confidence = 'high') OVER before, false) AS had_clear,
    max(v.cited_learner_at) FILTER (WHERE v.confidence IN ('medium','high')) OVER before AS newest_cited_before,${BLIND_BEFORE('v', '1', 'v.dated_at', 'v.completed_at')}
  FROM (${READINGS}) v
  WINDOW before AS (PARTITION BY v.concept_id ORDER BY v.completed_at, v.created_at, v.run_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
    blind_before AS (PARTITION BY v.concept_id, v.blind_revision ORDER BY v.completed_at, v.created_at, v.run_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`

/**
 * A reading of HISTORY (alias `h`) is news, and may be toasted at all, only when
 * - it cites a learner message (`cited_learner_at`): an uncited reading is a level, not news;
 * - that message is STRICTLY newer than every cited learner message of the counted readings
 *   already live: a re-grading of the same evidence, or a backfill behind what was shown, is not
 *   news, and only cited readings move this frontier;
 * - that message is at most TOAST_RECENCY_DAYS older than the reading going live: a first grading
 *   of an old conversation is history even when nothing newer was shown yet.
 */
export const NEWS = `(h.cited_learner_at IS NOT NULL
  AND (h.newest_cited_before IS NULL OR h.cited_learner_at > h.newest_cited_before)
  AND h.cited_learner_at >= h.completed_at - make_interval(days => ${TOAST_RECENCY_DAYS}))`

/**
 * Counted readings as MEASUREMENTS (review finding 4): gradings of one concept dated at the same
 * time rest on the same evidence, so they are one measurement and are averaged, never ordered: a
 * regrade that happens to score higher is noise, not a gain. One row per (concept, dated_at) with a
 * counted live reading or a counted prior-blind measurement:
 * - `understanding_percent`: the mean of the counted LIVE (anchored) gradings, null when none is
 *   counted; `clear` when every one of them is high. Descriptive: anchored to the published estimate.
 * - `blind_percent` / `blind_gradings` / `blind_runs`: the prior-blind measurement, the mean of the
 *   counted blind gradings (weighted by each run's count), how many, and from how many runs (gradings
 *   from different runs are correlated: `effectiveGradings`). Every verdict reads these. `blind_revision`
 *   names their grader prompt revisions (several, comma-joined, match no single one: BLIND_BEFORE).
 * - `gradings`: the concept's live gradings (any confidence) up to this evidence time: the
 *   opportunity count the holdout reports (review B2).
 * - `cited`: any grading cites a learner message; `learner_dated` when the measurement's time IS a
 *   cited learner message's: not a grading time (`graded`), not an uncited reading's 75th-percentile
 *   proxy (`evidence_set`), and not a cited reading whose newest cited message is the agent's.
 */
export const MEASUREMENTS = `
  SELECT r.concept_id, r.dated_at AS evidence_at,
    avg(r.understanding_percent) FILTER (WHERE ${ANCHORED_COUNTED('r')}) AS understanding_percent,
    count(*) FILTER (WHERE ${ANCHORED_COUNTED('r')})::int AS live_gradings,
    sum(r.blind_percent * r.blind_gradings) FILTER (WHERE ${BLIND_COUNTED('r')}) / NULLIF(sum(r.blind_gradings) FILTER (WHERE ${BLIND_COUNTED('r')}), 0) AS blind_percent,
    COALESCE(sum(r.blind_gradings) FILTER (WHERE ${BLIND_COUNTED('r')}), 0)::int AS blind_gradings,
    count(*) FILTER (WHERE ${BLIND_COUNTED('r')})::int AS blind_runs,
    CASE WHEN count(*) FILTER (WHERE ${BLIND_COUNTED('r')}) > 0 THEN 'medium' END AS blind_confidence,
    string_agg(DISTINCT r.blind_revision, ',' ORDER BY r.blind_revision) FILTER (WHERE ${BLIND_COUNTED('r')}) AS blind_revision,
    max(r.live_index)::int AS gradings,
    COALESCE(bool_and(r.confidence = 'high') FILTER (WHERE ${ANCHORED_COUNTED('r')}), false) AS clear,
    CASE WHEN bool_and(r.confidence = 'high') FILTER (WHERE ${ANCHORED_COUNTED('r')}) THEN 'high' ELSE 'medium' END AS confidence,
    bool_or(r.cited_learner_at IS NOT NULL) AS cited,
    bool_and(r.evidence_dated) AS evidence_dated,
    bool_or(date_trunc('milliseconds', r.cited_learner_at) = r.dated_at) AS learner_dated,
    min(r.completed_at) AS completed_at, min(r.created_at) AS created_at,
    to_timestamp(sum(extract(epoch FROM r.completed_at) * r.blind_gradings) FILTER (WHERE ${BLIND_COUNTED('r')}) / NULLIF(sum(r.blind_gradings) FILTER (WHERE ${BLIND_COUNTED('r')}), 0)) AS graded_at,
    (array_agg(r.run_id ORDER BY r.completed_at, r.created_at, r.run_id))[1] AS run_id
  FROM (SELECT x.*, count(*) OVER (PARTITION BY x.concept_id ORDER BY x.dated_at RANGE UNBOUNDED PRECEDING) AS live_index FROM (${READINGS}) x) r
  WHERE ${ANCHORED_COUNTED('r')} OR ${BLIND_COUNTED('r')}
  GROUP BY r.concept_id, r.dated_at`

/**
 * MEASUREMENTS in EVIDENCE order, for anything that asks "when did I learn it" after the fact
 * (the progress strip, the replay's evidence-week table): the best earlier live value, whether a
 * clear measurement came before, and the earlier prior-blind measurements' sum and count (BLIND_GAIN),
 * over measurements on strictly older evidence. Not for the feed: a reading graded tomorrow on old
 * evidence changes the rows after it.
 */
export const EVIDENCE_HISTORY = `
  SELECT m.*,
    max(m.understanding_percent) OVER before AS previous_best,
    COALESCE(bool_or(m.clear) OVER before, false) AS had_clear,${BLIND_BEFORE('m', 'm.blind_runs', 'm.evidence_at', 'm.graded_at')}
  FROM (${MEASUREMENTS}) m
  WINDOW before AS (PARTITION BY m.concept_id ORDER BY m.evidence_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
    blind_before AS (PARTITION BY m.concept_id, m.blind_revision ORDER BY m.evidence_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)`

/**
 * Without `since`: the newest `limit`. With it: the OLDEST `limit` after it, so a client that
 * moves its cursor to the newest `completedAt` it received never steps past one it was not
 * sent. A page never splits readings that share a `completedAt` (a finished pass publishes
 * all of its readings at once), so it can run past `limit` by that group. Newest first either way.
 */
export async function masteryNotifications(query: MetaPgQueryFn, userId: string, input: { since: string | null; limit: number }, rule?: GainRule): Promise<MasteryNotification[]> {
  const gain = rule ?? await learnerGainRule(query, userId)
  const [e2, g2, credit, driftLow, driftHigh] = gainParams(gain.noise, gain.drift)
  const rows = (await query<{ run_id: string; concept_id: string; title: string | null; understanding_percent: string; blind_percent: string | null; blind_before: string | null; is_gain: boolean; confidence: 'medium' | 'high'; completed_at: Date; quote: string | null }>(
    `WITH history AS (${HISTORY}), due AS (
       SELECT h.* FROM history h
       WHERE h.completed_at > COALESCE($2::timestamptz, '-infinity') AND h.understanding_percent IS NOT NULL
         AND ${NEWS}
         AND ((h.confidence = 'high' AND NOT h.had_clear) OR ${BLIND_GAIN(FEED_PARAMS, GAIN_MIN_POINTS, 'h', '1', 'h.dated_at', 'h.completed_at')})
     ), cut AS (
       SELECT CASE WHEN $2::timestamptz IS NULL
         THEN (SELECT completed_at FROM due ORDER BY completed_at DESC OFFSET $6 - 1 LIMIT 1)
         ELSE (SELECT completed_at FROM due ORDER BY completed_at ASC OFFSET $6 - 1 LIMIT 1) END AS at
     )
     SELECT d.run_id, d.concept_id, c.title, d.understanding_percent, d.blind_percent, d.blind_sum_before / NULLIF(d.blind_k_before, 0) AS blind_before,
       ${BLIND_GAIN(FEED_PARAMS, GAIN_MIN_POINTS, 'd', '1', 'd.dated_at', 'd.completed_at')} AS is_gain, d.confidence, d.completed_at,
       t.receipt #>> '{assessment,demonstrated,0,quote}' AS quote
     FROM due d CROSS JOIN cut
     JOIN learning_concept_assessment_receipts t USING (run_id)
     LEFT JOIN learning_concepts c ON c.id = d.concept_id
     WHERE cut.at IS NULL OR (CASE WHEN $2::timestamptz IS NULL THEN d.completed_at >= cut.at ELSE d.completed_at <= cut.at END)
     ORDER BY d.completed_at DESC, d.run_id`,
    [userId, input.since, e2, g2, credit, input.limit, driftLow, driftHigh])).rows
  return rows.map((row) => {
    // A gain is stated in prior-blind points: the measurement and the mean of the earlier ones.
    const isGain = row.is_gain
    const percent = isGain ? Number(row.blind_percent) : Number(row.understanding_percent)
    const previous = isGain ? Number(row.blind_before) : null
    return {
      runId: row.run_id, conceptId: row.concept_id, conceptName: row.title ?? row.concept_id,
      kind: isGain ? 'gain' : 'first_clear',
      // A first clear reading can sit below an earlier medium one: it carries no comparison.
      percent, previousPercent: previous, delta: previous === null ? null : percent - previous,
      confidence: row.confidence, completedAt: row.completed_at.toISOString(), quote: row.quote,
    }
  })
}

const FEED_PARAMS: GainPlaceholders = { e2: '$3', g2: '$4', credit: '$5', driftLow: '$7', driftHigh: '$8' }

/** The learner's counted blind measurements: concept, evidence time, percent, gradings, runs. */
export async function blindMeasurements(query: MetaPgQueryFn, userId: string): Promise<CountedReading[]> {
  const rows = (await query<{ concept_id: string; evidence_at: Date; blind_percent: string; blind_gradings: number; blind_runs: number }>(
    `SELECT m.concept_id, m.evidence_at, m.blind_percent, m.blind_gradings, m.blind_runs FROM (${MEASUREMENTS}) m
     WHERE m.blind_percent IS NOT NULL AND m.blind_gradings > 0 ORDER BY m.concept_id, m.evidence_at`, [userId])).rows
  return rows.map((r) => ({ conceptId: r.concept_id, at: r.evidence_at.getTime(), percent: Number(r.blind_percent), replicates: Number(r.blind_gradings), runs: Number(r.blind_runs) }))
}

/**
 * The noise of one prior-blind measurement for this learner (review round 2, NB1): σ_g from
 * identical-prompt regrades (graderNoise), σ_e from the learner's own blind measurements of different
 * evidence close in time (evidenceNoise). `blind` skips the read when the caller has them.
 */
export async function learnerBlindNoise(query: MetaPgQueryFn, userId: string, blind?: readonly CountedReading[], graderSd?: number): Promise<{ noise: MeasurementNoise; evidence: EvidenceNoise; graderSd: number }> {
  const [readings, sd] = await Promise.all([blind ?? blindMeasurements(query, userId), graderSd ?? graderNoise(query).then((n) => n.blind.sd)])
  const evidence = evidenceNoise(readings, sd)
  return { noise: measurementNoise(sd, evidence), evidence, graderSd: sd }
}

/** What the per-concept gain rule reads: the learner's measurement noise and the grader's drift interval (null: unmeasured). */
export interface GainRule { noise: MeasurementNoise; drift: [number, number] | null }

/** The gain rule for this learner: `learnerBlindNoise` plus the weekly drift panel's interval (graderNoise.blindDrift). */
export async function learnerGainRule(query: MetaPgQueryFn, userId: string): Promise<GainRule> {
  const grader = await graderNoise(query)
  const { noise } = await learnerBlindNoise(query, userId, undefined, grader.blind.sd)
  return { noise, drift: grader.blindDrift.interval }
}

/** The window feedHealth reports on: readings that went live this recently. */
export const FEED_HEALTH_WINDOW_DAYS = 14

/**
 * Why the feed is quiet (review S10). The recency rule in NEWS compares a reading's cited message
 * with the time it went LIVE, so while the grader works through a backlog no reading can pass it,
 * whatever the learner does (dev, October: 2 of 189 cited readings graded within 7 days). The rule
 * stays (a toast says "just now"); this says, beside the feed, how far behind grading is and how
 * many readings the rule let through, instead of leaving the silence unexplained.
 *
 * Over the learner's counted readings that cite a learner message and went live in the
 * FEED_HEALTH_WINDOW_DAYS before `now`: how many there were, how many passed the recency rule, how
 * many were news (NEWS: recency and the frontier), and the median days from the cited message to
 * the reading going live (the grading lag). `newestEvidenceAt` is the newest cited learner message
 * graded so far, at any time.
 */
export interface FeedHealth {
  windowDays: number
  recencyDays: number
  citedReadings: number
  withinRecency: number
  news: number
  medianLagDays: number | null
  newestEvidenceAt: string | null
}

export async function feedHealth(query: MetaPgQueryFn, userId: string, now = new Date()): Promise<FeedHealth> {
  const row = (await query<{ cited: string; recent: string; news: string; lag: string | null; newest: Date | null }>(
    `WITH history AS (${HISTORY})
     SELECT count(*) FILTER (WHERE w) AS cited,
       count(*) FILTER (WHERE w AND h.cited_learner_at >= h.completed_at - make_interval(days => ${TOAST_RECENCY_DAYS})) AS recent,
       count(*) FILTER (WHERE w AND ${NEWS}) AS news,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM h.completed_at - h.cited_learner_at) / 86400) FILTER (WHERE w) AS lag,
       max(h.cited_learner_at) FILTER (WHERE h.completed_at <= $2::timestamptz) AS newest
     FROM (SELECT x.*, (x.cited_learner_at IS NOT NULL AND ${ANCHORED_COUNTED('x')}
             AND x.completed_at > $2::timestamptz - make_interval(days => ${FEED_HEALTH_WINDOW_DAYS}) AND x.completed_at <= $2::timestamptz) AS w
           FROM history x) h`, [userId, now.toISOString()])).rows[0]!
  return {
    windowDays: FEED_HEALTH_WINDOW_DAYS, recencyDays: TOAST_RECENCY_DAYS,
    citedReadings: Number(row.cited), withinRecency: Number(row.recent), news: Number(row.news),
    medianLagDays: row.lag === null ? null : Number(row.lag), newestEvidenceAt: row.newest ? row.newest.toISOString() : null,
  }
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
  if (daysOfData < MIN_DAYS_FOR_PACE) return null
  if (remaining <= 0) return 0
  if (pacePerDay <= 0) return null
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
       FROM (${INDEPENDENT}) v
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
