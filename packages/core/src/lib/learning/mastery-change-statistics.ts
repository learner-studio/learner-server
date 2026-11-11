/**
 * Honest mastery statistics (docs/specs/mastery-change-statistics.md): pure functions over
 * counted measurements, no I/O. A measurement is one or more gradings of one concept (0–100),
 * placed in time by WHEN THE LEARNER SAID IT (evidence time), never when the grader ran.
 *
 * Two kinds of grading, two error models (review B1):
 * - A PRIOR-BLIND grading (the prompt carries no numeric current estimate: a concept's first
 *   grading, and every blind replicate) = true level + independent error, sd `blindSd` measured
 *   from regrades of identical blind prompts (dev 2026-11-11: 6.7 over 329 df).
 * - An ANCHORED grading (the live v6 grader revising its own published estimate) = the prior plus a
 *   move. The move barely depends on the evidence (slope on the prior 0.94) and is almost never
 *   down (dev: 72 % equal, 27 % up, 0.3 % down), so a chain of anchored readings rises with the
 *   number of gradings whether or not anything was learned (review B2). Its fresh noise (identical
 *   prompt regrades, sd ≈ 2.3) is small; its error is the persistent path, not that noise.
 *
 * So every verdict ("rose beyond noise", "a gain", "taught concepts scored higher") is computed on
 * prior-blind measurements only, whose differences have a known variance: σ_b²(1/k_a + 1/k_b). The
 * anchored series is reported as a description, next to how much the grader alone moves it.
 * Concepts are the unit of replication: intervals bootstrap over concepts.
 */

/** z for a two-sided 95 % interval, a one-sided 95 % bound, and 80 % power. */
export const Z_95_TWO_SIDED = 1.959964
export const Z_95_ONE_SIDED = 1.644854
export const Z_POWER_80 = 0.841621
export const WEEK_MS = 7 * 86_400_000
export const BOOTSTRAP_REPS = 2000
/** Fixed seed: the same rows always give the same interval (tests, and a page that does not flicker). */
export const BOOTSTRAP_SEED = 20261111
/**
 * Fewer concepts than this and an interval says nothing: "not enough data" (review S2: below about
 * 20 concepts a percentile bootstrap undercovers, 85 % at 5 concepts). Above it the interval is the
 * t-widened bootstrap (`tBootstrapInterval`), whose null coverage is tested.
 */
export const MIN_CONCEPTS_FOR_INTERVAL = 20
/** The holdout estimate is withheld until this many held-out (and this many taught) concepts are measured twice. */
export const MIN_HOLDOUT_CONCEPTS_PER_ARM = 20
/** The effect the holdout should be able to detect (points of understanding). */
export const HOLDOUT_TARGET_EFFECT = 5
export const PERCENT_BOUNDS = [0, 100] as const
/** False-discovery rate of the per-concept "beyond noise" flags (Benjamini–Hochberg; review S3). */
export const CONCEPT_FDR = 0.05
/**
 * Intra-class correlation of gradings dated at the same time that come from DIFFERENT runs (they
 * rest on overlapping evidence): dev's within-measurement sd 9.6 against 11.8 between (review S7).
 * Replicates of one run (the same prompt regraded) are independent draws.
 */
export const SAME_TIME_RHO = 0.34

export interface CountedReading {
  conceptId: string
  /** Evidence time, ms since epoch. */
  at: number
  percent: number
  /** Gradings averaged into this measurement (prior-blind gradings for a blind measurement). */
  replicates?: number
  /** Distinct runs those gradings came from (default 1): more than one run means correlated gradings. */
  runs?: number
  /** The concept's anchored (live) gradings up to and including this measurement: the opportunity count. */
  gradings?: number
  /** True when the measurement answers a blind probe of its concept (equal opportunity in both arms). */
  probe?: boolean
  /** True when it answers the concept's FIRST delivered probe since the holdout start (`k = 1`): the probe headline's only follow-up. */
  firstProbe?: boolean
}

// ---------------------------------------------------------------------------------------------
// Grader noise

export interface GraderNoise { sd: number; df: number; groups: number }

/**
 * Pooled within-group sd of repeated gradings of identical input: sqrt(Σ(n−1)s² / Σ(n−1)).
 * This, not the mean of per-group sds, estimates the per-grading sd: a group of two has
 * E[s] ≈ 0.8σ, so averaging sds understates the noise.
 */
export function pooledGraderSd(groups: ReadonlyArray<ReadonlyArray<number>>): GraderNoise {
  let ss = 0, df = 0, used = 0
  for (const g of groups) {
    if (g.length < 2) continue
    const m = g.reduce((a, b) => a + b, 0) / g.length
    ss += g.reduce((a, b) => a + (b - m) ** 2, 0)
    df += g.length - 1
    used++
  }
  return { sd: df ? Math.sqrt(ss / df) : 0, df, groups: used }
}

/**
 * The precision, in independent gradings, of a measurement of k gradings from `runs` runs: k when
 * they are replicates of one prompt, k / (1 + (k − 1)ρ) when they come from several runs (review S7).
 */
export function effectiveGradings(k: number, runs = 1, rho = SAME_TIME_RHO): number {
  if (k <= 1 || runs <= 1) return Math.max(k, 1)
  return k / (1 + (k - 1) * rho)
}

// ---------------------------------------------------------------------------------------------
// The error of one prior-blind measurement (review round 2, NB1)

