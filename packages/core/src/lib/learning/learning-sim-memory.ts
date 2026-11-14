/**
 * The simulated learner's memory between sessions (docs/specs/simulated-learner-experiment.md, "Learner memory"):
 * revision 10's rule on the fact ids the channel delivered. The state is `Held`, each held exam fact's id with its
 * strength. No model writes it; `renderHeld` shows it as text only where Sam reads the notebook (turns, probes), and
 * the exam is computed from it (`heldExam`: an item scores 2 when its fact is held).
 *
 * A lane's capacity and forget rate (SIM_LANES, MEMORY_RULES) make a learner slow, medium or fast:
 * - capacity: how many characters of NEW facts the learner takes in per session, counted on each fact's canonical
 *   sheet text, in delivery order (skip-and-continue): a new fact that does not fit in what is left is counted
 *   `overCapacity` and skipped, never truncated, and a later new fact that does fit is still taken.
 * - forget: the chance that a held fact is gone by the next session.
 *
 * Every draw is keyed `${pairKey}|${kind}|${factId}|${session}` (`simPairKey`): the two learners of a matched pair
 * share every forgetting and absorption draw for the same fact (common random numbers), and no draw reads text a
 * model wrote. Nothing here knows which policy taught the learner.
 */
import { createHash } from 'node:crypto'
import { HALYARD_FACT_EXAM, HALYARD_FACT_SHEETS } from './learning-sim-facts.js'
import { HALYARD_CATALOG, HALYARD_EDGES } from './learning-sim-halyard.js'

/** `none` is the never-learns negative control: capacity 0, so nothing is ever taken up (and its teaching budget is 0). */
export const SIM_LANES = {
  none: { capacity: 0 },
  slow: { capacity: 100 },
  medium: { capacity: 200 },
  fast: { capacity: 400 },
} as const
export type SimLane = keyof typeof SIM_LANES

/** The simulator's one PRNG: a stream of uniform numbers in [0, 1) seeded by a string (mulberry32 from the seed's
 * sha256), so every draw of a design, a memory rule or a bootstrap is reproducible from its inputs. */
