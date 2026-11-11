/**
 * A simulated learner for checking `probeDifference` (docs/specs/blind-probes.md, "How the
 * analysis was checked"). Synthetic numbers only; nothing here reads a database.
 *
 * The world: 120 concepts with a log-normal centrality, one in five held out, half met before.
 * A turn relates each concept with a chance proportional to its centrality (about eleven per
 * turn) and picks one of them uniformly, whatever its arm: the production rule. A probe is demonstrated with a chance that is
 * logistic in the concept's ability, which may rise with centrality (`centrality`), rises by
 * `testing` for each earlier probe of the same concept (at most five), rises by `trend` in all
 * over the run (the learner getting better at everything with time), and is `effect` higher in the
 * taught arm. `topicBoost` adds what a real turn has and the world above lacks: a turn is ABOUT one
 * concept, which is never a candidate on it, and a taught concept is the topic `1 + topicBoost` times
 * as often as a held-out one of the same centrality (teaching makes the learner return to it).
 */
import { createHash } from 'node:crypto'
import type { DependencyEdge } from './learning-foundation-priority.js'
import { probeDifference, selectProbe, type ProbeArm, type ProbeReading, type ProbeRow } from './learning-blind-probes.js'

export interface ProbeWorld { probes: number; effect?: number; centrality?: number; testing?: number; trend?: number; topicBoost?: number }

/** A simulated probe row, with the picked concept's centrality (how often it is near a turn). */
type SimulatedProbeRow = ProbeRow & { centrality: number }

/** A small deterministic generator, so a seed gives the same world on every machine. */
export const seededRandom = (seed: number) => {
  let state = seed >>> 0
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296 }
}

export function simulateProbeRows(world: ProbeWorld, random: () => number): SimulatedProbeRow[] {
  const normal = () => Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())
  const concepts = 120
  for (;;) {
    const centrality = Array.from({ length: concepts }, () => Math.exp(normal())), total = centrality.reduce((a, b) => a + b, 0)
    const held = centrality.map(() => random() < 0.2), met = centrality.map(() => random() < 0.5)
    const ability = centrality.map((c) => -0.3 + (world.centrality ?? 0) * Math.log(c) + 0.8 * normal())
    const asked = new Array<number>(concepts).fill(0), rows: SimulatedProbeRow[] = []
    for (let turn = 0; rows.length < world.probes && turn < 100_000; turn++) {
      let topic = -1
      if (world.topicBoost !== undefined) {
        const weight = (i: number) => centrality[i]! * (held[i] ? 1 : 1 + world.topicBoost!)
        let x = random() * centrality.reduce((sum, _c, i) => sum + weight(i), 0)
        do { topic++; x -= weight(topic) } while (x > 0 && topic < concepts - 1)
      }
      const related = centrality.flatMap((c, i) => (i !== topic && random() < Math.min(1, 11 * c / total) ? [i] : []))
      const pool = related
      if (!pool.length) continue
      const concept = pool[Math.floor(random() * pool.length)]!, arm = held[concept] ? 'held_out' as const : 'taught' as const
      const chance = 1 / (1 + Math.exp(-(ability[concept]! + (world.testing ?? 0) * Math.min(asked[concept]!, 5) + (world.trend ?? 0) * rows.length / world.probes))) + (arm === 'taught' ? world.effect ?? 0 : 0)
      asked[concept]!++
      rows.push({ arm, concept_id: String(concept), met_before: met[concept]!, probe_index: asked[concept]!, status: 'scored', demonstrated: random() < Math.min(0.999, Math.max(0.001, chance)), candidates: pool.length, days_since_holdout: turn, centrality: centrality[concept]! })
    }
    if (rows.length === world.probes) return rows
  }
}