/**
 * A prior-blind measurement grades ONE run's new evidence: a noisy sample of the learner's level.
 * Its k replicates regrade the same prompt, so they average away only the grader's noise given that
 * evidence (σ_g, measured on identical prompts); the evidence's own error e (sd σ_e) is common to all
 * of them and differs between measurements. So Var(measurement) = σ_e² + σ_g² / k_eff.
 * `replicateCredit` is false until σ_e is measured: every measurement then counts as ONE grading
 * (σ_e² + σ_g², the total variance of a single blind grading), whatever its k.
 */
export interface MeasurementNoise {
  graderSd: number
  evidenceSd: number
  replicateCredit: boolean
}

/** The pre-NB1 model, replicates as independent draws (σ_e = 0): for unit tests of the arithmetic only, never the server. */
export const graderOnlyNoise = (sd: number): MeasurementNoise => ({ graderSd: sd, evidenceSd: 0, replicateCredit: true })

/** Var of one measurement of `k` blind gradings from `runs` runs: σ_e² + σ_g² / k_eff (k_eff = 1 without replicate credit). */
export function measurementVariance(noise: MeasurementNoise, k = 1, runs = 1): number {
  const kEff = noise.replicateCredit ? effectiveGradings(k, runs) : 1
  return noise.evidenceSd ** 2 + noise.graderSd ** 2 / kEff
}

/**
 * The measurement's precision in units of one grading with no evidence error: σ_g² / Var. With σ_e > 0
 * it never exceeds σ_g² / σ_e² however large k is, which is what raising k can buy.
 */
export const effectiveK = (noise: MeasurementNoise, k = 1, runs = 1) => noise.graderSd ** 2 / measurementVariance(noise, k, runs)

/** Consecutive blind measurements of a concept closer than this are a pair for σ_e: learning inside it is negligible against σ_e. */
export const EVIDENCE_PAIR_MAX_GAP_DAYS = 7
/** σ_e is "measured" from this many pairs on; before that replicates get no credit and the fallback stands in. */
export const MIN_EVIDENCE_PAIRS = 10
/**
 * σ_e measured on dev (2026-11-11, 27 consecutive blind pairs over 18 concepts, review round 2 NB1:
 * RMS difference 16.3 against 9.1 from the grader alone, ρ ≈ 0.70). Used, without replicate credit,
 * only while fewer than MIN_EVIDENCE_PAIRS pairs exist.
 */
export const FALLBACK_EVIDENCE_SD = 10

export interface EvidenceNoise {
  sd: number
  /** 95 % interval of σ_e (χ² on the pairs; floored at 0). Null while unmeasured. */
  interval: [number, number] | null
  pairs: number
  /** ρ = σ_e² / (σ_e² + σ_g²): the correlation of two replicates of one measurement. */
  rho: number
  source: 'measured' | 'fallback'
}

/** χ² quantile (Wilson–Hilferty; relative error < 1 % from 5 df). */
export function chiSquareQuantile(p: number, df: number): number {
  // Inverse normal by bisection on normalCdf: p is only ever 0.025 or 0.975 here.
  let lo = -10, hi = 10
  for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (normalCdf(mid) < p) lo = mid; else hi = mid }
  const z = (lo + hi) / 2, a = 2 / (9 * df)
  return df * Math.max(0, 1 - a + z * Math.sqrt(a)) ** 3
}

/**
 * σ_e from blind measurements of DIFFERENT evidence close in time: for consecutive measurements of a
 * concept at most EVIDENCE_PAIR_MAX_GAP_DAYS apart, each from one run, E[d²] = 2σ_e² + σ_g²(1/k₁ + 1/k₂). Pairs
 * are disjoint (1–2, 3–4, …) so that they are independent and Σd² / E[d²] is χ² on n pairs. Learning
 * inside the gap only inflates σ_e, which errs toward less precision. Pooled over every learner
 * passed in: the evidence error is a property of the grader and the prompt as much as of a learner.
 */
export function evidenceNoise(blind: readonly CountedReading[], graderSd: number, opts: { maxGapDays?: number; minPairs?: number } = {}): EvidenceNoise {
  const maxGap = (opts.maxGapDays ?? EVIDENCE_PAIR_MAX_GAP_DAYS) * 86_400_000
  let ss = 0, grader = 0, n = 0
  for (const list of groupByConcept(blind).values()) {
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]!, b = list[i + 1]!
      // A measurement merged from several runs averages part of their evidence errors (runs dated at one
      // time rest on overlapping, not identical, evidence): its variance is not σ_e² + σ_g²/k_eff, so it
      // is no pair member. measurementVariance gives it the full σ_e², which errs toward less precision.
      if (b.at - a.at > maxGap || b.at === a.at || (a.runs ?? 1) > 1 || (b.runs ?? 1) > 1) continue
      ss += (b.percent - a.percent) ** 2
      grader += graderSd ** 2 * (1 / (a.replicates ?? 1) + 1 / (b.replicates ?? 1))
      n++
      i++
    }
  }
  const rhoOf = (sd: number) => (sd ** 2 + graderSd ** 2 > 0 ? sd ** 2 / (sd ** 2 + graderSd ** 2) : 0)
  if (n < (opts.minPairs ?? MIN_EVIDENCE_PAIRS)) return { sd: FALLBACK_EVIDENCE_SD, interval: null, pairs: n, rho: rhoOf(FALLBACK_EVIDENCE_SD), source: 'fallback' }
  const meanGrader = grader / n
  const sdOf = (meanSquare: number) => Math.sqrt(Math.max(0, (meanSquare - meanGrader) / 2))
  const sd = sdOf(ss / n)
  return { sd, interval: [sdOf(ss / chiSquareQuantile(0.975, n)), sdOf(ss / chiSquareQuantile(0.025, n))], pairs: n, rho: rhoOf(sd), source: 'measured' }
}

