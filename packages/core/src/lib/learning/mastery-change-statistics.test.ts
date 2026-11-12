import { describe, expect, test } from 'bun:test'
import {
  aggregateChange, ancova, benjaminiHochberg, combineReplicates, conceptChanges, effectiveGradings, gridContinuity, holdoutEffect, holdoutPower, holdoutUnits, probeHoldoutUnits,
  blindGain, driftPValue, sessionError, sharedSessionVariance, MIN_CONCEPTS_FOR_INTERVAL, gainThreshold, graderOnlyNoise, normalCdf, chiSquareQuantile, evidenceNoise, measurementVariance, FALLBACK_EVIDENCE_SD, MIN_EVIDENCE_PAIRS, MIN_MEASUREMENT_VARIANCE, MIN_PAIRS_FOR_UPPER_BOUND, EVIDENCE_UPPER_LEVEL, BOOTSTRAP_REPS, BOOTSTRAP_SEED, blindDrift, clearsDrift, randomEffectsMean, SAME_TIME_RHO, seededRandom, t975,
  ols, seededLaplace, seededNormal as normal, tBootstrapInterval, weightedSlope, WEEK_MS, Z_95_ONE_SIDED, type CountedReading, type HoldoutUnit,
} from './mastery-change-statistics.js'
import { commonTimeFollowUps } from './mastery-holdout-growthbook.js'
import { commonTimeSlope } from './mastery-change-statistics.js'

const DAY = 86_400_000
const r = (conceptId: string, day: number, percent: number, replicates?: number): CountedReading => ({ conceptId, at: day * DAY, percent, replicates })


describe('grader noise', () => {
  test('gain threshold: one-sided 95 % bound on a difference of two measurements of k, plus the grid correction, with a floor', () => {
    expect(gainThreshold(graderOnlyNoise(12), 10)).toBeCloseTo(Z_95_ONE_SIDED * 12 * Math.SQRT2 + 2.5, 9)
    expect(gainThreshold(graderOnlyNoise(12), 10, 3)).toBeCloseTo(Z_95_ONE_SIDED * 12 * Math.sqrt(2 / 3) + 2.5 / 3, 9)
    expect(gainThreshold(graderOnlyNoise(2), 10)).toBe(10) // the floor holds when the grader is precise
    // With an evidence error k buys little: σ_e 10, σ_g 6.74, k 3 against k 1.
    const shared = { graderSd: 6.74, evidenceSd: 10, replicateCredit: true }
    expect(gainThreshold(shared, 10, 3)).toBeCloseTo(Z_95_ONE_SIDED * Math.sqrt(2 * (100 + 6.74 ** 2 / 3)) + 2.5 / 3, 9)
    // Without replicate credit k changes nothing but the grid correction.
    expect(gainThreshold({ ...shared, replicateCredit: false }, 10, 3)).toBeCloseTo(Z_95_ONE_SIDED * Math.sqrt(2 * (100 + 6.74 ** 2)) + 2.5 / 3, 9)
  })
})

