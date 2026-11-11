import type { QueryFn as MetaPgQueryFn } from '../../db/handle.js'
import { graderNoise, type GraderNoiseComponents } from './grader-noise.js'
import { FIRST_PROBED_SQL, probeAnswerEvidenceSql } from './learning-blind-probes.js'
import { HOLDOUT_BUCKETS, HOLDOUT_EXPERIMENT_KEY, HOLDOUT_STARTED_AT, isHeldOut } from './learning-concept-holdout.js'
import {
  aggregateChange, conceptChanges, gainThreshold, sessionError, graderOnlyNoise, holdoutEffect, holdoutUnits, probeHoldoutReadings, probeHoldoutUnits,
  type AggregateChange, type ConceptChange, type CountedReading, type EvidenceNoise, type EvidenceSource, type EvidenceStratum, type HoldoutEffect, type MeasurementNoise,
} from './mastery-change-statistics.js'
import { feedHealth, GAIN_MIN_POINTS, learnerBlindNoise, MEASUREMENTS, type FeedHealth } from './mastery-notifications.js'

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
 * of their learner messages. `gradings` is the concept's live gradings up to then. With
 * `probesSince` (the holdout start) each row also says whether it answers its concept's FIRST
 * delivered probe since then (`firstProbe`).
 */
export async function countedMeasurements(query: MetaPgQueryFn, userId: string, opts: { probesSince?: string } = {}): Promise<CountedMeasurements> {
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
  const since = opts.probesSince === undefined ? null : '$2::timestamptz'
  const rows = (await query<{ concept_id: string; evidence_at: Date; understanding_percent: string | null; blind_percent: string | null; blind_gradings: number; blind_runs: number; gradings: number; probe: boolean; first_probe: boolean }>(
    `SELECT m.concept_id, m.evidence_at, m.understanding_percent, m.blind_percent, m.blind_gradings, m.blind_runs, m.gradings,
       (COALESCE(m.learner_dated, false) AND ${probeAnswerEvidenceSql('m.concept_id', 'm.evidence_at')}) AS probe,
       ${since === null ? 'false' : `(COALESCE(m.learner_dated, false) AND ${probeAnswerEvidenceSql('m.concept_id', 'm.evidence_at', since)})`} AS first_probe
     FROM (${MEASUREMENTS}) m
     ORDER BY m.concept_id, m.evidence_at`, since === null ? [userId] : [userId, opts.probesSince])).rows
  const base = (r: (typeof rows)[number]) => ({ conceptId: r.concept_id, at: r.evidence_at.getTime(), gradings: Number(r.gradings), probe: r.probe, ...(since === null ? {} : { firstProbe: r.first_probe }) })
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
  /** σ_e: sd of one blind measurement's evidence error, shared by its replicates (review round 2, NB1). */
  evidenceSd: number
  evidenceInterval: [number, number] | null
  evidencePairs: number
  evidenceSource: EvidenceSource
  /** σ_e per read-rate stratum (review round 3, S2); `evidenceSd` is the largest. */
  evidenceStrata: EvidenceStratum[]
  /** Whether replicates earn precision (only once σ_e is measured). */
  replicateCredit: boolean
  anchoredSd: number
  anchoredDf: number
  /** Anchored gradings' move from their prior: mean, and the shares that kept / raised / lowered it. */
  drift: GraderNoiseComponents['drift']
  /** The drift panel's state for the page (grader-drift-panel.ts); null with no panel. */
  driftPanel: { startedWeek: string | null; weeks: number; minWeeks: number; lastWeek: string | null; boundExpectedWeek: string | null; stale: boolean; bandsDisagree: boolean } | null
}

export interface MasteryChanges {
  sinceDays: number | null
  noise: MasteryNoiseReport
  /** A blind measurement of `gainThresholdGradings` gradings must rise this much over one earlier of as many to count as a gain (one-sided 95 %), never below GAIN_MIN_POINTS. */
  gainThreshold: number
  /** The learner's usual gradings per blind measurement (the median), which the threshold is quoted for (review round 2, N-b). */
  gainThresholdGradings: number
  /** Prior-blind: the verdicts. */
  concepts: ConceptChange[]
  aggregate: AggregateChange
  /** The live scores, anchored on their own prior: what they did and how much the grader alone moves them. */
  anchored: AggregateChange & { expectedFromDrift: number | null }
  /** Why the notification feed is quiet (review S10). */
  feed: FeedHealth
}

