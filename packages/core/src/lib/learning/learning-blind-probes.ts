import { createHash } from 'node:crypto'
import { REVIEW_HOPS_ALL } from '@learner/contract/learning/learning-policy.js'
import type { DependencyEdge } from './learning-foundation-priority.js'
import { turnDraw } from './learning-intervention-policy.js'
import { relatedHops } from './learning-spaced-repetition.js'

/**
 * Blind probes (docs/specs/blind-probes.md). Taught concepts get asked about and held-out
 * concepts do not, so the taught arm has more chances to show evidence. A probe is one short
 * check question about a concept related to the turn, worded identically for both arms.
 *
 * The comparison is only valid on a common turn population, so a turn is probed ONLY when both
 * arms have a candidate; on such a turn a fair coin on the turn id picks the arm. Every rule that
 * decides whether a turn is probed looks at the turn, never at the drawn arm, and the candidate
 * rule uses nothing that exists for taught concepts only (no suppression, no packet contents).
 */
export const PROBE_DRAW_SALT = 'learning-probe'
export const PROBE_ARM_SALT = 'learning-probe-arm'
export const PROBE_PICK_SALT = 'learning-probe-pick'
export const PROBE_ARMS = ['held_out', 'taught'] as const
export type ProbeArm = (typeof PROBE_ARMS)[number]
export type Probe = { conceptId: string; arm: ProbeArm; hops: number; relatedTo: string }

/** Why a turn did or did not deliver a probe. Stored on the turn for every turn decided with probes on. */
/** `fail_open` is a turn whose guidance lookup failed with probes on: nothing was decided, and the row says so. */
export const PROBE_OUTCOMES = ['not_drawn', 'no_target', 'packet_full', 'arm_empty', 'size', 'not_injected', 'delivered', 'fail_open'] as const
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number]
/** One turn's probe decision. `arm` and the candidate counts are set on every drawn turn, also when
 * nothing was delivered, so the fair subset (both counts > 0) and the coin can be audited from the table. */
export type ProbeDraw = {
  outcome: ProbeOutcome; rate: number; hops: number
  arm: ProbeArm | null; heldOutCandidates: number | null; taughtCandidates: number | null; conceptId: string | null
  /** The delivered concept's own distance from the turn (`hops` is the setting). The graph is not versioned, so it is stored. */
  conceptHops: number | null
}

/** Whether this turn draws a probe: a pure function of the turn id, independent of the injection coin. */
export const probeDrawn = (turnId: string, rate: number): boolean => turnDraw(PROBE_DRAW_SALT, turnId) < rate
/** The arm this turn probes: a fair coin on the turn id, independent of what is available. */
export const probeArm = (turnId: string): ProbeArm => turnDraw(PROBE_ARM_SALT, turnId) < 50 ? 'held_out' : 'taught'

/** How the agent treats the probe; sent only when one is delivered. The same words for both arms. */
export const PROBE_GUIDANCE = 'role "probe": a check, not a teaching target. End your reply with exactly ONE question in this form: "Quick check: in one sentence, what is <title>, and where would it matter in what we are doing?" Do not explain, define, hint at or teach that concept in this reply, do not answer the question yourself, and do not list it in taughtConceptIds. If the learner answers, acknowledge it in one line and carry on with the task; do not correct or expand on it.'

/**
 * Both arms' candidates for a turn: catalog concepts within `hops` of the turn's concepts (the
 * spaced-repetition relatedness), never the turn's own concepts. Nothing else is excluded: the
 * same rule for both arms. Each arm is in the order of a hash of turn and concept, so the first
 * entry is a uniform pick.
 */
export function probeCandidates(input: { turnId: string; hops: number; turnConceptIds: string[]; edges: DependencyEdge[]; catalogIds: string[]; heldOut: ReadonlySet<string> }): Record<ProbeArm, Probe[]> {
  const limit = input.hops >= REVIEW_HOPS_ALL ? Infinity : input.hops
  const order = (conceptId: string) => createHash('md5').update(`${PROBE_PICK_SALT}:${input.turnId.toLowerCase()}:${conceptId}`).digest('hex')
  const all = [...relatedHops({ edges: input.edges, catalogIds: input.catalogIds, from: input.turnConceptIds })]
    .filter(([, related]) => related.hops <= limit)
    .map(([conceptId, related]) => ({ conceptId, arm: (input.heldOut.has(conceptId) ? 'held_out' : 'taught') as ProbeArm, hops: related.hops, relatedTo: related.relatedTo, key: order(conceptId) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ key: _key, ...probe }) => probe)
  return { held_out: all.filter((p) => p.arm === 'held_out'), taught: all.filter((p) => p.arm === 'taught') }
}