describe('per-concept change', () => {
  test('signed delta, declines included, from the first to the last reading by evidence time', () => {
    const out = conceptChanges([r('a', 10, 50), r('a', 1, 20), r('b', 1, 60), r('b', 3, 30), r('c', 2, 40)], graderOnlyNoise(10))
    const a = out.find((c) => c.conceptId === 'a')!, b = out.find((c) => c.conceptId === 'b')!
    expect([a.from, a.to, a.delta]).toEqual([20, 50, 30])
    expect([b.from, b.to, b.delta]).toEqual([60, 30, -30])
    expect(out.some((c) => c.conceptId === 'c')).toBe(false) // one reading: no change
    expect(a.deltaSe).toBeCloseTo(10 * Math.SQRT2, 9)
    expect(a.beyondNoise).toBe(true) // 30 > 1.96·14.1
  })

  test('beyond noise needs more than 1.96 se; replicates shrink the se', () => {
    const [single] = conceptChanges([r('a', 0, 40), r('a', 7, 60)], graderOnlyNoise(12))
    expect(single!.beyondNoise).toBe(false) // 20 < 1.96·17
    const [averaged] = conceptChanges([r('a', 0, 40, 3), r('a', 7, 60, 3)], graderOnlyNoise(12))
    expect(averaged!.deltaSe).toBeCloseTo(12 * Math.sqrt(2 / 3), 9)
    expect(averaged!.beyondNoise).toBe(true) // 20 > 1.96·9.8
  })

  test('a window keeps the last reading before it as the starting point', () => {
    const readings = [r('a', 1, 10), r('a', 5, 30), r('a', 20, 45), r('b', 1, 50), r('b', 2, 70)]
    const out = conceptChanges(readings, graderOnlyNoise(10), { since: 10 * DAY })
    expect(out.map((c) => [c.conceptId, c.from, c.to])).toEqual([['a', 30, 45]]) // b has nothing in the window
  })

  test('slope is points per week; readings at one instant carry none', () => {
    const [c] = conceptChanges([r('a', 0, 20), r('a', 7, 30), r('a', 14, 40)], graderOnlyNoise(10))
    expect(c!.slopePerWeek).toBeCloseTo(10, 9)
    // se = sd / sqrt(Σ(t − t̄)²) in weeks: Σ = 2.
    expect(c!.slopeSe).toBeCloseTo(10 / Math.SQRT2, 9)
    expect(weightedSlope([r('a', 3, 20), r('a', 3, 40)], graderOnlyNoise(10))).toBeNull()
  })

  test('a grader sd measured at exactly 0 still gives finite slopes and p-values (review 4, N3)', () => {
    // Floor = the rounding error of a whole-point score, 1/12: se of a delta √(2/12), of the slope √(1/12)/√Σ(t − t̄)².
    const [c, flat] = conceptChanges([r('a', 0, 20), r('a', 7, 30), r('a', 14, 40), r('b', 0, 50), r('b', 7, 50)], graderOnlyNoise(0))
    expect(MIN_MEASUREMENT_VARIANCE).toBe(1 / 12)
    expect(c!.slopePerWeek).toBeCloseTo(10, 9)
    expect(c!.slopeSe).toBeCloseTo(Math.sqrt(1 / 12) / Math.SQRT2, 9)
    expect(c!.deltaSe).toBeCloseTo(Math.sqrt(2 / 12), 9)
    expect(flat!.pValue).toBeCloseTo(1, 6)
    expect(flat!.slopePerWeek).toBe(0)
  })

  test('readings at 0 or 100 are flagged: the scale cannot show movement past them', () => {
    const out = conceptChanges([r('a', 0, 100), r('a', 9, 95), r('b', 0, 40), r('b', 9, 45)], graderOnlyNoise(10))
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
    const flat = aggregateChange(conceptChanges(noise, graderOnlyNoise(12)))
    expect(flat.conclusive).toBe(false)
    expect(flat.changeInterval![0]).toBeLessThan(0)
    expect(flat.changeInterval![1]).toBeGreaterThan(0)
    const up = aggregateChange(conceptChanges(gain, graderOnlyNoise(12)))
    expect(up.conclusive).toBe(true)
    expect(up.meanChange!).toBeGreaterThan(4)
    expect(up.meanSlopePerWeek!).toBeCloseTo(up.meanChange! / (20 / 7), 6) // two readings, same span: slope = change / weeks
    expect(up.nConcepts).toBe(90)
    expect(up.nReadings).toBe(180)
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
    expect(units).toEqual([{ conceptId: 't1', heldOut: false, baseline: 30, followUp: 40, gradingsBetween: 0, followUpAt: 120 * DAY, baselineAt: 95 * DAY }])
    expect(baselineOnly).toEqual({ taught: 0, heldOut: 2 })
    expect(noPreStartBaseline).toEqual({ taught: 1, heldOut: 1 })
  })

  test('probe follow-up = FIRST answer after the start: repeat probes of held-out concepts carry practice (blind-probes B-1)', () => {
    // Teaching adds +5. Held-out concepts are probed four times (the scheduler before 829754b), taught ones once, and each probe
    // answered adds +3 of practice to the next. Prior-blind noise 6 on every measurement.
    const z = normal(seededRandom(41))
    const readings: CountedReading[] = []
    for (let i = 0; i < 400; i++) {
      const heldOut = i % 5 === 0, id = `${heldOut ? 'h' : 't'}${i}`, truth = 40 + 12 * z()
      readings.push({ ...r(id, 90, truth + 6 * z()), probe: false })
      const probes = heldOut ? 4 : 1
      for (let k = 0; k < probes; k++) readings.push({ ...r(id, 101 + k, truth + (heldOut ? 0 : 5) + 3 * k + 6 * z()), probe: true })
    }
    const effect = (followUp: 'first' | 'last') => ancova(holdoutUnits(readings, phase, { followUp }).units)!.effect
    expect(Math.abs(effect('first') - 5)).toBeLessThan(1.5)
    expect(effect('last')).toBeLessThan(-2) // 5 − 9 of practice: the pooled reading reverses the sign
  })

  test('probe follow-up = the answer to the FIRST delivered probe even when answers often yield no reading (review round 6, S-1)', () => {
    // The world above, but each probe answer yields a prior-blind reading only with probability q.
    // Falling through to the first probe that DID yield one gives the held-out arm (4 probes) a
    // follow-up with earlier probes' practice behind it: −2.3 at q = 0.5 in the review's simulation.
    const z = normal(seededRandom(43)), u = seededRandom(44)
    const effects = (q: number) => {
      const readings: CountedReading[] = [], firstProbed = new Set<string>()
      for (let i = 0; i < 4000; i++) {
        const heldOut = i % 5 === 0, id = `${heldOut ? 'h' : 't'}${i}`, truth = 40 + 12 * z()
        readings.push(r(id, 90, truth + 6 * z()))
        firstProbed.add(id)
        const probes = heldOut ? 4 : 1
        for (let k = 0; k < probes; k++) if (u() < q) readings.push({ ...r(id, 101 + k, truth + (heldOut ? 0 : 5) + 3 * k + 6 * z()), probe: true, firstProbe: k === 0 })
      }
      const fallThrough = holdoutUnits(readings.filter((x) => x.probe || x.at < start), phase, { followUp: 'first' })
      const first = probeHoldoutUnits(readings, firstProbed, phase)
      return { fallThrough: ancova(fallThrough.units)!.effect, first: ancova(first.units)!.effect, attrition: first.baselineOnly }
    }
    for (const q of [1, 0.75, 0.5]) {
      const e = effects(q)
      expect(Math.abs(e.first - 5)).toBeLessThan(0.75)
      if (q < 1) expect(e.fallThrough).toBeLessThan(q === 0.75 ? 4.5 : 3.5) // review: 4.05 and 2.68
      // A first probe without a reading is attrition in its arm, at the same rate in both arms.
      expect(e.attrition.taught / 3200).toBeCloseTo(1 - q, 1)
      expect(e.attrition.heldOut / 800).toBeCloseTo(1 - q, 1)
    }
  })

  test('ANCOVA recovers the arm effect with less variance than the change score', () => {
    // Randomized arms: same true distribution, a +5 effect, grader noise 12 on both readings.
    const fits: number[] = [], changes: number[] = []
    for (let rep = 0; rep < 200; rep++) {
      const z = normal(seededRandom(100 + rep))
      const units = Array.from({ length: 200 }, (_, i) => {
        const heldOut = i % 5 === 0
        const truth = 33 + 15 * z()
        return { conceptId: `${i}`, heldOut, baseline: truth + 12 * z(), followUp: truth + (heldOut ? 0 : 5) + 12 * z(), gradingsBetween: 0, followUpAt: 0, baselineAt: 0 }
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
      ...Array.from({ length: 30 }, (_, i): HoldoutUnit => ({ conceptId: `t${i}`, heldOut: false, baseline: 30 + (i % 7) * 5, followUp: 35 + (i % 5) * 5, gradingsBetween: 0, followUpAt: 0, baselineAt: 0 })),
      ...Array.from({ length: 6 }, (_, i): HoldoutUnit => ({ conceptId: `h${i}`, heldOut: true, baseline: 30 + i * 5, followUp: 30 + (i % 3) * 10, gradingsBetween: 0, followUpAt: 0, baselineAt: 0 })),
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
      return { conceptId: `${i}`, heldOut, baseline: truth + 12 * z(), followUp: truth + (heldOut ? 0 : 10) + 12 * z(), gradingsBetween: 0, followUpAt: 0, baselineAt: 0 }
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


describe('review fixes: the noise model and its inference', () => {
  test('B1: a gain compares a blind measurement with the MEAN of earlier ones, at σ_b·√(1/k_now + 1/k_before) (S11)', () => {
    const sd = 6.74, floor = 10
    // k = 1 each side: 1.645 · 6.74 · √2 = 15.7, + 2.5 for the grid = 18.2: on the grid, +20.
    expect(blindGain({ percent: 60, gradings: 1 }, [{ percent: 45, gradings: 1 }], graderOnlyNoise(sd), floor, null).beyondNoise).toBe(false)
    expect(blindGain({ percent: 63, gradings: 1 }, [{ percent: 45, gradings: 1 }], graderOnlyNoise(sd), floor, null).beyondNoise).toBe(false)
    expect(blindGain({ percent: 65, gradings: 1 }, [{ percent: 45, gradings: 1 }], graderOnlyNoise(sd), floor, null).beyondNoise).toBe(true)
    // Three earlier measurements average to 45 (their max is 55): the mean comparator, k_before = 3.
    // 13 clears 1.645·6.74·√(4/3) = 12.8 but not with the grid's continuity correction (5 / 2 / lcm(1, 3) = 0.83): 13.6.
    expect(blindGain({ percent: 58, gradings: 1 }, [{ percent: 45, gradings: 3 }], graderOnlyNoise(sd), floor, null).beyondNoise).toBe(false)
    expect(blindGain({ percent: 58, gradings: 1 }, [{ percent: 44, gradings: 3 }], graderOnlyNoise(sd), floor, null).beyondNoise).toBe(true)
    expect(gridContinuity(1, 4)).toBe(0.625)
    expect(gridContinuity(2, 4)).toBe(0.625)
    expect(gridContinuity(1, 1)).toBe(2.5)
    expect(blindGain({ percent: 58, gradings: 1 }, [], graderOnlyNoise(sd), floor, null).beyondNoise).toBe(false)
    expect(blindGain({ percent: 58, gradings: 0 }, [{ percent: 40, gradings: 1 }], graderOnlyNoise(sd), floor, null).beyondNoise).toBe(false)
  })

  test('the gain rule stays at or below 5 % under no change for every k_now / k_before (grid discreteness, N1)', () => {
    const r = seededRandom(4), sd = 6.74
    const grading = () => Math.min(100, Math.max(0, Math.round((50 + Math.sqrt(sd ** 2 - 25 / 12) * normal(r)()) / 5) * 5))
    for (const kNow of [1, 2, 3]) for (const kBefore of [1, 2, 3, 4, 6]) {
      let fired = 0
      const n = 40_000
      for (let i = 0; i < n; i++) {
        const now = Array.from({ length: kNow }, grading), before = Array.from({ length: kBefore }, grading)
        if (blindGain({ percent: now.reduce((a, b) => a + b, 0) / kNow, gradings: kNow }, [{ percent: before.reduce((a, b) => a + b, 0) / kBefore, gradings: kBefore }], graderOnlyNoise(sd), 10, null).beyondNoise) fired++
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
    const below = aggregateChange(conceptChanges(mk(MIN_CONCEPTS_FOR_INTERVAL - 1), graderOnlyNoise(6.74)), { reps: 200 })
    expect(below.changeInterval).toBeNull()
    expect(below.conclusive).toBe(false)
    expect(below.minimumConcepts).toBe(20)
    expect(aggregateChange(conceptChanges(mk(MIN_CONCEPTS_FOR_INTERVAL), graderOnlyNoise(6.74)), { reps: 200 }).changeInterval).not.toBeNull()
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
      const agg = aggregateChange(conceptChanges(readings, graderOnlyNoise(6.74)), { reps: 50 })
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
      return { conceptId: `${i}`, heldOut, baseline: truth + 2.3 * z(), followUp: truth + 2 * gradingsBetween + 2.3 * z(), gradingsBetween, followUpAt: 0, baselineAt: 0 }
    })
    const plain = ancova(units)!, adjusted = ancova(units, { adjustForGradings: true })!
    expect(plain.effect).toBeGreaterThan(7)
    expect(Math.abs(adjusted.effect)).toBeLessThan(2 * adjusted.se + 0.5)
  })
})

describe('review round 2: the evidence error (NB1), its estimate, and the gain rule (S-c)', () => {
  const shared = { graderSd: 6.74, evidenceSd: 10, replicateCredit: true }

  test('Var(measurement) = σ_e² + σ_g²/k_eff; without replicate credit every k counts as one grading', () => {
    expect(measurementVariance(shared, 3)).toBeCloseTo(100 + 6.74 ** 2 / 3, 9)
    expect(measurementVariance(shared, 3, 3)).toBeCloseTo(100 + 6.74 ** 2 / effectiveGradings(3, 3), 9)
    expect(measurementVariance({ ...shared, replicateCredit: false }, 3)).toBeCloseTo(100 + 6.74 ** 2, 9)
  })

  test('χ² quantiles (Wilson–Hilferty) within 1 % of the table', () => {
    expect(chiSquareQuantile(0.975, 10)).toBeCloseTo(20.483, 0)
    expect(chiSquareQuantile(0.025, 10) / 3.247).toBeGreaterThan(0.99)
    expect(chiSquareQuantile(0.025, 10) / 3.247).toBeLessThan(1.01)
    expect(chiSquareQuantile(0.975, 27) / 43.195).toBeCloseTo(1, 2)
  })

  test('σ_e from disjoint single-run pairs close in time: recovered, and its interval covers about 95 %', () => {
    let covered = 0
    const reps = 400
    for (let rep = 0; rep < reps; rep++) {
      const z = normal(seededRandom(9000 + rep))
      // 30 concepts, 3 measurements each a day apart (k = 2 replicates sharing the reading's evidence error):
      // disjoint pairs give 30 pairs (1–2; 3 has no partner).
      const readings = Array.from({ length: 30 }, (_, i) => [0, 1, 2].map((d) => {
        const e = 10 * z()
        return { conceptId: `c${i}`, at: d * DAY, percent: 50 + e + (6.74 * z() + 6.74 * z()) / 2, replicates: 2 }
      })).flat()
      const est = evidenceNoise(readings, 6.74)
      expect(est.pairs).toBe(30)
      if (est.interval![0] <= 10 && 10 <= est.interval![1]) covered++
    }
    expect(covered / reps).toBeGreaterThan(0.92)
    expect(covered / reps).toBeLessThan(0.98)
  })

  test('σ_e rules (review round 3, S1): a point estimate from 30 pairs, the 80 % upper bound from 5 to 29, the fallback 18 below 5; σ̂_e = 0 never earns credit', () => {
    expect([MIN_EVIDENCE_PAIRS, MIN_PAIRS_FOR_UPPER_BOUND, FALLBACK_EVIDENCE_SD, EVIDENCE_UPPER_LEVEL]).toEqual([30, 5, 18, 0.8])
    // Weekly-read concepts: pairs a day apart. Same instant and multi-run measurements are no pair member.
    const pair = (id: string, gapDays: number, diff = 20, runs = 1): CountedReading[] => [{ conceptId: id, at: 0, percent: 40, replicates: 2, runs }, { conceptId: id, at: gapDays * DAY, percent: 40 + diff, replicates: 2, runs }]
    const frequent = (n: number, diff = 20) => [...pair('same', 0), ...pair('merged', 1, 20, 2), ...Array.from({ length: n }, (_, i) => pair(`ok${i}`, 1, diff)).flat()]
    const exact = Math.sqrt((400 - 6.74 ** 2) / 2) // every pair differs by 20: σ_e² = (400 − 6.74²·(1/2 + 1/2)) / 2
    const at30 = evidenceNoise(frequent(30), 6.74)
    expect(at30.strata.map((st) => [st.stratum, st.pairs, st.source])).toEqual([['frequent', 30, 'measured']])
    expect([at30.source, at30.replicateCredit]).toEqual(['measured', true])
    expect(at30.sd).toBeCloseTo(exact, 9)
    const at29 = evidenceNoise(frequent(29), 6.74)
    expect([at29.source, at29.replicateCredit]).toEqual(['upper_bound', false])
    expect(at29.sd).toBeCloseTo(Math.sqrt((29 * 400 / chiSquareQuantile(0.2, 29) - 6.74 ** 2) / 2), 9)
    expect(at29.sd).toBeGreaterThan(exact)
    const at4 = evidenceNoise(frequent(4), 6.74)
    expect([at4.source, at4.sd, at4.replicateCredit, at4.interval]).toEqual(['fallback', 18, false, null])
    expect(evidenceNoise(frequent(5), 6.74).source).toBe('upper_bound')
    // Pairs that differ by less than the grader alone explains: σ̂_e = 0, measured, and still no replicate credit.
    const zero = evidenceNoise(frequent(40, 5), 6.74)
    expect([zero.source, zero.sd, zero.replicateCredit]).toEqual(['measured', 0, false])
    expect(evidenceNoise([], 6.74)).toMatchObject({ source: 'fallback', sd: 18, replicateCredit: false, strata: [] })
    // Review 4, M12 / N4: below 30 pairs the same over-agreeing pairs give an 80 % upper bound of 0. That is never
    // σ_e = 0 and no jump to 18: σ_e is bounded by the whole pair variance at the 80 % level.
    const low = evidenceNoise(frequent(12, 5), 6.74)
    expect(low.source).toBe('upper_bound')
    expect(low.sd).toBeCloseTo(Math.sqrt(12 * 25 / chiSquareQuantile(0.2, 12) / 2), 9)
    // Review 5, S4 (M12′): every pair identical (possible on the 5-point grid) bounds nothing: the fallback, never σ_e = 0.
    expect(evidenceNoise(frequent(5, 0), 6.74)).toMatchObject({ source: 'fallback', sd: 18 })
    expect(low.sd).toBeGreaterThan(0)
    expect(low.sd).toBeLessThan(FALLBACK_EVIDENCE_SD)
  })

  // Review 4, M6. Generator: rarely read concepts, pairs 8–28 days apart, a per-concept learning rate of
  // 1 ± 1 a week (the estimator removes ONE common rate: it does not assume the rates are equal), normal
  // evidence error 10 and grader error 6.74 at k 1. Over 10,000 learners the sparse stratum's σ̂_e² is
  // unbiased only when the detrend's degree of freedom is charged (df = n − 1; with df = n it is low by 1/n).
  test('the sparse stratum charges the detrend one degree of freedom: σ̂_e² is unbiased at 30 pairs', () => {
    const r = seededRandom(4646), z = normal(r)
    let sum = 0
    const reps = 10000
    for (let rep = 0; rep < reps; rep++) {
      const readings: CountedReading[] = []
      for (let i = 0; i < 30; i++) {
        const gap = 8 + Math.floor(r() * 21), rate = (1 + z()) / 7
        readings.push({ conceptId: `c${i}`, at: 0, percent: 50 + 10 * z() + 6.74 * z(), replicates: 1 },
          { conceptId: `c${i}`, at: gap * DAY, percent: 50 + rate * gap + 10 * z() + 6.74 * z(), replicates: 1 })
      }
      const st = evidenceNoise(readings, 6.74).strata.find((s) => s.stratum === 'sparse')!
      expect([st.pairs, st.source]).toEqual([30, 'measured'])
      sum += st.sd ** 2
    }
    // 2σ_e² = E[(d − βgap)²] − 2σ_g² − Var(rate)·E[gap²]: the per-concept spread of rates is evidence-like.
    const rateVar = (1 / 7) ** 2 * (Array.from({ length: 21 }, (_, i) => (8 + i) ** 2).reduce((a, b) => a + b, 0) / 21)
    expect(sum / reps).toBeCloseTo(100 + rateVar / 2, -0.3) // within ±1 of 100 + 2.6
  })

  test('a stratum interval is finite or null, never infinite (dev 2026-11-11: 2 sparse pairs, df 1, gave high = Infinity, serialized as null and rejected by the contract)', () => {
    // Two rarely read concepts, one pair each, 14 and 20 days apart: the dev shape that broke both RPCs.
    const readings = [r('a', 0, 40), r('a', 14, 55), r('b', 0, 60), r('b', 20, 50)]
    const e = evidenceNoise(readings, 6.74)
    const sparse = e.strata.find((st) => st.stratum === 'sparse')!
    expect([sparse.pairs, sparse.source, sparse.interval]).toEqual([2, 'fallback', null])
    // Any pair count: both ends finite whenever an interval is given, so JSON never turns one into null.
    for (let n = 1; n <= 40; n++) {
      const rs = Array.from({ length: n }, (_, i) => [r(`s${i}`, 0, 40 + (i % 7) * 3), r(`s${i}`, 10 + (i % 15), 45 + (i % 5) * 4)]).flat()
      for (const st of evidenceNoise(rs, 6.74).strata) if (st.interval) expect(st.interval.every(Number.isFinite)).toBe(true)
    }
    expect(JSON.parse(JSON.stringify(e.strata)).every((st: { interval: unknown }) => st.interval === null || (Array.isArray(st.interval) && st.interval.every((v) => typeof v === 'number')))).toBe(true)
  })

  test('σ_e of rarely read concepts removes the learning their long gaps carry (review round 3, S2: detrend)', () => {
    // Generator: 60 concepts read twice, 10 to 28 days apart, learning about +0.8 a day (varying by concept,
    // which the estimator does not model), evidence error t-tailed sd 5 (the estimator assumes normal).
    const rand = seededRandom(97), z = normal(rand)
    const t = () => { let c = 0; for (let j = 0; j < 5; j++) c += z() ** 2; return z() / Math.sqrt(c / 5) / Math.sqrt(5 / 3) }
    const readings = Array.from({ length: 60 }, (_, i) => {
      const gap = 10 + Math.floor(rand() * 19), truth = 30 + 40 * rand(), rate = 0.8 * (0.7 + 0.6 * rand())
      return [r(`s${i}`, 0, truth + 5 * t()), r(`s${i}`, gap, truth + rate * gap + 5 * t())]
    }).flat()
    const sparse = evidenceNoise(readings, 0).strata.find((st) => st.stratum === 'sparse')!
    expect([sparse.pairs, sparse.source]).toEqual([60, 'measured'])
    // Without the detrend the learning reads as evidence error: about √((15² + 2·5²)/2) ≈ 12.
    expect(sparse.sd).toBeGreaterThan(3.5)
    expect(sparse.sd).toBeLessThan(7)
  })

  test('σ_e by read rate (review round 3, S2): a rarely read concept pairs up to 28 days apart, its stratum\'s trend removed; the larger stratum σ_e is used', () => {
    const z = normal(seededRandom(41))
    // 40 concepts read weekly-ish (gaps 1–3 days), steady evidence σ_e 3; 40 read every 2–3 weeks, noisy σ_e 15,
    // learning 0.5 a day in the rare ones (removed with the trend). Generator: gridded gradings, k = 1.
    const g = (x: number) => Math.round(x / 5) * 5
    const often = Array.from({ length: 40 }, (_, i) => [0, 2, 4, 6].map((d) => ({ conceptId: `f${i}`, at: d * DAY, percent: g(50 + 3 * z() + 6.74 * z()), replicates: 1 }))).flat()
    const rare = Array.from({ length: 40 }, (_, i) => [0, 18, 36].map((d) => ({ conceptId: `r${i}`, at: d * DAY, percent: g(50 + 0.5 * d + 15 * z() + 6.74 * z()), replicates: 1 }))).flat()
    const ev = evidenceNoise([...often, ...rare], 6.74)
    const [f, r] = ev.strata
    expect([f!.stratum, f!.concepts, r!.stratum, r!.concepts]).toEqual(['frequent', 40, 'sparse', 40])
    expect(f!.sd).toBeLessThan(7)
    expect(r!.sd).toBeGreaterThan(11)
    expect(ev.sd).toBe(r!.sd)
    // Pooled the old way (pairs within 7 days only), σ_e comes from the steady concepts alone.
    expect(evidenceNoise(often, 6.74).sd).toBeLessThan(7)
    // A pair over 28 days apart is no pair.
    expect(evidenceNoise([{ conceptId: 'x', at: 0, percent: 40 }, { conceptId: 'x', at: 29 * DAY, percent: 90 }], 6.74).strata[0]!.pairs).toBe(0)
  })

  test('NB1 null: replicates share one evidence error; the per-concept flags and the gain rule stay at 5 % with σ_e, not without it', () => {
    let bhAny = 0, bhAnyIndependent = 0, gains = 0, gainsIndependent = 0, eligible = 0
    const reps = 200
    for (let rep = 0; rep < reps; rep++) {
      const z = normal(seededRandom(7000 + rep))
      const measurement = (conceptId: string, day: number, truth: number, k: number): CountedReading => {
        const e = 10 * z()
        return { conceptId, at: day * DAY, percent: truth + e + Array.from({ length: k }, () => 6.74 * z()).reduce((a, b) => a + b, 0) / k, replicates: k }
      }
      const readings = Array.from({ length: 60 }, (_, i) => { const t = 50 + 10 * z(); return [measurement(`c${i}`, 0, t, 3), measurement(`c${i}`, 3, t, 3), measurement(`c${i}`, 14, t, 3)] }).flat()
      const ev = evidenceNoise(readings, 6.74)
      const noise = { graderSd: 6.74, evidenceSd: ev.sd, replicateCredit: ev.source === 'measured' }
      if (conceptChanges(readings, noise).some((c) => c.beyondNoise)) bhAny++
      if (conceptChanges(readings, graderOnlyNoise(6.74)).some((c) => c.beyondNoise)) bhAnyIndependent++
      for (let i = 0; i < 60; i++) {
        const [a, b] = [readings[3 * i]!, readings[3 * i + 2]!].map((x) => ({ percent: x.percent, gradings: 3 }))
        eligible++
        if (blindGain(b!, [a!], noise, 0, null).beyondNoise) gains++
        if (blindGain(b!, [a!], graderOnlyNoise(6.74), 0, null).beyondNoise) gainsIndependent++
      }
    }
    expect(bhAny / reps).toBeLessThan(0.1) // FDR 5 % under the global null: P(any flag) ≈ 5 %
    expect(bhAnyIndependent / reps).toBeGreaterThan(0.9) // σ_b alone: nearly every learner has a false discovery
    expect(gains / eligible).toBeLessThan(0.065)
    expect(gainsIndependent / eligible).toBeGreaterThan(0.2)
  })

  test('S-c: the gain rule credits a measurement merged from several runs with k_eff, not k', () => {
    const noise = graderOnlyNoise(6.74)
    // k = 3 from one run: Var 6.74²/3; from 3 runs: 6.74²/k_eff(3, 3) = 6.74²·(1 + 2ρ)/3.
    const bound = (runs: number) => Z_95_ONE_SIDED * Math.sqrt(measurementVariance(noise, 3, runs) + 6.74 ** 2 / 3) + gridContinuity(3, 3)
    const delta = (bound(1) + bound(3)) / 2
    expect(blindGain({ percent: 40 + delta, gradings: 3, runs: 1 }, [{ percent: 40, gradings: 3 }], noise, 0, null).beyondNoise).toBe(true)
    expect(blindGain({ percent: 40 + delta, gradings: 3, runs: 3 }, [{ percent: 40, gradings: 3 }], noise, 0, null).beyondNoise).toBe(false)
    // The mean before weights each measurement by its gradings, and its variance is Σk²·Var / (Σk)².
    const before = [{ percent: 40, gradings: 1 }, { percent: 50, gradings: 3 }]
    const mean = (40 + 150) / 4, v = (1 * measurementVariance(shared, 1) + 9 * measurementVariance(shared, 3)) / 16
    const b = Z_95_ONE_SIDED * Math.sqrt(measurementVariance(shared, 1) + v) + gridContinuity(1, 4)
    expect(blindGain({ percent: mean + b + 0.01, gradings: 1 }, before, shared, 0, null).beyondNoise).toBe(true)
    expect(blindGain({ percent: mean + b - 0.01, gradings: 1 }, before, shared, 0, null).beyondNoise).toBe(false)
  })
})

describe('review round 2, NB2: follow-ups at different times per arm', () => {
  test('both arms learn 2.5 a week, the held-out answer comes sooner: the elapsed covariate removes the bias', () => {
    const z = normal(seededRandom(31)), rng = seededRandom(32)
    const units: HoldoutUnit[] = Array.from({ length: 1000 }, (_, i) => {
      const heldOut = i % 5 === 0
      const truth = 50 + 10 * z()
      // Exponential wait to the first probe: 1 a week held out, 0.25 a week taught.
      const weeks = -Math.log(1 - rng()) / (heldOut ? 1 : 0.25)
      return { conceptId: `${i}`, heldOut, baseline: truth + 8 * z(), followUp: truth + 2.5 * weeks + 8 * z(), gradingsBetween: 0, baselineAt: 0, followUpAt: weeks * WEEK_MS }
    })
    const plain = ancova(units)!, adjusted = ancova(units, { adjustForElapsed: true })!
    expect(plain.effect).toBeGreaterThan(5) // ≈ 2.5 · (4 − 1) weeks, shrunk a little by the baseline slope
    expect(Math.abs(adjusted.effect)).toBeLessThan(2 * adjusted.se + 0.3)
    expect(adjusted.elapsedSlope!).toBeCloseTo(2.5, 0)
    // Every unit at one elapsed time: the column would be the intercept again, so it is left out.
    expect(ancova(units.map((u) => ({ ...u, followUpAt: WEEK_MS })), { adjustForElapsed: true })!.elapsedSlope).toBeNull()
    // GrowthBook's twin (mastery-holdout-growthbook.ts): answers moved to the mean time, then baseline-adjusted only.
    const common = commonTimeFollowUps(units)
    const gb = ancova(units.map((u) => ({ ...u, followUp: common.get(u.conceptId)! })))!
    expect(Math.abs(gb.effect)).toBeLessThan(2 * gb.se + 0.3)
    const effect = holdoutEffect(units, { baselineOnly: { taught: 0, heldOut: 0 } }, 0.2, units, { reps: 200, adjustForElapsed: true })
    expect(effect.adjustedForElapsed).toBe(true)
    expect(effect.elapsedWeeks.taught! - effect.elapsedWeeks.heldOut!).toBeGreaterThan(2)
  })
})

describe('review round 2, N-a: each correction of the interval is pinned exactly', () => {
  // The bootstrap as tBootstrapInterval draws it (same seed, same order), re-implemented here.
  const bootstrapSe = <T>(strata: T[][], stat: (s: T[][]) => number | null, reps = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED) => {
    const random = seededRandom(seed), values: number[] = []
    for (let i = 0; i < reps; i++) {
      const v = stat(strata.map((u) => Array.from({ length: u.length }, () => u[Math.floor(random() * u.length)]!)))
      if (v !== null && Number.isFinite(v)) values.push(v)
    }
    const m = values.reduce((a, b) => a + b, 0) / values.length
    return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1))
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

  test('half-width = t(df) · bootstrap se · √(n/(n − 1)) (M3, M4)', () => {
    const z = normal(seededRandom(41))
    const xs = Array.from({ length: 12 }, () => 10 * z())
    const [lo, hi] = tBootstrapInterval(avg(xs), [xs], ([s]) => avg(s!), 11)!
    expect((hi - lo) / 2).toBeCloseTo(t975(11) * bootstrapSe([xs], ([s]) => avg(s!)) * Math.sqrt(12 / 11), 9)
  })

  test('the holdout interval uses df = units − model parameters (M23)', () => {
    const z = normal(seededRandom(42))
    const units: HoldoutUnit[] = Array.from({ length: 44 }, (_, i) => ({ conceptId: `${i}`, heldOut: i % 2 === 0, baseline: 40 + 10 * z(), followUp: 45 + 10 * z(), gradingsBetween: i % 4, baselineAt: 0, followUpAt: (1 + (i % 3)) * WEEK_MS }))
    for (const [opts, p] of [[{}, 3], [{ adjustForGradings: true }, 4], [{ adjustForElapsed: true }, 4]] as const) {
      const e = holdoutEffect(units, { baselineOnly: { taught: 0, heldOut: 0 } }, 0.5, units, { reps: 300, ...opts })
      const taught = units.filter((u) => !u.heldOut), held = units.filter((u) => u.heldOut)
      const se = bootstrapSe([taught, held], ([t, h]) => ancova([...t!, ...h!], opts)?.effect ?? null, 300)
      expect((e.interval![1] - e.interval![0]) / 2).toBeCloseTo(t975(44 - p) * se * Math.sqrt(44 / 43), 9)
    }
  })

  test('the slope is weighted by precision, not unweighted (M10)', () => {
    const noise = graderOnlyNoise(10)
    // Weights k = 1, 1, 4 at weeks 0, 1, 2: the precise last measurement pulls the fit.
    const readings = [r('a', 0, 20, 1), r('a', 7, 30, 1), r('a', 14, 60, 4)]
    const w = [1, 1, 4], t = [0, 1, 2], y = [20, 30, 60]
    const sw = 6, tb = (0 + 1 + 8) / sw, yb = (20 + 30 + 240) / sw
    const sxx = w.reduce((a, wi, i) => a + wi * (t[i]! - tb) ** 2, 0), sxy = w.reduce((a, wi, i) => a + wi * (t[i]! - tb) * (y[i]! - yb), 0)
    const fit = weightedSlope(readings, noise)!
    expect(fit.slope).toBeCloseTo(sxy / sxx, 9)
    expect(fit.slope).not.toBeCloseTo(20, 1) // the unweighted slope: (60 − 20) / 2
    expect(fit.se).toBeCloseTo(10 / Math.sqrt(sxx), 9) // weights are k / σ_g², so se = σ_g / √Σk(t − t̄)²
  })
})

describe('review round 2, S-b: grader drift', () => {
  test('within-group slope of identical-evidence regrades on grading time, with a t interval; none without regrades apart in time', () => {
    // Two groups at different levels, each +1 a week: the level difference must not enter the slope.
    const d = blindDrift([[{ weeks: 0, percent: 20 }, { weeks: 1, percent: 21 }, { weeks: 2, percent: 22 }], [{ weeks: 5, percent: 80 }, { weeks: 6, percent: 81 }], [{ weeks: 3, percent: 50 }]], 6.74)
    expect(d.perWeek).toBeCloseTo(1, 9)
    expect([d.gradings, d.groups, d.sxxWeeks2]).toEqual([5, 2, 2.5])
    const half = t975(2) * 6.74 / Math.sqrt(2.5)
    expect(d.interval![0]).toBeCloseTo(1 - half, 9)
    expect(d.interval![1]).toBeCloseTo(1 + half, 9)
    expect(blindDrift([[{ weeks: 1, percent: 40 }, { weeks: 1, percent: 50 }]], 6.74).interval).toBeNull()
  })

  test('a verdict must clear the drift over the span, on its own side', () => {
    expect(clearsDrift([2, 6], [-0.1, 0.3], [5])).toBe(true) // 2 > 1.5
    expect(clearsDrift([1, 6], [-0.1, 0.3], [5])).toBe(false) // 1 < 1.5
    expect(clearsDrift([-6, -1], [-0.1, 0.3], [5])).toBe(true) // −1 < −0.5
    expect(clearsDrift([-6, -0.4], [-0.1, 0.3], [5])).toBe(false)
    expect(clearsDrift([2, 6], [0.5, 0.9], [1])).toBe(true) // 2 > 0.9 even though the drift is surely upward
    expect(clearsDrift([2, 6], null, [1])).toBe(false) // unmeasured drift: withheld
    // Review 4, M32: a grader drifting DOWN. A fall inside the downward drift is not a fall, and a rise is
    // never made easier than 0 by a negative bound (max(0, …) on the rise side, min(0, …) on the fall side).
    expect(clearsDrift([-5, -1], [-3, -2], [3])).toBe(false) // −1 is not below −9, and −5 is not above 0
    expect(clearsDrift([-12, -10], [-3, -2], [3])).toBe(true) // −10 < −9
    expect(clearsDrift([-2, 2], [1, 2], [3])).toBe(false) // a rising drift never makes an interval straddling 0 a fall (2 < 3, but not < 0)
  })

  test('aggregateChange withholds "rose" that does not clear the drift, and says so', () => {
    const z = normal(seededRandom(61))
    const readings = Array.from({ length: 40 }, (_, i) => { const t = 50 + 8 * z(); return [r(`c${i}`, 0, t + 3 * z()), r(`c${i}`, 28, t + 6 + 3 * z())] }).flat()
    const changes = conceptChanges(readings, graderOnlyNoise(3))
    const free = aggregateChange(changes, { reps: 300 })
    expect(free.conclusive).toBe(true)
    expect([free.drift, free.withheldForDrift]).toEqual([null, false])
    const drifting = aggregateChange(changes, { reps: 300, drift: { perWeek: 1, interval: [0.5, 2], gradings: 60, groups: 20, sxxWeeks2: 50 } })
    expect(drifting.conclusive).toBe(false)
    expect(drifting.withheldForDrift).toBe(true)
    expect(drifting.drift!.spanWeeks).toBeCloseTo(4, 9)
    expect(drifting.drift!.expected).toEqual([2, 8])
    // Review 5, S3: the 'to' readings graded 2 weeks late: a 6-week grading span, the longer, is quoted and used.
    const late = readings.map((x) => ({ ...x, gradedAt: x.at + (x.at > 0 ? 2 * WEEK_MS : 0) }))
    const lagged = aggregateChange(conceptChanges(late, graderOnlyNoise(3)), { reps: 300, drift: { perWeek: 1, interval: [0.5, 2], gradings: 60, groups: 20, sxxWeeks2: 50 } })
    expect([lagged.drift!.spanWeeks, lagged.drift!.expected]).toEqual([6, [2, 12]])
    expect(aggregateChange(changes, { reps: 300, drift: { perWeek: 0, interval: [-0.2, 0.2], gradings: 60, groups: 20, sxxWeeks2: 500 } }).conclusive).toBe(true)
  })

  test('velocity faces the same drift rule, and a prompt revision withholds every verdict (review round 3, S3, S5)', () => {
    // Generator: 40 concepts read at weeks 0, 2, 4, 6, climbing 1.5 points a week with grader noise 3;
    // the estimator's random-effects slope assumes nothing about the readings' spacing.
    const z = normal(seededRandom(67))
    const readings = Array.from({ length: 40 }, (_, i) => { const t = 50 + 8 * z(); return [0, 14, 28, 42].map((d) => r(`c${i}`, d, t + 1.5 * d / 7 + 3 * z())) }).flat()
    const changes = conceptChanges(readings, graderOnlyNoise(3))
    const free = aggregateChange(changes, { reps: 300 })
    expect(free.slopeInterval![0]).toBeGreaterThan(0)
    expect([free.slopeConclusive, free.slopeWithheldForDrift, free.promptRevisions, free.withheldForRevision]).toEqual([true, false, null, false])
    // A drift of 1-3 points a week could produce the slope by itself: no direction for velocity.
    const drifting = aggregateChange(changes, { reps: 300, drift: { perWeek: 2, interval: [1, 3], gradings: 60, groups: 20, sxxWeeks2: 50 } })
    expect([drifting.slopeConclusive, drifting.slopeWithheldForDrift]).toEqual([false, true])
    const small = aggregateChange(changes, { reps: 300, drift: { perWeek: 0, interval: [-0.2, 0.2], gradings: 60, groups: 20, sxxWeeks2: 500 } })
    expect([small.slopeConclusive, small.conclusive]).toEqual([true, true])
    // Two prompt revisions among the readings: neither the change nor the velocity gets a verdict.
    const revised = aggregateChange(changes, { reps: 300, drift: { perWeek: 0, interval: [-0.2, 0.2], gradings: 60, groups: 20, sxxWeeks2: 500 }, promptRevisions: 2 })
    expect([revised.conclusive, revised.withheldForDrift, revised.withheldForRevision, revised.slopeConclusive, revised.promptRevisions]).toEqual([false, false, true, false, 2])
    expect(aggregateChange(changes, { reps: 300, promptRevisions: 1 }).conclusive).toBe(true)
  })
})

describe('review round 3, S4: the server and GrowthBook estimate the same thing', () => {
  test('the time-adjusted ANCOVA is OLS of the GrowthBook common-time column on [1, baseline, taught], with the slope counted in df', () => {
    // Generator: baselines at different times (−8 to 0 weeks), measured with error, linear common learning 2.5 a week,
    // held-out answers sooner. The estimator does not model the baseline's error.
    const z = normal(seededRandom(83))
    const units: HoldoutUnit[] = Array.from({ length: 300 }, (_, i) => {
      const heldOut = i % 5 === 0, tb = -8 * ((i * 0.618) % 1), tf = heldOut ? 1 + 0.5 * z() : 3.5 + z()
      const truth = 50 + 12 * z()
      return { conceptId: `${i}`, heldOut, baseline: truth + 2.5 * tb + 11 * z(), followUp: truth + 2.5 * tf + 11 * z(), gradingsBetween: 0, baselineAt: tb * WEEK_MS, followUpAt: tf * WEEK_MS }
    })
    const fit = ancova(units, { adjustForElapsed: true })!
    const common = commonTimeFollowUps(units)
    const gb = ols(units.map((u) => [1, u.baseline, u.heldOut ? 0 : 1]), units.map((u) => common.get(u.conceptId)!))!
    expect(fit.effect).toBeCloseTo(gb.beta[2]!, 9)
    expect(fit.parameters).toBe(4)
    expect(fit.residualVariance).toBeCloseTo(gb.residualVariance * (300 - 3) / (300 - 4), 9)
  })

  test('the common slope is the POOLED WITHIN-ARM slope of change on weeks, by hand (both sides share it, so it is pinned alone)', () => {
    // Taught: (1 wk, +2), (3 wk, +6) → sxy 4, sxx 2. Held out: (2 wk, 0), (4 wk, +8) → sxy 8, sxx 2. Pooled 12/4 = 3.
    // Ignoring arms would give 12/5 = 2.4; per-arm means would give 2 and 4.
    const u = (id: string, heldOut: boolean, weeks: number, change: number): HoldoutUnit =>
      ({ conceptId: id, heldOut, baseline: 40, followUp: 40 + change, gradingsBetween: 0, baselineAt: 0, followUpAt: weeks * WEEK_MS })
    const units = [u('a', false, 1, 2), u('b', false, 3, 6), u('c', true, 2, 0), u('d', true, 4, 8)]
    expect(commonTimeSlope(units)).toBeCloseTo(3, 12)
    // Follow-ups moved to the mean weeks (2.5): 42 − 3·(1 − 2.5) = 46.5, …
    expect([...commonTimeFollowUps(units).entries()]).toEqual([['a', 46.5], ['b', 44.5], ['c', 41.5], ['d', 43.5]])
  })
})

describe('round 4, strip review B1 / review3 S3: the per-concept gain rule clears the grader drift', () => {
  const dev = { graderSd: 6.7, evidenceSd: 9.9, replicateCredit: true }
  const t0 = Date.parse('2026-10-01T00:00:00Z')

  test('the strip review repro: +30 at k 2 over 4 weeks is beyond noise, but withheld under dev drift or unmeasured drift', () => {
    const before = [{ percent: 40, gradings: 2, at: t0 }], now = { percent: 70, gradings: 2, at: t0 + 4 * WEEK_MS }
    expect(blindGain(now, before, dev, 10, null).beyondNoise).toBe(true)
    expect(blindGain(now, before, dev, 10, [-4.6, 13])).toEqual({ beyondNoise: true, gain: false, withheldForDrift: true })
    expect(blindGain(now, before, dev, 10, null)).toEqual({ beyondNoise: true, gain: false, withheldForDrift: true })
    // A narrow drift interval lets the same rise through; a missing time never does.
    expect(blindGain(now, before, dev, 10, [-0.4, 0.4])).toEqual({ beyondNoise: true, gain: true, withheldForDrift: false })
    expect(blindGain({ percent: 70, gradings: 2 }, before, dev, 10, [-0.4, 0.4]).gain).toBe(false)
    // Not beyond noise: neither a gain nor withheld.
    expect(blindGain({ ...now, percent: 50 }, before, dev, 10, null)).toEqual({ beyondNoise: false, gain: false, withheldForDrift: false })
  })

  test('the drift bound is the worst end over the gap, from the k-weighted mean time before (the aggregate rule\'s, per concept)', () => {
    const noise = graderOnlyNoise(0)  // margin 0: the rise itself must exceed max(0, low·gap, high·gap)
    const before = [{ percent: 40, gradings: 1, at: t0 }, { percent: 40, gradings: 3, at: t0 + 4 * WEEK_MS }]  // mean time t0 + 3 weeks
    const now = (rise: number) => ({ percent: 40 + rise, gradings: 1, at: t0 + 5 * WEEK_MS })                // gap 2 weeks
    expect(blindGain(now(16.1), before, noise, 10, [-1, 8]).gain).toBe(true)
    expect(blindGain(now(15.9), before, noise, 10, [-1, 8]).gain).toBe(false)
    // A wholly negative drift interval bounds nothing above 0: the noise rule alone.
    expect(blindGain(now(10), before, noise, 10, [-3, -1]).gain).toBe(true)
    // An evidence-order history can put the earlier measurements' mean time AFTER now: the low end then binds.
    const late = { percent: 60, gradings: 1, at: t0 + 1 * WEEK_MS }  // gap −2 weeks
    expect(blindGain(late, before, noise, 10, [-11, 2]).gain).toBe(false)  // −11 × −2 = +22 > +20
    expect(blindGain(late, before, noise, 10, [-9, 2]).gain).toBe(true)    // +18 < +20
  })

  // Generator assumptions, and what the rule assumes that they do not: the grader drifts LINEARLY at the
  // worst end of the interval it is given (the rule's premise, shared); per-grading error is UNIFORM and
  // per-evidence error LAPLACE (heavier-tailed), both sd-matched, where the rule's bound is normal; gaps
  // and k vary per concept. No learning is planted, so every gain is false.
  test('null: with the grader drifting at the interval\'s high end and no learning, gains stay at the one-sided 5 %', () => {
    const r = seededRandom(9090), drift: [number, number] = [-0.5, 3]
    const uniform = (sd: number) => (r() - 0.5) * sd * Math.sqrt(12)
    const laplace = seededLaplace(r)
    let gains = 0, beyond = 0, n = 0
    for (let i = 0; i < 20000; i++) {
      const truth = 30 + 40 * r(), gap = 1 + Math.floor(r() * 8)
      const measure = (week: number, k: number) => ({ percent: truth + drift[1] * week + laplace(dev.evidenceSd) + Array.from({ length: k }, () => uniform(dev.graderSd)).reduce((a, b) => a + b, 0) / k, gradings: k, at: t0 + week * WEEK_MS })
      const v = blindGain(measure(gap, 1 + Math.floor(r() * 3)), [measure(0, 1 + Math.floor(r() * 3))], dev, 0, drift)
      n++; if (v.gain) gains++; if (v.beyondNoise) beyond++
    }
    expect(gains / n).toBeLessThan(0.065)
    expect(beyond / n).toBeGreaterThan(0.15)  // control: the noise rule alone is fooled by the drift
  })

  test('power: a planted +45 over 4 weeks is a gain at a narrow drift, and withheld (never a gain) while the drift is unmeasured', () => {
    const r = seededRandom(9191), z = normal(r)
    let narrow = 0, unmeasured = 0, withheld = 0
    const reps = 4000
    for (let i = 0; i < reps; i++) {
      const m = (lvl: number, week: number) => ({ percent: lvl + dev.evidenceSd * z() + (dev.graderSd * (z() + z())) / 2, gradings: 2, at: t0 + week * WEEK_MS })
      const before = [m(30, 0)], now = m(75, 4)
      if (blindGain(now, before, dev, 10, [-0.4, 0.4]).gain) narrow++
      const u = blindGain(now, before, dev, 10, null)
      if (u.gain) unmeasured++; if (u.withheldForDrift) withheld++
    }
    expect(narrow / reps).toBeGreaterThan(0.75)
    expect(unmeasured).toBe(0)
    expect(withheld / reps).toBeGreaterThan(0.75)
  })
})

describe('review 4, S4: per-concept flags clear the grader drift over each concept\'s span', () => {
  const noise = { graderSd: 6.7, evidenceSd: 10, replicateCredit: false }
  const se = Math.sqrt(2 * (6.7 ** 2 + 10 ** 2))

  test('the drift band is [min(0, low·span), max(0, high·span)]; a zero drift gives the noise p-value', () => {
    expect(driftPValue(10, se, [0, 0], [4])).toBeCloseTo(2 * (1 - normalCdf(10 / se)), 12)
    expect(driftPValue(12, se, [1, 3], [4])).toBe(1)                                          // inside [0, 12]
    expect(driftPValue(20, se, [1, 3], [4])).toBeCloseTo(2 * (1 - normalCdf(8 / se)), 12)      // 8 above the band
    expect(driftPValue(-2, se, [1, 3], [4])).toBeCloseTo(2 * (1 - normalCdf(2 / se)), 12)      // below 0: the band's low end is 0
    expect(driftPValue(-10, se, [-2, 3], [4])).toBeCloseTo(2 * (1 - normalCdf(2 / se)), 12)    // band [−8, 12]
    // Review 5, S3: both clocks. Graded 6 weeks apart for a 4-week evidence span: band [0, 18]; a grading gap
    // of −5 weeks under a falling-or-rising drift: band [−15, 12] (−5 · 3 and −5 · −2 = +10 ≤ 12).
    expect(driftPValue(20, se, [1, 3], [4, 6])).toBeCloseTo(2 * (1 - normalCdf(2 / se)), 12)
    expect(driftPValue(-16, se, [-2, 3], [4, -5])).toBeCloseTo(2 * (1 - normalCdf(1 / se)), 12)
  })

  test('no drift rule: null; unmeasured drift or a prompt change: no concept clears it', () => {
    const rs = [r('a', 0, 10), r('a', 28, 90)]
    expect(conceptChanges(rs, noise)[0]!.beyondDrift).toBeNull()
    const [c] = conceptChanges(rs, noise, { drift: { interval: [0, 1] } })
    expect(c!.beyondNoise && c!.beyondDrift).toBe(true)
    expect(conceptChanges(rs, noise, { drift: { interval: null } })[0]!.beyondDrift).toBe(false)
    expect(conceptChanges(rs, noise, { drift: { interval: [0, 1], promptRevisions: 2 } })[0]!.beyondDrift).toBe(false)
    expect(conceptChanges(rs, noise, { drift: { interval: [0, 30] } })[0]!.beyondDrift).toBe(false)  // 80 inside [0, 120]
    expect(aggregateChange(conceptChanges(rs, noise)).nBeyondDrift).toBeNull()
    expect(aggregateChange(conceptChanges(rs, noise, { drift: { interval: [0, 1] } })).nBeyondDrift).toBe(1)
  })

  // Generator assumptions, and what the rule assumes that they do not: the grader drifts LINEARLY at
  // +4 points/week, the TOP of the interval the rule is given (the rule's premise, shared); per-grading
  // error is UNIFORM and per-evidence error LAPLACE, sd-matched, where the rule's p-value is normal;
  // spans are 1–10 weeks and 2–5 readings per concept, uneven. No learning: every drift flag is false.
  test('null: a +4/week drift and no learning floods the noise flags but the drift flags stay at the FDR', () => {
    const rand = seededRandom(4404), reps = 400, drift: [number, number] = [2, 4]
    const uniform = (sd: number) => (rand() - 0.5) * sd * Math.sqrt(12)
    const laplace = seededLaplace(rand)
    let anyDrift = 0, noiseFlags = 0, driftFlags = 0
    for (let i = 0; i < reps; i++) {
      const rs: CountedReading[] = []
      for (let c = 0; c < 40; c++) {
        const truth = 20 + 60 * rand(), weeks = 1 + 9 * rand(), n = 2 + Math.floor(4 * rand())
        for (let j = 0; j < n; j++) {
          const day = (weeks * 7 * j) / (n - 1)
          rs.push(r(`c${c}`, day, truth + drift[1] * (day / 7) + laplace(noise.evidenceSd) + uniform(noise.graderSd)))
        }
      }
      const cs = conceptChanges(rs, noise, { drift: { interval: drift } })
      const nd = cs.filter((c) => c.beyondDrift).length
      noiseFlags += cs.filter((c) => c.beyondNoise).length; driftFlags += nd; anyDrift += nd > 0 ? 1 : 0
    }
    expect(noiseFlags / reps).toBeGreaterThan(3)       // the drift alone moves concepts beyond noise (about 4.4 of 40)
    // About none beyond the drift. BH under a global null flags any concept in at most 5 % of runs when the
    // errors are normal (3.8 % with this generator's errors made normal); the Laplace evidence error's
    // heavier tail roughly doubles that at BH's far end (9.5 % here). The bound records that, not 5 %.
    expect(driftFlags / reps).toBeLessThan(0.15)
    expect(anyDrift / reps).toBeLessThan(0.12)
  })

  // Review 5, S3: the panel measures drift per week of GRADING time, and the grader works through a backlog.
  // Generator: no learning; the grader drifts at the interval's top (+2/week) on grading time; each concept's
  // first reading is graded on its evidence day, later ones after an exponential lag of mean 42 days (the
  // reviewer's worst row: 38 % any-flag and 9.9 % gains on the evidence gap alone). Normal errors at σ_e 10, σ_g 6.7.
  test('null: a drift on grading time with lagged gradings is cleared neither by flags nor by gains', () => {
    const rand = seededRandom(5505), g = normal(rand), drift: [number, number] = [-0.5, 2], reps = 400
    const lag = () => -Math.log(1 - rand()) * 42 * DAY
    let anyFlag = 0, gains = 0, pairs = 0, evidenceOnly = 0
    for (let i = 0; i < reps; i++) {
      const rs: CountedReading[] = []
      for (let c = 0; c < 40; c++) {
        const truth = 20 + 60 * rand(), weeks = 1 + 9 * rand(), n = 2 + Math.floor(4 * rand())
        for (let j = 0; j < n; j++) {
          const at = (weeks * 7 * DAY * j) / (n - 1), gradedAt = at + (j ? lag() : 0)
          rs.push({ conceptId: `c${c}`, at, gradedAt, percent: truth + drift[1] * (gradedAt / WEEK_MS) + g() * noise.evidenceSd + g() * noise.graderSd, replicates: 1 })
        }
        const [first, last] = [rs.at(-n)!, rs.at(-1)!]
        const v = blindGain({ ...last, gradings: 1 }, [{ ...first, gradings: 1 }], noise, 0, drift)
        pairs++; if (v.gain) gains++
        if (blindGain({ ...last, gradedAt: undefined, gradings: 1 }, [{ ...first, gradedAt: undefined, gradings: 1 }], noise, 0, drift).gain) evidenceOnly++
      }
      if (conceptChanges(rs, noise, { drift: { interval: drift } }).some((c) => c.beyondDrift)) anyFlag++
    }
    expect(anyFlag / reps).toBeLessThan(0.05)
    expect(gains / pairs).toBeLessThan(0.05)
    expect(evidenceOnly / pairs).toBeGreaterThan(0.08) // control: the evidence gap alone is fooled
  })

  test('power: learning of +60 over the span on top of the drift is flagged beyond it', () => {
    const rand = seededRandom(4405), reps = 200, drift: [number, number] = [2, 4]
    const g = normal(rand)
    let found = 0, learners = 0
    for (let i = 0; i < reps; i++) {
      const rs: CountedReading[] = []
      for (let c = 0; c < 40; c++) {
        const learns = c < 10, weeks = 4
        rs.push(r(`c${c}`, 0, 30 + g() * 12), r(`c${c}`, weeks * 7, 30 + drift[1] * weeks + (learns ? 60 : 0) + g() * 12))
      }
      const cs = conceptChanges(rs, noise, { drift: { interval: drift } })
      found += cs.filter((c) => c.beyondDrift && Number(c.conceptId.slice(1)) < 10).length; learners += 10
    }
    expect(found / learners).toBeGreaterThan(0.7)
  })
})

describe('review 4, S1: an evidence error shared by a day\'s readings widens the aggregate intervals', () => {
  test('the cross-concept term: two concepts read on the same two days, equal weights', () => {
    // x_i = y(day 2) − y(day 1) for both: Var(mean) gains σ_u²·2·(c_1·c_2)/(Σw)² = σ_u²·2·2/4 = σ_u².
    const l = new Map([[1, -1], [2, 1]])
    expect(sharedSessionVariance([l, l], [1, 1], 9)).toBeCloseTo(9, 12)
    // Disjoint days share nothing; opposite loadings would subtract, and are clamped at 0.
    expect(sharedSessionVariance([l, new Map([[3, -1], [4, 1]])], [1, 1], 9)).toBe(0)
    expect(sharedSessionVariance([l, new Map([[1, 1], [2, -1]])], [1, 1], 9)).toBe(0)
    expect(sharedSessionVariance([l, l], [1, 1], 0)).toBe(0)
  })

  test('review 5, S4: a change loads −1 on its from-day and +1 on its to-day; a negative moment estimate is 0', () => {
    // a, c, d change from day 1 to day 2, b from day 0 to day 1 (b's to-day is their from-day), equal weights:
    // Σ_{i≠j} c_i·c_j = 2·(3·2 − 3·1) = 6 over (Σw)² = 16. A from-loading of +1 would give 18.
    const rs = ['a', 'c', 'd'].flatMap((id) => [r(id, 1, 50), r(id, 2, 60)]).concat([r('b', 0, 50), r('b', 1, 60)])
    const session = { variance: 16, pairs: 1, cluster: (at: number) => Math.floor(at / DAY) }
    expect(aggregateChange(conceptChanges(rs, graderOnlyNoise(5)), { reps: 50, session }).session!.changeSdAdded).toBeCloseTo(Math.sqrt(6), 9)
    // Two concepts read in the same two sittings moving opposite ways: Σe·e′ = −200 over ΣK = 1, clamped at 0.
    expect(sessionError([r('x', 0, 40), r('x', 1, 60), r('y', 0, 60), r('y', 1, 40)])).toMatchObject({ variance: 0, pairs: 2 })
  })

  test('the moment estimate reads a shared sitting effect and nothing from independent errors', () => {
    // Two sittings a day (07:12 and 16:48 UTC), each with its OWN effect (review 5, S1: counting the other
    // sitting's pairs halved σ̂_u²).
    const rand = seededRandom(1717), g = normal(rand)
    const sittings = Array.from({ length: 60 }, () => 8 * g())
    const make = (shared: boolean) => {
      const rs: CountedReading[] = []
      for (let c = 0; c < 80; c++) for (let s = 0; s < 60; s++) if (rand() < 0.1) rs.push(r(`c${c}`, Math.floor(s / 2) + (s % 2 ? 0.7 : 0.3), 50 + (shared ? sittings[s]! : 0) + 10 * g()))
      return sessionError(rs)
    }
    const withShared = make(true), without = make(false)
    expect(withShared.pairs).toBeGreaterThan(1000)
    // Against the sitting effects actually drawn (60 draws of sd 8 have their own spread).
    const m = sittings.reduce((x, y) => x + y, 0) / sittings.length, drawn = Math.sqrt(sittings.reduce((x, y) => x + (y - m) ** 2, 0) / (sittings.length - 1))
    expect(Math.abs(Math.sqrt(withShared.variance) / drawn - 1)).toBeLessThan(0.2)
    expect(Math.sqrt(without.variance)).toBeLessThan(2)
    // It is applied over UTC days (two sittings of day 2 are one cluster), joined when a sitting runs past
    // midnight (23:50 and 00:10 are one sitting, so days 0 and 1 are one cluster).
    const { cluster } = sessionError([r('a', 0.375, 50), r('b', 0.993, 50), r('b', 1.007, 50), r('a', 1.5, 50), r('a', 2.375, 50), r('b', 2.625, 50), r('b', 3.5, 50)])
    expect([0.375, 0.993, 1.007, 1.5, 2.375, 2.625, 3.5].map((d) => cluster(d * DAY))).toEqual([0, 0, 0, 0, 1, 1, 2])
  })

  // Generator assumptions, and what the estimator assumes that they do not: errors are shared by
  // SESSIONS at random times, several of which can fall on one day (the estimator reads sittings, the widening UTC
  // day); a session's sd is 0.6σ or 1.3σ at random (not one normal); per-reading evidence error is
  // LAPLACE and grader error UNIFORM; concepts are read by chance in a session (uneven counts per concept).
  // No learning: the true change and slope are 0 for every concept.
  const sessionWorld = (seed: number, concepts: number, sessionSd: number) => {
    const rand = seededRandom(seed), g = normal(rand)
    const sessions = Array.from({ length: 24 }, () => ({ day: Math.floor(rand() * 56 * 4) / 4, u: sessionSd * g() * (rand() < 0.5 ? 0.6 : 1.3) }))
    const truth = Array.from({ length: concepts }, () => 20 + 60 * rand())
    const rs: CountedReading[] = []
    for (const s of sessions) for (let c = 0; c < concepts; c++) if (rand() < 0.12) {
      rs.push(r(`c${c}`, s.day, truth[c]! + s.u + seededLaplace(rand)(10) + 6.7 * (rand() - 0.5) * Math.sqrt(12)))
    }
    return rs
  }
  const coverage = (concepts: number, sessionSd: number, n: number) => {
    const noise = { graderSd: 6.7, evidenceSd: 10, replicateCredit: false }
    let plain = 0, widened = 0, slopeWidened = 0, runs = 0
    for (let i = 0; i < n; i++) {
      const rs = sessionWorld(500 + i, concepts, sessionSd), cs = conceptChanges(rs, noise)
      const before = aggregateChange(cs, { reps: 200 }), after = aggregateChange(cs, { reps: 200, session: sessionError(rs) })
      if (!before.changeInterval || !after.changeInterval || !after.slopeInterval) continue
      const covers = (i: [number, number]) => i[0] <= 0 && 0 <= i[1]
      plain += covers(before.changeInterval) ? 1 : 0; widened += covers(after.changeInterval) ? 1 : 0; slopeWidened += covers(after.slopeInterval) ? 1 : 0; runs++
    }
    return { plain: plain / runs, widened: widened / runs, slope: slopeWidened / runs, runs }
  }

  test('session sd 8: the concept bootstrap covers a true 0 far below 95 %; widened, about 95 % (60 and 120 concepts)', () => {
    for (const concepts of [60, 120]) {
      const c = coverage(concepts, 8, 150)
      expect(c.runs).toBeGreaterThan(140)
      expect(c.plain).toBeLessThan(0.88)
      expect(c.widened).toBeGreaterThan(0.92)
      expect(c.slope).toBeGreaterThan(0.92)
    }
  }, 120_000)

  test('no shared error: the widening costs about nothing (coverage stays near nominal, not far above it)', () => {
    const c = coverage(60, 0, 150)
    expect(c.plain).toBeGreaterThan(0.92)
    expect(c.widened).toBeGreaterThan(0.92)
    expect(c.widened - c.plain).toBeLessThan(0.03)
  }, 120_000)
})

test('strip review B-R2b: a rise is compared with earlier measurements by the same grader prompt revision only', () => {
  const before = [{ percent: 30, gradings: 1, at: 0, revision: 'r1' }], now = { percent: 80, gradings: 1, at: 7 * 86_400_000 }
  expect(blindGain({ ...now, revision: 'r1' }, before, graderOnlyNoise(6.74), 10, [-0.4, 0.4]).gain).toBe(true)
  expect(blindGain({ ...now, revision: 'r2' }, before, graderOnlyNoise(6.74), 10, [-0.4, 0.4])).toEqual({ beyondNoise: false, gain: false, withheldForDrift: false })
})
