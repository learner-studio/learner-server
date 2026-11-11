import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { graderNoise, type GraderNoiseComponents } from './grader-noise.js'
import { probeAnswerEvidenceSql } from './learning-blind-probes.js'
import { HOLDOUT_BUCKETS, HOLDOUT_EXPERIMENT_KEY, HOLDOUT_STARTED_AT, isHeldOut } from './learning-concept-holdout.js'
import {
  aggregateChange, conceptChanges, holdoutEffect, holdoutUnits, noiseAwareGainThreshold,
  type AggregateChange, type ConceptChange, type CountedReading, type HoldoutEffect,
} from './mastery-change-statistics.js'
import { GAIN_MIN_POINTS, MEASUREMENTS } from './mastery-notifications.js'

/**
 * Reads for the honest mastery statistics (docs/specs/mastery-change-statistics.md). Computed on
 * read: no cached state. The statistics themselves are pure (mastery-change-statistics.ts).
 */

/** A learner's counted measurements, two series of one MEASUREMENTS read. */
export interface CountedMeasurements {
  /** Prior-blind measurements: the only series any verdict reads. `replicates` = blind gradings, `runs` = runs they came from. */
  blind: CountedReading[]
  /** Live (anchored) measurements: the scores the learner sees, descriptive only. */
  anchored: CountedReading[]
}

/**
 * Every counted measurement of the learner, by evidence time (mastery-notifications.ts
 * MEASUREMENTS): one row per (concept, evidence time), uncited readings dated by the 75th percentile
 * of their learner messages. `gradings` is the concept's live gradings up to then.
 */
export async function countedMeasurements(query: MetaPgQueryFn, userId: string): Promise<CountedMeasurements> {
  // A probe answer (docs/specs/blind-probes.md, "Analysis"): learning-blind-probes.ts
  // probeAnswerEvidenceSql, the rule PROBE_ANALYSIS_SQL scores probes by: evidence after a
  // delivered probe of the concept and no later than two minutes after the next live turn of that
  // session began, and that next turn did not teach the concept. Probes reach both arms, so these
  // measurements compare them on an equal opportunity to show evidence.
  // The bound is two minutes on the LEARNER's clock, so only one clock may stand in for `at`:
  // the time of a cited learner message (`learner_dated`). Never the grading time (a `graded`
  // reading has no evidence time; the grader runs days later), never an uncited reading's
  // 75th-percentile date (median error 0.6 d against the cited message, mastery-notifications.ts
  // READINGS: whether it lands in a two-minute window is chance), and never a cited AGENT message
  // (the agent's reply to the probe turn falls inside the window without being an answer).
  const rows = (await query<{ concept_id: string; evidence_at: Date; understanding_percent: string | null; blind_percent: string | null; blind_gradings: number; blind_runs: number; gradings: number; probe: boolean }>(
    `SELECT m.concept_id, m.evidence_at, m.understanding_percent, m.blind_percent, m.blind_gradings, m.blind_runs, m.gradings,
       (COALESCE(m.learner_dated, false) AND ${probeAnswerEvidenceSql('m.concept_id', 'm.evidence_at')}) AS probe
     FROM (${MEASUREMENTS}) m
     ORDER BY m.concept_id, m.evidence_at`, [userId])).rows
  const base = (r: (typeof rows)[number]) => ({ conceptId: r.concept_id, at: r.evidence_at.getTime(), gradings: Number(r.gradings), probe: r.probe })
  return {
    blind: rows.filter((r) => r.blind_percent !== null && Number(r.blind_gradings) > 0)
      .map((r) => ({ ...base(r), percent: Number(r.blind_percent), replicates: Number(r.blind_gradings), runs: Number(r.blind_runs) })),
    anchored: rows.filter((r) => r.understanding_percent !== null).map((r) => ({ ...base(r), percent: Number(r.understanding_percent), replicates: 1 })),
  }
}

export interface MasteryNoiseReport {
  blindSd: number
  blindDf: number
  blindSource: 'measured' | 'fallback'
  anchoredSd: number
  anchoredDf: number
  /** Anchored gradings' move from their prior: mean, and the shares that kept / raised / lowered it. */
  drift: GraderNoiseComponents['drift']
}

export interface MasteryChanges {
  sinceDays: number | null
  noise: MasteryNoiseReport
  /** A single blind grading must rise this much over a single earlier one to count as a gain (one-sided 95 %), never below GAIN_MIN_POINTS. */
  gainThreshold: number
  /** Prior-blind: the verdicts. */
  concepts: ConceptChange[]
  aggregate: AggregateChange
  /** The live scores, anchored on their own prior: what they did and how much the grader alone moves them. */
  anchored: AggregateChange & { expectedFromDrift: number | null }
}

export const noiseReport = (n: GraderNoiseComponents): MasteryNoiseReport => ({
  blindSd: n.blind.sd, blindDf: n.blind.df, blindSource: n.blind.source, anchoredSd: n.anchored.sd, anchoredDf: n.anchored.df, drift: n.drift,
})

