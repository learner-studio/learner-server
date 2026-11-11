/**
 * Known-truth recovery (docs/specs/mastery-change-statistics.md, "Known-truth recovery"): simulated
 * learners whose true mastery trajectory is planted, graded by a simulated grader that reproduces
 * the measured behaviour of the live one, then read by the same statistics a real learner is read
 * by. Pure and seeded: no I/O.
 *
 * The grader (calibration: data/mastery-grader-calibration.json, from scripts/mastery-grader-calibration.ts):
 * - A prior-blind grading of evidence at true level T: grid(T + N(0, blind sd)), clipped to 0–100.
 * - An anchored grading with prior p: let B be what a prior-blind grading of the same evidence would
 *   say and G = B − p. The grading moves up with probability up(G), down (one step) with
 *   probability down(G), else keeps p; an up move has mean upMove(G). up/down/upMove are the measured
 *   table, linearly interpolated (end values held). So it rises a little whatever the evidence
 *   (the ratchet: up 38 % at G ≈ −7), follows a positive gap partly, and almost never goes down.
 * - The cadence (when each concept is read, and which readings are counted) is a real concept's,
 *   resampled; first levels come from the real first counted levels, shrunk by the blind noise.
 */
import calibration from './data/mastery-grader-calibration.json'
import {
  WEEK_MS, aggregateChange, conceptChanges, holdoutEffect, holdoutUnits, isBlindGain, seededRandom,
  type AggregateChange, type CountedReading, type HoldoutEffect,
} from './mastery-change-statistics.js'

export const GRADER_CALIBRATION = calibration
/** Planted true learning rates, points of understanding per week. */
export const KNOWN_TRUTH_LANES = { none: 0, slow: 1, medium: 2.5, fast: 5 } as const
export type KnownTruthLane = keyof typeof KNOWN_TRUTH_LANES
export const KNOWN_TRUTH_LANE_ORDER: readonly KnownTruthLane[] = ['none', 'slow', 'medium', 'fast']
const DAY = 86_400_000
/** True levels start inside this band and are planted so the window never carries them past it (the scale clips). */
export const TRUE_LEVEL_BAND = [10, 90] as const

export interface SimOptions {
  lane: KnownTruthLane
  seed: number
  /** Gradings per reading (policy gradingReplicates): the live anchored one plus k − 1 prior-blind replicates. */
  k: number
  /** Concepts with a counted reading (default: as many as the calibration has). */
  concepts?: number
  /** The holdout starts this many days into the window (default 28); held out = 1 in 5. */
  phaseStartDay?: number
  /** After the start a taught concept is read this many times as often (the differential opportunity of review B2). */
  taughtReadMultiplier?: number
  /** Planted teaching effect: after the start a held-out concept learns at this share of the lane rate (default 1: no effect). */
  heldOutRateShare?: number
  /** Blind probe answers per concept per week after the start, equal in both arms (default 0). */
  probesPerWeek?: number
}

export interface SimReading {
  conceptId: string
  at: number
  truth: number
  heldOut: boolean
  /** The published estimate the live grading started from (null: prior-blind), the live grading, and whether it is counted (medium/high). */
  prior: number | null
  anchored: number
  counted: boolean
  /** The prior-blind gradings of this reading: the live one when it was the concept's first, plus the replicates. */
  blind: number[]
  /** The concept's live gradings so far, this one included. */
  gradings: number
  probe: boolean
}

export interface SimLearner {
  lane: KnownTruthLane
  rate: number
  k: number
  phaseStart: number
  readings: SimReading[]
  heldOut: Set<string>
}

const clamp = (x: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x))
const grid = (x: number) => clamp(Math.round(x / 5) * 5)

