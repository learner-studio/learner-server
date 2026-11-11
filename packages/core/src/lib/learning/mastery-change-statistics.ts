/**
 * Honest mastery statistics (docs/specs/mastery-change-statistics.md): pure functions over
 * counted readings, no I/O. A reading is one graded assessment of one concept (0–100, a
 * multiple of 5 for a single grading, the raw mean for replicate gradings), placed in time by
 * WHEN THE LEARNER SAID IT (evidence time), never when the grader ran.
 *
 * Noise model: a reading = true mastery + grader error, error sd = `sd / sqrt(replicates)`, with
 * `sd` measured from identical-evidence regrades (`pooledGraderSd`). Errors are independent
 * between gradings. Concepts are the unit of replication: intervals bootstrap over concepts.
 */

/** z for a two-sided 95 % interval, a one-sided 95 % bound, and 80 % power. */
export const Z_95_TWO_SIDED = 1.959964
export const Z_95_ONE_SIDED = 1.644854
export const Z_POWER_80 = 0.841621
export const WEEK_MS = 7 * 86_400_000
export const BOOTSTRAP_REPS = 2000
/** Fixed seed: the same rows always give the same interval (tests, and a page that does not flicker). */
export const BOOTSTRAP_SEED = 20261111
/** Fewer concepts than this and an interval says nothing: none is reported. */
export const MIN_CONCEPTS_FOR_INTERVAL = 5
/** The holdout estimate is withheld until this many held-out (and this many taught) concepts are measured twice. */
export const MIN_HOLDOUT_CONCEPTS_PER_ARM = 20
/** The effect the holdout should be able to detect (points of understanding). */
export const HOLDOUT_TARGET_EFFECT = 5
export const PERCENT_BOUNDS = [0, 100] as const

export interface CountedReading {
  conceptId: string
  /** Evidence time, ms since epoch. */
  at: number
  percent: number
  /** Independent gradings averaged into this reading (1 = today's single grading). */
  replicates?: number
  /** True when the reading's evidence came from a blind probe turn (when that setting exists). */
  probe?: boolean
}

// ---------------------------------------------------------------------------------------------
// Grader noise

export interface GraderNoise { sd: number; df: number; groups: number }

/**
 * Pooled within-group sd of repeated gradings of identical evidence: sqrt(Σ(n−1)s² / Σ(n−1)).
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
 * A gain beyond noise: the new reading must exceed the earlier one by more than a one-sided 95 %
 * bound on the difference of two independent gradings (sd·√(1/k_now + 1/k_prev)), and never by
 * less than `floor` (GAIN_MIN_POINTS). Single gradings sit on the 5-point grid, so the effective
 * threshold for them is this value rounded up to the next multiple of 5.
 */
export function noiseAwareGainThreshold(sd: number, floor: number, replicatesNow = 1, replicatesBefore = 1): number {
  return Math.max(floor, Z_95_ONE_SIDED * sd * Math.sqrt(1 / replicatesNow + 1 / replicatesBefore))
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
  /** Grader-noise se of delta: sd·√(1/k_from + 1/k_to). */
  deltaSe: number
  /** |delta| > 1.96 · deltaSe. */
  beyondNoise: boolean
  /** Precision-weighted least-squares slope over the concept's readings, points per week; null when they share one time. */
  slopePerWeek: number | null
  slopeSe: number | null
  readings: number
  /** A reading at 0 or 100: the scale cannot show movement past it. */
  atBound: boolean
}

const byTime = (a: CountedReading, b: CountedReading) => a.at - b.at

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

/**
 * Per concept, the readings that describe its change since `since` (ms; absent = all time): the
 * last reading before `since` (where the concept stood when the window opened) and every reading
 * from `since` on. Concepts with fewer than two such readings, or none in the window, have no change.
 */
export function conceptChanges(readings: readonly CountedReading[], sd: number, opts: { since?: number } = {}): ConceptChange[] {
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
    const deltaSe = sd * Math.sqrt(1 / (first.replicates ?? 1) + 1 / (last.replicates ?? 1))
    const slope = weightedSlope(used, sd)
    out.push({
      conceptId, from: first.percent, to: last.percent, fromAt: first.at, toAt: last.at, delta, deltaSe,
      beyondNoise: deltaSe > 0 ? Math.abs(delta) > Z_95_TWO_SIDED * deltaSe : delta !== 0,
      slopePerWeek: slope?.slope ?? null, slopeSe: slope?.se ?? null, readings: used.length,
      atBound: used.some((r) => r.percent <= PERCENT_BOUNDS[0] || r.percent >= PERCENT_BOUNDS[1]),
    })
  }
  return out
}

