import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { ASSESSMENT_MODEL } from './learning-concept-assessment.js'
import { Z_95_ONE_SIDED, type GraderNoise } from './mastery-change-statistics.js'

/** The live grader, as the digest's `model` column spells it (migration 0020). */
export const LIVE_GRADER_MODEL = `${ASSESSMENT_MODEL.backend}/${ASSESSMENT_MODEL.model}/${ASSESSMENT_MODEL.effort}`
/** Until there are this many degrees of freedom the measured sd is not trusted and the fallback is used. */
export const MIN_GRADER_NOISE_DF = 30
/** The audit's pooled figure (2026-11-11, 1,253 df, gpt-5.6-luna xhigh): used only while too few regrades exist. */
export const FALLBACK_GRADER_SD = 11.75

export type MeasuredGraderNoise = GraderNoise & { source: 'measured' | 'fallback' }

/**
 * Grader noise, measured: the pooled within-group sd of the live model grading the same concept on
 * identical evidence with the same prompt revision more than once (non-live comparison runs), plus
 * the spread inside every replicate-averaged reading. Both are regrades of identical input.
 */
export async function graderNoise(query: MetaPgQueryFn): Promise<MeasuredGraderNoise> {
  const row = (await query<{ ss: string | null; df: string | null; groups: string }>(
    `WITH graded AS (
       SELECT r.concept_id, d.evidence_ids, d.prompt_revision, (t.receipt #>> '{assessment,understandingPercent}')::numeric p
       FROM learning_concept_assessment_runs r
       JOIN learning_concept_assessment_run_digests d USING (run_id)
       JOIN learning_concept_assessment_receipts t USING (run_id)
       WHERE d.model = $1 AND t.receipt->>'status' = 'completed' AND t.receipt #>> '{assessment,understandingPercent}' IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM learning_mastery_readings v WHERE v.run_id = r.run_id)
     ), groups AS (
       SELECT count(*) - 1 AS df, (count(*) - 1) * var_samp(p) AS ss FROM graded GROUP BY concept_id, evidence_ids, prompt_revision HAVING count(*) > 1
       UNION ALL
       SELECT replicates - 1, (replicates - 1) * sd * sd FROM learning_concept_assessment_replicate_summaries WHERE replicates > 1 AND sd IS NOT NULL
     )
     SELECT sum(ss) AS ss, sum(df) AS df, count(*) AS groups FROM groups`, [LIVE_GRADER_MODEL])).rows[0]!
  const df = Number(row.df ?? 0)
  if (df < MIN_GRADER_NOISE_DF) return { sd: FALLBACK_GRADER_SD, df, groups: Number(row.groups), source: 'fallback' }
  return { sd: Math.sqrt(Number(row.ss) / df), df, groups: Number(row.groups), source: 'measured' }
}

/**
 * SQL for the noise-aware gain rule over a HISTORY row `h` (mastery-notifications.ts): a gain must
 * exceed `$zsd · √(1/k_now + 1/k_before)` (zsd = one-sided z × grader sd), never less than the floor.
 * k_before is the FEWEST replicates among the earlier counted readings: conservative, since the
 * reading the best came from is not tracked.
 */
export const gainThresholdSql = (zsdParam: string, floor: number, alias = 'h') =>
  `GREATEST(${floor}::numeric, ${zsdParam}::numeric * sqrt(1.0 / ${alias}.replicates + 1.0 / COALESCE(${alias}.previous_min_replicates, 1)))`
export const zTimesSd = (sd: number) => Z_95_ONE_SIDED * sd