function normal(rand: () => number): number {
  const u = Math.max(rand(), 1e-12), v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
function poisson(rand: () => number, lambda: number): number {
  if (lambda <= 0) return 0
  let k = 0, p = Math.exp(-lambda), s = p
  const u = rand()
  while (u > s && k < 1000) { k++; p *= lambda / k; s += p }
  return k
}

type Row = (typeof calibration.response)[number]
function interpolate(gap: number, pick: (r: Row) => number): number {
  const rows = calibration.response.filter((r) => r.n >= 5)
  if (gap <= rows[0]!.gap) return pick(rows[0]!)
  if (gap >= rows.at(-1)!.gap) return pick(rows.at(-1)!)
  const i = rows.findIndex((r) => r.gap >= gap)
  const a = rows[i - 1]!, b = rows[i]!
  return pick(a) + (pick(b) - pick(a)) * (gap - a.gap) / (b.gap - a.gap)
}

/**
 * The latent sd before the 5-point grid: the measured blind sd is of GRIDDED gradings, and rounding to
 * the grid adds about 5²/12 of variance, so drawing N(0, measured sd) and then gridding would make the
 * simulated grader noisier than the real one (6.89 against 6.74) and inflate every false-positive rate.
 */
export const latentBlindSd = (gridded: number) => Math.sqrt(Math.max(0, gridded ** 2 - 25 / 12))

/** One prior-blind grading of evidence at true level `truth`: gridded, with the measured sd after gridding. */
export const blindGrading = (rand: () => number, truth: number, sd = calibration.blind.sd) => grid(truth + latentBlindSd(sd) * normal(rand))

/**
 * The response table comes from the 541 anchored gradings that have prior-blind regrades of the same
 * evidence, and that subset rises more often (about 43 %) than the 4,113 anchored gradings as a whole
 * (27.4 %). Scaling the up probability by this factor makes the simulated live scores rise at the
 * population rate (`anchored moves match the population` in mastery-known-truth.test.ts). Verdicts never
 * read the anchored series, so this tunes only the descriptive line and the opportunity covariate.
 */
export const RATCHET_POPULATION_SCALE = 0.62

/** One anchored grading: the live grader revising its estimate `prior` on evidence at true level `truth`. */
export function anchoredGrading(rand: () => number, prior: number, truth: number, sd = calibration.blind.sd, scale = RATCHET_POPULATION_SCALE): number {
  const gap = truth + sd * normal(rand) - prior
  const up = scale * interpolate(gap, (r) => r.up), down = interpolate(gap, (r) => r.down)
  const u = rand()
  if (u < up) {
    // An up move is whole grid steps with the measured mean: 5·(1 + Poisson(mean/5 − 1)).
    const meanUp = Math.max(5, interpolate(gap, (r) => r.upMove ?? 5))
    return clamp(prior + 5 * (1 + poisson(rand, meanUp / 5 - 1)))
  }
  if (u < up + down) return clamp(prior - 5)
  return prior
}

/** True first levels: the real first counted levels' spread minus the blind noise variance, kept inside the band. */
function trueBases(): number[] {
  const xs = calibration.firstLevels, m = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)
  const shrink = Math.sqrt(Math.max(0, v - calibration.blind.sd ** 2) / v)
  return xs.map((x) => clamp(m + shrink * (x - m), TRUE_LEVEL_BAND[0], TRUE_LEVEL_BAND[1]))
}
const BASES = trueBases()

/** Held out iff the concept's index falls in bucket 0 of 5 (a fixed 1 in 5, like the real assignment). */
export const simHeldOut = (conceptId: string) => Number(conceptId.split('-c')[1] ?? 0) % 5 === 0

