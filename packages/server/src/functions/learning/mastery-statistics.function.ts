import { defineFunction } from '../../runtime/define.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { holdoutReport, masteryChanges } from '@learner/core/lib/learning/mastery-change.js'
import { HOLDOUT_TARGET_EFFECT, type AggregateChange, type HoldoutEffect as HoldoutEffectStats } from '@learner/core/lib/learning/mastery-change-statistics.js'
import { GetMasteryChangesInput, HoldoutEffect, MasteryChanges } from '@learner/contract'
import { z } from 'zod'
import { masteryLearnerFor } from './mastery-notifications.function.js'

/** docs/specs/mastery-change-statistics.md. Computed on read; admin session or device key, as the other mastery RPCs. */

const interval = (i: [number, number] | null) => (i ? { low: i[0], high: i[1] } : null)

const aggregate = (a: AggregateChange) => ({
  meanChange: a.meanChange, changeInterval: interval(a.changeInterval),
  meanSlopePerWeek: a.meanSlopePerWeek, slopeInterval: interval(a.slopeInterval),
  betweenConceptSd: a.betweenConceptSd, nConcepts: a.nConcepts, minimumConcepts: a.minimumConcepts, nReadings: a.nReadings,
  nBeyondNoise: a.nBeyondNoise, nBeyondNoiseUnadjusted: a.nBeyondNoiseUnadjusted, expectedBeyondNoiseByChance: a.expectedBeyondNoiseByChance,
  nAtBound: a.nAtBound, meanGradingsBetween: a.meanGradingsBetween, conclusive: a.conclusive,
})

export const getMasteryChanges = defineFunction({
  title: 'Signed mastery change with a 95 % interval, per concept and overall',
  description: 'Declines included. Verdicts rest on prior-blind measurements (by evidence time): per-concept from/to/delta/slope with a Benjamini–Hochberg beyond-noise flag; the random-effects mean change and slope per week with t-widened bootstrap intervals over concepts (none below the minimum), and whether the change interval excludes zero. The live, anchored scores are reported beside them with the grader\'s own drift.',
  expose: true, readonly: true,
  input: GetMasteryChangesInput, output: MasteryChanges,
  func: async (services, { sinceDays }, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    const out = await masteryChanges(metaDbQuery, userId, { sinceDays: sinceDays ?? null })
    const names = new Map((await metaDbQuery<{ id: string; title: string }>('SELECT id, title FROM learning_concepts WHERE id = ANY($1::text[])', [out.concepts.map((c) => c.conceptId)])).rows.map((r) => [r.id, r.title]))
    const iso = (ms: number) => new Date(ms).toISOString()
    return {
      sinceDays: out.sinceDays, noise: out.noise, gainThreshold: out.gainThreshold,
      concepts: out.concepts.map((c) => ({
        conceptId: c.conceptId, conceptName: names.get(c.conceptId) ?? c.conceptId, from: c.from, to: c.to, fromAt: iso(c.fromAt), toAt: iso(c.toAt),
        delta: c.delta, slopePerWeek: c.slopePerWeek, readings: c.readings, beyondNoise: c.beyondNoise, pValue: c.pValue, atBound: c.atBound,
      })),
      aggregate: aggregate(out.aggregate),
      anchored: { ...aggregate(out.anchored), expectedFromDrift: out.anchored.expectedFromDrift },
    }
  },
})

const estimate = (e: HoldoutEffectStats) => ({
  state: e.state, measuredTwice: e.measuredTwice, baselineOnly: e.baselineOnly, noPreStartBaseline: e.noPreStartBaseline,
  measuredTwiceShare: e.measuredTwiceShare, gradingsBetween: e.gradingsBetween, adjustedForGradings: e.adjustedForGradings,
  minimumPerArm: e.minimumPerArm, effect: e.effect, interval: interval(e.interval), conclusive: e.conclusive, meanChange: e.meanChange, meanBaseline: e.meanBaseline,
  power: { ...e.power, targetEffect: HOLDOUT_TARGET_EFFECT },
})

export const getHoldoutEffect = defineFunction({
  title: 'osmosis-concept-holdout: taught minus held-out mastery, adjusted for baseline',
  description: 'Concepts with a baseline measured before the phase start; follow-up = the latest measurement after it. The headline is prior-blind probe answers (an equal opportunity in both arms); every prior-blind measurement (opportunistic) and the live scores adjusted for gradings between are reported beside it. ANCOVA with a t-widened stratified bootstrap interval once enough concepts per arm are measured twice; per-arm gradings, attrition and a power line with the pace.',
  expose: true, readonly: true,
  input: z.object({}), output: HoldoutEffect,
  func: async (services, _data, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    const report = await holdoutReport(metaDbQuery, userId)
    return {
      experimentKey: report.phase.experimentKey, phase: report.phase.phase, buckets: report.phase.buckets, heldOutShare: 1 / report.phase.buckets,
      startedAt: report.phase.startedAt, noise: report.noise,
      probe: report.probe ? estimate(report.probe) : null, estimate: estimate(report.effect), anchored: estimate(report.anchored),
    }
  },
})
