/**
 * Revision 10 (design D.4): the group-sequential paired test of the primary (AUC item-mean, on minus off, matched fast
 * pairs), pre-registered in SIM_PREREGISTRATION.primary.sequential and the spec (docs/specs/simulated-learner-experiment.md,
 * "Revision 10"). Pure: no I/O, no randomness.
 *
 * Boundary: O'Brien-Fleming type, one-sided, equally spaced looks (12, 24, 36 pairs), at the alpha revision 10 spends
 * (SIM_ALPHA = the programme's 0.025 minus revision 9's spent 0.00026). The efficacy critical z at look k of K is
 * c * sqrt(K / k); c is solved by integrating the partial-sum process with Simpson's rule on a grid that ends exactly on
 * the boundary (`obfConstant`; the 2026-11-14 correction of design D.4's grid value), turned into a nominal one-sided p
 * and applied to the paired t (df = pairs - lanes). Futility (binding, applied by the runner): at a
 * look before the last, t <= 0 stops. Both are verified by simulation in learning-sim-sequential.test.ts.
 */

/** Revision 10's one-sided alpha (design D.4, B2): the programme's 0.025 minus revision 9's spent look-1 alpha 0.00026. */
export const SIM_ALPHA = 0.025 - 0.00026

const lgamma = (x: number): number => {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]!
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i]! / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}
const betacf = (a: number, b: number, x: number) => {
  let c = 1, d = 1 / (1 - (a + b) * x / (a + 1)), h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((a + m2 - 1) * (a + m2))
    d = 1 / (1 + aa * d); c = 1 + aa / c; h *= d * c
    aa = -(a + m) * (a + b + m) * x / ((a + m2) * (a + m2 + 1))
    d = 1 / (1 + aa * d); c = 1 + aa / c
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-13) break
  }
  return h
}
const ibeta = (a: number, b: number, x: number) => {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b
}
/** P(T > t) for Student's t with df degrees of freedom. */
export const tUpper = (t: number, df: number) => { const p = 0.5 * ibeta(df / 2, 0.5, df / (df + t * t)); return t >= 0 ? p : 1 - p }
/** The t with P(T > t) = p (bisection; p in (0, 1)). */
const quantiles = new Map<string, number>()
export function tQuantileUpper(p: number, df: number) {
  const key = `${p}|${df}`, known = quantiles.get(key)
  if (known !== undefined) return known
  let lo = -1e3, hi = 1e3
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (tUpper(m, df) > p) lo = m; else hi = m }
  quantiles.set(key, (lo + hi) / 2)
  return (lo + hi) / 2
}
const phiUpper = (z: number) => {
  // Complementary normal CDF via erfc (W. J. Cody's rational approximation is overkill here; this is accurate to 1e-7).
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.5 * x)
  const erfc = t * Math.exp(-x * x - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
  return z >= 0 ? erfc / 2 : 1 - erfc / 2
}
/** The density of N(0, 1). */
const phi = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
/**
 * The one-sided type I error of K equally spaced looks at the O'Brien-Fleming constant c, no futility in the calculation
 * (binding futility only lowers the realized type I): the partial sums S_k cross b = c * sqrt(K) at some look. Each
 * look's sub-boundary density is integrated over [-9, b] by Simpson's rule with an even number of steps of at most `h`,
 * so the grid ends exactly on b. Correction of 2026-11-14 (stats review RC1, before any revision 10 data existed): the
 * design's scratch/obf.py summed a grid of step 0.02 from -9 that stops short of b, an aliasing error of -5.1e-5 at
 * 0.02474 (c 2.0074 spends 0.02479 > 0.02474); this rule is accurate to better than 1e-7 at h = 0.02.
 */