export function seeded(seed: string) {
  let state = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16)
  return () => { state = (state + 0x6d2b79f5) | 0; let t = Math.imul(state ^ (state >>> 15), 1 | state); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** One draw from `seeded(s)`: the same input always gives the same number. */
export const draw = (s: string) => seeded(s)()

/**
 * The memory rules (docs/specs/simulated-learner-experiment.md, "Memory rules"). They read only the held facts, the
 * fact ids the channel delivered this session and the curriculum's prerequisite edges. Fixed before any comparison;
 * the spec justifies each value. The result of a run is conditional on them and says nothing about a real person's
 * memory.
 *
 * - forget: the chance that an unrehearsed fact is gone by the next session (one session gap of SIM_DAY_GAP days).
 * - spacing: each session in which a held fact is delivered again multiplies its forget rate by this factor
 *   (strength n gives forget x spacing^n).
 * - prerequisiteAbsorb: the chance a new fact is kept when some direct prerequisite of its concept has no held fact
 *   (facts taken up earlier in the same session count). It still uses capacity: the reading cost is paid.
 */
export type MemoryRules = { forget: Record<SimLane, number>; spacing: number; prerequisiteAbsorb: number }
export const MEMORY_RULES: MemoryRules = { forget: { none: 1, slow: 0.3, medium: 0.25, fast: 0.2 }, spacing: 0.5, prerequisiteAbsorb: 0.5 }

/** The curriculum as the rules read it: a fact's concept and a concept's direct prerequisites. */
export type MemoryGraph = { conceptOf: (factId: string) => string; prerequisites: (conceptId: string) => string[] }
const FACTS = new Map(HALYARD_FACT_SHEETS.flatMap((s) => s.facts.map((f) => [f.id, { conceptId: s.conceptId, text: f.fact }] as const)))
const factOf = (id: string) => {
  const f = FACTS.get(id)
  if (!f) throw new Error(`Unknown exam fact ${id}`)
  return f
}
export const HALYARD_GRAPH: MemoryGraph = {
  conceptOf: (id) => factOf(id).conceptId,
  prerequisites: (conceptId) => HALYARD_EDGES.filter(([, to]) => to === conceptId).map(([from]) => from),
}

/** Held exam facts: id -> strength (the sessions in which the fact was delivered again while held). */
export type Held = Record<string, number>
/** A delivered fact and the path the channel delivered it by. The path type is the channel's (packet 2's matcher
 * `DeliveryPath`); it is optional because deliveries recorded before the channel kept it carry none. */
export type Delivery<P extends string = string> = { factId: string; path?: P }

/** One session: forget (slowed by strength), strengthen what was delivered again, then take up new facts in delivery
 * order within capacity (one that does not fit is skipped, later ones that fit are still taken), each kept with probability 1, or prerequisiteAbsorb when a direct prerequisite concept has
 * no held fact. `delivered` are the session's delivered fact ids in delivery order. */
export function updateHeld(previous: Held, delivered: readonly string[], lane: SimLane, pairKey: string, session: number,
  graph: MemoryGraph = HALYARD_GRAPH, rules: MemoryRules = MEMORY_RULES) {
  const u = (kind: string, id: string) => draw(`${pairKey}|${kind}|${id}|${session}`)
  const held: Held = {}
  let forgotten = 0, strengthened = 0, added = 0, used = 0, overCapacity = 0, unabsorbed = 0
  for (const [id, strength] of Object.entries(previous)) {
    if (u('forget', id) < rules.forget[lane] * rules.spacing ** strength) forgotten++
    else held[id] = strength
  }
  for (const id of new Set(delivered)) {
    if (id in held) { held[id]!++; strengthened++; continue }
    const length = factOf(id).text.length
    if (used + length > SIM_LANES[lane].capacity) { overCapacity++; continue }
    used += length
    const have = new Set(Object.keys(held).map(graph.conceptOf))
    if (graph.prerequisites(graph.conceptOf(id)).some((p) => !have.has(p)) && u('absorb', id) >= rules.prerequisiteAbsorb) { unabsorbed++; continue }
    held[id] = 0
    added++
  }
  return { held, facts: Object.keys(held).length, added, used, overCapacity, forgotten, strengthened, unabsorbed }
}

/** The notebook Sam reads: `### <concept title>`, then `- <sheet text>` for each held fact, in sheet order. */
export const renderHeld = (held: Held) => HALYARD_FACT_SHEETS.map((s) => ({ s, facts: s.facts.filter((f) => f.id in held) })).filter((x) => x.facts.length)
  .map(({ s, facts }) => `### ${HALYARD_CATALOG.concepts.find((c) => c.id === s.conceptId)!.title}\n${facts.map((f) => `- ${f.fact}`).join('\n')}`).join('\n\n')

/** An exam: `points` per item (0-2), `byConcept` each concept's mean percent, `total` the concept mean (rounded, as
 * every revision before 10 reported it) and `items` the item mean (unrounded: one item is 100/60 points). */
export type ExamResult = { timepoint: number; byConcept: Record<string, number>; total: number; items: number; points: Record<string, number> }
export function examResult(timepoint: number, points: Record<string, number>): ExamResult {
  const byConcept: Record<string, number> = {}
  for (const concept of HALYARD_CATALOG.concepts) {
    const questions = HALYARD_FACT_EXAM.filter((x) => x.conceptId === concept.id)
    byConcept[concept.id] = Math.round(100 * questions.reduce((n, x) => n + (points[x.id] ?? 0), 0) / (2 * questions.length))
  }
  const total = Math.round(Object.values(byConcept).reduce((a, b) => a + b, 0) / HALYARD_CATALOG.concepts.length)
  const items = 100 * HALYARD_FACT_EXAM.reduce((n, x) => n + (points[x.id] ?? 0), 0) / (2 * HALYARD_FACT_EXAM.length)
  return { timepoint, byConcept, total, items, points }
}
/** The exam after a session: an item scores 2 when its fact is held, else 0. */
export const heldExam = (timepoint: number, held: Held) => examResult(timepoint, Object.fromEntries(HALYARD_FACT_EXAM.map((q) => [q.id, q.id in held ? 2 : 0])))

/**
 * The exams after each session, recomputed from stored deliveries (one inner list per session, in delivery order)
 * through `updateHeld`, the notebook step's own rule. With no override it reproduces the run's exams exactly. The
 * overrides give the pre-registered sensitivity versions and the decomposition: `absorb` replaces prerequisiteAbsorb,
 * `dropPaths` removes the deliveries of those paths, `truncateTo[i]` keeps only the first n deliveries of session i + 1.
 */
export function replayExams<P extends string>(deliveries: ReadonlyArray<readonly Delivery<P>[]>, lane: SimLane, pairKey: string,
  overrides: { absorb?: number; dropPaths?: readonly P[]; truncateTo?: readonly number[] } = {}, graph: MemoryGraph = HALYARD_GRAPH): ExamResult[] {
  const rules = overrides.absorb === undefined ? MEMORY_RULES : { ...MEMORY_RULES, prerequisiteAbsorb: overrides.absorb }
  let held: Held = {}
  return deliveries.map((session, i) => {
    const kept = session.filter((d) => !d.path || !overrides.dropPaths?.includes(d.path)).slice(0, overrides.truncateTo?.[i])
    held = updateHeld(held, kept.map((d) => d.factId), lane, pairKey, i + 1, graph, rules).held
    return heldExam(i + 1, held)
  })
}
