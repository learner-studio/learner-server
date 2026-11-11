import { describe, expect, test } from 'bun:test'
import type { RpcOutput } from '@learner/contract'
import { changeLine, efficacyLine, noiseLine, powerLine, velocityLine } from './progress-statistics-model'

type Changes = RpcOutput<'getMasteryChanges'>
type Holdout = RpcOutput<'getHoldoutEffect'>

const aggregate = (over: Partial<Changes['aggregate']> = {}): Changes['aggregate'] => ({
  meanChange: 0.6, changeInterval: { low: -2.7, high: 3.9 }, meanSlopePerWeek: 0.31, slopeInterval: { low: -0.5, high: 1.1 },
  betweenConceptSd: 3, nConcepts: 87, nReadings: 400, nBeyondNoise: 4, nAtBound: 1, conclusive: false, ...over,
})
const changes = (over: Partial<Changes['aggregate']> = {}): Changes => ({
  sinceDays: null, concepts: [], aggregate: aggregate(over), graderSd: 11.75, graderNoiseDf: 1253, graderNoiseSource: 'measured', gainThreshold: 27.3,
})
const arms = (taught: number, heldOut: number) => ({ taught, heldOut })
const holdout = (over: Partial<Holdout['estimate']> = {}): Holdout => ({
  experimentKey: 'osmosis-concept-holdout', phase: 1, buckets: 5, heldOutShare: 0.2, startedAt: '2026-10-30T18:05:00.000Z', graderSd: 11.75, probe: null,
  estimate: {
    state: 'setting_baseline', measuredTwice: arms(12, 3), baselineOnly: arms(40, 9), minimumPerArm: 20, effect: null, interval: null, conclusive: false,
    meanChange: { taught: 2, heldOut: 1 }, meanBaseline: { taught: 40, heldOut: 41 },
    power: { varianceSource: 'all_pairs', residualSd: 12, minimumDetectableEffect: 21.4, targetEffect: 5, conceptsNeeded: 1131, heldOutNeeded: 227, conceptsStillNeeded: 1116 }, ...over,
  },
})

describe('Progress page statistics lines', () => {
  test('change: signed, with the interval, and says when it is indistinguishable from zero', () => {
    expect(changeLine(changes())).toBe('+0.6 points (95% −2.7 to +3.9) across 87 concepts measured twice: not yet distinguishable from no change.')
    expect(changeLine(changes({ meanChange: -4, changeInterval: { low: -6, high: -1.5 }, conclusive: true }))).toBe('−4.0 points (95% −6.0 to −1.5) across 87 concepts measured twice: a real decline.')
    expect(changeLine(changes({ meanChange: 3, changeInterval: { low: 0.5, high: 5 }, conclusive: true }))).toContain('a real gain')
    expect(changeLine(changes({ changeInterval: null, nConcepts: 3 }))).toBe('+0.6 points across 3 concepts measured twice: too few concepts for an interval yet.')
    expect(changeLine(changes({ meanChange: null, changeInterval: null, nConcepts: 0 }))).toContain('No concept has two counted readings')
  })
  test('velocity and noise', () => {
    expect(velocityLine(changes())).toBe('+0.3 points per week (95% −0.5 to +1.1)')
    expect(velocityLine(changes({ meanSlopePerWeek: null }))).toBeNull()
    expect(noiseLine(changes())).toBe('Grader noise sd 11.8 points (measured from 1,253 regrade degrees of freedom); a single reading must rise 27+ points to count as a gain.')
  })
  test('efficacy: baseline state until the minimum, then the adjusted effect; power line', () => {
    expect(efficacyLine(holdout())).toBe('Teaching vs holdout: setting baseline: 3 of 20 held-out concepts measured twice (taught: 12 of 20).')
    expect(efficacyLine(holdout({ state: 'estimate', measuredTwice: arms(90, 22), effect: 2.1, interval: { low: -1, high: 5.2 } })))
      .toBe('Teaching vs holdout: +2.1 points (95% −1.0 to +5.2), adjusted for baseline, n = 90 taught, 22 held out: not yet distinguishable from no change.')
    expect(efficacyLine(holdout({ state: 'estimate', measuredTwice: arms(90, 22), effect: 6, interval: { low: 1, high: 11 } }))).toContain('teaching helps')
    expect(powerLine(holdout())).toBe('Smallest effect detectable today at 80% power: 21.4 points; 1,116 more concepts measured twice to detect 5.')
  })
})