export const noiseReport = (n: GraderNoiseComponents, e: EvidenceNoise, m: MeasurementNoise): MasteryNoiseReport => ({
  blindSd: n.blind.sd, blindDf: n.blind.df, blindSource: n.blind.source,
  evidenceSd: e.sd, evidenceInterval: e.interval, evidencePairs: e.pairs, evidenceSource: e.source, evidenceStrata: e.strata, replicateCredit: m.replicateCredit,
  anchoredSd: n.anchored.sd, anchoredDf: n.anchored.df, drift: n.drift,
  driftPanel: n.driftPanel?.items ? { startedWeek: n.driftPanel.window?.startedWeek ?? null, weeks: n.driftPanel.weeks, minWeeks: n.driftPanel.minWeeks, lastWeek: n.driftPanel.lastWeek,
    boundExpectedWeek: n.driftPanel.boundExpectedWeek, stale: n.driftPanel.stale, bandsDisagree: n.driftPanel.bandsDisagree } : null,
})

/**
 * Distinct grader prompt revisions among the prior-blind measurements the change statistics read
 * (review round 3, S5): per concept, the readings from its anchor (its last reading before `since`,
 * as conceptChanges anchors) up to `now`, for concepts with two or more such readings. Replicate
 * gradings run under their reading's run, so the run's digest names the revision. A revision change
 * is a break the drift rule cannot cover. Times are evidence times (an uncited reading's 75th-
 * percentile dating can move it by about a day: a window edge can count one reading more or less).
 */
export async function blindPromptRevisions(query: MetaPgQueryFn, userId: string, since: Date | null, now: Date): Promise<number> {
  const row = (await query<{ n: number }>(
    `WITH b AS (
       SELECT m.concept_id, m.evidence_at, COALESCE(d.prompt_revision, '') AS rev
       FROM learning_mastery_readings m JOIN learning_concept_assessment_run_digests d USING (run_id)
       WHERE m.user_id = $1 AND m.blind_gradings > 0 AND m.blind_percent IS NOT NULL
         AND m.blind_confidence IN ('medium','high') AND m.evidence_at <= $3
     ), anchor AS (
       SELECT concept_id, max(evidence_at) AS a FROM b WHERE $2::timestamptz IS NOT NULL AND evidence_at < $2::timestamptz GROUP BY concept_id
     ), used AS (
       SELECT b.concept_id, b.rev, count(*) OVER (PARTITION BY b.concept_id) AS n
       FROM b LEFT JOIN anchor USING (concept_id)
       WHERE $2::timestamptz IS NULL OR b.evidence_at >= COALESCE(anchor.a, $2::timestamptz)
     )
     SELECT count(DISTINCT rev)::int AS n FROM used WHERE n >= 2`,
    [userId, since, now])).rows[0]
  return row?.n ?? 0
}

const medianGradings = (blind: readonly CountedReading[]) => {
  const ks = blind.map((r) => r.replicates ?? 1).sort((a, b) => a - b)
  return ks.length ? ks[Math.floor((ks.length - 1) / 2)]! : 1
}

