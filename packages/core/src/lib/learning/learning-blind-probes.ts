import { createHash } from 'node:crypto'
import { REVIEW_HOPS_ALL } from '@learner/contract/learning/learning-policy.js'
import type { DependencyEdge } from './learning-foundation-priority.js'
import { turnDraw } from './learning-intervention-policy.js'
import { relatedHops } from './learning-spaced-repetition.js'

/**
 * Blind probes (docs/specs/blind-probes.md). Taught concepts get asked about and held-out
 * concepts do not, so the taught arm has more chances to show evidence. A probe is one short
 * check question about a concept related to the turn, drawn with EQUAL probability from the
 * held-out and the taught arm and worded identically for both, so both arms get the same chance
 * to show what the learner knows. It is the only way a held-out concept reaches the guidance,
 * and it is a question, never a lesson.
 */
export const PROBE_DRAW_SALT = 'learning-probe'
export const PROBE_ARM_SALT = 'learning-probe-arm'
export const PROBE_PICK_SALT = 'learning-probe-pick'
export const PROBE_ARMS = ['held_out', 'taught'] as const
export type ProbeArm = (typeof PROBE_ARMS)[number]
export type Probe = { conceptId: string; arm: ProbeArm; hops: number; relatedTo: string }

/** Whether this turn draws a probe: a pure function of the turn id, independent of the injection coin. */
export const probeDrawn = (turnId: string, rate: number): boolean => turnDraw(PROBE_DRAW_SALT, turnId) < rate
/** The arm this turn probes: a fair coin on the turn id, decided BEFORE looking at what is available. */
export const probeArm = (turnId: string): ProbeArm => turnDraw(PROBE_ARM_SALT, turnId) < 50 ? 'held_out' : 'taught'

/** How the agent treats the probe; sent only when one is delivered. The same words for both arms. */
export const PROBE_GUIDANCE = 'role "probe": a check, not a teaching target. End your reply with exactly ONE question in this form: "Quick check: in one sentence, what is <title>, and where would it matter in what we are doing?" Do not explain, define, hint at or teach that concept in this reply, do not answer the question yourself, and do not list it in taughtConceptIds. If the learner answers, acknowledge it in one line and carry on with the task; do not correct or expand on it.'

/**
 * The turn's probe, or null. Candidates are catalog concepts within `hops` of the turn's concepts
 * (the spaced-repetition relatedness), never the turn's own concepts or `skip` (what the guidance
 * already carries, and recently demonstrated ones). The arm is drawn first; within it every
 * candidate is equally likely (ordered by a hash of turn and concept). No candidate in the drawn
 * arm means no probe: falling back to the other arm would probe taught concepts more often.
 */
export function selectProbe(input: { turnId: string; rate: number; hops: number; turnConceptIds: string[]; edges: DependencyEdge[]; catalogIds: string[]; heldOut: ReadonlySet<string>; skip: ReadonlySet<string> }): Probe | null {
  if (!probeDrawn(input.turnId, input.rate)) return null
  const arm = probeArm(input.turnId)
  const limit = input.hops >= REVIEW_HOPS_ALL ? Infinity : input.hops
  const order = (conceptId: string) => createHash('md5').update(`${PROBE_PICK_SALT}:${input.turnId}:${conceptId}`).digest('hex')
  const candidates = [...relatedHops({ edges: input.edges, catalogIds: input.catalogIds, from: input.turnConceptIds })]
    .filter(([conceptId, related]) => related.hops <= limit && !input.skip.has(conceptId) && input.heldOut.has(conceptId) === (arm === 'held_out'))
    .map(([conceptId, related]) => ({ conceptId, arm, hops: related.hops, relatedTo: related.relatedTo, key: order(conceptId) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const picked = candidates[0]
  return picked ? { conceptId: picked.conceptId, arm: picked.arm, hops: picked.hops, relatedTo: picked.relatedTo } : null
}