/** The noise every per-concept and gain decision uses: σ_g, σ_e, and replicate credit only once σ_e is measured. */
export const measurementNoise = (graderSd: number, evidence: EvidenceNoise): MeasurementNoise => ({ graderSd, evidenceSd: evidence.sd, replicateCredit: evidence.source === 'measured' })

/** A single grading lives on this grid (5-point steps), so a mean of k gradings on a grid of GRID_POINTS / k. */
export const GRID_POINTS = 5

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
/**
 * Half the lattice step of a difference between a mean of `kNow` and a mean of `kBefore` gridded
 * gradings: the difference can only take values GRID_POINTS / lcm(kNow, kBefore) apart. Requiring the
 * difference to clear the threshold by this much is the continuity correction that keeps the rule at
 * or below its nominal 5 % (without it, k_now 1 against k_before 4 fires 5.8 % of the time under no
 * change, because the threshold 12.4 falls just below the reachable 12.5).
 */
export function gridContinuity(kNow: number, kBefore: number): number {
  if (!Number.isInteger(kNow) || !Number.isInteger(kBefore) || kNow < 1 || kBefore < 1) return 0
  return GRID_POINTS / 2 / ((kNow * kBefore) / gcd(kNow, kBefore))
}

/** One counted blind measurement as the gain rule sees it. */
export interface GainMeasurement { percent: number; gradings: number; runs?: number }

/**
 * The pure twin of the feed's and the strip's SQL gain rule (mastery-notifications.ts BLIND_GAIN):
 * `now` beats the gradings-weighted MEAN of the concept's earlier measurements by
 * max(floor, z·√(Var(now) + Var(mean before)) + the grid's continuity correction). Var(now) =
 * σ_e² + σ_g²/k_eff; the mean before weights measurement i by k_i, so its variance is
 * Σk_i²·Var_i / (Σk_i)² (review round 2 NB1: earlier gradings of one measurement share its evidence
 * error; S-c: k_eff carries the runs correction).
 */
export function isBlindGain(now: GainMeasurement, before: readonly GainMeasurement[], noise: MeasurementNoise, floor: number): boolean {
  const counted = before.filter((b) => b.gradings > 0)
  if (!counted.length || now.gradings <= 0) return false
  const k = counted.reduce((a, b) => a + b.gradings, 0)
  const mean = counted.reduce((a, b) => a + b.percent * b.gradings, 0) / k
  const varBefore = counted.reduce((a, b) => a + b.gradings ** 2 * measurementVariance(noise, b.gradings, b.runs ?? 1), 0) / k ** 2
  const bound = Z_95_ONE_SIDED * Math.sqrt(measurementVariance(noise, now.gradings, now.runs ?? 1) + varBefore)
  // The correction belongs to the statistical bound only; the floor is a product rule (never less than +10).
  const continuity = noise.graderSd > 0 ? gridContinuity(now.gradings, k) : 0
  return now.percent - mean >= Math.max(floor, bound + continuity)
}

/** The gain threshold of one measurement of `k` gradings against one earlier of `k` (what the noise line quotes). */
export function gainThreshold(noise: MeasurementNoise, floor: number, k = 1): number {
  return Math.max(floor, Z_95_ONE_SIDED * Math.sqrt(2 * measurementVariance(noise, k)) + (noise.graderSd > 0 ? gridContinuity(k, k) : 0))
}

// ---------------------------------------------------------------------------------------------
// Distributions

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf; |error| < 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

/** Student's t 97.5 % quantiles for df 1–10, where the expansion below is poor (it gives 9.71 at df 1). */
const T975_SMALL_DF = [12.7062, 4.3027, 3.1824, 2.7764, 2.5706, 2.4469, 2.3646, 2.306, 2.2622, 2.2281]

/** Two-sided 95 % quantile of Student's t with `df` degrees of freedom: a table to df 10, Cornish–Fisher above (< 0.01 % off there). */
export function t975(df: number): number {
  if (!Number.isFinite(df) || df > 1e6) return Z_95_TWO_SIDED
  if (df <= 10) return T975_SMALL_DF[Math.max(1, Math.floor(df)) - 1]!
  const z = Z_95_TWO_SIDED, v = df
  return z + (z ** 3 + z) / (4 * v) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * v ** 3)
}

// ---------------------------------------------------------------------------------------------
// Per-concept change and slope

export interface ConceptChange {
  conceptId: string
  from: number
  to: number
  fromAt: number
  toAt: number
  /** to − from: signed, declines included. */
  delta: number
  /** se of delta: √(Var(from) + Var(to)), Var = σ_e² + σ_g²/k_eff (`measurementVariance`). */
  deltaSe: number
  /** Two-sided p-value of delta against no change under the noise model. */
  pValue: number
  /** Significant after Benjamini–Hochberg at CONCEPT_FDR across the concepts reported together (review S3). */
  beyondNoise: boolean
  /** |delta| > 1.96 · deltaSe without multiplicity control (about 5 % of concepts by chance alone). */
  beyondNoiseUnadjusted: boolean
  /** Precision-weighted least-squares slope over the concept's measurements, points per week; null when they share one time. */
  slopePerWeek: number | null
  slopeSe: number | null
  readings: number
  /** Anchored gradings of the concept between the first and last measurement used (null when unknown). */
  gradingsBetween: number | null
  /** A measurement at 0 or 100: the scale cannot show movement past it. */
  atBound: boolean
}

const byTime = (a: CountedReading, b: CountedReading) => a.at - b.at
const variance = (noise: MeasurementNoise, r: CountedReading) => measurementVariance(noise, r.replicates ?? 1, r.runs ?? 1)

