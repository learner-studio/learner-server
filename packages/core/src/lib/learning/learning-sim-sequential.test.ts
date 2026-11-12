import { describe, expect, test } from 'bun:test'
import { obfBoundary, pairedEstimate, sequentialLooks, tQuantileUpper, tUpper } from './learning-sim-sequential.js'

// A seeded normal source (Park-Miller + Box-Muller): the simulation is reproducible.
const normals = (seed: number) => { let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }; return () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r()) }
const simulate = (delta: number, sdD: number, draws: number, seed: number) => {
  const z = normals(seed), out = { efficacy: 0, futility: 0, pairs: 0 }
  for (let i = 0; i < draws; i++) {
    const pairs = Array.from({ length: 30 }, (_, pair) => ({ lane: 'fast', pair, diff: delta + sdD * z() }))
    const stop = sequentialLooks(pairs, [10, 20, 30], 30).at(-1)!
    if (stop.decision === 'efficacy') out.efficacy++
    if (stop.decision === 'futility') out.futility++
    out.pairs += stop.plannedPairs
  }
  return { power: out.efficacy / draws, futility: out.futility / draws, expectedPairs: out.pairs / draws }
}

describe('revision 8: the group-sequential paired primary', () => {
  test('the t distribution and the pre-registered O\'Brien-Fleming boundaries', () => {
    expect(tUpper(2.262, 9)).toBeCloseTo(0.025, 4)
    expect(tQuantileUpper(0.025, 29)).toBeCloseTo(2.0452, 3)
    expect(tQuantileUpper(0.025, 1e7)).toBeCloseTo(1.96, 3)
    const b = obfBoundary(3)
    expect(b.map((x) => +x.z.toFixed(3))).toEqual([3.471, 2.454, 2.004])
    expect(b.map((x) => +x.nominalP.toPrecision(3))).toEqual([0.000259, 0.00706, 0.0225])
    expect(obfBoundary(1)[0]!.nominalP).toBeCloseTo(0.025, 4)
    expect(() => obfBoundary(2)).toThrow()
  })

  test('decisions: efficacy, futility, continue and final, and a look is never taken before its pairs are scheduled', () => {
    const at = (diffs: number[]) => diffs.map((diff, pair) => ({ lane: 'fast', pair, diff }))
    const big = at(Array.from({ length: 30 }, (_, i) => 10 + (i % 3) - 1))
    expect(sequentialLooks(big, [10, 20, 30], 30).map((l) => l.decision)).toEqual(['efficacy'])
    const harmful = at(Array.from({ length: 30 }, (_, i) => -2 + (i % 3) - 1))
    expect(sequentialLooks(harmful, [10, 20, 30], 30).map((l) => l.decision)).toEqual(['futility'])
    // Positive but not past 0.00026 at 10 pairs: continue; at 20 crossing 0.0071.
    const moderate = at(Array.from({ length: 30 }, (_, i) => 1 + [3, -2, 1, 0, -1][i % 5]!))
    const seq = sequentialLooks(moderate, [10, 20, 30], 30)
    expect(seq[0]!.decision).toBe('continue')
    expect(seq.at(-1)!.decision).toBe('efficacy')
    // Only 10 pairs scheduled: one look, and it may say continue (the runner then schedules block 2).
    expect(sequentialLooks(moderate.slice(0, 10), [10, 20, 30], 10).map((l) => l.decision)).toEqual(['continue'])
    expect(sequentialLooks(moderate.slice(0, 9), [10, 20, 30], 9)).toEqual([])
    // A positive but weak final look is 'final', never futility.
    const weak = at(Array.from({ length: 30 }, (_, i) => 0.3 + [3, -3][i % 2]!))
    expect(sequentialLooks(weak, [10, 20, 30], 30).at(-1)!.decision).toBe('final')
    // Review 7 S6: a last look at or below 0 is 'final' too (futility is only for looks 1 and 2).
    const late = at(Array.from({ length: 30 }, (_, i) => i < 20 ? 0.3 + [3, -3][i % 2]! : -8 + (i % 3)))
    expect(sequentialLooks(late, [10, 20, 30], 30).map((l) => l.decision)).toEqual(['continue', 'continue', 'final'])
    expect(sequentialLooks(late, [10, 20, 30], 30).at(-1)!.estimate.t).toBeLessThanOrEqual(0)
    // Two lanes weigh the same: the estimate is the mean of the lane means.
    const two = pairedEstimate([[1, 2, 3], [10, 11, 12, 13, 14]])
    expect(two.mean).toBeCloseTo((2 + 12) / 2, 9)
    expect(two.df).toBe(6)
  })

  test('the overall one-sided false-positive rate holds at 0.025 (seeded simulation, 20,000 runs at a true 0)', () => {
    const nul = simulate(0, 7, 20_000, 20261112)
    // 2.4% expected (the design memo's 100,000-draw figure); the Monte Carlo SE at 20,000 is 0.11 points.
    expect(nul.power).toBeLessThanOrEqual(0.025 + 0.003)
    expect(nul.power).toBeGreaterThan(0.018)
    expect(nul.futility).toBeGreaterThan(0.55) // half stop at look 1, an eighth at look 2
    expect(nul.expectedPairs).toBeLessThan(20)
  })

  test('the stated power at +4.5 (SD 5 and SD 8, no within-pair correlation)', () => {
    const sd5 = simulate(4.5, 5 * Math.SQRT2, 5_000, 7), sd8 = simulate(4.5, 8 * Math.SQRT2, 5_000, 8)
    expect(sd5.power).toBeGreaterThan(0.88)
    expect(sd5.power).toBeLessThan(0.93)
    expect(sd8.power).toBeGreaterThan(0.5)
    expect(sd8.power).toBeLessThan(0.57)
  })
})
