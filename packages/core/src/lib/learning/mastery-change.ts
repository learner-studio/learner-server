import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { graderNoise, type MeasuredGraderNoise } from './grader-noise.js'
import { HOLDOUT_EXPERIMENT_KEY, HOLDOUT_STARTED_AT, HOLDOUT_BUCKETS, isHeldOutAt } from './learning-concept-holdout.js'
import {
  aggregateChange, conceptChanges, holdoutEffect, holdoutUnits, noiseAwareGainThreshold,
  type AggregateChange, type ConceptChange, type CountedReading, type HoldoutEffect,
} from './mastery-change-statistics.js'
import { GAIN_MIN_POINTS, MEASUREMENTS } from './mastery-notifications.js'

/**
 * Reads for the honest mastery statistics (docs/specs/mastery-change-statistics.md). Computed on
 * read: no cached state. The statistics themselves are pure (mastery-change-statistics.ts).
 */

/** A reading whose evidence falls this long after a probe of its concept answers that probe. */
export const PROBE_ANSWER_WINDOW_HOURS = 24

/**
 * Every counted measurement of the learner, by evidence time (mastery-notifications.ts
 * MEASUREMENTS): medium/high readings, one per origin, uncited ones dated by the 75th percentile
 * of their learner messages, and gradings dated at the same time averaged into one measurement
 * whose `replicates` is the number of gradings behind it.
 */
export async function countedReadings(query: MetaPgQueryFn, userId: string): Promise<CountedReading[]> {
  // A probe answer (docs/specs/blind-probes.md, "Analysis"): evidence within a day after a live turn
  // whose guidance probed that concept. Probes reach both arms, so these measurements compare them
  // on an equal opportunity to show evidence.
  const rows = (await query<{ concept_id: string; evidence_at: Date; understanding_percent: string; replicates: number; probe: boolean }>(
    `SELECT m.concept_id, m.evidence_at, m.understanding_percent, m.replicates,
       EXISTS (SELECT 1 FROM learning_live_feedback_turns t WHERE t.user_id = $1 AND t.probe_concept_id = m.concept_id
         AND m.evidence_at >= t.created_at AND m.evidence_at < t.created_at + interval '${PROBE_ANSWER_WINDOW_HOURS} hours') AS probe
     FROM (${MEASUREMENTS}) m
     ORDER BY m.concept_id, m.evidence_at`, [userId])).rows
  return rows.map((r) => ({ conceptId: r.concept_id, at: r.evidence_at.getTime(), percent: Number(r.understanding_percent), replicates: Number(r.replicates ?? 1), probe: r.probe }))
}

export interface MasteryChanges {
  sinceDays: number | null
  graderSd: number
  graderNoiseDf: number
  graderNoiseSource: 'measured' | 'fallback'
  /** A single-grading gain must reach this many points to beyond noise (one-sided 95 %), never below GAIN_MIN_POINTS. */
  gainThreshold: number
  concepts: ConceptChange[]
  aggregate: AggregateChange
}

export async function masteryChanges(query: MetaPgQueryFn, userId: string, input: { sinceDays: number | null }, now = new Date(), noise?: MeasuredGraderNoise): Promise<MasteryChanges> {
  const measured = noise ?? await graderNoise(query)
  const readings = await countedReadings(query, userId)
  const since = input.sinceDays === null ? undefined : now.getTime() - input.sinceDays * 86_400_000
  const concepts = conceptChanges(readings.filter((r) => r.at <= now.getTime()), measured.sd, { since })
  return {
    sinceDays: input.sinceDays, graderSd: measured.sd, graderNoiseDf: measured.df, graderNoiseSource: measured.source,
    gainThreshold: noiseAwareGainThreshold(measured.sd, GAIN_MIN_POINTS),
    concepts, aggregate: aggregateChange(concepts),
  }
}

// ---------------------------------------------------------------------------------------------
// Holdout

export interface HoldoutPhase { experimentKey: string; phase: number; buckets: number; startedAt: string }

/** The current phase of osmosis-concept-holdout; the S6 constants if the table is empty. */
export async function currentHoldoutPhase(query: MetaPgQueryFn): Promise<HoldoutPhase> {
  const row = (await query<{ phase: number; buckets: number; started_at: Date }>(
    'SELECT phase, buckets, started_at FROM learning_holdout_phases WHERE experiment_key = $1 ORDER BY phase DESC LIMIT 1', [HOLDOUT_EXPERIMENT_KEY])).rows[0]
  return row
    ? { experimentKey: HOLDOUT_EXPERIMENT_KEY, phase: row.phase, buckets: row.buckets, startedAt: row.started_at.toISOString() }
    : { experimentKey: HOLDOUT_EXPERIMENT_KEY, phase: 1, buckets: HOLDOUT_BUCKETS, startedAt: HOLDOUT_STARTED_AT }
}

export interface HoldoutReport { phase: HoldoutPhase; graderSd: number; effect: HoldoutEffect; probe: HoldoutEffect | null }

/**
 * Taught minus held-out mastery, adjusted for baseline, in the current phase. The power line's
 * variance comes from the fitted model once the arms can be fitted, before that from every concept
 * measured twice at any time (follow-up regressed on baseline).
 */
export async function holdoutReport(query: MetaPgQueryFn, userId: string, noise?: MeasuredGraderNoise): Promise<HoldoutReport> {
  const [phase, readings, measured] = await Promise.all([currentHoldoutPhase(query), countedReadings(query, userId), noise ?? graderNoise(query)])
  const assignment = { startedAt: Date.parse(phase.startedAt), isHeldOut: isHeldOutAt(phase.buckets) }
  const { units, baselineOnly } = holdoutUnits(readings, assignment)
  const allPairs = conceptChanges(readings, measured.sd).map((c) => ({ baseline: c.from, followUp: c.to }))
  const effect = holdoutEffect(units, baselineOnly, 1 / phase.buckets, allPairs)
  // Probe-turn evidence (blindProbes): reported separately so differential opportunity can be seen.
  const probeReadings = readings.filter((r) => r.probe)
  const probe = probeReadings.length ? (() => { const p = holdoutUnits(probeReadings, assignment); return holdoutEffect(p.units, p.baselineOnly, 1 / phase.buckets, allPairs) })() : null
  return { phase, graderSd: measured.sd, effect, probe }
}