/**
 * The turn's probe decision from its candidates alone (the packet rules are applied by the
 * caller, on the turn and before the arm matters). Not drawn: nothing is computed. Drawn: the
 * arm and both counts are recorded. A probe is picked only when BOTH arms have a candidate; a
 * turn near no held-out (or no taught) concept is not probed in either arm, so held-out and
 * taught probes come from the same turns and the coin alone decides the arm.
 */
export function selectProbe(input: { turnId: string; rate: number; hops: number; turnConceptIds: string[]; edges: DependencyEdge[]; catalogIds: string[]; heldOut: ReadonlySet<string> }): { draw: ProbeDraw; probe: Probe | null; candidates: Record<ProbeArm, Probe[]> | null } {
  const base = { rate: input.rate, hops: input.hops }
  if (!probeDrawn(input.turnId, input.rate)) return { draw: { ...base, outcome: 'not_drawn', arm: null, heldOutCandidates: null, taughtCandidates: null, conceptId: null, conceptHops: null }, probe: null, candidates: null }
  const arm = probeArm(input.turnId)
  const candidates = probeCandidates(input)
  const counts = { arm, heldOutCandidates: candidates.held_out.length, taughtCandidates: candidates.taught.length }
  const probe = candidates.held_out.length && candidates.taught.length ? candidates[arm][0]! : null
  return { draw: { ...base, ...counts, outcome: probe ? 'delivered' : 'arm_empty', conceptId: probe?.conceptId ?? null, conceptHops: probe?.hops ?? null }, probe, candidates }
}

/** Every delivered probe with its score. Shared by the two analysis queries below. $1 = user id.
 * - `scored`: the probe has an answer turn (the session's next turn) that does not report the concept
 *   as taught. `answered` / `demonstrated` are read on that turn ONLY: later turns can follow
 *   teaching of the probed concept, which only the taught arm ever gets.
 * - `k`: the probe's index for its concept (1 = the first time this concept was probed).
 * - `seen_in_session`: an earlier turn of the session delivered the concept as a teaching target or
 *   a review, or reported it taught. */
const PROBED_CTE = `turns AS (
  SELECT t.*, row_number() OVER (PARTITION BY session_id ORDER BY created_at) AS n
  FROM learning_live_feedback_turns t WHERE user_id = $1
), probed AS (
  SELECT p.probe_arm, p.probe_concept_id, p.created_at,
    row_number() OVER (PARTITION BY p.probe_concept_id ORDER BY p.created_at) AS k,
    a.turn_id IS NOT NULL AND NOT COALESCE(jsonb_exists(CASE WHEN jsonb_typeof(a.feedback->'taughtConceptIds') = 'array' THEN a.feedback->'taughtConceptIds' ELSE '[]' END, p.probe_concept_id), false) AS scored,
    EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.feedback->'matches') = 'array' THEN a.feedback->'matches' ELSE '[]' END) m
      WHERE m->>'conceptId' = p.probe_concept_id AND m->>'relationship' = 'learner_evidence') AS answered,
    EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.feedback->'matches') = 'array' THEN a.feedback->'matches' ELSE '[]' END) m
      WHERE m->>'conceptId' = p.probe_concept_id AND m->>'relationship' = 'learner_evidence' AND m->>'outcome' = 'demonstrated') AS demonstrated,
    EXISTS (SELECT 1 FROM turns e WHERE e.session_id = p.session_id AND e.n < p.n AND (
      p.probe_concept_id = ANY(COALESCE(e.guidance_concept_ids, '{}')) OR e.review_concept_id = p.probe_concept_id
      OR jsonb_exists(CASE WHEN jsonb_typeof(e.feedback->'taughtConceptIds') = 'array' THEN e.feedback->'taughtConceptIds' ELSE '[]' END, p.probe_concept_id))) AS seen_in_session
  FROM turns p LEFT JOIN turns a ON a.session_id = p.session_id AND a.n = p.n + 1
  WHERE p.probe_outcome = 'delivered'
)`

