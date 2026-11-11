import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { ASSESSMENT_MODEL } from './learning-concept-assessment.js'
import { type BlindDrift, type GraderNoise } from './mastery-change-statistics.js'
import { panelBlindDrift, type DriftPanelStatus } from './grader-drift-panel.js'

/** The live grader, as the digest's `model` column spells it (migration 0020). */
export const LIVE_GRADER_MODEL = `${ASSESSMENT_MODEL.backend}/${ASSESSMENT_MODEL.model}/${ASSESSMENT_MODEL.effort}`
/** Until there are this many degrees of freedom a measured sd is not trusted and its fallback is used. */
export const MIN_GRADER_NOISE_DF = 30
/** Prior-blind regrade sd measured on dev (2026-11-11, 329 df, gpt-5.6-luna xhigh): used only while too few regrades exist. */
export const FALLBACK_BLIND_SD = 6.74
/** Anchored identical-prompt regrade sd measured on dev (2026-11-11, 501 df). */
export const FALLBACK_ANCHORED_SD = 2.26

export type MeasuredGraderNoise = GraderNoise & { source: 'measured' | 'fallback' }

/**
 * The two components of a reading's error (review B1), and the anchored grader's own drift.
 * - `blind`: prior-blind gradings of identical evidence (concept, evidence ids, prompt revision, no
 *   numeric prior in the prompt) and the spread inside every prior-blind replicate summary. This is
 *   the error of a prior-blind measurement, and the only one any verdict uses.
 * - `anchored`: gradings of identical evidence that carry the SAME numeric prior: the fresh noise of
 *   the live grader. Small, because the live grade mostly copies the prior; its real error is the
 *   path (`drift`), not this.
 * - `drift`: every anchored grading's move from its prior (live model): how much the live scores rise
 *   per grading on their own. Shown next to the anchored series, never used as a correction.
 */
export interface GraderNoiseComponents {
  blind: MeasuredGraderNoise
  anchored: MeasuredGraderNoise
  drift: { gradings: number; meanMove: number | null; sdMove: number | null; equal: number | null; up: number | null; down: number | null }
  /**
   * The PRIOR-BLIND grader's drift over calendar time (review round 2, S-b): identical evidence graded
   * at different times, within-group slope per week. Every aggregate "rose"/"fell" must clear it.
   */
  blindDrift: BlindDrift
  /**
   * Where `blindDrift` comes from: the weekly regrade panel (grader-drift-panel.ts), its window and
   * how many weekly runs it has, so the page can say why a verdict is withheld and until when.
   */
  driftPanel?: DriftPanelStatus
}

/** Every anchored live grading's move from the prior its prompt carried (the live grader's ratchet). */
const LIVE_MOVE_SQL = `SELECT count(*) n, avg(p - d.prior_percent) mean, stddev(p - d.prior_percent) sd,
       avg((p = d.prior_percent)::int) equal, avg((p > d.prior_percent)::int) up, avg((p < d.prior_percent)::int) down
     FROM (SELECT run_id, (receipt #>> '{assessment,understandingPercent}')::numeric p FROM learning_concept_assessment_receipts
           WHERE receipt->>'status' = 'completed' AND jsonb_typeof(receipt #> '{assessment,understandingPercent}') = 'number') t
     JOIN learning_concept_assessment_run_digests d USING (run_id)
     WHERE d.model = $1 AND d.prior_percent IS NOT NULL`
type LiveMoveRow = { n: string; mean: string | null; sd: string | null; equal: string | null; up: string | null; down: string | null }

/** Mean move of a live grading from its prior (null with none): what a live score rises per grading on its own (review round 3, B2). */
export async function liveRisePerGrading(query: MetaPgQueryFn): Promise<number | null> {
  const row = (await query<LiveMoveRow>(LIVE_MOVE_SQL, [LIVE_GRADER_MODEL])).rows[0]
  return row?.mean === null || row?.mean === undefined ? null : Number(row.mean)
}

/** One σ_g component from its regrade sums: measured from MIN_GRADER_NOISE_DF degrees of freedom, else `fallback`. */
export const component = (row: { ss: string | null; df: string | null; groups: string }, fallback: number): MeasuredGraderNoise => {
  const df = Number(row.df ?? 0)
  if (df < MIN_GRADER_NOISE_DF) return { sd: fallback, df, groups: Number(row.groups), source: 'fallback' }
  return { sd: Math.sqrt(Number(row.ss) / df), df, groups: Number(row.groups), source: 'measured' }
}
const num = (v: string | null) => (v === null ? null : Number(v))

/** `deps.panel` is the drift source (the weekly panel); a parameter so a test can see which σ_g it is read with. */
export async function graderNoise(query: MetaPgQueryFn, deps: { panel?: typeof panelBlindDrift } = {}): Promise<GraderNoiseComponents> {
  const rows = (await query<{ kind: 'blind' | 'anchored'; ss: string | null; df: string | null; groups: string }>(
    `WITH graded AS (
       SELECT r.concept_id, d.evidence_ids, d.prompt_revision, d.prior_percent, (t.receipt #>> '{assessment,understandingPercent}')::numeric p
       FROM learning_concept_assessment_runs r
       JOIN learning_concept_assessment_run_digests d USING (run_id)
       JOIN learning_concept_assessment_receipts t USING (run_id)
       WHERE d.model = $1 AND t.receipt->>'status' = 'completed' AND jsonb_typeof(t.receipt #> '{assessment,understandingPercent}') = 'number'
     ), groups AS (
       SELECT CASE WHEN prior_percent IS NULL THEN 'blind' ELSE 'anchored' END AS kind, count(*) - 1 AS df, (count(*) - 1) * var_samp(p) AS ss
       FROM graded GROUP BY concept_id, evidence_ids, prompt_revision, prior_percent HAVING count(*) > 1
       UNION ALL
       SELECT 'blind', s.replicates - 1, (s.replicates - 1) * s.sd * s.sd
       FROM learning_concept_assessment_replicate_summaries s JOIN learning_concept_assessment_run_digests d USING (run_id)
       WHERE d.model = $1 AND s.replicates > 1 AND s.sd IS NOT NULL
     )
     SELECT k.kind, sum(g.ss) AS ss, sum(g.df) AS df, count(g.kind) AS groups
     FROM (VALUES ('blind'), ('anchored')) k(kind) LEFT JOIN groups g USING (kind) GROUP BY k.kind`, [LIVE_GRADER_MODEL])).rows
  const drift = (await query<LiveMoveRow>(LIVE_MOVE_SQL, [LIVE_GRADER_MODEL])).rows[0]!
  const of = (kind: 'blind' | 'anchored') => rows.find((r) => r.kind === kind) ?? { ss: null, df: null, groups: '0' }
  const blind = component(of('blind'), FALLBACK_BLIND_SD)
  // The panel is regraded PRIOR-BLIND, so its item-level error is the blind σ_g, never the anchored one.
  const panel = await (deps.panel ?? panelBlindDrift)(query, blind.sd)
  return {
    blind,
    // The drift every aggregate verdict must clear comes from the fixed weekly panel only (review round 2 S-b,
    // round 3 S5): ad-hoc regrades of identical evidence are too few and too close in time to bound it.
    blindDrift: panel.drift, driftPanel: panel.panel,
    anchored: component(of('anchored'), FALLBACK_ANCHORED_SD),
    drift: { gradings: Number(drift.n), meanMove: num(drift.mean), sdMove: num(drift.sd), equal: num(drift.equal), up: num(drift.up), down: num(drift.down) },
  }
}