/** Weighted least squares of percent on time (weeks), weight = replicates (precision ∝ k); se from the known grader noise. */
export function weightedSlope(readings: readonly CountedReading[], sd: number): { slope: number; se: number } | null {
  const w = readings.map((r) => r.replicates ?? 1)
  const t = readings.map((r) => r.at / WEEK_MS)
  const sw = w.reduce((a, b) => a + b, 0)
  const tBar = t.reduce((a, ti, i) => a + w[i]! * ti, 0) / sw
  const yBar = readings.reduce((a, r, i) => a + w[i]! * r.percent, 0) / sw
  let sxx = 0, sxy = 0
  readings.forEach((r, i) => { sxx += w[i]! * (t[i]! - tBar) ** 2; sxy += w[i]! * (t[i]! - tBar) * (r.percent - yBar) })
  // Readings closer together than about a second carry no slope information.
  if (sxx < 1e-12) return null
  return { slope: sxy / sxx, se: sd / Math.sqrt(sxx) }
}

// ---------------------------------------------------------------------------------------------
// Pooling across concepts

export interface Estimate { value: number; variance: number }

/**
 * DerSimonian–Laird random-effects mean: each concept's estimate weighted by 1/(v_i + τ²), where
 * v_i is its known noise variance and τ² the between-concept variance estimated from the data.
 * Equal v_i (single gradings, as today) make it the plain mean.
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

/**
 * Percentile bootstrap: resample the units (concepts) with replacement, `strata` resampled
 * separately (the holdout's arms), and take the 2.5th and 97.5th percentiles of `stat`.
 * Non-finite resamples (e.g. no slope in the draw) are dropped.
 */
export function bootstrapInterval<T>(strata: ReadonlyArray<readonly T[]>, stat: (sample: T[][]) => number | null, reps = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED): [number, number] | null {
  const random = seededRandom(seed)
  const values: number[] = []
  for (let r = 0; r < reps; r++) {
    const sample = strata.map((units) => Array.from({ length: units.length }, () => units[Math.floor(random() * units.length)]!))
    const v = stat(sample)
    if (v !== null && Number.isFinite(v)) values.push(v)
  }
  if (values.length < reps / 2) return null
  values.sort((a, b) => a - b)
  return [quantile(values, 0.025), quantile(values, 0.975)]
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
  nReadings: number
  nBeyondNoise: number
  nAtBound: number
  /** The change interval excludes zero. */
  conclusive: boolean
}

const changeEstimates = (cs: readonly ConceptChange[]) => cs.map((c) => ({ value: c.delta, variance: c.deltaSe ** 2 }))
const slopeEstimates = (cs: readonly ConceptChange[]) => cs.filter((c) => c.slopePerWeek !== null).map((c) => ({ value: c.slopePerWeek!, variance: c.slopeSe! ** 2 }))

export function aggregateChange(changes: readonly ConceptChange[], opts: { reps?: number; seed?: number } = {}): AggregateChange {
  const change = randomEffectsMean(changeEstimates(changes))
  const slope = randomEffectsMean(slopeEstimates(changes))
  const withSlope = changes.filter((c) => c.slopePerWeek !== null)
  const enough = changes.length >= MIN_CONCEPTS_FOR_INTERVAL
  const changeInterval = enough ? bootstrapInterval([changes], ([s]) => randomEffectsMean(changeEstimates(s!))?.mean ?? null, opts.reps, opts.seed) : null
  const slopeInterval = withSlope.length >= MIN_CONCEPTS_FOR_INTERVAL ? bootstrapInterval([withSlope], ([s]) => randomEffectsMean(slopeEstimates(s!))?.mean ?? null, opts.reps, opts.seed) : null
  return {
    meanChange: change?.mean ?? null, changeInterval,
    meanSlopePerWeek: slope?.mean ?? null, slopeInterval,
    betweenConceptSd: change ? Math.sqrt(change.tau2) : null,
    nConcepts: changes.length, nConceptsWithSlope: withSlope.length,
    nReadings: changes.reduce((a, c) => a + c.readings, 0),
    nBeyondNoise: changes.filter((c) => c.beyondNoise).length,
    nAtBound: changes.filter((c) => c.atBound).length,
    conclusive: !!changeInterval && (changeInterval[0] > 0 || changeInterval[1] < 0),
  }
}