function groupByConcept(readings: readonly CountedReading[]): Map<string, CountedReading[]> {
  const out = new Map<string, CountedReading[]>()
  for (const r of readings) {
    const list = out.get(r.conceptId)
    if (list) list.push(r)
    else out.set(r.conceptId, [r])
  }
  for (const list of out.values()) list.sort(byTime)
  return out
}

/** Benjamini–Hochberg: which of `p` are discoveries at false-discovery rate `q`. */
export function benjaminiHochberg(p: readonly number[], q = CONCEPT_FDR): boolean[] {
  const order = p.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0])
  let cut = -1
  order.forEach(([v], rank) => { if (v <= ((rank + 1) / p.length) * q) cut = rank })
  const out = p.map(() => false)
  for (let rank = 0; rank <= cut; rank++) out[order[rank]![1]] = true
  return out
}

/**
 * Per concept, the measurements that describe its change since `since` (ms; absent = all time): the
 * last measurement before `since` (where the concept stood when the window opened) and every one
 * from `since` on. Concepts with fewer than two such measurements, or none in the window, have no change.
 * `noise` is the measurements' error model (prior-blind: `measurementNoise`).
 */
export function conceptChanges(readings: readonly CountedReading[], noise: MeasurementNoise, opts: { since?: number; fdr?: number } = {}): ConceptChange[] {
  const out: ConceptChange[] = []
  for (const [conceptId, all] of groupByConcept(readings)) {
    let used = all
    if (opts.since !== undefined) {
      const inside = all.filter((r) => r.at >= opts.since!)
      const anchor = all.filter((r) => r.at < opts.since!).at(-1)
      used = anchor ? [anchor, ...inside] : inside
      if (!inside.length) continue
    }
    if (used.length < 2) continue
    const first = used[0]!, last = used.at(-1)!
    const delta = last.percent - first.percent
    const deltaSe = Math.sqrt(variance(noise, first) + variance(noise, last))
    const z = deltaSe > 0 ? delta / deltaSe : delta === 0 ? 0 : Infinity
    const slope = weightedSlope(used, noise)
    out.push({
      conceptId, from: first.percent, to: last.percent, fromAt: first.at, toAt: last.at, delta, deltaSe,
      pValue: 2 * (1 - normalCdf(Math.abs(z))), beyondNoise: false, beyondNoiseUnadjusted: Math.abs(z) > Z_95_TWO_SIDED,
      slopePerWeek: slope?.slope ?? null, slopeSe: slope?.se ?? null, readings: used.length,
      gradingsBetween: first.gradings !== undefined && last.gradings !== undefined ? last.gradings - first.gradings : null,
      atBound: used.some((r) => r.percent <= PERCENT_BOUNDS[0] || r.percent >= PERCENT_BOUNDS[1]),
    })
  }
  const flags = benjaminiHochberg(out.map((c) => c.pValue), opts.fdr ?? CONCEPT_FDR)
  out.forEach((c, i) => { c.beyondNoise = flags[i]! })
  return out
}

/** Weighted least squares of percent on time (weeks), weight = 1 / Var(measurement); se from the known noise model. */
export function weightedSlope(readings: readonly CountedReading[], noise: MeasurementNoise): { slope: number; se: number } | null {
  const w = readings.map((r) => 1 / variance(noise, r))
  const t = readings.map((r) => r.at / WEEK_MS)
  const sw = w.reduce((a, b) => a + b, 0)
  const tBar = t.reduce((a, ti, i) => a + w[i]! * ti, 0) / sw
  const yBar = readings.reduce((a, r, i) => a + w[i]! * r.percent, 0) / sw
  let sxx = 0, sxy = 0
  readings.forEach((r, i) => { sxx += w[i]! * (t[i]! - tBar) ** 2; sxy += w[i]! * (t[i]! - tBar) * (r.percent - yBar) })
  // Readings closer together than about a second carry no slope information (the weighted variance of t, weeks²).
  if (sxx / sw < 1e-12) return null
  return { slope: sxy / sxx, se: 1 / Math.sqrt(sxx) }
}

// ---------------------------------------------------------------------------------------------
// Pooling across concepts

export interface Estimate { value: number; variance: number }

/**
 * DerSimonian–Laird random-effects mean: each concept's estimate weighted by 1/(v_i + τ²), where
 * v_i is its known noise variance and τ² the between-concept variance estimated from the data.
 * Equal v_i make it the plain mean.
 */
export function randomEffectsMean(estimates: readonly Estimate[]): { mean: number; se: number; tau2: number } | null {
  if (!estimates.length) return null
  const v = estimates.map((e) => Math.max(e.variance, 1e-9))
  const w = v.map((x) => 1 / x)
  const sw = w.reduce((a, b) => a + b, 0)
  const fixed = estimates.reduce((a, e, i) => a + w[i]! * e.value, 0) / sw
  const q = estimates.reduce((a, e, i) => a + w[i]! * (e.value - fixed) ** 2, 0)
  const c = sw - w.reduce((a, b) => a + b * b, 0) / sw
  const tau2 = c > 0 ? Math.max(0, (q - (estimates.length - 1)) / c) : 0
  const wr = v.map((x) => 1 / (x + tau2))
  const swr = wr.reduce((a, b) => a + b, 0)
  return { mean: estimates.reduce((a, e, i) => a + wr[i]! * e.value, 0) / swr, se: Math.sqrt(1 / swr), tau2 }
}

