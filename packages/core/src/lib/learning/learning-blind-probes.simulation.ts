/**
 * A simulated learner for checking `probeDifference` (docs/specs/blind-probes.md, "How the
 * analysis was checked"). Synthetic numbers only; nothing here reads a database.
 *
 * The world: 120 concepts with a log-normal centrality, one in five held out, half met before.
 * A turn relates each concept with a chance proportional to its centrality (about eleven per
 * turn), is probed only when both arms have a related concept, flips a fair coin for the arm and
 * picks uniformly inside it: the production rule. A probe is demonstrated with a chance that is
 * logistic in the concept's ability, which may rise with centrality (`centrality`), rises by
 * `testing` for each earlier probe of the same concept (at most five), and is `effect` higher in
 * the taught arm.
 */
import { probeDifference, type ProbeReading, type ProbeRow } from './learning-blind-probes.js'

export interface ProbeWorld { probes: number; effect?: number; centrality?: number; testing?: number }

/** A small deterministic generator, so a seed gives the same world on every machine. */
export const seededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
}

export function simulateProbeRows(world: ProbeWorld, random: () => number): ProbeRow[] {
  const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())
  const concepts = 120
  for (;;) {
    const centrality = Array.from({ length: concepts }, () => Math.exp(normal())), total = centrality.reduce((a, b) => a + b, 0)
    const held = centrality.map(() => random() < 0.2), met = centrality.map(() => random() < 0.5)
    const ability = centrality.map((c) => -0.3 + (world.centrality ?? 0) * Math.log(c) + 0.8 * normal())
    const asked = new Array<number>(concepts).fill(0), rows: ProbeRow[] = []
    for (let turn = 0; rows.length < world.probes && turn < 100_000; turn++) {
      const related = centrality.flatMap((c, i) => (random() < Math.min(1, 11 * c / total) ? [i] : []))
      const heldOut = related.filter((i) => held[i]), taught = related.filter((i) => !held[i])
      if (!heldOut.length || !taught.length) continue
      const arm = random() < 0.5 ? 'held_out' : 'taught', pool = arm === 'held_out' ? heldOut : taught, concept = pool[Math.floor(random() * pool.length)]!
      const chance = 1 / (1 + Math.exp(-(ability[concept]! + (world.testing ?? 0) * Math.min(asked[concept]!, 5)))) + (arm === 'taught' ? world.effect ?? 0 : 0)
      asked[concept]!++
      rows.push({ arm, concept_id: String(concept), met_before: met[concept]!, probe_index: asked[concept]!, status: 'scored', demonstrated: random() < Math.min(0.999, Math.max(0.001, chance)), own_candidates: pool.length, days_since_holdout: turn })
    }
    if (rows.length === world.probes) return rows
  }
}

export interface ProbeCoverage {
  /** Replications that gave a difference at all. */
  compared: number
  /** Mean difference minus the true effect. */
  bias: number
  /** The spread of the difference across replications, and the mean reported standard error: equal when the error is honest. */
  spread: number
  meanSe: number
  /** Share of 95 % intervals that hold the true effect. */
  coverage: number
  /** Share of intervals that exclude zero: the false-positive rate when the effect is 0, the power otherwise. */
  excludesZero: number
  /** Replications whose standard error was 0. Must stay 0. */
  zeroSe: number
}

export function probeCoverage(world: ProbeWorld, reading: ProbeReading, replications: number, seed: number): ProbeCoverage {
  const random = seededRandom(seed), truth = world.effect ?? 0
  let compared = 0, sum = 0, squares = 0, se = 0, covered = 0, excludesZero = 0, zeroSe = 0
  for (let i = 0; i < replications; i++) {
    const d = probeDifference(simulateProbeRows(world, random), { reading })
    if (d.status !== 'ok') continue
    compared++; sum += d.difference!; squares += d.difference! ** 2; se += d.se!
    if (!(d.se! > 0)) zeroSe++
    if (d.interval![0] <= truth && truth <= d.interval![1]) covered++
    if (d.interval![0] > 0 || d.interval![1] < 0) excludesZero++
  }
  const mean = sum / compared
  return { compared, bias: mean - truth, spread: Math.sqrt(Math.max(0, squares / compared - mean ** 2)), meanSe: se / compared, coverage: covered / compared, excludesZero: excludesZero / compared, zeroSe }
}
