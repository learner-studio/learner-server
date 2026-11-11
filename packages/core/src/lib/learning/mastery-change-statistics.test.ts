import { describe, expect, test } from 'bun:test'
import {
  aggregateChange, ancova, benjaminiHochberg, combineReplicates, conceptChanges, effectiveGradings, gridContinuity, holdoutEffect, holdoutPower, holdoutUnits,
  isBlindGain, MIN_CONCEPTS_FOR_INTERVAL, noiseAwareGainThreshold, normalCdf, pooledGraderSd, randomEffectsMean, SAME_TIME_RHO, seededRandom, t975,
  tBootstrapInterval, weightedSlope, WEEK_MS, Z_95_ONE_SIDED, type CountedReading, type HoldoutUnit,
} from './mastery-change-statistics.js'

const DAY = 86_400_000
const r = (conceptId: string, day: number, percent: number, replicates?: number): CountedReading => ({ conceptId, at: day * DAY, percent, replicates })

/** Normal draws (Box–Muller) from the seeded generator, for synthetic data with a known truth. */
const normal = (random: () => number) => () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random())

describe('grader noise', () => {
  test('pooled sd is sqrt(Σ(n−1)s²/Σ(n−1)), not the mean of group sds', () => {
    // Groups {0,10} (s² = 50) and {20,20,50} (s² = 300): pooled = sqrt((1·50 + 2·300)/3).
    const noise = pooledGraderSd([[0, 10], [20, 20, 50], [70]])
    expect(noise.sd).toBeCloseTo(Math.sqrt(650 / 3), 9)
    expect(noise.df).toBe(3)
    expect(noise.groups).toBe(2)
  })

  test('it recovers a known sd where averaging pair sds understates it', () => {
    const z = normal(seededRandom(1))
    const pairs = Array.from({ length: 4000 }, () => [50 + 12 * z(), 50 + 12 * z()])
    expect(pooledGraderSd(pairs).sd).toBeGreaterThan(11.5)
    expect(pooledGraderSd(pairs).sd).toBeLessThan(12.5)
    const meanOfSds = pairs.reduce((a, [x, y]) => a + Math.abs(x! - y!) / Math.SQRT2, 0) / pairs.length
    expect(meanOfSds).toBeLessThan(10) // ≈ 0.8 × 12: the audit's 8.6 came from this estimator
  })

  test('noise-aware gain threshold: one-sided 95 % bound on a difference of two gradings, with a floor', () => {
    expect(noiseAwareGainThreshold(12, 10)).toBeCloseTo(Z_95_ONE_SIDED * 12 * Math.SQRT2, 9)
    expect(noiseAwareGainThreshold(12, 10, 3, 3)).toBeCloseTo(Z_95_ONE_SIDED * 12 * Math.sqrt(2 / 3), 9)
    expect(noiseAwareGainThreshold(2, 10)).toBe(10) // the floor holds when the grader is precise
  })
})

