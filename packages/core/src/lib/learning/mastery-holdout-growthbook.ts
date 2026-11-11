import { holdoutBucketSql } from './learning-concept-holdout.js'
import { elapsedWeeks, type HoldoutUnit } from './mastery-change-statistics.js'

/**
 * osmosis-concept-holdout in GrowthBook, on the corrected estimand (docs/specs/mastery-change-statistics.md,
 * "GrowthBook"; review B1/B2). The server's headline (mastery-change.ts holdoutReport `probe`) is
 * each concept's FIRST prior-blind probe answer after the start against its last prior-blind
 * measurement before it. This is the same estimand as GrowthBook rows, so GrowthBook's own analysis
 * of the experiment reads what the Progress page reads:
 * - one post-start row per concept: its answer to its FIRST delivered probe since the start, the probe
 *   analysis's k = 1 (`probe_percent`, `probe_answer` = 1). A concept whose first probe produced no
 *   prior-blind reading has no row, never a later probe's answer (review round 6, S-1);
 * - one pre-start row per such concept: its baseline, which GrowthBook's regression adjustment
 *   (CUPED, lookback covering every pre-start day) uses as the covariate, the server's ANCOVA;
 * - only concepts with both enter, as in `holdoutUnits`.
 * The metric is the ratio sum(probe_percent) / sum(probe_answer): the mean first probe answer among
 * answered concepts. A plain mean would score an unprobed concept 0, and held-out concepts are
 * probed more often.
 *
 * Review round 2, NB2: held-out concepts are probed about four times as often, so their first answer
 * comes sooner after the baseline, and while both arms learn that alone favours the taught arm.
 * The server adjusts for weeks from baseline to the answer inside its ANCOVA. GrowthBook can adjust
 * only for the metric's own pre-period value, so the time adjustment is made here:
 * `probe_percent_common_time` = the answer moved to the mean elapsed time, answer − b·(weeks − mean
 * weeks), b the pooled WITHIN-ARM slope of change (answer − baseline) on weeks (so a teaching effect,
 * which differs between arms, does not enter b). Its pre-start row is the baseline. The goal metric
 * reads it; `commonTimeFollowUps` is its pure twin.
 *
 * It reads `learning_blind_measurements(user, holdout start)` (migration 0034): GrowthBook's read-only role may
 * execute it but cannot read the tables behind it, which carry the learner's messages.
 */
export const HOLDOUT_PROBE_FACT_COLUMNS = ['concept_id', 'timestamp', 'probe_percent', 'probe_answer', 'probe_percent_common_time'] as const

/** Each unit's follow-up moved to the mean weeks from baseline, by the pooled within-arm slope of change on weeks (the fact SQL's twin). */
export function commonTimeFollowUps(units: readonly HoldoutUnit[]): Map<string, number> {
  const arms = [units.filter((u) => u.heldOut), units.filter((u) => !u.heldOut)]
  let sxy = 0, sxx = 0
  for (const arm of arms) {
    if (!arm.length) continue
    const w = arm.reduce((a, u) => a + elapsedWeeks(u), 0) / arm.length, c = arm.reduce((a, u) => a + u.followUp - u.baseline, 0) / arm.length
    for (const u of arm) { sxy += (elapsedWeeks(u) - w) * (u.followUp - u.baseline - c); sxx += (elapsedWeeks(u) - w) ** 2 }
  }
  const b = sxx > 0 ? sxy / sxx : 0
  const mean = units.length ? units.reduce((a, u) => a + elapsedWeeks(u), 0) / units.length : 0
  return new Map(units.map((u) => [u.conceptId, u.followUp - b * (elapsedWeeks(u) - mean)]))
}

const literal = (v: string) => `'${v.replaceAll("'", "''")}'`

export function holdoutProbeFactSql(userId: string, startedAt: string): string {
  const start = `timestamptz ${literal(new Date(startedAt).toISOString())}`
  return `WITH m AS (SELECT * FROM public.learning_blind_measurements(${literal(userId)}, ${start})),
baseline AS (
  SELECT DISTINCT ON (concept_id) concept_id, evidence_at, blind_percent FROM m
  WHERE evidence_at < ${start} ORDER BY concept_id, evidence_at DESC),
first_probe AS (
  SELECT DISTINCT ON (m.concept_id) m.concept_id, m.evidence_at, m.blind_percent FROM m JOIN baseline b USING (concept_id)
  WHERE m.first_probe ORDER BY m.concept_id, m.evidence_at),
units AS (
  SELECT f.concept_id, f.evidence_at, f.blind_percent AS follow, b.blind_percent AS base,
    extract(epoch FROM f.evidence_at - b.evidence_at) / 604800.0 AS weeks, ${holdoutBucketSql('f.concept_id')} = 0 AS held
  FROM first_probe f JOIN baseline b USING (concept_id)),
centred AS (
  SELECT u.*, u.weeks - avg(u.weeks) OVER (PARTITION BY u.held) AS dw,
    (u.follow - u.base) - avg(u.follow - u.base) OVER (PARTITION BY u.held) AS dc, avg(u.weeks) OVER () AS mean_weeks
  FROM units u),
slope AS (SELECT COALESCE(sum(dw * dc) / NULLIF(sum(dw * dw), 0), 0) AS b FROM centred)
SELECT c.concept_id, c.evidence_at AS timestamp, c.follow::float AS probe_percent, 1 AS probe_answer,
  (c.follow - s.b * (c.weeks - c.mean_weeks))::float AS probe_percent_common_time FROM centred c CROSS JOIN slope s
UNION ALL
SELECT b.concept_id, b.evidence_at, b.blind_percent::float, 1, b.blind_percent::float FROM baseline b JOIN first_probe f USING (concept_id)`
}
