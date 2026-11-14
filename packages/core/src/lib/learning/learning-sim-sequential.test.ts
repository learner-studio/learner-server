import { describe, expect, test } from 'bun:test'
import { obfBoundary, obfConstant, pairedEstimate, sequentialLooks, SIM_ALPHA, tQuantileUpper, tUpper } from './learning-sim-sequential.js'
import { SIM_PREREGISTRATION } from './learning-sim-analysis.js'

const LOOKS = [...SIM_PREREGISTRATION.primary.sequential.looks]

// A seeded normal source (Park-Miller + Box-Muller): the simulation is reproducible.
const normals = (seed: number) => { let s = seed; const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }; return () => Math.sqrt(-2 * Math.log(r())) * Math.cos(2 * Math.PI * r()) }
/** Seeded runs of the pre-registered design (36 pairs, looks 12/24/36, SIM_ALPHA): the decisions and, per efficacy
 * stop, the look and the estimate; `covered`: the stop's naive 95% interval holds the truth. */
const simulate = (delta: number, sdD: number, draws: number, seed: number) => {
  const z = normals(seed), out = { efficacy: 0, futility: 0, pairs: 0, covered: 0 }, supported: number[][] = [[], [], []]
  for (let i = 0; i < draws; i++) {
    const pairs = Array.from({ length: LOOKS.at(-1)! }, (_, pair) => ({ lane: 'fast', pair, diff: delta + sdD * z() }))
    const stop = sequentialLooks(pairs, LOOKS, LOOKS.at(-1)!).at(-1)!
    if (stop.decision === 'efficacy') { out.efficacy++; supported[stop.look - 1]!.push(stop.estimate.mean) }
    if (stop.decision === 'futility') out.futility++
    if (stop.estimate.lo <= delta && delta <= stop.estimate.hi) out.covered++
    out.pairs += stop.plannedPairs
  }
  const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  return { power: out.efficacy / draws, futility: out.futility / draws, expectedPairs: out.pairs / draws, naiveCoverage: out.covered / draws,
    whenSupported: m(supported.flat()), atLook1: m(supported[0]!), atLook2: m(supported[1]!) }
}

describe('revision 10: the group-sequential paired primary (design D.4)', () => {
  test('the t distribution, and the O\'Brien-Fleming constant by grid integration (scratch/obf.py) at both alphas', () => {
    expect(tUpper(2.262, 9)).toBeCloseTo(0.025, 4)
    expect(tQuantileUpper(0.025, 29)).toBeCloseTo(2.0452, 3)
    expect(tQuantileUpper(0.025, 1e7)).toBeCloseTo(1.96, 3)
    // The programme's alpha minus revision 9's spent look-1 alpha (its single look's nominal p, 0.00026).
    expect(SIM_ALPHA).toBeCloseTo(0.02474, 12)
    // At 0.025 the integration reproduces the standard table (c_3 2.004) and obf.py's 2.0039.
    expect(+obfConstant(3, 0.025).toFixed(4)).toBe(2.0039)
    expect(obfBoundary(3, 0.025).map((x) => +x.z.toFixed(3))).toEqual([3.471, 2.454, 2.004])
    expect(obfBoundary(3, 0.025).map((x) => +x.nominalP.toFixed(5))).toEqual([0.00026, 0.00706, 0.02254])
    // Revision 10's boundary (design D.4): c 2.0074, z 3.477 / 2.459 / 2.007, nominal p 0.00025 / 0.00697 / 0.02235.
    expect(+obfConstant(3).toFixed(4)).toBe(2.0074)
    expect(obfBoundary(3).map((x) => +x.z.toFixed(3))).toEqual([3.477, 2.459, 2.007])
    expect(obfBoundary(3).map((x) => +x.nominalP.toFixed(5))).toEqual([0.00025, 0.00697, 0.02235])
    // One fixed look (the e2e fixtures) is the fixed test at SIM_ALPHA.
    expect(obfBoundary(1)[0]!.nominalP).toBeCloseTo(SIM_ALPHA, 4)
    expect(LOOKS).toEqual([12, 24, 36])
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

  test('the false-positive rate at a true 0 is at most 2.8% (seeded, 60,000 runs at 12/24/36 and SIM_ALPHA)', () => {
    const nul = simulate(0, 3.4, 60_000, 20261114)
    // 2.36% at this seed (design D.4: 2.6% in seqpow.py's resampling); the Monte Carlo SE at 60,000 is 0.06 points.
    expect(nul.power).toBeLessThanOrEqual(0.028)
    expect(nul.power).toBeGreaterThan(0.018)
    expect(nul.futility).toBeGreaterThan(0.55) // design D.4: 63%
    expect(nul.expectedPairs).toBeLessThan(24) // design D.4: 22.2
  })

  test('power under the normal model at 36 pairs (design D.4, [review]: 81% at d/sd 0.5, 63% at 0.4 at alpha 0.025)', () => {
    const half = simulate(0.5, 1, 5_000, 7), four = simulate(0.4, 1, 5_000, 8)
    expect(half.power).toBeGreaterThan(0.78)
    expect(half.power).toBeLessThan(0.84)
    expect(four.power).toBeGreaterThan(0.59)
    expect(four.power).toBeLessThan(0.66)
  })

  test('the stop-bias table printed beside every stopped primary is this seeded simulation (20,000 runs per row)', () => {
    const rows = SIM_PREREGISTRATION.primary.sequential.stopBias.rows
    expect(rows.map((x) => x.truth)).toEqual(['0 (SD 3.4)', '+1.44 (d/sd 0.42)', '+2.29 (d/sd 0.62)'])
    for (const [i, [delta, sd]] of [[0, 3.4], [1.44, 1.44 / 0.42], [2.29, 2.29 / 0.62]].entries()) {
      const x = simulate(delta!, sd!, 20_000, 101 + i)
      expect({ whenSupported: +x.whenSupported.toFixed(2), atLook1: +x.atLook1.toFixed(2), atLook2: +x.atLook2.toFixed(2), naiveCoverage: +x.naiveCoverage.toFixed(3) })
        .toEqual({ whenSupported: rows[i]!.whenSupported, atLook1: rows[i]!.atLook1, atLook2: rows[i]!.atLook2, naiveCoverage: rows[i]!.naiveCoverage })
    }
  })
})
