import { describe, expect, test } from 'bun:test'
import type { RpcOutput } from '@learner/contract'
import { anchoredLine, changeLine, conceptsLine, efficacyLine, feedLine, noiseLine, powerLine, velocityLine, VERDICT_FELL, VERDICT_NONE, VERDICT_ROSE } from './progress-statistics-model'

type Changes = RpcOutput<'getMasteryChanges'>
type Holdout = RpcOutput<'getHoldoutEffect'>
type Estimate = Holdout['estimate']

const aggregate = (over: Partial<Changes['aggregate']> = {}): Changes['aggregate'] => ({
  meanChange: 0.6, changeInterval: { low: -2.7, high: 3.9 }, meanSlopePerWeek: 0.31, slopeInterval: { low: -0.5, high: 1.1 },
  betweenConceptSd: 3, nConcepts: 87, minimumConcepts: 20, nReadings: 400, nBeyondNoise: 2, nBeyondNoiseUnadjusted: 5, expectedBeyondNoiseByChance: 4.35,
  nAtBound: 1, meanGradingsBetween: 4, conclusive: false, drift: null, withheldForDrift: false, ...over,
})
const noise: Changes['noise'] = {
  blindSd: 6.74, blindDf: 329, blindSource: 'measured', anchoredSd: 2.26, anchoredDf: 501,
  evidenceSd: 10, evidenceInterval: { low: 7.8, high: 13.5 }, evidencePairs: 27, evidenceSource: 'measured', replicateCredit: true,
  drift: { gradings: 4113, meanMove: 2.15, sdMove: 4.23, equal: 0.723, up: 0.274, down: 0.0032 },
}
const feed = (over: Partial<Changes['feed']> = {}): Changes['feed'] => ({
  windowDays: 14, recencyDays: 7, citedReadings: 41, withinRecency: 1, news: 0, medianLagDays: 44.7, newestEvidenceAt: '2026-09-28T10:00:00.000Z', ...over,
})
const changes = (over: Partial<Changes['aggregate']> = {}, anchored: Partial<Changes['anchored']> = {}, feedOver: Partial<Changes['feed']> = {}): Changes => ({
  feed: feed(feedOver), sinceDays: null, concepts: [], aggregate: aggregate(over), noise, gainThreshold: 27.3, gainThresholdGradings: 2,
  anchored: { ...aggregate({ meanChange: 9.2, meanGradingsBetween: 4.1 }), expectedFromDrift: 8.8, ...anchored },
})
const arms = (taught: number, heldOut: number) => ({ taught, heldOut })
const estimate = (over: Partial<Estimate> = {}): Estimate => ({
  state: 'setting_baseline', measuredTwice: arms(12, 3), baselineOnly: arms(40, 9), noPreStartBaseline: arms(5, 1),
  measuredTwiceShare: { taught: 0.23, heldOut: 0.25 }, gradingsBetween: { taught: 5.2, heldOut: 1.4 }, adjustedForGradings: false, adjustedForElapsed: false, elapsedWeeks: { taught: 3.9, heldOut: 1.1 },
  minimumPerArm: 20, effect: null, interval: null, conclusive: false,
  meanChange: { taught: 2, heldOut: 1 }, meanBaseline: { taught: 40, heldOut: 41 },
  power: { varianceSource: 'all_pairs', residualSd: 12, minimumDetectableEffect: 21.4, targetEffect: 5, conceptsNeeded: 1131, heldOutNeeded: 227, conceptsStillNeeded: 1116, pacePerWeek: 37.2, weeksToTarget: 30 },
  ...over,
})
const holdout = (probe: Estimate | null, est: Partial<Estimate> = {}): Holdout => ({
  experimentKey: 'osmosis-concept-holdout', phase: 1, buckets: 5, heldOutShare: 0.2, startedAt: '2026-10-30T18:05:00.000Z', noise,
  probed: { taught: { probed: 120, eligible: 600 }, heldOut: { probed: 30, eligible: 150 } },
  probe, estimate: estimate(est), anchored: estimate({ adjustedForGradings: true }),
})