/**
 * The documented analysis (docs/specs/blind-probes.md, "Analysis"). $1 = user id, $2 = when the
 * holdout started. One row per arm and stratum; the unit is the CONCEPT, not the probe.
 *
 * - Each concept's rate is the mean over its scored probes in the stratum; arms are compared on
 *   concept means (`concepts`, `demonstrated`, `sd_demonstrated`), so a few often-probed concepts
 *   do not carry it. Unscored probes are counted in `unscored_probes`.
 * - `probe_index`: 1, 2 or 3+ = how many times the concept had been probed, this probe included. A
 *   repeated probe is practice, and held-out concepts are repeated about four times as often.
 * - `met_before`: the concept was taught or matched (not a bare mention) before the holdout
 *   started. Held-out concepts were taught before that date too.
 * - `days_since_holdout`: mean days from the holdout start to the probe. Held-out concepts reach
 *   each index sooner; a large gap between the arms within a stratum is a timing confound.
 * Compare the arms within a stratum.
 */
export const PROBE_ANALYSIS_SQL = `
WITH ${PROBED_CTE}, concept AS (
  SELECT q.probe_arm, q.probe_concept_id, CASE WHEN q.k >= 3 THEN '3+' ELSE q.k::text END AS probe_index,
    count(*) FILTER (WHERE scored) AS probes, count(*) FILTER (WHERE NOT scored) AS unscored,
    avg(answered::int) FILTER (WHERE scored) AS answered, avg(demonstrated::int) FILTER (WHERE scored) AS demonstrated,
    avg(extract(epoch FROM q.created_at - $2::timestamptz) / 86400) FILTER (WHERE scored) AS days,
    EXISTS (SELECT 1 FROM learning_live_feedback_turns b WHERE b.user_id = $1 AND b.created_at < $2::timestamptz AND (
      jsonb_exists(CASE WHEN jsonb_typeof(b.feedback->'taughtConceptIds') = 'array' THEN b.feedback->'taughtConceptIds' ELSE '[]' END, q.probe_concept_id)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.feedback->'matches') = 'array' THEN b.feedback->'matches' ELSE '[]' END) m
        WHERE m->>'conceptId' = q.probe_concept_id AND m->>'relationship' <> 'mention'))) AS met_before
  FROM probed q GROUP BY 1, 2, 3
)
SELECT probe_arm AS arm, met_before, probe_index,
  count(*) FILTER (WHERE probes > 0)::int AS concepts, COALESCE(sum(probes), 0)::int AS probes, COALESCE(sum(unscored), 0)::int AS unscored_probes,
  avg(answered)::float8 AS answered, avg(demonstrated)::float8 AS demonstrated, stddev_samp(demonstrated)::float8 AS sd_demonstrated,
  avg(days)::float8 AS days_since_holdout
FROM concept GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`

/**
 * Sensitivity only, never a filter (docs/specs/blind-probes.md, "Limits"): the same comparison split
 * by whether the agent had the probed concept in this session before the probe (`seen_in_session`).
 * For a taught concept that is the route by which the agent could guess the arm; for a held-out
 * concept it is contamination (the agent taught it unasked). $1 = user id. Concepts are the unit.
 */
export const PROBE_LEAK_SQL = `
WITH ${PROBED_CTE}, concept AS (
  SELECT q.probe_arm, q.seen_in_session, q.probe_concept_id, count(*) FILTER (WHERE scored) AS probes, count(*) AS delivered,
    avg(answered::int) FILTER (WHERE scored) AS answered, avg(demonstrated::int) FILTER (WHERE scored) AS demonstrated
  FROM probed q GROUP BY 1, 2, 3
)
SELECT probe_arm AS arm, seen_in_session, count(*) FILTER (WHERE probes > 0)::int AS concepts, COALESCE(sum(probes), 0)::int AS probes,
  sum(delivered)::int AS delivered_probes, avg(answered)::float8 AS answered, avg(demonstrated)::float8 AS demonstrated
FROM concept GROUP BY 1, 2 ORDER BY 1, 2`