export function obfTypeI(c: number, K: number, h = 0.02) {
  const b = c * Math.sqrt(K), lo = -9, n = 2 * Math.ceil((b - lo) / h / 2), step = (b - lo) / n
  const xs = Array.from({ length: n + 1 }, (_, i) => lo + i * step)
  const w = xs.map((_, i) => ((i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * step) / 3)
  let f = xs.map(phi), cross = phiUpper(b)
  for (let k = 2; k <= K; k++) {
    cross += f.reduce((a, fx, i) => a + w[i]! * fx * phiUpper(b - xs[i]!), 0)
    f = xs.map((y) => f.reduce((a, fx, i) => a + w[i]! * fx * phi(y - xs[i]!), 0))
  }
  return cross
}
/** The O'Brien-Fleming constant c for K equally spaced looks at one-sided `alpha`: bisection on [1.8, 2.3], 40 steps,
 * returning the upper end, so the boundary never spends more than `alpha` (K = 1 is the fixed test). At SIM_ALPHA and
 * K = 3: 2.0083 (z 3.478 / 2.460 / 2.008); at 0.025: 2.0040 (the standard table's 2.004). */
export function obfConstant(K: number, alpha = SIM_ALPHA, h = 0.02) {
  let lo = 1.8, hi = 2.3
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (obfTypeI(m, K, h) > alpha) lo = m; else hi = m }
  return hi
}
const boundaries = new Map<string, Array<{ z: number; nominalP: number }>>()
/** The efficacy boundary per look: critical z and the nominal one-sided p it is applied as. */
export function obfBoundary(looks: number, alpha = SIM_ALPHA) {
  const key = `${looks}|${alpha}`
  if (!boundaries.has(key)) {
    const c = obfConstant(looks, alpha)
    boundaries.set(key, Array.from({ length: looks }, (_, i) => { const z = c * Math.sqrt(looks / (i + 1)); return { z, nominalP: phiUpper(z) } }))
  }
  return boundaries.get(key)!
}

export type PairedEstimate = { pairs: number; lanes: number; mean: number; se: number; df: number; t: number; p: number; lo: number; hi: number; lo90: number; hi90: number }
/** The paired primary: per lane the mean of the pair differences, then the mean over lanes (every lane weighs the
 * same); se from the per-lane variances, df = pairs - lanes; p one-sided (on > off); 95% and 90% t intervals. */
export function pairedEstimate(diffsByLane: number[][]): PairedEstimate {
  const pairs = diffsByLane.flat().length, lanes = diffsByLane.length
  const none = { pairs, lanes, mean: NaN, se: NaN, df: NaN, t: NaN, p: NaN, lo: NaN, hi: NaN, lo90: NaN, hi90: NaN }
  if (!lanes || diffsByLane.some((d) => d.length < 2)) return none
  const m = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  const mean = m(diffsByLane.map(m))
  const se = Math.sqrt(diffsByLane.reduce((s, d) => { const dm = m(d); return s + d.reduce((v, x) => v + (x - dm) ** 2, 0) / (d.length - 1) / d.length }, 0)) / lanes
  const df = pairs - lanes
  if (!(se > 0)) return { ...none, mean, se, df }
  const t = mean / se, q95 = tQuantileUpper(0.025, df), q90 = tQuantileUpper(0.05, df)
  return { pairs, lanes, mean, se, df, t, p: tUpper(t, df), lo: mean - q95 * se, hi: mean + q95 * se, lo90: mean - q90 * se, hi90: mean + q90 * se }
}

export type LookDecision = 'efficacy' | 'futility' | 'continue' | 'final'
export type Look = { look: number; plannedPairs: number; estimate: PairedEstimate; nominalP: number; z: number; decision: LookDecision }
/**
 * The efficacy looks on what is present: look k reads the complete pairs with a pair index below looks[k] (the
 * runner schedules pairs in blocks, so a look sees exactly its blocks). A look whose planned pairs have not all been
 * scheduled is not taken. Efficacy: p <= the look's nominal p. Futility: t <= 0 before the last look (or t not
 * computable). The sequence stops at the first efficacy or futility decision; the last look is 'final' otherwise.
 */
export function sequentialLooks(pairIndexed: Array<{ lane: string; pair: number; diff: number }>, looks: number[], scheduledPairs: number): Look[] {
  const bounds = obfBoundary(looks.length), out: Look[] = []
  const lanes = [...new Set(pairIndexed.map((p) => p.lane))].sort()
  for (let k = 0; k < looks.length; k++) {
    if (scheduledPairs < looks[k]!) break
    const estimate = pairedEstimate(lanes.map((lane) => pairIndexed.filter((p) => p.lane === lane && p.pair < looks[k]!).map((p) => p.diff)))
    const last = k === looks.length - 1
    const decision: LookDecision = estimate.p <= bounds[k]!.nominalP ? 'efficacy' : last ? 'final' : !(estimate.t > 0) ? 'futility' : 'continue'
    out.push({ look: k + 1, plannedPairs: looks[k]!, estimate, nominalP: bounds[k]!.nominalP, z: bounds[k]!.z, decision })
    if (decision !== 'continue') break
  }
  return out
}
