import { createHash } from 'node:crypto'
import { HALYARD_CATALOG, HALYARD_TASKS_V2 } from './learning-sim-halyard.js'
import { SIM_LANES, type SimLane } from './learning-sim-memory.js'

/**
 * Batch 2's assignment (docs/specs/simulated-learner-experiment.md, "Batch 2"): pure functions of the run id, so a
 * resumed run rebuilds exactly the same learners.
 *
 * - Arm is randomized within lane: the lane's arm slots are shuffled, and learner ids follow the shuffled order.
 * - Holdout: each learner holds out HELD_OUT_PER_LEARNER concepts (3 of 13, the share the product uses), passed to the
 *   live turn explicitly. Stratified across learners: within each (lane, arm) cell, learner k takes positions 3k..3k+2
 *   of one seeded permutation of the catalog, so over 13 learners of a cell every concept is held out exactly 3 times
 *   (the counts never differ by more than one), and no concept is held out more in one arm than in another.
 * - Task order: a cyclic Latin square over the five briefs; learner k of a cell takes row k mod 5, so each brief sits
 *   in each session position equally often within the cell.
 * - Teaching budget: facts per session near the lane's notebook capacity (one fact is about 50 characters of notes).
 */
export const HELD_OUT_PER_LEARNER = 3
/** Days between sessions on the simulated calendar: past every spaced-repetition interval below 60% mastery. */
export const SIM_DAY_GAP = 5
export const factBudget = (lane: SimLane) => Math.max(1, Math.round(SIM_LANES[lane].capacity / 50))

const seeded = (seed: string) => { let n = 0; return () => parseInt(createHash('sha256').update(`${seed}:${n++}`).digest('hex').slice(0, 12), 16) / 2 ** 48 }
export function shuffle<T>(items: readonly T[], seed: string): T[] {
  const out = [...items], r = seeded(seed)
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j]!, out[i]!] }
  return out
}
/** Row `k` of the cyclic Latin square over `n` tasks: (k, k+1, ..., k+n-1) mod n. */
export const latinRow = (k: number, n = HALYARD_TASKS_V2.length) => Array.from({ length: n }, (_, i) => (k + i) % n)
/** The `k`-th learner's held-out concepts of a cell whose permutation is seeded by `seed`. */
export function stratifiedHoldout(k: number, seed: string, size = HELD_OUT_PER_LEARNER) {
  const order = shuffle(HALYARD_CATALOG.concepts.map((c) => c.id), seed)
  return Array.from({ length: size }, (_, i) => order[(k * size + i) % order.length]!).sort()
}

export type Batch2Slot = { lane: SimLane; arm: string; index: number; cellIndex: number; heldOut: string[]; taskOrder: number[]; factBudget: number; dayGap: number }
/** Every learner of a batch-2 run: per lane, the arm slots shuffled (arm randomized within lane); within each cell the
 * k-th learner's holdout block and Latin-square row. `index` is the learner's position in its lane (1-based). */
export function batch2Slots(runId: string, lanes: SimLane[], perArm: (arm: string, lane: SimLane) => number, arms: string[], sessions: number): Batch2Slot[] {
  const out: Batch2Slot[] = []
  for (const lane of lanes) {
    const slots = shuffle(arms.flatMap((arm) => Array.from({ length: perArm(arm, lane) }, () => arm)), `${runId}:arms:${lane}`)
    const seen = new Map<string, number>()
    slots.forEach((arm, i) => {
      const k = seen.get(arm) ?? 0
      seen.set(arm, k + 1)
      out.push({ lane, arm, index: i + 1, cellIndex: k, heldOut: stratifiedHoldout(k, `${runId}:holdout:${lane}:${arm}`), taskOrder: latinRow(k).slice(0, sessions), factBudget: factBudget(lane), dayGap: SIM_DAY_GAP })
    })
  }
  return out
}