describe('per-concept change', () => {
  test('signed delta, declines included, from the first to the last reading by evidence time', () => {
    const out = conceptChanges([r('a', 10, 50), r('a', 1, 20), r('b', 1, 60), r('b', 3, 30), r('c', 2, 40)], 10)
    const a = out.find((c) => c.conceptId === 'a')!, b = out.find((c) => c.conceptId === 'b')!
    expect([a.from, a.to, a.delta]).toEqual([20, 50, 30])
    expect([b.from, b.to, b.delta]).toEqual([60, 30, -30])
    expect(out.some((c) => c.conceptId === 'c')).toBe(false) // one reading: no change
    expect(a.deltaSe).toBeCloseTo(10 * Math.SQRT2, 9)
    expect(a.beyondNoise).toBe(true) // 30 > 1.96·14.1
  })

  test('beyond noise needs more than 1.96 se; replicates shrink the se', () => {
    const [single] = conceptChanges([r('a', 0, 40), r('a', 7, 60)], 12)
    expect(single!.beyondNoise).toBe(false) // 20 < 1.96·17
    const [averaged] = conceptChanges([r('a', 0, 40, 3), r('a', 7, 60, 3)], 12)
    expect(averaged!.deltaSe).toBeCloseTo(12 * Math.sqrt(2 / 3), 9)
    expect(averaged!.beyondNoise).toBe(true) // 20 > 1.96·9.8
  })

  test('a window keeps the last reading before it as the starting point', () => {
    const readings = [r('a', 1, 10), r('a', 5, 30), r('a', 20, 45), r('b', 1, 50), r('b', 2, 70)]
    const out = conceptChanges(readings, 10, { since: 10 * DAY })
    expect(out.map((c) => [c.conceptId, c.from, c.to])).toEqual([['a', 30, 45]]) // b has nothing in the window
  })

  test('slope is points per week; readings at one instant carry none', () => {
    const [c] = conceptChanges([r('a', 0, 20), r('a', 7, 30), r('a', 14, 40)], 10)
    expect(c!.slopePerWeek).toBeCloseTo(10, 9)
    // se = sd / sqrt(Σ(t − t̄)²) in weeks: Σ = 2.
    expect(c!.slopeSe).toBeCloseTo(10 / Math.SQRT2, 9)
    expect(weightedSlope([r('a', 3, 20), r('a', 3, 40)], 10)).toBeNull()
  })

  test('readings at 0 or 100 are flagged: the scale cannot show movement past them', () => {
    const out = conceptChanges([r('a', 0, 100), r('a', 9, 95), r('b', 0, 40), r('b', 9, 45)], 10)
    expect(out.find((c) => c.conceptId === 'a')!.atBound).toBe(true)
    expect(out.find((c) => c.conceptId === 'b')!.atBound).toBe(false)
  })
})

describe('pooling', () => {
  test('equal noise variances make the random-effects mean the plain mean', () => {
    const re = randomEffectsMean([{ value: 10, variance: 4 }, { value: -20, variance: 4 }, { value: 4, variance: 4 }])!
    expect(re.mean).toBeCloseTo(-2, 9)
    expect(re.tau2).toBeGreaterThan(0)
  })

  test('a noisy estimate counts for less when the others agree', () => {
    const re = randomEffectsMean([{ value: 1, variance: 1 }, { value: 1.2, variance: 1 }, { value: 50, variance: 10_000 }])!
    expect(re.mean).toBeLessThan(2)
  })

  test('the bootstrap is reproducible and stratified', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const mean = ([s]: number[][]) => s!.reduce((x, y) => x + y, 0) / s!.length
    const a = tBootstrapInterval(5.5, [xs], mean, xs.length - 1, 500, 7)
    expect(a).toEqual(tBootstrapInterval(5.5, [xs], mean, xs.length - 1, 500, 7))
    expect(a![0]).toBeLessThan(5.5)
    expect(a![1]).toBeGreaterThan(5.5)
    // Strata keep their sizes: a draw never has more 'b' than there are b units.
    tBootstrapInterval(0, [['a', 'a', 'a'], ['b']], ([s1, s2]) => { expect([s1!.length, s2!.length]).toEqual([3, 1]); return 0 }, 2, 20, 1)
  })

  test('pure noise around zero change is not conclusive; a real gain is', () => {
    const z = normal(seededRandom(3))
    const noise: CountedReading[] = [], gain: CountedReading[] = []
    for (let i = 0; i < 90; i++) {
      const truth = 30 + 15 * z()
      noise.push(r(`n${i}`, 0, truth + 12 * z()), r(`n${i}`, 20, truth + 12 * z()))
      gain.push(r(`g${i}`, 0, truth + 12 * z()), r(`g${i}`, 20, truth + 8 + 12 * z()))
    }
    const flat = aggregateChange(conceptChanges(noise, 12))
    expect(flat.conclusive).toBe(false)
    expect(flat.changeInterval![0]).toBeLessThan(0)
    expect(flat.changeInterval![1]).toBeGreaterThan(0)
    const up = aggregateChange(conceptChanges(gain, 12))
    expect(up.conclusive).toBe(true)
    expect(up.meanChange!).toBeGreaterThan(4)
    expect(up.meanSlopePerWeek!).toBeCloseTo(up.meanChange! / (20 / 7), 6) // two readings, same span: slope = change / weeks
    expect(up.nConcepts).toBe(90)
    expect(up.nReadings).toBe(180)
  })

  test('too few concepts: no interval, never conclusive', () => {
    const agg = aggregateChange(conceptChanges([r('a', 0, 0), r('a', 7, 100), r('b', 0, 0), r('b', 7, 100)], 1))
    expect(agg.meanChange).toBe(100)
    expect(agg.changeInterval).toBeNull()
    expect(agg.conclusive).toBe(false)
  })
})