export async function masteryChanges(query: MetaPgQueryFn, userId: string, input: { sinceDays: number | null }, now = new Date(), noise?: GraderNoiseComponents): Promise<MasteryChanges> {
  const measured = noise ?? await graderNoise(query)
  const m = await countedMeasurements(query, userId)
  const since = input.sinceDays === null ? undefined : now.getTime() - input.sinceDays * 86_400_000
  const upToNow = (rs: CountedReading[]) => rs.filter((r) => r.at <= now.getTime())
  const concepts = conceptChanges(upToNow(m.blind), measured.blind.sd, { since })
  const anchored = aggregateChange(conceptChanges(upToNow(m.anchored), measured.anchored.sd, { since }))
  return {
    sinceDays: input.sinceDays, noise: noiseReport(measured),
    gainThreshold: noiseAwareGainThreshold(measured.blind.sd, GAIN_MIN_POINTS),
    concepts, aggregate: aggregateChange(concepts),
    anchored: { ...anchored, expectedFromDrift: anchored.meanGradingsBetween !== null && measured.drift.meanMove !== null ? anchored.meanGradingsBetween * measured.drift.meanMove : null },
  }
}

// ---------------------------------------------------------------------------------------------
// Holdout

export interface HoldoutPhase { experimentKey: string; phase: number; buckets: number; startedAt: string }

/**
 * osmosis-concept-holdout as recorded in learning_holdout_phases (one row: 1 in 5 from the S6 start).
 * The share is a constant by owner decision (2026-11-11), so there is one phase; the table is the
 * experiment's record, and the S6 constants stand in if it is empty.
 */
export async function currentHoldoutPhase(query: MetaPgQueryFn): Promise<HoldoutPhase> {
  const row = (await query<{ phase: number; buckets: number; started_at: Date }>(
    'SELECT phase, buckets, started_at FROM learning_holdout_phases WHERE experiment_key = $1 ORDER BY phase DESC LIMIT 1', [HOLDOUT_EXPERIMENT_KEY])).rows[0]
  return row
    ? { experimentKey: HOLDOUT_EXPERIMENT_KEY, phase: row.phase, buckets: row.buckets, startedAt: row.started_at.toISOString() }
    : { experimentKey: HOLDOUT_EXPERIMENT_KEY, phase: 1, buckets: HOLDOUT_BUCKETS, startedAt: HOLDOUT_STARTED_AT }
}

export interface HoldoutReport {
  phase: HoldoutPhase
  noise: MasteryNoiseReport
  /** The headline: prior-blind probe answers, an equal opportunity in both arms. Null while no measurement answers a probe. */
  probe: HoldoutEffect | null
  /** Every prior-blind measurement: opportunistic (teaching drives how often a concept is read), so never a verdict. */
  effect: HoldoutEffect
  /** The live scores, adjusted for gradings between: descriptive only, they ratchet with every grading. */
  anchored: HoldoutEffect
}

/**
 * Taught minus held-out mastery, adjusted for baseline, in the current phase (review B2, S9).
 * Only concepts with a baseline measured before the start enter; each estimate reports the anchored
 * gradings per arm, and the anchored one adjusts for them. The power line's variance comes from the
 * fitted model once the arms can be fitted, before that from every concept measured twice.
 */
export async function holdoutReport(query: MetaPgQueryFn, userId: string, noise?: GraderNoiseComponents, now = new Date()): Promise<HoldoutReport> {
  const [phase, m, measured] = await Promise.all([currentHoldoutPhase(query), countedMeasurements(query, userId), noise ?? graderNoise(query)])
  if (phase.buckets !== HOLDOUT_BUCKETS) throw new Error(`osmosis-concept-holdout is recorded at 1 in ${phase.buckets}, the code assigns 1 in ${HOLDOUT_BUCKETS}`)
  const assignment = { startedAt: Date.parse(phase.startedAt), isHeldOut }
  const share = 1 / phase.buckets
  const at = now.getTime()
  const estimate = (readings: CountedReading[], sd: number, adjustForGradings: boolean) => {
    const u = holdoutUnits(readings, assignment)
    const pairs = conceptChanges(readings, sd).map((c) => ({ baseline: c.from, followUp: c.to }))
    return holdoutEffect(u.units, u, share, pairs, { adjustForGradings, now: at })
  }
  // Probe answers after the start, against the concept's pre-start baseline.
  const probeReadings = m.blind.filter((r) => r.probe || r.at < assignment.startedAt)
  return {
    phase, noise: noiseReport(measured),
    probe: m.blind.some((r) => r.probe && r.at >= assignment.startedAt) ? estimate(probeReadings, measured.blind.sd, false) : null,
    effect: estimate(m.blind, measured.blind.sd, false),
    anchored: estimate(m.anchored, measured.anchored.sd, true),
  }
}
