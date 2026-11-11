// Null tests for the σ_e (evidence noise) rules, review round 3 S1 and S2.
//
// Every learner here has a FIXED true level per concept: any "gain beyond
// noise" is a false positive. The generator deliberately does not share the
// estimator's assumptions:
//  - evidence error is Student-t (5 df) scaled to σ_e, not normal;
//  - readings arrive on a Poisson clock with a rate per concept, so pair gaps
//    are irregular and the estimator's 7/28-day strata cut through them;
//  - scores are gridded to 5 points and clipped to 0..100;
//  - S2: σ_e differs by concept, either tied to read rate (sparse concepts
//    noisier) or independent of it, while the estimator pools within a stratum.
// The "round-2" comparator is the rule this replaced: one pooled point estimate
// from the pairs ≤ 7 days apart, with replicate credit.
import { describe, expect, test } from 'bun:test'
import {
  blindGain,
  conceptChanges,
  evidenceNoise,
  measurementNoise,
  seededRandom,
  type CountedReading,
} from './mastery-change-statistics.js'

const DAY = 86_400_000
const GRADER_SD = 6.74

function learner(
  seed: number,
  concepts: number,
  rateOf: (i: number, r: () => number) => number,
  sigmaOf: (i: number, rate: number) => number,
): CountedReading[] {
  const r = seededRandom(seed)
  const normal = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
  const t5 = () => {
    let chi = 0
    for (let j = 0; j < 5; j++) chi += normal() ** 2
    return normal() / Math.sqrt(chi / 5) / Math.sqrt(5 / 3)
  }
  const out: CountedReading[] = []
  for (let i = 0; i < concepts; i++) {
    const rate = rateOf(i, r)
    const sigma = sigmaOf(i, rate)
    const truth = 20 + 60 * r()
    let week = -Math.log(1 - r()) / rate
    while (week < 8) {
      const raw = truth + sigma * t5() + GRADER_SD * normal()
      out.push({
        conceptId: `c${i}`,
        at: Math.round(week * 7 * DAY),
        percent: Math.min(100, Math.max(0, Math.round(raw / 5) * 5)),
        replicates: 1,
      })
      week += -Math.log(1 - r()) / rate
    }
  }
  return out
}

interface NullRates { pairs: number; anyUp: number; anyUpRound2: number; gainRate: number; gainRateRound2: number }

function nullRates(reps: number, generate: (seed: number) => CountedReading[]): NullRates {
  let pairs = 0, anyUp = 0, anyUpRound2 = 0, gains = 0, gainsRound2 = 0, eligible = 0
  for (let rep = 0; rep < reps; rep++) {
    const readings = generate(7000 + rep)
    const evidence = evidenceNoise(readings, GRADER_SD)
    const pointEstimate = evidenceNoise(readings, GRADER_SD, { minPairs: 1 })
    pairs += evidence.pairs
    const noise = measurementNoise(GRADER_SD, evidence)
    const round2 = {
      graderSd: GRADER_SD,
      evidenceSd: pointEstimate.strata.find((s) => s.stratum === 'frequent')?.sd ?? pointEstimate.sd,
      replicateCredit: true,
    }
    if (conceptChanges(readings, noise).some((c) => c.beyondNoise && c.delta > 0)) anyUp++
    if (conceptChanges(readings, round2).some((c) => c.beyondNoise && c.delta > 0)) anyUpRound2++
    const byConcept = new Map<string, CountedReading[]>()
    for (const reading of readings) {
      const list = byConcept.get(reading.conceptId) ?? []
      list.push(reading)
      byConcept.set(reading.conceptId, list)
    }
    for (const list of byConcept.values()) {
      for (let j = 1; j < list.length; j++) {
        eligible++
        const before = list.slice(0, j).map((x) => ({ percent: x.percent, gradings: 1 }))
        const latest = { percent: list[j]!.percent, gradings: 1 }
        if (blindGain(latest, before, noise, 0, null).beyondNoise) gains++
        if (blindGain(latest, before, round2, 0, null).beyondNoise) gainsRound2++
      }
    }
  }
  return {
    pairs: pairs / reps,
    anyUp: anyUp / reps,
    anyUpRound2: anyUpRound2 / reps,
    gainRate: gains / eligible,
    gainRateRound2: gainsRound2 / eligible,
  }
}

const REPS = 150
const sparseRate = (_i: number, r: () => number) => 0.5 * Math.exp(0.5 * (2 * r() - 1))

describe('σ_e null tests (review round 3)', () => {
  test('S1: with 10-15 pairs, false gains stay at or under the nominal 5 % for true σ_e 5, 10 and 15', () => {
    for (const sigma of [5, 10, 15]) {
      const rates = nullRates(REPS, (seed) => learner(seed, 8, sparseRate, () => sigma))
      expect(rates.pairs).toBeGreaterThanOrEqual(10)
      expect(rates.pairs).toBeLessThanOrEqual(15)
      expect(rates.gainRate).toBeLessThanOrEqual(0.05)
      expect(rates.anyUp).toBeLessThanOrEqual(0.06)
    }
    // The comparator shows what the rule fixes: the round-2 point estimate,
    // at σ_e 15, exceeds the nominal rate on both counts.
    const round2 = nullRates(REPS, (seed) => learner(seed, 8, sparseRate, () => 15))
    expect(round2.gainRateRound2).toBeGreaterThan(0.05)
    expect(round2.anyUpRound2).toBeGreaterThan(0.08)
  })

  test('S2: σ_e 3 on often-read concepts and 15 on rarely-read ones keeps any-up near nominal', () => {
    const rates = nullRates(REPS, (seed) => learner(seed, 25, (i) => (i % 2 ? 2 : 0.35), (_i, rate) => (rate > 1 ? 3 : 15)))
    expect(rates.anyUp).toBeLessThanOrEqual(0.08)
    expect(rates.gainRate).toBeLessThanOrEqual(0.05)
    // Pooling the frequent concepts only (round 2) reads σ_e ≈ 4 and flags
    // the rarely-read concepts in about half the learners.
    expect(rates.anyUpRound2).toBeGreaterThan(0.3)
  })

  test('S2: σ_e 3 or 15 by concept at an equal read rate (heterogeneity the strata cannot see) stays bounded', () => {
    const rates = nullRates(REPS, (seed) => learner(seed, 25, () => 1, (i) => (i % 2 ? 3 : 15)))
    expect(rates.anyUp).toBeLessThanOrEqual(0.08)
    expect(rates.gainRate).toBeLessThanOrEqual(0.05)
  })
})