describe('holdout', () => {
  const start = 100 * DAY
  const phase = { startedAt: start, isHeldOut: (id: string) => id.startsWith('h') }

  test('baseline = last measurement BEFORE the start only (S9); follow-up = latest after; the rest is counted, not dropped silently', () => {
    const { units, baselineOnly, noPreStartBaseline } = holdoutUnits([
      r('t1', 90, 20), r('t1', 95, 30), r('t1', 110, 50), r('t1', 120, 40), // before + after
      r('t2', 105, 10), r('t2', 130, 35), // both after: no untouched baseline
      r('h1', 80, 40), // before only
      r('h2', 101, 60), // one after only
      r('h3', 70, 10), r('h3', 99, 15), // two before, none after: no follow-up
    ], phase)
    expect(units).toEqual([{ conceptId: 't1', heldOut: false, baseline: 30, followUp: 40, gradingsBetween: 0, followUpAt: 120 * DAY }])
    expect(baselineOnly).toEqual({ taught: 0, heldOut: 2 })
    expect(noPreStartBaseline).toEqual({ taught: 1, heldOut: 1 })
  })

  test('ANCOVA recovers the arm effect with less variance than the change score', () => {
    // Randomized arms: same true distribution, a +5 effect, grader noise 12 on both readings.
    const fits: number[] = [], changes: number[] = []
    for (let rep = 0; rep < 200; rep++) {
      const z = normal(seededRandom(100 + rep))
      const units = Array.from({ length: 200 }, (_, i) => {
        const heldOut = i % 5 === 0
        const truth = 33 + 15 * z()
        return { conceptId: `${i}`, heldOut, baseline: truth + 12 * z(), followUp: truth + (heldOut ? 0 : 5) + 12 * z(), gradingsBetween: 0, followUpAt: 0 }
      })
      fits.push(ancova(units)!.effect)
      const d = (us: typeof units) => us.reduce((a, u) => a + u.followUp - u.baseline, 0) / us.length
      changes.push(d(units.filter((u) => !u.heldOut)) - d(units.filter((u) => u.heldOut)))
    }
    const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const v = (xs: number[]) => xs.reduce((a, b) => a + (b - m(xs)) ** 2, 0) / (xs.length - 1)
    expect(m(fits)).toBeGreaterThan(4) // unbiased: randomization makes the noisy baseline harmless
    expect(m(fits)).toBeLessThan(6)
    expect(v(fits)).toBeLessThan(v(changes)) // and more precise than the difference in change scores
  })

  test('the estimate is withheld until the minimum per arm, with a power line from the data meanwhile', () => {
    const units = [
      ...Array.from({ length: 30 }, (_, i): HoldoutUnit => ({ conceptId: `t${i}`, heldOut: false, baseline: 30 + (i % 7) * 5, followUp: 35 + (i % 5) * 5, gradingsBetween: 0, followUpAt: 0 })),
      ...Array.from({ length: 6 }, (_, i): HoldoutUnit => ({ conceptId: `h${i}`, heldOut: true, baseline: 30 + i * 5, followUp: 30 + (i % 3) * 10, gradingsBetween: 0, followUpAt: 0 })),
    ]
    const out = holdoutEffect(units, { baselineOnly: { taught: 1, heldOut: 25 } }, 0.2, units, { reps: 200 })
    expect(out.state).toBe('setting_baseline')
    expect(out.effect).toBeNull()
    expect(out.interval).toBeNull()
    expect(out.measuredTwice).toEqual({ taught: 30, heldOut: 6 })
    expect(out.power.varianceSource).toBe('all_pairs')
    expect(out.power.minimumDetectableEffect).toBeGreaterThan(0)
    expect(out.power.conceptsStillNeeded).toBe(out.power.conceptsNeeded! - 36)
  })

  test('power: n = (z_α/2 + z_β)² σ² / (d² p (1 − p)); MDE shrinks as 1/√n', () => {
    const p = holdoutPower(144, 80, 20, 0.2)
    expect(p.conceptsNeeded).toBe(Math.ceil((1.959964 + 0.841621) ** 2 * 144 / (25 * 0.16)))
    expect(p.heldOutNeeded).toBe(Math.ceil(p.conceptsNeeded! * 0.2))
    expect(p.minimumDetectableEffect).toBeCloseTo((1.959964 + 0.841621) * 12 * Math.sqrt(1 / 80 + 1 / 20), 9)
    expect(holdoutPower(144, 320, 80, 0.2).minimumDetectableEffect).toBeCloseTo(p.minimumDetectableEffect! / 2, 9)
  })

  test('with enough concepts the estimate and its interval appear', () => {
    const z = normal(seededRandom(5))
    const units = Array.from({ length: 200 }, (_, i) => {
      const heldOut = i % 4 === 0
      const truth = 35 + 15 * z()
      return { conceptId: `${i}`, heldOut, baseline: truth + 12 * z(), followUp: truth + (heldOut ? 0 : 10) + 12 * z(), gradingsBetween: 0, followUpAt: 0 }
    })
    const out = holdoutEffect(units, { baselineOnly: { taught: 0, heldOut: 0 } }, 0.25, units, { reps: 400 })
    expect(out.state).toBe('estimate')
    expect(out.effect!).toBeGreaterThan(5)
    expect(out.interval![0]).toBeLessThan(out.effect!)
    expect(out.interval![1]).toBeGreaterThan(out.effect!)
    expect(out.conclusive).toBe(true)
    expect(out.power.varianceSource).toBe('ancova')
  })
})