// ---------------------------------------------------------------------------------------------
// Holdout: taught vs held-out, adjusted for baseline (ANCOVA)

export interface HoldoutUnit { conceptId: string; heldOut: boolean; baseline: number; followUp: number }

export interface HoldoutPhaseInput {
  startedAt: number
  isHeldOut: (conceptId: string) => boolean
}

/**
 * Per concept: baseline = the last reading with evidence before the phase started, or failing
 * that the first one after; follow-up = the latest reading with evidence after the start that is
 * not the baseline. Concepts with no follow-up are counted as "baseline only".
 */
export function holdoutUnits(readings: readonly CountedReading[], phase: HoldoutPhaseInput): { units: HoldoutUnit[]; baselineOnly: { taught: number; heldOut: number } } {
  const units: HoldoutUnit[] = []
  const baselineOnly = { taught: 0, heldOut: 0 }
  for (const [conceptId, list] of groupByConcept(readings)) {
    const before = list.filter((r) => r.at < phase.startedAt)
    const after = list.filter((r) => r.at >= phase.startedAt)
    const baseline = before.at(-1) ?? after[0]
    const followUp = before.length ? after.at(-1) : after.length >= 2 ? after.at(-1) : undefined
    const heldOut = phase.isHeldOut(conceptId)
    if (!baseline) continue
    if (!followUp) { baselineOnly[heldOut ? 'heldOut' : 'taught']++; continue }
    units.push({ conceptId, heldOut, baseline: baseline.percent, followUp: followUp.percent })
  }
  return { units, baselineOnly }
}

/** OLS of followUp on [1, baseline, taught]: the taught coefficient, its classical se and the residual variance. */
export function ancova(units: readonly HoldoutUnit[]): { effect: number; se: number; residualVariance: number; slope: number } | null {
  const n = units.length
  if (n < 4 || !units.some((u) => u.heldOut) || !units.some((u) => !u.heldOut)) return null
  const x = units.map((u) => [1, u.baseline, u.heldOut ? 0 : 1])
  const y = units.map((u) => u.followUp)
  const xtx = [0, 1, 2].map((i) => [0, 1, 2].map((j) => x.reduce((a, r) => a + r[i]! * r[j]!, 0)))
  const xty = [0, 1, 2].map((i) => x.reduce((a, r, k) => a + r[i]! * y[k]!, 0))
  const inv = invert3(xtx)
  if (!inv) return null
  const beta = inv.map((row) => row.reduce((a, v, j) => a + v * xty[j]!, 0))
  const rss = x.reduce((a, r, k) => a + (y[k]! - (beta[0]! * r[0]! + beta[1]! * r[1]! + beta[2]! * r[2]!)) ** 2, 0)
  const residualVariance = rss / (n - 3)
  return { effect: beta[2]!, se: Math.sqrt(residualVariance * inv[2]![2]!), residualVariance, slope: beta[1]! }
}

function invert3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0]!, [d, e, f] = m[1]!, [g, h, i] = m[2]!
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a! * A + b! * B + c! * C
  if (Math.abs(det) < 1e-9) return null
  return [
    [A / det, -(b! * i! - c! * h!) / det, (b! * f! - c! * e!) / det],
    [B / det, (a! * i! - c! * g!) / det, -(a! * f! - c! * d!) / det],
    [C / det, -(a! * h! - b! * g!) / det, (a! * e! - b! * d!) / det],
  ]
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
}

