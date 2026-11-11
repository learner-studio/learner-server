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

const MATCHES = (row: string) => `jsonb_array_elements(CASE WHEN jsonb_typeof(${row}.feedback->'matches') = 'array' THEN ${row}.feedback->'matches' ELSE '[]' END)`
const TAUGHT = (row: string, concept: string) => `COALESCE(jsonb_exists(CASE WHEN jsonb_typeof(${row}.feedback->'taughtConceptIds') = 'array' THEN ${row}.feedback->'taughtConceptIds' ELSE '[]' END, ${concept}), false)`

/** Every delivered probe with its score. Shared by the analysis queries below. $1 = user id.
 * - The answer turn is the session's next turn, and it has an answer only once its feedback is
 *   submitted. `no_answer`: there is no next turn, or it was begun and never submitted.
 *   `explained`: the answer turn reports the concept as taught, so the agent explained instead of
 *   asking. `scored`: neither. `answered` / `demonstrated` are read on the answer turn ONLY: later
 *   turns can follow teaching of the probed concept, which only the taught arm ever gets.
 * - `answered`: the learner said something about the concept, right or wrong (learner evidence or
 *   a misconception). `demonstrated`: learner evidence with outcome demonstrated.
 * - `k`: the probe's index for its concept (1 = the first time this concept was probed).
 * - `seen_in_session`: an earlier turn of the session delivered the concept as a teaching target or
 *   a review, or reported it taught. */
const PROBED_CTE = `turns AS (
  SELECT t.*, row_number() OVER (PARTITION BY session_id ORDER BY created_at) AS n
  FROM learning_live_feedback_turns t WHERE user_id = $1
), probed AS (
  SELECT p.probe_arm, p.probe_concept_id, p.created_at,
    row_number() OVER (PARTITION BY p.probe_concept_id ORDER BY p.created_at) AS k,
    a.feedback IS NULL AS no_answer,
    a.feedback IS NOT NULL AND ${TAUGHT('a', 'p.probe_concept_id')} AS explained,
    a.feedback IS NOT NULL AND NOT ${TAUGHT('a', 'p.probe_concept_id')} AS scored,
    EXISTS (SELECT 1 FROM ${MATCHES('a')} m
      WHERE m->>'conceptId' = p.probe_concept_id AND m->>'relationship' IN ('learner_evidence', 'misconception')) AS answered,
    EXISTS (SELECT 1 FROM ${MATCHES('a')} m
      WHERE m->>'conceptId' = p.probe_concept_id AND m->>'relationship' = 'learner_evidence' AND m->>'outcome' = 'demonstrated') AS demonstrated,
    EXISTS (SELECT 1 FROM turns e WHERE e.session_id = p.session_id AND e.n < p.n AND (
      p.probe_concept_id = ANY(COALESCE(e.guidance_concept_ids, '{}')) OR e.review_concept_id = p.probe_concept_id
      OR ${TAUGHT('e', 'p.probe_concept_id')})) AS seen_in_session
  FROM turns p LEFT JOIN turns a ON a.session_id = p.session_id AND a.n = p.n + 1
  WHERE p.probe_outcome = 'delivered'
)`

/** One row per arm, concept and probe index: the concept's rates over its scored probes there. $2 = holdout start. */
const CONCEPT_CTE = `concept AS (
  SELECT q.probe_arm, q.probe_concept_id, CASE WHEN q.k >= 3 THEN '3+' ELSE q.k::text END AS probe_index,
    count(*) FILTER (WHERE scored) AS probes, count(*) FILTER (WHERE no_answer) AS no_answer, count(*) FILTER (WHERE explained) AS explained,
    avg(answered::int) FILTER (WHERE scored) AS answered, avg(demonstrated::int) FILTER (WHERE scored) AS demonstrated,
    avg(extract(epoch FROM q.created_at - $2::timestamptz) / 86400) FILTER (WHERE scored) AS days,
    EXISTS (SELECT 1 FROM learning_live_feedback_turns b WHERE b.user_id = $1 AND b.created_at < $2::timestamptz AND (
      ${TAUGHT('b', 'q.probe_concept_id')}
      OR EXISTS (SELECT 1 FROM ${MATCHES('b')} m WHERE m->>'conceptId' = q.probe_concept_id AND m->>'relationship' <> 'mention'))) AS met_before
  FROM probed q GROUP BY 1, 2, 3
)`