describe('replicates', () => {
  test('mean kept raw, grid only for display, the MEDIAN confidence (S6: stable in k)', () => {
    const c = combineReplicates([{ percent: 40, confidence: 'high' }, { percent: 55, confidence: 'medium' }, { percent: 50, confidence: 'high' }])!
    expect(c.meanPercent).toBeCloseTo(48.3333333, 6)
    expect(c.displayPercent).toBe(50)
    expect([c.min, c.max, c.replicates]).toEqual([40, 55, 3])
    expect(c.sd).toBeCloseTo(Math.sqrt(((40 - 145 / 3) ** 2 + (55 - 145 / 3) ** 2 + (50 - 145 / 3) ** 2) / 2), 9)
    expect(c.confidence).toBe('high') // medium, high, high: the weakest rule said medium
    expect(combineReplicates([{ percent: 40, confidence: 'high' }, { percent: 45, confidence: 'low' }, { percent: 50, confidence: 'low' }])!.confidence).toBe('low')
  })

  test('a replicate with no percent adds no number but its confidence counts (lower middle of an even k)', () => {
    const c = combineReplicates([{ percent: 40, confidence: 'high' }, { percent: null, confidence: 'insufficient' }])!
    expect(c.meanPercent).toBe(40)
    expect(c.replicates).toBe(1)
    expect(c.confidence).toBe('insufficient')
    expect(combineReplicates([{ percent: null, confidence: 'insufficient' }])).toBeNull()
  })

  test('one grading is unchanged', () => {
    expect(combineReplicates([{ percent: 35, confidence: 'medium' }])).toEqual({ replicates: 1, meanPercent: 35, displayPercent: 35, sd: null, min: 35, max: 35, confidence: 'medium' })
  })
})