export function holdoutPower(residualVariance: number | null, nTaught: number, nHeldOut: number, heldOutShare: number, target = HOLDOUT_TARGET_EFFECT, source: HoldoutPower['varianceSource'] = 'ancova'): HoldoutPower {
  if (residualVariance === null) return { varianceSource: null, residualSd: null, minimumDetectableEffect: null, conceptsNeeded: null, heldOutNeeded: null, conceptsStillNeeded: null }
  const z = Z_95_TWO_SIDED + Z_POWER_80
  const mde = nTaught > 0 && nHeldOut > 0 ? z * Math.sqrt(residualVariance * (1 / nTaught + 1 / nHeldOut)) : null
  const needed = Math.ceil(z * z * residualVariance / (target * target * heldOutShare * (1 - heldOutShare)))
  return {
    varianceSource: source, residualSd: Math.sqrt(residualVariance), minimumDetectableEffect: mde,
    conceptsNeeded: needed, heldOutNeeded: Math.ceil(needed * heldOutShare), conceptsStillNeeded: Math.max(0, needed - nTaught - nHeldOut),
  }
}

export interface HoldoutEffect {
  state: 'setting_baseline' | 'estimate'
  measuredTwice: { taught: number; heldOut: number }
  baselineOnly: { taught: number; heldOut: number }
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
 * twice, any time) supplies the variance for the power line before the arms can be fitted.
 */
export function holdoutEffect(units: readonly HoldoutUnit[], baselineOnly: { taught: number; heldOut: number }, heldOutShare: number, allPairs: ReadonlyArray<{ baseline: number; followUp: number }> = units, opts: { reps?: number; seed?: number; minimumPerArm?: number } = {}): HoldoutEffect {
  const taught = units.filter((u) => !u.heldOut), held = units.filter((u) => u.heldOut)
  const minimumPerArm = opts.minimumPerArm ?? MIN_HOLDOUT_CONCEPTS_PER_ARM
  const fit = ancova(units)
  const ready = taught.length >= minimumPerArm && held.length >= minimumPerArm && !!fit
  const interval = ready ? bootstrapInterval([taught, held], ([t, h]) => ancova([...t!, ...h!])?.effect ?? null, opts.reps, opts.seed) : null
  const fallback = pairResidualVariance(allPairs)
  const power = fit && ready
    ? holdoutPower(fit.residualVariance, taught.length, held.length, heldOutShare, HOLDOUT_TARGET_EFFECT, 'ancova')
    : holdoutPower(fallback, taught.length, held.length, heldOutShare, HOLDOUT_TARGET_EFFECT, fallback === null ? null : 'all_pairs')
  return {
    state: ready ? 'estimate' : 'setting_baseline',
    measuredTwice: { taught: taught.length, heldOut: held.length },
    baselineOnly, minimumPerArm,
    effect: ready ? fit!.effect : null,
    interval,
    conclusive: !!interval && (interval[0] > 0 || interval[1] < 0),
    meanChange: { taught: mean(taught.map((u) => u.followUp - u.baseline)), heldOut: mean(held.map((u) => u.followUp - u.baseline)) },
    meanBaseline: { taught: mean(taught.map((u) => u.baseline)), heldOut: mean(held.map((u) => u.baseline)) },
    power,
  }
}

// ---------------------------------------------------------------------------------------------
// Replicate gradings

export const CONFIDENCE_ORDER = ['insufficient', 'low', 'medium', 'high'] as const
export type Confidence = (typeof CONFIDENCE_ORDER)[number]

export interface ReplicateCombination { replicates: number; meanPercent: number; displayPercent: number; sd: number | null; min: number; max: number; confidence: Confidence }

/**
 * k gradings of one reading → one: the raw mean percent (the grid value only for display), the
 * spread, and the WEAKEST confidence (conservative: one replicate that could not tell holds the
 * reading back from counting as clear).
 */
export function combineReplicates(gradings: ReadonlyArray<{ percent: number | null; confidence: Confidence }>): ReplicateCombination | null {
  // A grading with no percent (insufficient evidence) adds no number, but its confidence still counts.
  const ps = gradings.map((g) => g.percent).filter((p): p is number => p !== null)
  if (!ps.length) return null
  const m = ps.reduce((a, b) => a + b, 0) / ps.length
  const sd = ps.length > 1 ? Math.sqrt(ps.reduce((a, p) => a + (p - m) ** 2, 0) / (ps.length - 1)) : null
  const confidence = CONFIDENCE_ORDER[Math.min(...gradings.map((g) => CONFIDENCE_ORDER.indexOf(g.confidence)))]!
  return { replicates: ps.length, meanPercent: m, displayPercent: Math.round(m / 5) * 5, sd, min: Math.min(...ps), max: Math.max(...ps), confidence }
}