interface ProbeCoverage {
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

interface ProbeSchedule {
  /** Per arm, over all replications. */
  arms: Record<'held_out' | 'taught', {
    /** Probes of the arm per concept of the arm that was probed at all. */
    probesPerConcept: number
    /** When a concept's first probe came, as a share of the run (0 = start, 1 = end): mean, and the quartiles. */
    firstProbeAt: number
    firstProbeQuartiles: [number, number, number]
    /** Mean centrality of the concepts that were probed. */
    probedCentrality: number
  }>
}

/** How the scheduler treats the two arms, with no outcome involved: equal figures mean a concept's arm does not decide when or whether it is probed. */
export function probeSchedule(world: ProbeWorld, replications: number, seed: number): ProbeSchedule {
  const random = seededRandom(seed)
  const firsts: Record<'held_out' | 'taught', number[]> = { held_out: [], taught: [] }
  const sums = { held_out: { probes: 0, concepts: 0, centrality: 0 }, taught: { probes: 0, concepts: 0, centrality: 0 } }
  for (let i = 0; i < replications; i++) {
    const rows = simulateProbeRows(world, random), end = rows.at(-1)!.days_since_holdout || 1
    for (const r of rows) { sums[r.arm].probes++; if (r.probe_index === 1) { sums[r.arm].concepts++; sums[r.arm].centrality += r.centrality; firsts[r.arm].push(r.days_since_holdout / end) } }
  }
  const arm = (a: 'held_out' | 'taught') => {
    const sorted = firsts[a].sort((x, y) => x - y), q = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!
    return { probesPerConcept: sums[a].probes / sums[a].concepts, firstProbeAt: sorted.reduce((x, y) => x + y, 0) / sorted.length, firstProbeQuartiles: [q(0.25), q(0.5), q(0.75)] as [number, number, number], probedCentrality: sums[a].centrality / sums[a].concepts }
  }
  return { arms: { held_out: arm('held_out'), taught: arm('taught') } }
}

interface TopicFeedback {
  /** Probes per catalog concept of the arm. */
  perConcept: Record<ProbeArm, number>
  /** Held-out over taught: 1 when the arm does not decide how often a concept is probed. */
  ratio: number
  /** The turn by which a quarter of the arm's concepts had their first probe. */
  firstProbeQuartile: Record<ProbeArm, number>
}

/**
 * The real `selectProbe` on a sparse random graph over a catalog and its holdout, with turn topics that
 * DEPEND on the arm (review 7, S2). A turn is about one concept, drawn by popularity. With `boost` > 0 a
 * taught neighbour of the topic is taught with chance 0.3 and from then on is a topic with `boost` more
 * weight: the learner returns to what was taught. A turn's own concept is never a candidate, so such a
 * concept is probed less there, while its neighbours are candidates more often: the two pull opposite ways and
 * the net sign depends on the graph. `boost` 0 is the world of the fixture test: topics do not know the arm.
 */
export function topicFeedback(input: { seed: number; boost: number; turns: number; hops: number; catalogIds: string[]; heldOut: ReadonlySet<string> }): TopicFeedback {
  const random = seededRandom(input.seed), ids = input.catalogIds, n = ids.length
  const edges: DependencyEdge[] = Array.from({ length: n * 2 }, () => ({ from: ids[Math.floor(random() * n)]!, to: ids[Math.floor(random() * n)]!, kind: 'related' as const }))
  const weight = ids.map(() => Math.exp(1.2 * Math.sqrt(-2 * Math.log(random() + 1e-12)) * Math.cos(2 * Math.PI * random())))
  const index = new Map(ids.map((id, i) => [id, i])), neighbours = ids.map(() => [] as number[])
  for (const e of edges) { neighbours[index.get(e.from)!]!.push(index.get(e.to)!); neighbours[index.get(e.to)!]!.push(index.get(e.from)!) }
  const probes = new Array<number>(n).fill(0), first = new Array<number>(n).fill(input.turns)
  let total = weight.reduce((a, b) => a + b, 0)
  for (let turn = 0; turn < input.turns; turn++) {
    let x = random() * total, topic = 0
    while ((x -= weight[topic]!) > 0 && topic < n - 1) topic++
    const hex = createHash('md5').update(`${input.seed}:${turn}`).digest('hex'), turnId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
    const { probe } = selectProbe({ turnId, rate: 100, hops: input.hops, turnConceptIds: [ids[topic]!], edges, catalogIds: ids, heldOut: input.heldOut })
    if (probe) { const i = index.get(probe.conceptId)!; probes[i]!++; first[i] = Math.min(first[i]!, turn) }
    // The teaching draw is made at every boost, 0 included, so two boosts with one seed share graph, popularity and draws.
    for (const i of neighbours[topic]!) if (!input.heldOut.has(ids[i]!) && random() < 0.3) { weight[i]! += input.boost; total += input.boost }
  }
  const arm = (heldOut: boolean) => {
    const own = ids.flatMap((id, i) => (input.heldOut.has(id) === heldOut ? [i] : [])), times = own.map((i) => first[i]!).sort((a, b) => a - b)
    return { perConcept: own.reduce((sum, i) => sum + probes[i]!, 0) / own.length, quartile: times[Math.floor(times.length / 4)]! }
  }
  const held = arm(true), taught = arm(false)
  return { perConcept: { held_out: held.perConcept, taught: taught.perConcept }, ratio: held.perConcept / taught.perConcept, firstProbeQuartile: { held_out: held.quartile, taught: taught.quartile } }
}