export function simulateLearner(o: SimOptions): SimLearner {
  const rand = seededRandom(o.seed), noise = seededRandom(o.seed ^ 0x5bd1e995)
  const rate = KNOWN_TRUTH_LANES[o.lane]
  const n = o.concepts ?? calibration.cadence.length
  const phaseStart = (o.phaseStartDay ?? 28) * DAY
  const heldOutRate = rate * (o.heldOutRateShare ?? 1)
  const windowWeeks = calibration.windowDays / 7
  const readings: SimReading[] = []
  const heldOut = new Set<string>()
  for (let i = 0; i < n; i++) {
    const conceptId = `kt${o.seed}-c${i}`
    const held = simHeldOut(conceptId)
    if (held) heldOut.add(conceptId)
    const base = Math.min(BASES[Math.floor(rand() * BASES.length)]!, TRUE_LEVEL_BAND[1] - rate * windowWeeks)
    const truthAt = (t: number) => {
      const w = t / WEEK_MS, s = phaseStart / WEEK_MS
      return clamp(base + (held && t > phaseStart ? rate * s + heldOutRate * (w - s) : rate * w))
    }
    const cadence = calibration.cadence[Math.floor(rand() * calibration.cadence.length)]!
    const shift = rand() * 7 * DAY
    const times: Array<{ at: number; counted: boolean; probe: boolean }> = cadence.map(([d, c]) => ({ at: Math.round(d * DAY + shift), counted: c === 1, probe: false }))
    const countedShare = cadence.filter(([, c]) => c === 1).length / cadence.length
    // Differential opportunity: after the start a taught concept gets extra readings (review B2).
    const extra = (o.taughtReadMultiplier ?? 1) - 1
    if (!held && extra > 0) for (const t of times.filter((x) => x.at >= phaseStart)) {
      for (let j = 0; j < poisson(rand, extra); j++) times.push({ at: t.at + Math.round(rand() * 2 * DAY), counted: rand() < countedShare, probe: false })
    }
    // Blind probes reach both arms alike.
    const probeWeeks = Math.max(0, (calibration.windowDays * DAY + shift - phaseStart) / WEEK_MS)
    for (let j = 0; j < poisson(rand, (o.probesPerWeek ?? 0) * probeWeeks); j++) times.push({ at: Math.round(phaseStart + rand() * probeWeeks * WEEK_MS), counted: rand() < countedShare, probe: true })
    times.sort((a, b) => a.at - b.at)
    let prior: number | null = null
    times.forEach((t, j) => {
      const truth = truthAt(t.at)
      const from = prior
      const live: number = from === null ? blindGrading(noise, truth) : anchoredGrading(noise, from, truth)
      const blind = [...(prior === null ? [live] : []), ...Array.from({ length: Math.max(0, o.k - 1) }, () => blindGrading(noise, truth))]
      // A reading the grader could not tell (low / insufficient) publishes no estimate to anchor on only when it is the first.
      if (t.counted || prior !== null) prior = live
      readings.push({ conceptId, at: t.at, truth, heldOut: held, prior: from, anchored: live, counted: t.counted, blind, gradings: j + 1, probe: t.probe })
    })
  }
  return { lane: o.lane, rate, k: o.k, phaseStart, readings, heldOut }
}

/** The learner's counted measurements as `countedReadings` forms them: anchored (every counted live reading) and prior-blind. */
export function simMeasurements(s: SimLearner): { anchored: CountedReading[]; blind: CountedReading[] } {
  const counted = s.readings.filter((r) => r.counted)
  return {
    anchored: counted.map((r) => ({ conceptId: r.conceptId, at: r.at, percent: r.anchored, replicates: 1, gradings: r.gradings, probe: r.probe })),
    blind: counted.filter((r) => r.blind.length).map((r) => ({ conceptId: r.conceptId, at: r.at, percent: r.blind.reduce((a, b) => a + b, 0) / r.blind.length, replicates: r.blind.length, gradings: r.gradings, probe: r.probe })),
  }
}