/** mulberry32: a small seeded PRNG, so a bootstrap is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const quantile = (sorted: readonly number[], p: number) => {
  const i = (sorted.length - 1) * p
  const lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)
}

function bootstrapDraws<T>(strata: ReadonlyArray<readonly T[]>, stat: (sample: T[][]) => number | null, reps: number, seed: number): number[] | null {
  const random = seededRandom(seed)
  const values: number[] = []
  for (let r = 0; r < reps; r++) {
    const sample = strata.map((units) => Array.from({ length: units.length }, () => units[Math.floor(random() * units.length)]!))
    const v = stat(sample)
    if (v !== null && Number.isFinite(v)) values.push(v)
  }
  return values.length < reps / 2 ? null : values
}

/**
 * The interval the verdicts use: estimate ± t(df) · bootstrap se · √(n/(n − 1)). The percentile
 * bootstrap is too narrow with few units (review S2: 85 % coverage at 5 concepts, 93 % at 20, and
 * the holdout's stratified one 93.6 %, N2): the bootstrap se of a mean is biased low by √((n−1)/n),
 * and a normal quantile ignores that the se is itself estimated. Null coverage is tested.
 */
export function tBootstrapInterval<T>(estimate: number, strata: ReadonlyArray<readonly T[]>, stat: (sample: T[][]) => number | null, df: number, reps = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED): [number, number] | null {
  const values = bootstrapDraws(strata, stat, reps, seed)
  if (!values) return null
  const n = strata.reduce((a, s) => a + s.length, 0)
  const m = values.reduce((a, b) => a + b, 0) / values.length
  const se = Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / (values.length - 1)) * Math.sqrt(n / Math.max(n - 1, 1))
  const half = t975(df) * se
  return [estimate - half, estimate + half]
}

export interface AggregateChange {
  /** Random-effects mean of per-concept signed change (points). */
  meanChange: number | null
  changeInterval: [number, number] | null
  /** Random-effects mean of per-concept slopes (points per week). */
  meanSlopePerWeek: number | null
  slopeInterval: [number, number] | null
  /** τ (sd) of true change between concepts, beyond grader noise. */
  betweenConceptSd: number | null
  nConcepts: number
  nConceptsWithSlope: number
  /** Concepts needed before an interval is reported. */
  minimumConcepts: number
  nReadings: number
  /** Concepts beyond noise after Benjamini–Hochberg. */
  nBeyondNoise: number
  /** Concepts beyond noise one at a time, and how many of those chance alone gives (5 % of the concepts). */
  nBeyondNoiseUnadjusted: number
  expectedBeyondNoiseByChance: number
  nAtBound: number
  /** Mean anchored gradings between each concept's first and last measurement (null when unknown). */
  meanGradingsBetween: number | null
  /** The change interval excludes zero. */
  conclusive: boolean
}

const changeEstimates = (cs: readonly ConceptChange[]) => cs.map((c) => ({ value: c.delta, variance: c.deltaSe ** 2 }))
const slopeEstimates = (cs: readonly ConceptChange[]) => cs.filter((c) => c.slopePerWeek !== null).map((c) => ({ value: c.slopePerWeek!, variance: c.slopeSe! ** 2 }))

export function aggregateChange(changes: readonly ConceptChange[], opts: { reps?: number; seed?: number; minimumConcepts?: number } = {}): AggregateChange {
  const minimumConcepts = opts.minimumConcepts ?? MIN_CONCEPTS_FOR_INTERVAL
  const change = randomEffectsMean(changeEstimates(changes))
  const slope = randomEffectsMean(slopeEstimates(changes))
  const withSlope = changes.filter((c) => c.slopePerWeek !== null)
  const changeInterval = change && changes.length >= minimumConcepts
    ? tBootstrapInterval(change.mean, [changes], ([s]) => randomEffectsMean(changeEstimates(s!))?.mean ?? null, changes.length - 1, opts.reps, opts.seed) : null
  const slopeInterval = slope && withSlope.length >= minimumConcepts
    ? tBootstrapInterval(slope.mean, [withSlope], ([s]) => randomEffectsMean(slopeEstimates(s!))?.mean ?? null, withSlope.length - 1, opts.reps, opts.seed) : null
  const between = changes.filter((c) => c.gradingsBetween !== null)
  return {
    meanChange: change?.mean ?? null, changeInterval,
    meanSlopePerWeek: slope?.mean ?? null, slopeInterval,
    betweenConceptSd: change ? Math.sqrt(change.tau2) : null,
    nConcepts: changes.length, nConceptsWithSlope: withSlope.length, minimumConcepts,
    nReadings: changes.reduce((a, c) => a + c.readings, 0),
    nBeyondNoise: changes.filter((c) => c.beyondNoise).length,
    nBeyondNoiseUnadjusted: changes.filter((c) => c.beyondNoiseUnadjusted).length,
    expectedBeyondNoiseByChance: 0.05 * changes.length,
    nAtBound: changes.filter((c) => c.atBound).length,
    meanGradingsBetween: between.length ? between.reduce((a, c) => a + c.gradingsBetween!, 0) / between.length : null,
    conclusive: !!changeInterval && (changeInterval[0] > 0 || changeInterval[1] < 0),
  }
}

// ---------------------------------------------------------------------------------------------
// Holdout: taught vs held-out, adjusted for baseline (ANCOVA)

export interface HoldoutUnit {
  conceptId: string
  heldOut: boolean
  baseline: number
  followUp: number
  /** Anchored gradings of the concept between baseline and follow-up: the opportunity teaching drives (review B2). */
  gradingsBetween: number
  /** Evidence time of the follow-up (ms), for the pace of the power line. */
  followUpAt: number
  /** Evidence time of the baseline (ms): with `followUpAt`, the time over which the change accrued. */
  baselineAt: number
}

/** Weeks from a unit's baseline to its follow-up: the covariate that makes the follow-up's timing arm-independent (review round 2, NB2). */
export const elapsedWeeks = (u: HoldoutUnit) => (u.followUpAt - u.baselineAt) / WEEK_MS

