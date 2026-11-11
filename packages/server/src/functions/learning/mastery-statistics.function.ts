import { defineFunction } from '../../runtime/define.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { holdoutReport, masteryChanges } from '@learner/core/lib/learning/mastery-change.js'
import { HOLDOUT_TARGET_EFFECT, type HoldoutEffect as HoldoutEffectStats } from '@learner/core/lib/learning/mastery-change-statistics.js'
import { GetMasteryChangesInput, HoldoutEffect, MasteryChanges } from '@learner/contract'
import { z } from 'zod'
import { masteryLearnerFor } from './mastery-notifications.function.js'

/** docs/specs/mastery-change-statistics.md. Computed on read; admin session or device key, as the other mastery RPCs. */

const interval = (i: [number, number] | null) => (i ? { low: i[0], high: i[1] } : null)

export const getMasteryChanges = defineFunction({
  title: 'Signed mastery change with a 95 % interval, per concept and overall',
  description: 'Declines included. Readings by evidence time; per-concept from/to/delta/slope with a beyond-noise flag; the random-effects mean change and slope per week with bootstrap intervals over concepts, and whether the change interval excludes zero.',
  expose: true, readonly: true,
  input: GetMasteryChangesInput, output: MasteryChanges,
  func: async (services, { sinceDays }, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    const out = await masteryChanges(metaDbQuery, userId, { sinceDays: sinceDays ?? null })
    const names = new Map((await metaDbQuery<{ id: string; title: string }>('SELECT id, title FROM learning_concepts WHERE id = ANY($1::text[])', [out.concepts.map((c) => c.conceptId)])).rows.map((r) => [r.id, r.title]))
    const iso = (ms: number) => new Date(ms).toISOString()
    return {
      sinceDays: out.sinceDays,
      concepts: out.concepts.map((c) => ({
        conceptId: c.conceptId, conceptName: names.get(c.conceptId) ?? c.conceptId, from: c.from, to: c.to, fromAt: iso(c.fromAt), toAt: iso(c.toAt),
        delta: c.delta, slopePerWeek: c.slopePerWeek, readings: c.readings, beyondNoise: c.beyondNoise, atBound: c.atBound,
      })),
      aggregate: {
        meanChange: out.aggregate.meanChange, changeInterval: interval(out.aggregate.changeInterval),
        meanSlopePerWeek: out.aggregate.meanSlopePerWeek, slopeInterval: interval(out.aggregate.slopeInterval),
        betweenConceptSd: out.aggregate.betweenConceptSd, nConcepts: out.aggregate.nConcepts, nReadings: out.aggregate.nReadings,
        nBeyondNoise: out.aggregate.nBeyondNoise, nAtBound: out.aggregate.nAtBound, conclusive: out.aggregate.conclusive,
      },
      graderSd: out.graderSd, graderNoiseDf: out.graderNoiseDf, graderNoiseSource: out.graderNoiseSource, gainThreshold: out.gainThreshold,
    }
  },
})

const estimate = (e: HoldoutEffectStats) => ({
  state: e.state, measuredTwice: e.measuredTwice, baselineOnly: e.baselineOnly, minimumPerArm: e.minimumPerArm,
  effect: e.effect, interval: interval(e.interval), conclusive: e.conclusive, meanChange: e.meanChange, meanBaseline: e.meanBaseline,
  power: { ...e.power, targetEffect: HOLDOUT_TARGET_EFFECT },
})

export const getHoldoutEffect = defineFunction({
  title: 'osmosis-concept-holdout: taught minus held-out mastery, adjusted for baseline',
  description: 'Per concept, baseline (last reading before the phase start, else the first after) and follow-up (latest after); ANCOVA effect with a stratified bootstrap 95 % interval once enough concepts per arm are measured twice, else the baseline state; a power line from the data\'s own variance.',
  expose: true, readonly: true,
  input: z.object({}), output: HoldoutEffect,
  func: async (services, _data, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    const report = await holdoutReport(metaDbQuery, userId)
    return {
      experimentKey: report.phase.experimentKey, phase: report.phase.phase, buckets: report.phase.buckets, heldOutShare: 1 / report.phase.buckets,
      startedAt: report.phase.startedAt, graderSd: report.graderSd, estimate: estimate(report.effect), probe: report.probe ? estimate(report.probe) : null,
    }
  },
})