/**
 * The documented analysis (docs/specs/blind-probes.md, "Analysis"). $1 = user id, $2 = when the
 * holdout started. One row per arm and stratum; the unit is the CONCEPT, not the probe.
 *
 * - Each concept's rate is the mean over its scored probes in the stratum; arms are compared on
 *   concept means (`concepts`, `demonstrated`, `sd_demonstrated`), so a few often-probed concepts
 *   do not carry it. Probes that are not scored are counted by reason, per arm:
 *   `no_answer_probes` and `explained_probes`.
 * - `probe_index`: 1, 2 or 3+ = how many times the concept had been probed, this probe included. A
 *   repeated probe is practice, and held-out concepts are repeated about four times as often.
 * - `met_before`: the concept was taught or matched (not a bare mention) before the holdout
 *   started. Held-out concepts were taught before that date too.
 * - `days_since_holdout`: mean days from the holdout start to the probe. Held-out concepts reach
 *   each index sooner; a large gap between the arms within a stratum is a timing confound.
 * Compare the arms within a stratum; `probeDifference` combines the strata.
 */
export const PROBE_ANALYSIS_SQL = `
WITH ${PROBED_CTE}, ${CONCEPT_CTE}
SELECT probe_arm AS arm, met_before, probe_index,
  count(*) FILTER (WHERE probes > 0)::int AS concepts, COALESCE(sum(probes), 0)::int AS probes,
  COALESCE(sum(no_answer), 0)::int AS no_answer_probes, COALESCE(sum(explained), 0)::int AS explained_probes,
  avg(answered)::float8 AS answered, avg(demonstrated)::float8 AS demonstrated, stddev_samp(demonstrated)::float8 AS sd_demonstrated,
  avg(days)::float8 AS days_since_holdout
FROM concept GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`

/** The rows behind PROBE_ANALYSIS_SQL, one per arm, concept and probe index with a scored probe: the input of `probeDifference`. Same parameters. */
export const PROBE_CONCEPTS_SQL = `
WITH ${PROBED_CTE}, ${CONCEPT_CTE}
SELECT probe_arm AS arm, probe_concept_id AS concept_id, met_before, probe_index, demonstrated::float8 AS demonstrated, days::float8 AS days_since_holdout
FROM concept WHERE probes > 0 ORDER BY 1, 2, 4`

export interface ProbeConceptRow { arm: ProbeArm; concept_id: string; met_before: boolean; probe_index: string; demonstrated: number; days_since_holdout: number }
export interface ProbeDifference {
  /** Taught minus held-out share demonstrated, over the strata that have both arms. Null when no stratum has both. */
  difference: number | null
  /** Its standard error: the spread of `difference` over resamples of whole concepts within each arm. */
  se: number | null
  /** Strata (met_before x probe_index) with both arms, and the ones left out for lacking an arm. */
  strata: number
  strataDropped: number
  /** Concepts with a scored probe in a used stratum. A concept probed at several indexes counts once. */
  heldOutConcepts: number
  taughtConcepts: number
  /** Mean days from the holdout start to the probe, taught minus held-out, with the same weights. */
  daysGap: number | null
}

const mulberry32 = (seed: number) => () => { let t = seed += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296 }
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

/**
 * The arms' difference combined over strata (docs/specs/blind-probes.md, "The combined difference").
 * Within a stratum: mean taught rate minus mean held-out rate, concepts as units. A stratum's weight
 * is the number of concepts in its smaller arm; strata lacking an arm are dropped and counted.
 * The standard error is a bootstrap that resamples concepts within each arm, with all of a concept's
 * rows together, because one concept appears at several probe indexes. Deterministic for a seed.
 * `firstProbeOnly` keeps index 1: no practice and no earlier probe behind it, but a timing gap (`daysGap`).
 */