export async function masteryChanges(query: MetaPgQueryFn, userId: string, input: { sinceDays: number | null }, now = new Date(), noise?: GraderNoiseComponents): Promise<MasteryChanges> {
  const measured = noise ?? await graderNoise(query)
  const since = input.sinceDays === null ? undefined : now.getTime() - input.sinceDays * 86_400_000
  const [m, feed, promptRevisions] = await Promise.all([
    countedMeasurements(query, userId), feedHealth(query, userId, now),
    blindPromptRevisions(query, userId, since === undefined ? null : new Date(since), now),
  ])
  const upToNow = (rs: CountedReading[]) => rs.filter((r) => r.at <= now.getTime())
  const blindNoise = await learnerBlindNoise(query, userId, m.blind, measured.blind.sd)
  const concepts = conceptChanges(upToNow(m.blind), blindNoise.noise, { since, drift: { interval: measured.blindDrift.interval, promptRevisions } })
  // Review 4, S1: the day-shared error, from every prior-blind measurement up to now (not only the window's).
  const session = sessionError(upToNow(m.blind))
  // The live series is descriptive only: its error is its anchoring path, so only the fresh grader noise is used.
  const anchored = aggregateChange(conceptChanges(upToNow(m.anchored), graderOnlyNoise(measured.anchored.sd), { since }))
  const k = medianGradings(m.blind)
  return {
    sinceDays: input.sinceDays, noise: noiseReport(measured, blindNoise.evidence, blindNoise.noise),
    gainThreshold: gainThreshold(blindNoise.noise, GAIN_MIN_POINTS, k), gainThresholdGradings: k,
    concepts, aggregate: aggregateChange(concepts, { drift: measured.blindDrift, promptRevisions, session }),
    anchored: { ...anchored, expectedFromDrift: anchored.meanGradingsBetween !== null && measured.drift.meanMove !== null ? anchored.meanGradingsBetween * measured.drift.meanMove : null },
    feed,
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
  /** The headline: each probed concept's answer to its FIRST delivered probe (an equal opportunity in both arms); a first probe with no prior-blind reading is attrition (`baselineOnly`). Null while no measurement answers a first probe. */
  probe: HoldoutEffect | null
  /**
   * Of each arm's concepts with a pre-start prior-blind baseline, how many had a first probe delivered
   * since the start (review round 2, S-d): the probe headline conditions on being probed, and the
   * arms' probed shares can differ by chance (before 829754b the held-out arm was probed about 4× as
   * often), so the reader needs both shares.
   */
  probed: { taught: { probed: number; eligible: number }; heldOut: { probed: number; eligible: number } }
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
  const phase = await currentHoldoutPhase(query)
  if (phase.buckets !== HOLDOUT_BUCKETS) throw new Error(`osmosis-concept-holdout is recorded at 1 in ${phase.buckets}, the code assigns 1 in ${HOLDOUT_BUCKETS}`)
  const [m, probed, measured] = await Promise.all([
    countedMeasurements(query, userId, { probesSince: phase.startedAt }),
    query<{ concept_id: string }>(FIRST_PROBED_SQL, [userId, phase.startedAt]),
    noise ?? graderNoise(query),
  ])
  const assignment = { startedAt: Date.parse(phase.startedAt), isHeldOut }
  const share = 1 / phase.buckets
  const at = now.getTime()
  const blindNoise = await learnerBlindNoise(query, userId, m.blind, measured.blind.sd)
  const estimate = (readings: CountedReading[], u: ReturnType<typeof holdoutUnits>, noise: MeasurementNoise, adjustForGradings: boolean, adjustForElapsed = false) => {
    const pairs = conceptChanges(readings, noise).map((c) => ({ baseline: c.from, followUp: c.to }))
    return holdoutEffect(u.units, u, share, pairs, { adjustForGradings, adjustForElapsed, now: at })
  }
  // The headline: each probed concept's answer to its FIRST delivered probe since the start (the
  // probe analysis's k = 1), against its pre-start baseline. A first probe that produced no
  // prior-blind reading is attrition, never replaced by a later probe's answer (review round 6, S-1).
  // Both arms are probed at the same per-concept rate since 829754b, so in expectation their first
  // answers come equally soon; the model still adjusts for weeks from baseline to that answer, since
  // one learner's realized timing differs by chance and common learning would read as an effect of
  // teaching (review round 2, NB2: under the old 4× held-out rate this was a +2 bias).
  const firstProbed = new Set(probed.rows.map((r) => r.concept_id))
  const eligible = new Set(m.blind.filter((r) => r.at < assignment.startedAt).map((r) => r.conceptId))
  const arm = (held: boolean) => {
    const ids = [...eligible].filter((id) => isHeldOut(id) === held)
    return { probed: ids.filter((id) => firstProbed.has(id)).length, eligible: ids.length }
  }
  return {
    probed: { taught: arm(false), heldOut: arm(true) },
    phase, noise: noiseReport(measured, blindNoise.evidence, blindNoise.noise),
    probe: m.blind.some((r) => r.firstProbe) ? estimate(probeHoldoutReadings(m.blind, firstProbed, assignment), probeHoldoutUnits(m.blind, firstProbed, assignment), blindNoise.noise, false, true) : null,
    effect: estimate(m.blind, holdoutUnits(m.blind, assignment), blindNoise.noise, false),
    anchored: estimate(m.anchored, holdoutUnits(m.anchored, assignment), graderOnlyNoise(measured.anchored.sd), true),
  }
}
