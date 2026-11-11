import { describe, expect, test } from 'bun:test'
import { conceptChanges, seededRandom } from './mastery-change-statistics.js'
import {
  anchoredGrading, blindGrading, GRADER_CALIBRATION, KNOWN_TRUTH_LANE_ORDER, learnerVerdicts, simMeasurements, simulateLearner,
  type KnownTruthLane, type LearnerVerdicts,
} from './mastery-known-truth.js'
import { GAIN_MIN_POINTS } from './mastery-notifications.js'

/**
 * Known-truth recovery (docs/specs/mastery-change-statistics.md). Simulated learners with a planted
 * learning rate, graded by a simulated grader calibrated on the live one (including its ratchet),
 * read by the same statistics as a real learner. Fixed seeds: the numbers are reproducible.
 *
 * The permanent NULL TEST (review B2): with no learning at all, every verdict that can tell a learner
 * "you improved" must say so at most about 5 % of the time. It runs the ratcheting grader and a
 * differential opportunity (taught concepts read twice as often after the holdout starts), so a rule
 * that leans on the live scores, or on how often a concept is read, fails it.
 */

const SD = GRADER_CALIBRATION.blind.sd
const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i)
/** The null test pools more learners: a verdict that may fire 2.5–5 % of the time needs them to be told apart from 10 %. */
const NULL_SEEDS = Array.from({ length: 100 }, (_, i) => 1001 + i)
const verdicts = (lane: KnownTruthLane, k: number, extra: Partial<Parameters<typeof simulateLearner>[0]> = {}, seeds = SEEDS) =>
  seeds.map((seed) => {
    const s = simulateLearner({ lane, seed, k, taughtReadMultiplier: 2, probesPerWeek: 1, ...extra })
    return { s, v: learnerVerdicts(s, SD, GAIN_MIN_POINTS, 300) }
  })
const share = (xs: boolean[]) => xs.filter(Boolean).length / xs.length
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
/**
 * The most hits out of `n` independent learners that a verdict firing at the allowed 5 % gives 99 % of
 * the time: a fixed-seed count above it says the rate is above 5 %, not that a few seeds were unlucky.
 */
const allowedHits = (n: number, rate = 0.05) => {
  let cdf = 0, pmf = (1 - rate) ** n
  for (let x = 0; x <= n; x++) { cdf += pmf; if (cdf >= 0.99) return x; pmf *= ((n - x) / (x + 1)) * (rate / (1 - rate)) }
  return n
}
const hits = (xs: boolean[]) => xs.filter(Boolean).length
const rose = (v: LearnerVerdicts) => !!v.blind.changeInterval && v.blind.changeInterval[0] > 0

test('allowedHits is the 99th percentile of Binomial(n, 5 %)', () => {
  expect(allowedHits(18)).toBe(4) // P(X ≤ 3) = 0.988
  expect(allowedHits(100)).toBe(11)
})

describe('the simulated grader reproduces the measured one', () => {
  test('prior-blind regrade sd matches the calibration (after the 5-point grid)', () => {
    const r = seededRandom(9)
    const d = Array.from({ length: 20_000 }, () => blindGrading(r, 50) - blindGrading(r, 50))
    expect(Math.sqrt(mean(d.map((x) => x * x)) / 2)).toBeCloseTo(SD, 0)
  })
  test('anchored moves match the population: mostly equal, up about a quarter of the time, almost never down (the ratchet)', () => {
    const moves = SEEDS.slice(0, 20).flatMap((seed) => simulateLearner({ lane: 'none', seed, k: 1 }).readings.filter((r) => r.prior !== null).map((r) => r.anchored - r.prior!))
    const m = GRADER_CALIBRATION.moves
    expect(Math.abs(share(moves.map((x) => x === 0)) - m.equal)).toBeLessThan(0.03)
    expect(Math.abs(share(moves.map((x) => x > 0)) - m.up)).toBeLessThan(0.03)
    expect(share(moves.map((x) => x < 0))).toBeLessThan(0.01)
    expect(Math.abs(mean(moves) - m.mean)).toBeLessThan(0.4)
    // The table alone, with no population scaling, rises far more often than the live grader does.
    const r = seededRandom(10)
    expect(share(Array.from({ length: 5000 }, () => anchoredGrading(r, 40, 42.5, SD, 1) > 40))).toBeGreaterThan(0.4)
  })
})