export function probeDifference(rows: readonly ProbeConceptRow[], options: { firstProbeOnly?: boolean; resamples?: number; seed?: number } = {}): ProbeDifference {
  const used = options.firstProbeOnly ? rows.filter((r) => r.probe_index === '1') : rows
  const estimate = (sample: readonly ProbeConceptRow[], field: 'demonstrated' | 'days_since_holdout') => {
    const strata = new Map<string, Record<ProbeArm, number[]>>()
    for (const r of sample) { const key = `${r.met_before}|${r.probe_index}`; if (!strata.has(key)) strata.set(key, { held_out: [], taught: [] }); strata.get(key)![r.arm].push(r[field]) }
    let total = 0, weight = 0, both = 0
    for (const s of strata.values()) { if (!s.held_out.length || !s.taught.length) continue; const w = Math.min(s.held_out.length, s.taught.length); total += w * (mean(s.taught) - mean(s.held_out)); weight += w; both++ }
    return { value: weight ? total / weight : null, both, dropped: strata.size - both, keys: new Set([...strata].filter(([, s]) => s.held_out.length && s.taught.length).map(([k]) => k)) }
  }
  const point = estimate(used, 'demonstrated')
  const inUse = used.filter((r) => point.keys.has(`${r.met_before}|${r.probe_index}`))
  const byConcept = (arm: ProbeArm) => { const m = new Map<string, ProbeConceptRow[]>(); for (const r of used) if (r.arm === arm) m.set(r.concept_id, [...(m.get(r.concept_id) ?? []), r]); return [...m.values()] }
  const held = byConcept('held_out'), taught = byConcept('taught')
  const random = mulberry32(options.seed ?? 1), draws: number[] = []
  const resample = (groups: ProbeConceptRow[][]) => groups.map(() => groups[Math.floor(random() * groups.length)]!).flat()
  if (point.value !== null) for (let i = 0; i < (options.resamples ?? 2000); i++) { const v = estimate([...resample(held), ...resample(taught)], 'demonstrated').value; if (v !== null) draws.push(v) }
  const se = draws.length > 1 ? Math.sqrt(draws.reduce((a, d) => a + (d - mean(draws)) ** 2, 0) / (draws.length - 1)) : null
  const concepts = (arm: ProbeArm) => new Set(inUse.filter((r) => r.arm === arm).map((r) => r.concept_id)).size
  return { difference: point.value, se, strata: point.both, strataDropped: point.dropped, heldOutConcepts: concepts('held_out'), taughtConcepts: concepts('taught'), daysGap: estimate(used, 'days_since_holdout').value }
}

/**
 * True when a time is a probe answer's: after a delivered, scored probe of the concept and no later
 * than two minutes after its answer turn began (the answer is the human message that begins that
 * turn). The same rule as PROBE_ANALYSIS_SQL, for evidence that carries a time and not a turn
 * (mastery readings). An EXISTS fragment; $1 = user id.
 */
export const probeAnswerEvidenceSql = (concept: string, at: string) => `EXISTS (SELECT 1 FROM learning_live_feedback_turns p
  CROSS JOIN LATERAL (SELECT a.created_at, a.feedback FROM learning_live_feedback_turns a WHERE a.user_id = p.user_id AND a.session_id = p.session_id AND a.created_at > p.created_at ORDER BY a.created_at LIMIT 1) a
  WHERE p.user_id = $1 AND p.probe_outcome = 'delivered' AND p.probe_concept_id = ${concept}
    AND a.feedback IS NOT NULL AND NOT ${TAUGHT('a', 'p.probe_concept_id')}
    AND ${at} > p.created_at AND ${at} <= a.created_at + interval '2 minutes')`

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
