import { HOLDOUT_TARGET_EFFECT, type AggregateChange, type HoldoutEffect as HoldoutEffectStats } from '@learner/core/lib/learning/mastery-change-statistics.js'
import type { HoldoutReport, MasteryChanges as MasteryChangesStats } from '@learner/core/lib/learning/mastery-change.js'
import type { HoldoutEffect, MasteryChanges } from '@learner/contract'
import type { z } from 'zod'

/**
 * The wire shapes of getMasteryChanges and getHoldoutEffect (mastery-statistics.function.ts), pure, so
 * the four-lane e2e (apps/web/e2e/mastery-lanes.e2e.ts) renders a seeded learner exactly as the RPCs do.
 */

const interval = (i: [number, number] | null) => (i ? { low: i[0], high: i[1] } : null)

const noise = (n: MasteryChangesStats['noise']) => ({ ...n, evidenceInterval: interval(n.evidenceInterval), evidenceStrata: n.evidenceStrata.map((st) => ({ ...st, interval: interval(st.interval) })) })

const aggregate = (a: AggregateChange) => ({
  meanChange: a.meanChange, changeInterval: interval(a.changeInterval),
  meanSlopePerWeek: a.meanSlopePerWeek, slopeInterval: interval(a.slopeInterval),
  betweenConceptSd: a.betweenConceptSd, nConcepts: a.nConcepts, minimumConcepts: a.minimumConcepts, nReadings: a.nReadings,
  nBeyondNoise: a.nBeyondNoise, nBeyondNoiseUnadjusted: a.nBeyondNoiseUnadjusted, nBeyondDrift: a.nBeyondDrift, expectedBeyondNoiseByChance: a.expectedBeyondNoiseByChance,
  nAtBound: a.nAtBound, meanGradingsBetween: a.meanGradingsBetween, conclusive: a.conclusive,
  drift: a.drift && { ...a.drift, interval: interval(a.drift.interval), expected: interval(a.drift.expected) }, withheldForDrift: a.withheldForDrift,
  slopeConclusive: a.slopeConclusive, slopeWithheldForDrift: a.slopeWithheldForDrift, promptRevisions: a.promptRevisions, withheldForRevision: a.withheldForRevision,
})

/** The wire shape of masteryChanges. */
export function masteryChangesOutput(out: MasteryChangesStats, names: ReadonlyMap<string, string>): z.infer<typeof MasteryChanges> {
  const iso = (ms: number) => new Date(ms).toISOString()
  return {
    sinceDays: out.sinceDays, noise: noise(out.noise), gainThreshold: out.gainThreshold, gainThresholdGradings: out.gainThresholdGradings,
    concepts: out.concepts.map((c) => ({
      conceptId: c.conceptId, conceptName: names.get(c.conceptId) ?? c.conceptId, from: c.from, to: c.to, fromAt: iso(c.fromAt), toAt: iso(c.toAt),
      delta: c.delta, slopePerWeek: c.slopePerWeek, readings: c.readings, beyondNoise: c.beyondNoise, beyondDrift: c.beyondDrift ?? false, pValue: c.pValue, atBound: c.atBound,
    })),
    aggregate: aggregate(out.aggregate),
    anchored: { ...aggregate(out.anchored), expectedFromDrift: out.anchored.expectedFromDrift },
    feed: out.feed,
  }
}

const estimate = (e: HoldoutEffectStats) => ({
  state: e.state, measuredTwice: e.measuredTwice, baselineOnly: e.baselineOnly, noPreStartBaseline: e.noPreStartBaseline,
  measuredTwiceShare: e.measuredTwiceShare, gradingsBetween: e.gradingsBetween, adjustedForGradings: e.adjustedForGradings,
  adjustedForElapsed: e.adjustedForElapsed, elapsedWeeks: e.elapsedWeeks,
  minimumPerArm: e.minimumPerArm, effect: e.effect, interval: interval(e.interval), conclusive: e.conclusive, meanChange: e.meanChange, meanBaseline: e.meanBaseline,
  power: { ...e.power, targetEffect: HOLDOUT_TARGET_EFFECT },
})

/** The wire shape of holdoutReport. */
export function holdoutEffectOutput(report: HoldoutReport): z.infer<typeof HoldoutEffect> {
  return {
    experimentKey: report.phase.experimentKey, phase: report.phase.phase, buckets: report.phase.buckets, heldOutShare: 1 / report.phase.buckets,
    startedAt: report.phase.startedAt, noise: noise(report.noise),
    probe: report.probe ? estimate(report.probe) : null, probed: report.probed, estimate: estimate(report.effect), anchored: estimate(report.anchored),
  }
}