export interface HoldoutPhaseInput {
  startedAt: number
  isHeldOut: (conceptId: string) => boolean
}

export interface HoldoutArmCounts { taught: number; heldOut: number }

/**
 * Per concept: baseline = the last measurement with evidence BEFORE the phase started; follow-up =
 * the latest measurement with evidence after it. A concept first measured after the start has no
 * baseline untouched by teaching (review S9: such a baseline already holds the effect), so it is
 * counted in `noPreStartBaseline`, never estimated. Concepts with a baseline and no follow-up yet are
 * `baselineOnly`: with `units` they give each arm's attrition.
 */
/**
 * `followUp`: which measurement after the start is the follow-up. 'last' (the default) for readings
 * the learner's own work produces. 'first' for probe answers: a held-out concept is probed about four
 * times as often as a taught one (blind-probes.md, review round 5 B-1) and being asked is itself
 * practice, so a later probe answer carries more testing in one arm than the other; the first answer
 * after the start is one per concept in both arms.
 */
export function holdoutUnits(readings: readonly CountedReading[], phase: HoldoutPhaseInput, opts: { followUp?: 'first' | 'last' } = {}): { units: HoldoutUnit[]; baselineOnly: HoldoutArmCounts; noPreStartBaseline: HoldoutArmCounts } {
  const units: HoldoutUnit[] = []
  const baselineOnly = { taught: 0, heldOut: 0 }, noPreStartBaseline = { taught: 0, heldOut: 0 }
  for (const [conceptId, list] of groupByConcept(readings)) {
    const heldOut = phase.isHeldOut(conceptId)
    const arm = heldOut ? 'heldOut' : 'taught'
    const baseline = list.filter((r) => r.at < phase.startedAt).at(-1)
    const after = list.filter((r) => r.at >= phase.startedAt)
    const followUp = opts.followUp === 'first' ? after[0] : after.at(-1)
    if (!baseline) { if (followUp) noPreStartBaseline[arm]++; continue }
    if (!followUp) { baselineOnly[arm]++; continue }
    units.push({ conceptId, heldOut, baseline: baseline.percent, followUp: followUp.percent, gradingsBetween: Math.max(0, (followUp.gradings ?? 0) - (baseline.gradings ?? 0)), followUpAt: followUp.at, baselineAt: baseline.at })
  }
  return { units, baselineOnly, noPreStartBaseline }
}

/**
 * The probe headline's units (review round 6, S-1): the same "first" as the probe analysis
 * (learning-blind-probes.ts, `first` reading). The population is the concepts with a delivered probe
 * since the start (`firstProbed`); the follow-up is a measurement answering THAT concept's first
 * delivered probe, never a later probe's answer. A concept whose first probe produced no prior-blind
 * reading is attrition (`baselineOnly`, per arm): falling through to probe 2, 3, … would give the
 * held-out arm, probed about four times as often, a follow-up with earlier probes' practice behind it.
 */
export function probeHoldoutUnits(readings: readonly CountedReading[], firstProbed: ReadonlySet<string>, phase: HoldoutPhaseInput): ReturnType<typeof holdoutUnits> {
  return holdoutUnits(probeHoldoutReadings(readings, firstProbed, phase), phase, { followUp: 'first' })
}

/** The measurements the probe headline reads: probed concepts' pre-start baselines and first-probe answers. */
export const probeHoldoutReadings = (readings: readonly CountedReading[], firstProbed: ReadonlySet<string>, phase: HoldoutPhaseInput): CountedReading[] =>
  readings.filter((r) => firstProbed.has(r.conceptId) && (r.at < phase.startedAt || r.firstProbe))

/** Solve A x = b (small, dense) by Gaussian elimination with partial pivoting; null when singular. */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r
    if (Math.abs(m[p]![c]!) < 1e-9) return null
    ;[m[c], m[p]] = [m[p]!, m[c]!]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r]![c]! / m[c]![c]!
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!
    }
  }
  return m.map((row, i) => row[n]! / row[i]!)
}

/** Ordinary least squares of y on the columns of x: coefficients, the residual variance and (X'X)⁻¹'s diagonal. */
export function ols(x: readonly number[][], y: readonly number[]): { beta: number[]; residualVariance: number; inverseDiagonal: number[] } | null {
  const p = x[0]?.length ?? 0, n = y.length
  if (n <= p) return null
  const xtx = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => x.reduce((a, r) => a + r[i]! * r[j]!, 0)))
  const xty = Array.from({ length: p }, (_, i) => x.reduce((a, r, k) => a + r[i]! * y[k]!, 0))
  const beta = solve(xtx, xty)
  if (!beta) return null
  const inverseDiagonal: number[] = []
  for (let i = 0; i < p; i++) {
    const col = solve(xtx, Array.from({ length: p }, (_, j) => (j === i ? 1 : 0)))
    if (!col) return null
    inverseDiagonal.push(col[i]!)
  }
  const rss = x.reduce((a, r, k) => a + (y[k]! - r.reduce((s, v, j) => s + v * beta[j]!, 0)) ** 2, 0)
  return { beta, residualVariance: rss / (n - p), inverseDiagonal }
}

/**
 * OLS of followUp on [1, baseline, taught] (+ gradings between, with `adjustForGradings`; + weeks from
 * baseline to follow-up, with `adjustForElapsed`): the taught coefficient, its classical se and the
 * residual variance. Adjusting for gradings removes a ratchet that is linear in the number of gradings
 * from the anchored series (review B2); on prior-blind measurements it is not used, since teaching
 * drives gradings (a mediator). Adjusting for elapsed time removes the bias of follow-ups that come
 * at different times per arm while both arms learn (review round 2, NB2): the probe headline's
 * follow-up is the first probe's answer, and the held-out arm is probed about four times as often, so
 * its answers come sooner. The estimand is then the arm difference at EQUAL time since baseline.
 * The column is left out when every unit has the same elapsed time (it would be collinear with the
 * intercept); `elapsedSlope` is null then.
 */
