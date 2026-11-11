/**
 * osmosis-concept-holdout in GrowthBook, on the corrected estimand (docs/specs/mastery-change-statistics.md,
 * "GrowthBook"; review B1/B2). The server's headline (mastery-change.ts holdoutReport `probe`) is
 * each concept's FIRST prior-blind probe answer after the start against its last prior-blind
 * measurement before it. This is the same estimand as GrowthBook rows, so GrowthBook's own analysis
 * of the experiment reads what the Progress page reads:
 * - one post-start row per concept: its first probe answer (`probe_percent`, `probe_answer` = 1);
 * - one pre-start row per such concept: its baseline, which GrowthBook's regression adjustment
 *   (CUPED, lookback covering every pre-start day) uses as the covariate, the server's ANCOVA;
 * - only concepts with both enter, as in `holdoutUnits`.
 * The metric is the ratio sum(probe_percent) / sum(probe_answer): the mean first probe answer among
 * answered concepts. A plain mean would score an unprobed concept 0, and held-out concepts are
 * probed more often.
 *
 * It reads `learning_blind_measurements(user)` (migration 0032): GrowthBook's read-only role may
 * execute it but cannot read the tables behind it, which carry the learner's messages.
 */
export const HOLDOUT_PROBE_FACT_COLUMNS = ['concept_id', 'timestamp', 'probe_percent', 'probe_answer'] as const

const literal = (v: string) => `'${v.replaceAll("'", "''")}'`

export function holdoutProbeFactSql(userId: string, startedAt: string): string {
  const start = `timestamptz ${literal(new Date(startedAt).toISOString())}`
  return `WITH m AS (SELECT * FROM public.learning_blind_measurements(${literal(userId)})),
baseline AS (
  SELECT DISTINCT ON (concept_id) concept_id, evidence_at, blind_percent FROM m
  WHERE evidence_at < ${start} ORDER BY concept_id, evidence_at DESC),
first_probe AS (
  SELECT DISTINCT ON (m.concept_id) m.concept_id, m.evidence_at, m.blind_percent FROM m JOIN baseline b USING (concept_id)
  WHERE m.probe AND m.evidence_at >= ${start} ORDER BY m.concept_id, m.evidence_at)
SELECT concept_id, evidence_at AS timestamp, blind_percent::float AS probe_percent, 1 AS probe_answer FROM first_probe
UNION ALL
SELECT b.concept_id, b.evidence_at, b.blind_percent::float, 1 FROM baseline b JOIN first_probe f USING (concept_id)`
}