describe('permanent null test: no learning, ratcheting grader, unequal opportunity', () => {
  for (const k of [2, 3]) {
    test(`k = ${k}: no "you improved" verdict fires more than about 5 % of the time`, () => {
      const runs = verdicts('none', k, {}, NULL_SEEDS)
      // The aggregate "readings rose beyond grader noise" (one side of a 95 % interval: 2.5 % nominal).
      expect(runs.every(({ v }) => v.blind.changeInterval !== null)).toBe(true)
      expect(hits(runs.map(({ v }) => rose(v)))).toBeLessThanOrEqual(allowedHits(runs.length))
      // Per-concept "beyond noise" upward flags after Benjamini–Hochberg.
      const flags = runs.flatMap(({ s }) => conceptChanges(simMeasurements(s).blind, SD))
      expect(share(flags.map((c) => c.beyondNoise && c.delta > 0))).toBeLessThanOrEqual(0.05)
      // The toast and the strip's gain (one rule): per eligible measurement.
      const eligible = runs.reduce((a, { v }) => a + v.gains.eligible, 0), announced = runs.reduce((a, { v }) => a + v.gains.announced, 0)
      expect(eligible).toBeGreaterThan(1000)
      expect(announced / eligible).toBeLessThanOrEqual(0.05)
      // The holdout headline: taught concepts never score higher on probes when teaching does nothing.
      const probes = runs.filter(({ v }) => v.probe?.interval)
      expect(probes.length).toBeGreaterThan(10)
      expect(hits(probes.map(({ v }) => v.probe!.interval![0] > 0))).toBeLessThanOrEqual(allowedHits(probes.length))
      // And the live scores, the series the old statistics read: they rise on their own, far beyond any noise.
      expect(mean(runs.map(({ v }) => v.anchored.meanChange!))).toBeGreaterThan(10)
      expect(share(runs.map(({ v }) => !!v.anchored.changeInterval && v.anchored.changeInterval[0] > 0))).toBeGreaterThan(0.9)
    })
  }

  test('k = 1 (the default policy): only first gradings are prior-blind, so no verdict is given at all', () => {
    const runs = verdicts('none', 1)
    expect(runs.every(({ v }) => v.blind.changeInterval === null && v.gains.announced === 0 && !v.probe?.interval && !v.holdout.interval)).toBe(true)
    expect(mean(runs.map(({ v }) => v.anchored.meanChange!))).toBeGreaterThan(10) // the live scores still ratchet
  })
})

describe('known-truth recovery: slow, medium and fast lanes clock in', () => {
  const k = 2
  const lanes = Object.fromEntries(KNOWN_TRUTH_LANE_ORDER.map((lane) => [lane, verdicts(lane, k)])) as Record<KnownTruthLane, ReturnType<typeof verdicts>>
  const slope = (lane: KnownTruthLane) => mean(lanes[lane].map(({ v }) => v.blind.meanSlopePerWeek!))

  test('the recovered velocity ranks the lanes and lands on the planted rate', () => {
    expect(slope('none')).toBeLessThan(slope('slow'))
    expect(slope('slow')).toBeLessThan(slope('medium'))
    expect(slope('medium')).toBeLessThan(slope('fast'))
    expect(Math.abs(slope('none'))).toBeLessThan(0.3)
    expect(slope('slow')).toBeCloseTo(1, 0)
    expect(slope('medium')).toBeCloseTo(2.5, 0)
    expect(slope('fast')).toBeCloseTo(5, 0)
  })

  test('the change interval covers the true change about 95 % of the time in every lane, with no bias', () => {
    const all: boolean[] = []
    for (const lane of KNOWN_TRUTH_LANE_ORDER) {
      const runs = lanes[lane]
      const covered = runs.map(({ v }) => v.blind.changeInterval![0] <= v.trueChange! && v.trueChange! <= v.blind.changeInterval![1])
      all.push(...covered)
      // 40 learners per lane: 34 of 40 is the lower 1 % tail of a true 95 %.
      expect(share(covered)).toBeGreaterThanOrEqual(0.85)
      expect(Math.abs(mean(runs.map(({ v }) => v.blind.meanChange! - v.trueChange!)))).toBeLessThan(0.75)
    }
    expect(share(all)).toBeGreaterThanOrEqual(0.92)
  })

  test('power: medium and fast learners are told their readings rose; sensitivity to a true +20', () => {
    expect(share(lanes.medium.map(({ v }) => rose(v)))).toBeGreaterThanOrEqual(0.9)
    expect(share(lanes.fast.map(({ v }) => rose(v)))).toBe(1)
    expect(share(lanes.slow.map(({ v }) => rose(v)))).toBeGreaterThan(share(lanes.none.map(({ v }) => rose(v))))
    const g = lanes.fast.reduce((a, { v }) => ({ n: a.n + v.gains.trueGainAtLeast20, hit: a.hit + v.gains.trueGainAnnounced }), { n: 0, hit: 0 })
    expect(g.n).toBeGreaterThan(20)
    expect(g.hit / g.n).toBeGreaterThan(0.8)
  })

  test('a planted teaching effect is found by the probe headline; none is not', () => {
    const none = verdicts('fast', k, { heldOutRateShare: 1 }), taught = verdicts('fast', k, { heldOutRateShare: 0 })
    const helps = (rs: typeof none) => rs.filter(({ v }) => v.probe?.interval).map(({ v }) => v.probe!.interval![0] > 0)
    expect(hits(helps(none))).toBeLessThanOrEqual(allowedHits(helps(none).length))
    expect(share(helps(taught))).toBeGreaterThan(share(helps(none)))
  })
})