export function ancova(units: readonly HoldoutUnit[], opts: { adjustForGradings?: boolean; adjustForElapsed?: boolean } = {}): { effect: number; se: number; residualVariance: number; slope: number; elapsedSlope: number | null; parameters: number } | null {
  if (!units.some((u) => u.heldOut) || !units.some((u) => !u.heldOut)) return null
  const elapsed = units.map(elapsedWeeks)
  const useElapsed = !!opts.adjustForElapsed && Math.max(...elapsed) - Math.min(...elapsed) > 1e-9
  const x = units.map((u, i) => [1, u.baseline, u.heldOut ? 0 : 1, ...(opts.adjustForGradings ? [u.gradingsBetween] : []), ...(useElapsed ? [elapsed[i]!] : [])])
  const fit = ols(x, units.map((u) => u.followUp))
  if (!fit || units.length < x[0]!.length + 1) return null
  return { effect: fit.beta[2]!, se: Math.sqrt(fit.residualVariance * fit.inverseDiagonal[2]!), residualVariance: fit.residualVariance, slope: fit.beta[1]!, elapsedSlope: useElapsed ? fit.beta.at(-1)! : null, parameters: x[0]!.length }
}

/** Residual variance of follow-up on baseline over pairs regardless of arm: the variance to plan power with before the arms can be fitted. */
export function pairResidualVariance(pairs: ReadonlyArray<{ baseline: number; followUp: number }>): number | null {
  const n = pairs.length
  if (n < 3) return null
  const mx = pairs.reduce((a, p) => a + p.baseline, 0) / n, my = pairs.reduce((a, p) => a + p.followUp, 0) / n
  const sxx = pairs.reduce((a, p) => a + (p.baseline - mx) ** 2, 0)
  const sxy = pairs.reduce((a, p) => a + (p.baseline - mx) * (p.followUp - my), 0)
  const b = sxx > 0 ? sxy / sxx : 0
  return pairs.reduce((a, p) => a + (p.followUp - my - b * (p.baseline - mx)) ** 2, 0) / (n - 2)
}

export interface HoldoutPower {
  /** Where the variance came from: the fitted ANCOVA, or the follow-up-on-baseline regression over all concepts measured twice. */
  varianceSource: 'ancova' | 'all_pairs' | null
  residualSd: number | null
  /** Smallest effect detectable at 80 % power, two-sided α = 0.05, with today's n per arm. */
  minimumDetectableEffect: number | null
  /** Concepts measured twice needed in all to detect HOLDOUT_TARGET_EFFECT at the holdout share, and of those held out. */
  conceptsNeeded: number | null
  heldOutNeeded: number | null
  /** conceptsNeeded minus the concepts already measured twice (never negative). */
  conceptsStillNeeded: number | null
  /** Concepts newly measured twice per week over the last four weeks, and the weeks the rest takes at that pace (null at pace 0). */
  pacePerWeek: number | null
  weeksToTarget: number | null
}

export function holdoutPower(residualVariance: number | null, nTaught: number, nHeldOut: number, heldOutShare: number, target = HOLDOUT_TARGET_EFFECT, source: HoldoutPower['varianceSource'] = 'ancova', pacePerWeek: number | null = null): HoldoutPower {
  if (residualVariance === null) return { varianceSource: null, residualSd: null, minimumDetectableEffect: null, conceptsNeeded: null, heldOutNeeded: null, conceptsStillNeeded: null, pacePerWeek, weeksToTarget: null }
  const z = Z_95_TWO_SIDED + Z_POWER_80
  const mde = nTaught > 0 && nHeldOut > 0 ? z * Math.sqrt(residualVariance * (1 / nTaught + 1 / nHeldOut)) : null
  const needed = Math.ceil(z * z * residualVariance / (target * target * heldOutShare * (1 - heldOutShare)))
  const still = Math.max(0, needed - nTaught - nHeldOut)
  return {
    varianceSource: source, residualSd: Math.sqrt(residualVariance), minimumDetectableEffect: mde,
    conceptsNeeded: needed, heldOutNeeded: Math.ceil(needed * heldOutShare), conceptsStillNeeded: still,
    pacePerWeek, weeksToTarget: still === 0 ? 0 : pacePerWeek && pacePerWeek > 0 ? Math.ceil(still / pacePerWeek) : null,
  }
}

