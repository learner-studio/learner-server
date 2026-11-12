import { describe, expect, test } from 'bun:test'
import { ancova, blindDrift, chanceCritical, conceptChanges, graderOnlyNoise, holdoutEffect, measurementNoise, probeHoldoutUnits, seededRandom } from './mastery-change-statistics.js'
import { probeCandidates } from './learning-blind-probes.js'
import {
  anchoredGrading, blindGrading, GRADER_CALIBRATION, simulatedDriftPanel, KNOWN_TRUTH_LANE_ORDER, learnerVerdicts, simMeasurements, simulateLearner,
  gainTrials, type KnownTruthLane, type LearnerVerdicts,
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
 *
 * The generator's error model is NOT the estimator's (review round 2, S-a): each reading's evidence
 * error is shared by all of its gradings (σ_e 10, dev's ρ ≈ 0.7), and the statistics are told only
 * σ_g; they estimate σ_e from the measurements as the server does. Both arms are probed at 0.25 a
 * week per concept, as the real scheduler does since 829754b (review7 S1); the NB2 and B1 tests set
 * the old unequal rate (0.25 against 1) on purpose.
 */

const SD = GRADER_CALIBRATION.blind.sd
const SEEDS = Array.from({ length: 40 }, (_, i) => 1 + i)
/** The null test pools more learners: a verdict that may fire 2.5–5 % of the time needs them to be told apart from 10 %. */
const DAY = 86_400_000, WEEK = 7 * DAY
const NULL_SEEDS = Array.from({ length: 100 }, (_, i) => 1001 + i)
const verdicts = (lane: KnownTruthLane, k: number, extra: Partial<Parameters<typeof simulateLearner>[0]> = {}, seeds = SEEDS) =>
  seeds.map((seed) => {
    // Both arms at 0.4 a week (review 4, S3): the design comparison, as the report; dev's real rate is about 0.03.
    const s = simulateLearner({ lane, seed, k, taughtReadMultiplier: 2, probesPerWeek: 0.4, ...extra })
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
/** Told "rose": the interval is above zero and, when a drift estimate is given, above the drift too (`conclusive`). */
const rose = (v: LearnerVerdicts) => !!v.blind.changeInterval && v.blind.changeInterval[0] > 0 && v.blind.conclusive

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
      // σ_e comes from the learner's own pairs, never the fallback, and near what was planted (10; the 0–100 bounds
      // clip some of it). A read-rate group with fewer than 30 pairs uses its 80 % upper bound and earns no credit (round 3, S1).
      expect(runs.filter(({ v }) => v.evidence.source !== 'fallback').length).toBeGreaterThan(90)
      expect(runs.filter(({ v }) => v.evidence.replicateCredit).every(({ v }) => v.evidence.strata.every((st) => st.source === 'measured'))).toBe(true)
      expect(mean(runs.map(({ v }) => v.evidence.sd))).toBeGreaterThan(8)
      // Per-concept "beyond noise" upward flags after Benjamini–Hochberg: per learner, any false one at most about 5 %.
      const flagged = runs.map(({ s, v }) => conceptChanges(simMeasurements(s).blind, measurementNoise(SD, v.evidence)).some((c) => c.beyondNoise && c.delta > 0))
      expect(hits(flagged)).toBeLessThanOrEqual(allowedHits(runs.length))
      // The same learners read with replicates as independent draws (σ_g alone, review round 2 M19): false flags almost always.
      const independent = runs.map(({ s }) => conceptChanges(simMeasurements(s).blind, graderOnlyNoise(SD)).some((c) => c.beyondNoise && c.delta > 0))
      expect(share(independent)).toBeGreaterThan(0.3)
      // The toast and the strip's gain (one rule): per eligible measurement.
      const eligible = runs.reduce((a, { v }) => a + v.gains.eligible, 0), announced = runs.reduce((a, { v }) => a + v.gains.announced, 0)
      expect(eligible).toBeGreaterThan(1000)
      // Nominal 5 %; the binomial sd at ~3,000 eligible is 0.4 points.
      expect(announced / eligible).toBeLessThanOrEqual(0.06)
      // Review 6, S1: per LEARNER that is many false gains in 8 weeks (about 12 at k 2–3 here). The chance gate:
      // the feed toasts a gain only when its 30 days hold at least chanceCritical(m) gains of their m comparisons,
      // and the strip's ▲ needs the same of its window. Measured on these learners: 0.5 false toasts a learner
      // (14–16 % of learners get one) and a ▲ in under 1 % of weekly 30-day looks.
      expect(mean(runs.map(({ v }) => v.gains.announced))).toBeGreaterThan(5)
      expect(mean(runs.map(({ v }) => v.gains.reported))).toBeLessThanOrEqual(0.8)
      expect(share(runs.map(({ v }) => v.gains.reported > 0))).toBeLessThanOrEqual(0.25)
      const looks = runs.flatMap(({ v }) => {
        const at = v.gains.trials.map((t) => t.at), last = Math.max(...at)
        return Array.from({ length: Math.floor((last - Math.min(...at)) / WEEK) - 2 }, (_, w) => {
          const to = last - w * WEEK, inside = v.gains.trials.filter((t) => t.at > to - 30 * DAY && t.at <= to)
          const up = new Set(inside.filter((t) => t.gain).map((t) => t.conceptId)).size
          return up > 0 && up >= chanceCritical(inside.length)
        })
      })
      expect(looks.length).toBeGreaterThan(400)
      expect(share(looks)).toBeLessThanOrEqual(0.05)
      // The probe headline at the calibrated size never reaches its minimum: only the answer to each
      // concept's FIRST probe counts (review round 6, S-1), and about 64 % of answers are graded low
      // confidence, so a learner of 159 concepts has about 11 held-out units against the 20 needed.
      expect(runs.every(({ v }) => !v.probe?.interval)).toBe(true)
      // And the live scores, the series the old statistics read: they rise on their own, far beyond any noise.
      expect(mean(runs.map(({ v }) => v.anchored.meanChange!))).toBeGreaterThan(10)
      expect(share(runs.map(({ v }) => !!v.anchored.changeInterval && v.anchored.changeInterval[0] > 0))).toBeGreaterThan(0.9)
    })
  }

  test('NB2: both arms learn, the held-out arm probed 4× as often (the scheduler before 829754b), no teaching effect: the headline adjusts for when the answer came', () => {
    const runs = verdicts('medium', 2, { concepts: 600, probesPerWeek: 0.25, heldOutProbesPerWeek: 1 }, NULL_SEEDS.slice(0, 60)).filter(({ v }) => v.probe?.interval)
    expect(runs.length).toBeGreaterThan(30)
    // Held-out answers come sooner after the baseline.
    expect(mean(runs.map(({ v }) => v.probe!.elapsedWeeks.taught! - v.probe!.elapsedWeeks.heldOut!))).toBeGreaterThan(0.5)
    expect(hits(runs.map(({ v }) => v.probe!.interval![0] > 0))).toBeLessThanOrEqual(allowedHits(runs.length))
    expect(Math.abs(mean(runs.map(({ v }) => v.probe!.effect!)))).toBeLessThan(1)
    // Without the adjustment (the first answer read at face value) common learning reads as teaching.
    const naive = runs.map(({ s }) => {
      const m = simMeasurements(s), phase = { startedAt: s.phaseStart, isHeldOut: (id: string) => s.heldOut.has(id) }
      const u = probeHoldoutUnits(m.blind, new Set(s.readings.filter((r) => r.probe).map((r) => r.conceptId)), phase)
      return holdoutEffect(u.units, u, 0.2, u.units, { reps: 300 })
    })
    expect(mean(naive.map((e) => e.effect!))).toBeGreaterThan(2)
    expect(hits(naive.map((e) => !!e.interval && e.interval[0] > 0))).toBeGreaterThan(allowedHits(runs.length))
  }, 60_000)

  /**
   * Review round 3, B1. What the generator assumes that the estimator does not: common learning in both
   * arms is CONCAVE (fast after the start, then flat), and a concept's activity drives both how often it
   * is probed and how much it learns. The estimator's time adjustment is a straight line and knows
   * nothing of activity. No teaching effect is planted.
   */
  const B1_WORLDS = [
    ['concave 10·(1 − e^(−t/1 wk)) × activity', { commonCurve: { amplitude: 10, tauWeeks: 1 }, activitySd: 0.6 }],
    ['concave 15·(1 − e^(−t/2 wk))', { commonCurve: { amplitude: 15, tauWeeks: 2 } }],
    ['activity drives probes, concave learning not tied to it', { commonCurve: { amplitude: 10, tauWeeks: 1 }, activitySd: 0.6, activityDrivesLearning: false }],
  ] as const
  const probeBias = (taughtRate: number, heldOutRate: number, world: Partial<Parameters<typeof simulateLearner>[0]>, n = 400) => mean(Array.from({ length: n }, (_, i) => {
    const s = simulateLearner({ lane: 'none', seed: 7000 + i, k: 2, concepts: 600, taughtReadMultiplier: 2, probesPerWeek: taughtRate, heldOutProbesPerWeek: heldOutRate, ...world })
    const u = probeHoldoutUnits(simMeasurements(s).blind, new Set(s.readings.filter((r) => r.probe).map((r) => r.conceptId)), { startedAt: s.phaseStart, isHeldOut: (id: string) => s.heldOut.has(id) }).units
    return ancova(u, { adjustForElapsed: true })?.effect ?? 0
  }))
  /**
   * Per-concept probe rates the real scheduler gives (taught 0.25 a week): `probeCandidates`' pick per
   * candidate appearance, by arm, on a synthetic sparse graph with 1 concept in 5 held out. Under the
   * uniform pick (829754b) the two rates are equal by construction; under the earlier arm coin the
   * held-out one was about 4×.
   */
  const schedulerRates = () => {
    const ids = Array.from({ length: 200 }, (_, i) => `b1-c${i}`), heldOut = new Set(ids.filter((_, i) => i % 5 === 0))
    const rnd = seededRandom(4242), at = () => ids[Math.floor(rnd() * ids.length)]!
    const edges = ids.map(() => ({ from: at(), to: at(), kind: 'related' as const }))
    const seen = { held_out: 0, taught: 0 }, picked = { held_out: 0, taught: 0 }
    for (let i = 0; i < 20_000; i++) {
      const c = probeCandidates({ turnId: `b1-turn-${i}`, hops: 2, turnConceptIds: [at()], edges, catalogIds: ids, heldOut })
      seen.held_out += c.held_out.length; seen.taught += c.taught.length
      if (c.pick) picked[c.pick.arm]++
    }
    const ratio = (picked.held_out / seen.held_out) / (picked.taught / seen.taught)
    return { taught: 0.25, heldOut: 0.25 * ratio, ratio }
  }

  test('B1: with EQUAL per-concept probe rates the headline is unbiased (|bias| < 0.5) under concave and activity-linked common learning; at 0.25 against 1 it is not', () => {
    for (const [, world] of B1_WORLDS) expect(Math.abs(probeBias(0.4, 0.4, world))).toBeLessThan(0.5)
    // The mechanism: a straight time line cannot put a held-out arm probed on the steep part next to a taught arm probed on the flat part.
    expect(probeBias(0.25, 1, B1_WORLDS[0][1])).toBeGreaterThan(1.5)
  }, 120_000)

  // Was test.failing under the arm coin (held-out concepts probed about 4× as often); green since the
  // uniform pick (829754b) gives every candidate the same chance.
  test("B1: under the real scheduler's arm rates the headline is unbiased (|bias| < 0.5) under concave × activity common learning", () => {
    const r = schedulerRates()
    expect(Math.abs(r.ratio - 1)).toBeLessThan(0.1)
    expect(Math.abs(probeBias(r.taught, r.heldOut, B1_WORLDS[0][1]))).toBeLessThan(0.5)
  }, 120_000)

  test('S-b: a grader drifting +1 a week and no learning: "rose" fires well above 5 % unless it must clear the measured drift', () => {
    const runs = NULL_SEEDS.slice(0, 60).map((seed) => {
      const s = simulateLearner({ lane: 'none', seed, k: 2, taughtReadMultiplier: 2, driftPerWeek: 1 })
      const drift = blindDrift(simulatedDriftPanel(seed, 1), SD)
      return { plain: learnerVerdicts(s, SD, GAIN_MIN_POINTS, 300), ruled: learnerVerdicts(s, SD, GAIN_MIN_POINTS, 300, { drift }), drift }
    })
    // Without the rule "rose" fires far above 5 % (27 % of these 60; the shared evidence error widens the interval, or it would be more).
    expect(hits(runs.map(({ plain }) => rose(plain)))).toBeGreaterThan(allowedHits(runs.length))
    // The panel (30 items regraded weekly for 8 weeks) brackets the drift...
    expect(share(runs.map(({ drift }) => drift.interval![0] <= 1 && 1 <= drift.interval![1]))).toBeGreaterThan(0.85)
    // ...and a verdict that must clear it fires at most about 5 %, withheld instead.
    expect(hits(runs.map(({ ruled }) => rose(ruled)))).toBeLessThanOrEqual(allowedHits(runs.length))
    expect(runs.some(({ ruled }) => ruled.blind.withheldForDrift)).toBe(true)
  }, 60_000)

  /** The probe headline needs about three times the calibrated concepts to reach 20 per arm (see above). */
  const PROBE_CONCEPTS = 600
  for (const k of [2, 3]) test(`k = ${k}: the first-probe headline says "taught scored higher" at most about 5 % of the time (${PROBE_CONCEPTS} concepts)`, () => {
    const probes = verdicts('none', k, { concepts: PROBE_CONCEPTS }, NULL_SEEDS.slice(0, 60)).filter(({ v }) => v.probe?.interval)
    expect(probes.length).toBeGreaterThan(30)
    expect(hits(probes.map(({ v }) => v.probe!.interval![0] > 0))).toBeLessThanOrEqual(allowedHits(probes.length))
  }, 60_000) // 60 learners of 600 concepts: seconds alone, longer beside the parallel suite

  // Review 4, S3: lane "none" has no common learning, so it passes under any probe rates and tests
  // nothing about time. Here both arms learn on a CONCAVE course tied to activity (which also drives
  // how often a concept is probed), at the scheduler's equal rates; the estimator's time adjustment is
  // a straight line and knows nothing of activity. No teaching effect: "taught higher" is a false positive.
  test('k = 2, common concave × activity learning in both arms, equal rates: "taught scored higher" at most about 5 %', () => {
    const probes = verdicts('none', 2, { concepts: PROBE_CONCEPTS, ...B1_WORLDS[0][1] }, NULL_SEEDS.slice(0, 60)).filter(({ v }) => v.probe?.interval)
    expect(probes.length).toBeGreaterThan(30)
    expect(hits(probes.map(({ v }) => v.probe!.interval![0] > 0))).toBeLessThanOrEqual(allowedHits(probes.length))
  }, 60_000)

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

  test('the velocity interval covers the true slope in every lane, also when truth bends at 100 (review N4)', () => {
    const covers = (runs: ReturnType<typeof verdicts>) => runs.map(({ v }) => v.blind.slopeInterval![0] <= v.trueSlope! && v.trueSlope! <= v.blind.slopeInterval![1])
    const all: boolean[] = []
    for (const lane of KNOWN_TRUTH_LANE_ORDER) {
      const c = covers(lanes[lane])
      all.push(...c)
      expect(share(c)).toBeGreaterThanOrEqual(0.85)
      expect(Math.abs(mean(lanes[lane].map(({ v }) => v.blind.meanSlopePerWeek! - v.trueSlope!)))).toBeLessThan(0.3)
    }
    expect(share(all)).toBeGreaterThanOrEqual(0.92)
    // Starting levels as measured, with no room left for the rise: some fast learners' concepts reach
    // 100. The estimand is the slope of that bent trajectory, and it is still covered.
    const bound = verdicts('fast', k, { reachBound: true })
    expect(bound.some(({ v }) => v.blind.nAtBound > 0)).toBe(true)
    expect(share(covers(bound))).toBeGreaterThanOrEqual(0.85)
    expect(mean(bound.map(({ v }) => v.trueSlope!))).toBeLessThan(mean(lanes.fast.map(({ v }) => v.trueSlope!)))
  })

  test('power: medium and fast learners are told their readings rose; sensitivity to a true +20', () => {
    expect(share(lanes.medium.map(({ v }) => rose(v)))).toBeGreaterThanOrEqual(0.9)
    expect(share(lanes.fast.map(({ v }) => rose(v)))).toBe(1)
    expect(share(lanes.slow.map(({ v }) => rose(v)))).toBeGreaterThan(share(lanes.none.map(({ v }) => rose(v))))
    const g = lanes.fast.reduce((a, { v }) => ({ n: a.n + v.gains.trueGainAtLeast20, hit: a.hit + v.gains.trueGainAnnounced }), { n: 0, hit: 0 })
    expect(g.n).toBeGreaterThan(20)
    // At dev's evidence error a true +20 is announced only about half the time (49 % at equal probe rates,
    // 55–60 % when the held-out arm was probed 4× as often): one measurement's own evidence error (sd 10)
    // caps what k can buy, so the bound is about +26 at k = 2 (review round 2, S-e).
    expect(g.hit / g.n).toBeGreaterThan(0.4)
    expect(g.hit / g.n).toBeLessThan(0.75)
    // Were replicates independent (σ_e = 0, and known to be) the same rule would catch above 80 %.
    const zero = verdicts('fast', k, { evidenceSd: 0 })
    const independent = zero.map(({ s }) => gainTrials(s, graderOnlyNoise(SD), GAIN_MIN_POINTS)).reduce((a, t) => ({ n: a.n + t.trueGainAtLeast20, hit: a.hit + t.trueGainAnnounced }), { n: 0, hit: 0 })
    expect(independent.hit / independent.n).toBeGreaterThan(0.8)
    // ESTIMATED from the measurements it is not known to be 0: at equal probe rates (review7 S1) a learner
    // has fewer close pairs, so most strata use the 80 % upper bound or the fallback, and the same learners
    // are caught about 66 % of the time (86 % when the held-out arm was probed 4× as often).
    const estimated = zero.reduce((a, { v }) => ({ n: a.n + v.gains.trueGainAtLeast20, hit: a.hit + v.gains.trueGainAnnounced }), { n: 0, hit: 0 })
    expect(estimated.hit / estimated.n).toBeLessThan(independent.hit / independent.n)
  }, 60_000)

  test('a planted teaching effect is found by the probe headline; none is not', () => {
    const none = verdicts('fast', k, { heldOutRateShare: 1, concepts: 600 }), taught = verdicts('fast', k, { heldOutRateShare: 0, concepts: 600 })
    const helps = (rs: typeof none) => rs.filter(({ v }) => v.probe?.interval).map(({ v }) => v.probe!.interval![0] > 0)
    expect(hits(helps(none))).toBeLessThanOrEqual(allowedHits(helps(none).length))
    expect(helps(taught).length).toBeGreaterThan(20)
    expect(share(helps(taught))).toBeGreaterThan(share(helps(none)))
  }, 60_000)
})