/** True mean change over the concepts and spans the statistic measured (first to last measurement of each). */
export function trueMeanChange(s: SimLearner, measured: readonly CountedReading[]): number | null {
  const byConcept = new Map<string, CountedReading[]>()
  for (const r of measured) (byConcept.get(r.conceptId) ?? byConcept.set(r.conceptId, []).get(r.conceptId)!).push(r)
  const truth = new Map(s.readings.map((r) => [`${r.conceptId}@${r.at}`, r.truth]))
  const deltas: number[] = []
  for (const list of byConcept.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => a.at - b.at)
    deltas.push(truth.get(`${list.at(-1)!.conceptId}@${list.at(-1)!.at}`)! - truth.get(`${list[0]!.conceptId}@${list[0]!.at}`)!)
  }
  return deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null
}

export interface GainTrials { eligible: number; announced: number; trueGainAtLeast20: number; trueGainAnnounced: number }

/**
 * The toast's gain rule (and the strip's ▲, the same rule in evidence order) over the learner's
 * readings in order: each counted blind measurement against the mean of the concept's earlier ones.
 * Counts how many were eligible, how many announced, and of those whose TRUE level rose ≥ 20 since
 * the earlier measurements' mean true level, how many were announced (notification sensitivity).
 */
export function gainTrials(s: SimLearner, sd: number, floor: number): GainTrials {
  const out: GainTrials = { eligible: 0, announced: 0, trueGainAtLeast20: 0, trueGainAnnounced: 0 }
  const before = new Map<string, { sum: number; k: number; truth: number; n: number }>()
  for (const r of [...s.readings].sort((a, b) => a.at - b.at)) {
    if (!r.counted || !r.blind.length) continue
    const now = { percent: r.blind.reduce((a, b) => a + b, 0) / r.blind.length, gradings: r.blind.length }
    const b = before.get(r.conceptId)
    if (b) {
      out.eligible++
      const announced = isBlindGain(now, { mean: b.sum / b.k, gradings: b.k }, sd, floor)
      if (announced) out.announced++
      if (r.truth - b.truth / b.n >= 20) { out.trueGainAtLeast20++; if (announced) out.trueGainAnnounced++ }
    }
    const next = b ?? { sum: 0, k: 0, truth: 0, n: 0 }
    next.sum += now.percent * now.gradings; next.k += now.gradings; next.truth += r.truth; next.n++
    before.set(r.conceptId, next)
  }
  return out
}

export interface LearnerVerdicts {
  /** Prior-blind statistics: the ones that may say "rose" / "fell". */
  blind: AggregateChange
  trueChange: number | null
  /** The anchored series, descriptive only. */
  anchored: AggregateChange
  gains: GainTrials
  /** Holdout over blind probe answers (the equal-opportunity headline) and over all blind measurements. */
  probe: HoldoutEffect | null
  holdout: HoldoutEffect
}

/** Everything the statistics would say about one simulated learner. `reps` sets the bootstrap size. */
export function learnerVerdicts(s: SimLearner, sd: number, floor: number, reps = 500): LearnerVerdicts {
  const m = simMeasurements(s)
  const phase = { startedAt: s.phaseStart, isHeldOut: (id: string) => s.heldOut.has(id) }
  const blindChanges = conceptChanges(m.blind, sd)
  const probeReadings = m.blind.filter((r) => r.probe || r.at < s.phaseStart)
  const pu = holdoutUnits(probeReadings, phase)
  const u = holdoutUnits(m.blind, phase)
  const pairs = blindChanges.map((c) => ({ baseline: c.from, followUp: c.to }))
  return {
    blind: aggregateChange(blindChanges, { reps }),
    trueChange: trueMeanChange(s, m.blind.filter((r) => blindChanges.some((c) => c.conceptId === r.conceptId))),
    anchored: aggregateChange(conceptChanges(m.anchored, calibration.anchored.sd), { reps }),
    gains: gainTrials(s, sd, floor),
    probe: m.blind.some((r) => r.probe) ? holdoutEffect(pu.units, pu, 0.2, pairs, { reps }) : null,
    holdout: holdoutEffect(u.units, u, 0.2, pairs, { reps }),
  }
}