export interface HoldoutEffect {
  state: 'setting_baseline' | 'estimate'
  measuredTwice: HoldoutArmCounts
  baselineOnly: HoldoutArmCounts
  /** First measured after the start: no untouched baseline, so outside the estimate. */
  noPreStartBaseline: HoldoutArmCounts
  /** Share of each arm's concepts with a pre-start baseline that are measured twice (1 − attrition). */
  measuredTwiceShare: { taught: number | null; heldOut: number | null }
  /** Mean anchored gradings between baseline and follow-up per arm: unequal = unequal opportunity. */
  gradingsBetween: { taught: number | null; heldOut: number | null }
  /** Whether the model adjusts for gradings between (the anchored series). */
  adjustedForGradings: boolean
  /** Whether the model adjusts for weeks from baseline to follow-up (the probe headline, review round 2 NB2), and each arm's mean of them. */
  adjustedForElapsed: boolean
  elapsedWeeks: { taught: number | null; heldOut: number | null }
  minimumPerArm: number
  /** Taught minus held-out follow-up, adjusted for baseline. Null while setting the baseline. */
  effect: number | null
  interval: [number, number] | null
  conclusive: boolean
  /** Unadjusted mean change from baseline per arm (for reading the estimate, not a second estimate). */
  meanChange: { taught: number | null; heldOut: number | null }
  meanBaseline: { taught: number | null; heldOut: number | null }
  power: HoldoutPower
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/**
 * The holdout's effect on mastery. `allPairs` (baseline/follow-up pairs of every concept measured
 * twice, any time) supplies the variance for the power line before the arms can be fitted; `now`
 * (ms) dates the pace of the power line.
 */
export function holdoutEffect(units: readonly HoldoutUnit[], counts: { baselineOnly: HoldoutArmCounts; noPreStartBaseline?: HoldoutArmCounts }, heldOutShare: number, allPairs: ReadonlyArray<{ baseline: number; followUp: number }> = units, opts: { reps?: number; seed?: number; minimumPerArm?: number; adjustForGradings?: boolean; adjustForElapsed?: boolean; now?: number } = {}): HoldoutEffect {
  const taught = units.filter((u) => !u.heldOut), held = units.filter((u) => u.heldOut)
  const minimumPerArm = opts.minimumPerArm ?? MIN_HOLDOUT_CONCEPTS_PER_ARM
  const model = { adjustForGradings: !!opts.adjustForGradings, adjustForElapsed: !!opts.adjustForElapsed }
  const fit = ancova(units, model)
  const ready = taught.length >= minimumPerArm && held.length >= minimumPerArm && !!fit
  const interval = ready ? tBootstrapInterval(fit!.effect, [taught, held], ([t, h]) => ancova([...t!, ...h!], model)?.effect ?? null, units.length - fit!.parameters, opts.reps, opts.seed) : null
  const fallback = pairResidualVariance(allPairs)
  const now = opts.now ?? Math.max(0, ...units.map((u) => u.followUpAt))
  const pace = units.length ? units.filter((u) => u.followUpAt > now - 4 * WEEK_MS).length / 4 : null
  const power = fit && ready
    ? holdoutPower(fit.residualVariance, taught.length, held.length, heldOutShare, HOLDOUT_TARGET_EFFECT, 'ancova', pace)
    : holdoutPower(fallback, taught.length, held.length, heldOutShare, HOLDOUT_TARGET_EFFECT, fallback === null ? null : 'all_pairs', pace)
  const share = (twice: number, only: number) => (twice + only ? twice / (twice + only) : null)
  return {
    state: ready ? 'estimate' : 'setting_baseline',
    measuredTwice: { taught: taught.length, heldOut: held.length },
    baselineOnly: counts.baselineOnly, noPreStartBaseline: counts.noPreStartBaseline ?? { taught: 0, heldOut: 0 },
    measuredTwiceShare: { taught: share(taught.length, counts.baselineOnly.taught), heldOut: share(held.length, counts.baselineOnly.heldOut) },
    gradingsBetween: { taught: mean(taught.map((u) => u.gradingsBetween)), heldOut: mean(held.map((u) => u.gradingsBetween)) },
    adjustedForGradings: model.adjustForGradings,
    adjustedForElapsed: model.adjustForElapsed,
    elapsedWeeks: { taught: mean(taught.map(elapsedWeeks)), heldOut: mean(held.map(elapsedWeeks)) },
    minimumPerArm,
    effect: ready ? fit!.effect : null,
    interval,
    conclusive: !!interval && (interval[0] > 0 || interval[1] < 0),
    meanChange: { taught: mean(taught.map((u) => u.followUp - u.baseline)), heldOut: mean(held.map((u) => u.followUp - u.baseline)) },
    meanBaseline: { taught: mean(taught.map((u) => u.baseline)), heldOut: mean(held.map((u) => u.baseline)) },
    power,
  }
}

// ---------------------------------------------------------------------------------------------
// Prior-blind replicate gradings

export const CONFIDENCE_ORDER = ['insufficient', 'low', 'medium', 'high'] as const
export type Confidence = (typeof CONFIDENCE_ORDER)[number]

export interface ReplicateCombination { replicates: number; meanPercent: number; displayPercent: number; sd: number | null; min: number; max: number; confidence: Confidence }

/**
 * k prior-blind gradings of one reading → one measurement: the raw mean percent (the grid value only
 * for display), the spread, and the MEDIAN confidence (the lower middle when k is even). Review S6:
 * the weakest replicate's confidence made a reading's counted status, and so its level, depend on
 * k (17.7 % of regrade pairs disagree on it, and the counted one averages +9.3 points); the median
 * is stable in k.
 */
export function combineReplicates(gradings: ReadonlyArray<{ percent: number | null; confidence: Confidence }>): ReplicateCombination | null {
  // A grading with no percent (insufficient evidence) adds no number, but its confidence still counts.
  const ps = gradings.map((g) => g.percent).filter((p): p is number => p !== null)
  if (!ps.length) return null
  const m = ps.reduce((a, b) => a + b, 0) / ps.length
  const sd = ps.length > 1 ? Math.sqrt(ps.reduce((a, p) => a + (p - m) ** 2, 0) / (ps.length - 1)) : null
  const ranks = gradings.map((g) => CONFIDENCE_ORDER.indexOf(g.confidence)).sort((a, b) => a - b)
  const confidence = CONFIDENCE_ORDER[ranks[Math.floor((ranks.length - 1) / 2)]!]!
  return { replicates: ps.length, meanPercent: m, displayPercent: Math.round(m / 5) * 5, sd, min: Math.min(...ps), max: Math.max(...ps), confidence }
}