describe('Progress page statistics lines', () => {
  test('change: signed, with the interval, and the verdict says what the statistic shows and no more (S1)', () => {
    expect(changeLine(changes())).toBe(`+0.6 points (95% −2.7 to +3.9) across 87 concepts measured twice without the previous score: ${VERDICT_NONE}.`)
    expect(changeLine(changes({ meanChange: -4, changeInterval: { low: -6, high: -1.5 }, conclusive: true }))).toBe(`−4.0 points (95% −6.0 to −1.5) across 87 concepts measured twice without the previous score: ${VERDICT_FELL}.`)
    const rose = changeLine(changes({ meanChange: 3, changeInterval: { low: 0.5, high: 5 }, conclusive: true }))
    expect(rose).toContain(VERDICT_ROSE)
    expect(rose).toContain('not proof of learning')
    expect(rose).not.toMatch(/real gain|learned|teaching helps/)
    // Review round 2, S-b: beyond noise but not beyond what the grader's drift could do over the span: no verdict.
    const drift = { perWeek: 0.2, interval: { low: -0.3, high: 0.7 }, spanWeeks: 6, expected: { low: -1.8, high: 4.2 } }
    expect(changeLine(changes({ meanChange: 3, changeInterval: { low: 0.5, high: 5 }, conclusive: false, drift, withheldForDrift: true })))
      .toBe(`+3.0 points (95% +0.5 to +5.0) across 87 concepts measured twice without the previous score: ${VERDICT_NONE}: the grader’s own drift over 6.0 weeks could move readings −1.8 to +4.2.`)
    expect(changeLine(changes({ meanChange: 3, changeInterval: { low: 0.5, high: 5 }, drift: { ...drift, perWeek: null, interval: null, expected: null }, withheldForDrift: true })))
      .toContain(`${VERDICT_NONE}: the grader’s drift over time is not measured yet, and could do this alone.`)
    expect(changeLine(changes({ meanChange: 9, changeInterval: { low: 5, high: 13 }, conclusive: true, drift }))).toContain(VERDICT_ROSE)
    expect(changeLine(changes({ changeInterval: null, nConcepts: 3 }))).toBe('+0.6 points across 3 concepts measured twice without the previous score: not enough data for an interval (20 concepts needed).')
    expect(changeLine(changes({ meanChange: null, changeInterval: null, nConcepts: 0 }))).toContain('No concept is measured twice')
  })
  test('per-concept flags carry their multiplicity (S3)', () => {
    expect(conceptsLine(changes())).toBe('2 concepts beyond noise after correcting for 87 tests (5 one at a time; about 4 expected by chance).')
    expect(conceptsLine(changes({ nConcepts: 0 }))).toBeNull()
  })
  test('the live scores are described with the grader drift and never given a verdict (B2)', () => {
    const line = anchoredLine(changes())!
    expect(line).toBe('Your scores (each grading starts from the previous score) moved +9.2 points across 87 concepts over 4.1 gradings on average; the grader alone raises a score about +2.1 points per grading (+8.8 here), so they are not evidence of learning.')
    expect(anchoredLine(changes({}, { meanChange: null }))).toBeNull()
  })
  test('velocity and noise: the gain threshold is shown on the 5-point grid (N1)', () => {
    expect(velocityLine(changes())).toBe('+0.3 points per week (95% −0.5 to +1.1)')
    expect(velocityLine(changes({ meanSlopePerWeek: null }))).toBeNull()
    expect(noiseLine(changes())).toBe('Prior-blind grader noise sd 6.7 points (measured from 329 regrade degrees of freedom); each reading’s own evidence adds sd 10.0, which extra gradings of it cannot average away (measured from 27 pairs of readings close in time, 95% 7.8–13.5); a blind measurement of 2 gradings must rise 30+ points over one earlier of 2 to count as a gain. Live gradings keep the previous score 72% of the time, raise it 27%, lower it 0.3%.')
    // N-b: at k = 1 the rule is about one grading; while σ_e is a fallback, replicates earn nothing and the line says so.
    const k1: Changes = { ...changes(), gainThresholdGradings: 1, gainThreshold: 18.2, noise: { ...noise, evidenceSource: 'fallback', evidenceInterval: null, evidencePairs: 3, replicateCredit: false } }
    expect(noiseLine(k1)).toContain('(fallback: fewer than 10 pairs of readings close in time, so extra gradings earn no precision yet); one blind grading must rise 20+ points over one earlier to count as a gain.')
  })
  test('feed: a grader behind the learner is named as the reason the feed is quiet (S10)', () => {
    expect(feedLine(changes())).toBe('Notifications: of 41 readings citing your messages graded in the last 14 days, 1 cited a message from within 7 days of grading and 0 were news; only news can become a notification, and only when it is a first clear reading or a gain. Grading is running about 45 days behind your messages, so the feed stays quiet until it catches up: this says nothing about your learning.')
    expect(feedLine(changes({}, {}, { withinRecency: 30, news: 6, medianLagDays: 1.2 }))).toBe('Notifications: of 41 readings citing your messages graded in the last 14 days, 30 cited a message from within 7 days of grading and 6 were news; only news can become a notification, and only when it is a first clear reading or a gain.')
    expect(feedLine(changes({}, {}, { citedReadings: 0, withinRecency: 0, medianLagDays: null }))).toBe('Notifications: no reading citing your messages was graded in the last 14 days, so there was nothing to announce.')
  })
  test('efficacy: the first-probe estimate is the headline, says it is the first probe and counts first probes with no reading; the opportunistic one never carries a verdict', () => {
    expect(efficacyLine(holdout(null))).toBe('Teaching vs holdout (answer to each concept’s first probe): no first probe answered yet. All readings: setting baseline: 3 of 20 held-out concepts measured twice (taught: 12 of 20).')
    expect(efficacyLine(holdout(estimate({ measuredTwice: arms(4, 1) })))).toContain('(answer to each concept’s first probe): setting baseline: 1 of 20 held-out concepts measured twice (taught: 4 of 20); first probe without a reading: taught 40, held out 9; probed so far: taught 120 of 600, held out 30 of 150.')
    expect(efficacyLine(holdout(estimate({ measuredTwice: arms(4, 1), baselineOnly: arms(0, 0) })))).not.toContain('without a reading')
    const probe = estimate({ state: 'estimate', measuredTwice: arms(90, 22), baselineOnly: arms(30, 8), effect: 6, interval: { low: 1, high: 11 }, conclusive: true, adjustedForElapsed: true })
    const line = efficacyLine(holdout(probe, { state: 'estimate', measuredTwice: arms(140, 30), effect: 9, interval: { low: 4, high: 14 }, conclusive: true }))
    expect(line).toBe('Teaching vs holdout (answer to each concept’s first probe): +6.0 points (95% +1.0 to +11.0), adjusted for baseline and weeks to the answer (taught 3.9 wk, held out 1.1 wk), n = 90 taught, 22 held out; first probe without a reading: taught 30, held out 8; probed so far: taught 120 of 600, held out 30 of 150: taught concepts scored higher on probes beyond grader noise. All readings: +9.0 points (95% +4.0 to +14.0), n = 140 taught, 30 held out; gradings between: taught 5.2, held out 1.4; not a verdict: taught concepts get read more often.')
    expect(line).not.toContain('teaching helps')
  })
  test('power: minimum detectable effect, what is still needed, and how long it takes at this pace', () => {
    expect(powerLine(holdout(null))).toBe('Smallest effect detectable today at 80% power: 21.4 points; 1,116 more concepts measured twice to detect 5 (about 30 weeks at the current pace).')
    expect(powerLine(holdout(null, { power: { ...estimate().power, weeksToTarget: null, pacePerWeek: 0 } }))).toContain('no concept was measured twice in the last four weeks')
  })
})