test('WEEK_MS is a week', () => expect(WEEK_MS).toBe(604_800_000))

describe('review fixes: the noise model and its inference', () => {
  test('B1: a gain compares a blind measurement with the MEAN of earlier ones, at σ_b·√(1/k_now + 1/k_before) (S11)', () => {
    const sd = 6.74, floor = 10
    // k = 1 each side: 1.645 · 6.74 · √2 = 15.7, + 2.5 for the grid = 18.2: on the grid, +20.
    expect(isBlindGain({ percent: 60, gradings: 1 }, { mean: 45, gradings: 1 }, sd, floor)).toBe(false)
    expect(isBlindGain({ percent: 63, gradings: 1 }, { mean: 45, gradings: 1 }, sd, floor)).toBe(false)
    expect(isBlindGain({ percent: 65, gradings: 1 }, { mean: 45, gradings: 1 }, sd, floor)).toBe(true)
    // Three earlier measurements average to 45 (their max is 55): the mean comparator, k_before = 3.
    // 13 clears 1.645·6.74·√(4/3) = 12.8 but not with the grid's continuity correction (5 / 2 / lcm(1, 3) = 0.83): 13.6.
    expect(isBlindGain({ percent: 58, gradings: 1 }, { mean: 45, gradings: 3 }, sd, floor)).toBe(false)
    expect(isBlindGain({ percent: 58, gradings: 1 }, { mean: 44, gradings: 3 }, sd, floor)).toBe(true)
    expect(gridContinuity(1, 4)).toBe(0.625)
    expect(gridContinuity(2, 4)).toBe(0.625)
    expect(gridContinuity(1, 1)).toBe(2.5)
    expect(isBlindGain({ percent: 58, gradings: 1 }, null, sd, floor)).toBe(false)
    expect(isBlindGain({ percent: 58, gradings: 0 }, { mean: 40, gradings: 1 }, sd, floor)).toBe(false)
  })

  test('the gain rule stays at or below 5 % under no change for every k_now / k_before (grid discreteness, N1)', () => {
    const r = seededRandom(4), sd = 6.74
    const grading = () => Math.min(100, Math.max(0, Math.round((50 + Math.sqrt(sd ** 2 - 25 / 12) * normal(r)()) / 5) * 5))
    for (const kNow of [1, 2, 3]) for (const kBefore of [1, 2, 3, 4, 6]) {
      let fired = 0
      const n = 40_000
      for (let i = 0; i < n; i++) {
        const now = Array.from({ length: kNow }, grading), before = Array.from({ length: kBefore }, grading)
        if (isBlindGain({ percent: now.reduce((a, b) => a + b, 0) / kNow, gradings: kNow }, { mean: before.reduce((a, b) => a + b, 0) / kBefore, gradings: kBefore }, sd, 10)) fired++
      }
      expect(fired / n).toBeLessThan(0.0525) // nominal 5 %; 0.25 points is two standard errors at n = 40,000
    }
  })

  test('S7: gradings from different runs at one time are correlated; replicates of one prompt are not', () => {
    expect(effectiveGradings(3, 1)).toBe(3)
    expect(effectiveGradings(3, 3)).toBeCloseTo(3 / (1 + 2 * SAME_TIME_RHO), 9)
    expect(effectiveGradings(1, 4)).toBe(1)
  })

  test('S2: no interval below the minimum number of concepts; the minimum is reported', () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => [r(`c${i}`, 0, 40 + (i % 3)), r(`c${i}`, 14, 45 + (i % 5))]).flat()
    const below = aggregateChange(conceptChanges(mk(MIN_CONCEPTS_FOR_INTERVAL - 1), 6.74), { reps: 200 })
    expect(below.changeInterval).toBeNull()
    expect(below.conclusive).toBe(false)
    expect(below.minimumConcepts).toBe(20)
    expect(aggregateChange(conceptChanges(mk(MIN_CONCEPTS_FOR_INTERVAL), 6.74), { reps: 200 }).changeInterval).not.toBeNull()
  })

  test('N2: t975 matches Student t, including small df', () => {
    expect(t975(1)).toBeCloseTo(12.706, 2)
    expect(t975(5)).toBeCloseTo(2.571, 3)
    expect(t975(19)).toBeCloseTo(2.093, 3)
    expect(t975(60)).toBeCloseTo(2.000, 3)
    expect(t975(Infinity)).toBeCloseTo(1.96, 3)
    expect(normalCdf(Z_95_ONE_SIDED)).toBeCloseTo(0.95, 6)
  })

  test('S4: the t-bootstrap interval covers a true mean of zero 92–98 % of the time at n = 20', () => {
    let covered = 0
    const runs = 400
    for (let rep = 0; rep < runs; rep++) {
      const z = normal(seededRandom(1000 + rep))
      const xs = Array.from({ length: 20 }, () => 10 * z())
      const mean = (s: number[]) => s.reduce((a, b) => a + b, 0) / s.length
      const [lo, hi] = tBootstrapInterval(mean(xs), [xs], ([s]) => mean(s!), 19, 300, rep)!
      if (lo <= 0 && hi >= 0) covered++
    }
    expect(covered / runs).toBeGreaterThanOrEqual(0.92)
    expect(covered / runs).toBeLessThanOrEqual(0.98)
  })

  test('S3: Benjamini–Hochberg flags across concepts; under pure noise it flags about none while one-at-a-time flags ~5 %', () => {
    expect(benjaminiHochberg([0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216], 0.05)).toEqual([true, true, false, false, false, false, false, false, false, false])
    let flagged = 0, unadjusted = 0
    for (let rep = 0; rep < 20; rep++) {
      const z = normal(seededRandom(500 + rep))
      const readings = Array.from({ length: 100 }, (_, i) => { const t = 50 + 10 * z(); return [r(`c${i}`, 0, t + 6.74 * z()), r(`c${i}`, 14, t + 6.74 * z())] }).flat()
      const agg = aggregateChange(conceptChanges(readings, 6.74), { reps: 50 })
      flagged += agg.nBeyondNoise
      unadjusted += agg.nBeyondNoiseUnadjusted
      expect(agg.expectedBeyondNoiseByChance).toBe(5)
    }
    expect(flagged / 20).toBeLessThan(0.5) // FDR control: ≤ 5 % of reps flag anything, each a few at most
    expect(unadjusted / 2000).toBeGreaterThan(0.03)
    expect(unadjusted / 2000).toBeLessThan(0.07)
  })

  test('B2: unequal opportunity biases the unadjusted holdout effect; the gradings covariate removes it', () => {
    const z = normal(seededRandom(77))
    // No teaching effect. Taught concepts get ~6 gradings between, held-out ~1; each grading adds +2 (the ratchet).
    const units: HoldoutUnit[] = Array.from({ length: 400 }, (_, i) => {
      const heldOut = i % 5 === 0
      const truth = 40 + 12 * z()
      const gradingsBetween = Math.max(0, Math.round((heldOut ? 1 : 6) + 1.5 * z()))
      return { conceptId: `${i}`, heldOut, baseline: truth + 2.3 * z(), followUp: truth + 2 * gradingsBetween + 2.3 * z(), gradingsBetween, followUpAt: 0 }
    })
    const plain = ancova(units)!, adjusted = ancova(units, { adjustForGradings: true })!
    expect(plain.effect).toBeGreaterThan(7)
    expect(Math.abs(adjusted.effect)).toBeLessThan(2 * adjusted.se + 0.5)
  })
})
