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

/** Every probe delivered since the holdout started, with its score. Shared by the analysis queries
 * below. $1 = user id, $2 = when the holdout started (earlier probes have no arm to speak of, and
 * the probe index counts from that date).
 * - The answer turn is the session's next turn, and it has an answer only once its feedback is
 *   submitted. `no_answer`: there is no next turn, or it was begun and never submitted.
 *   `explained`: the answer turn reports the concept as taught, so the agent explained instead of
 *   asking. `scored`: neither. `answered` / `demonstrated` are read on the answer turn ONLY: later
 *   turns can follow teaching of the probed concept, which only the taught arm ever gets.
 * - `answered`: the learner said something about the concept, right or wrong (learner evidence or
 *   a misconception). `demonstrated`: learner evidence with outcome demonstrated.
 * - `k`: the probe's index for its concept (1 = the first time this concept was probed).
 * - `own_candidates`: how many concepts the probe's arm had to pick from on that turn. The pick is
 *   uniform, so this is the inverse of the chance that this concept was the one picked.
 * - `seen_in_session`: the agent already had the concept in this session when it asked. An EARLIER
 *   turn delivered it as a teaching target or a review, or a turn up to and INCLUDING the probe
 *   turn reported it taught (a turn's taughtConceptIds describe the reply before it, so the probe
 *   turn's own report is the reply just before the question).
 * Turns are ordered by created_at, then turn_id, so two turns begun at the same instant still have one order. */
const PROBED_CTE = `turns AS (
  SELECT t.*, row_number() OVER (PARTITION BY session_id ORDER BY created_at, turn_id) AS n
  FROM learning_live_feedback_turns t WHERE user_id = $1
), probed AS (
  SELECT p.probe_arm, p.probe_concept_id, p.created_at,
    CASE p.probe_arm WHEN 'held_out' THEN p.probe_held_out_candidates ELSE p.probe_taught_candidates END AS own_candidates,
    row_number() OVER (PARTITION BY p.probe_concept_id ORDER BY p.created_at, p.turn_id) AS k,
    a.feedback IS NULL AS no_answer,
    a.feedback IS NOT NULL AND ${TAUGHT('a', 'p.probe_concept_id')} AS explained,
    a.feedback IS NOT NULL AND NOT ${TAUGHT('a', 'p.probe_concept_id')} AS scored,
    EXISTS (SELECT 1 FROM ${MATCHES('a')} m
      WHERE m->>'conceptId' = p.probe_concept_id AND m->>'relationship' IN ('learner_evidence', 'misconception')) AS answered,
    EXISTS (SELECT 1 FROM ${MATCHES('a')} m
      WHERE m->>'conceptId' = p.probe_concept_id AND m->>'relationship' = 'learner_evidence' AND m->>'outcome' = 'demonstrated') AS demonstrated,
    EXISTS (SELECT 1 FROM turns e WHERE e.session_id = p.session_id AND (
      e.n < p.n AND (p.probe_concept_id = ANY(COALESCE(e.guidance_concept_ids, '{}')) OR e.review_concept_id = p.probe_concept_id)
      OR e.n <= p.n AND ${TAUGHT('e', 'p.probe_concept_id')})) AS seen_in_session,
    EXISTS (SELECT 1 FROM learning_live_feedback_turns b WHERE b.user_id = $1 AND b.created_at < $2::timestamptz AND (
      ${TAUGHT('b', 'p.probe_concept_id')}
      OR EXISTS (SELECT 1 FROM ${MATCHES('b')} m WHERE m->>'conceptId' = p.probe_concept_id AND m->>'relationship' <> 'mention'))) AS met_before
  FROM turns p LEFT JOIN turns a ON a.session_id = p.session_id AND a.n = p.n + 1
  WHERE p.probe_outcome = 'delivered' AND p.created_at >= $2::timestamptz
)`

/** One row per arm, concept and probe index: the concept's rates over its scored probes there. */
const CONCEPT_CTE = `concept AS (
  SELECT q.probe_arm, q.probe_concept_id, q.met_before, CASE WHEN q.k >= 3 THEN '3+' ELSE q.k::text END AS probe_index,
    count(*) FILTER (WHERE scored) AS probes, count(*) FILTER (WHERE no_answer) AS no_answer, count(*) FILTER (WHERE explained) AS explained,
    avg(answered::int) FILTER (WHERE scored) AS answered, avg(demonstrated::int) FILTER (WHERE scored) AS demonstrated,
    avg(extract(epoch FROM q.created_at - $2::timestamptz) / 86400) FILTER (WHERE scored) AS days
  FROM probed q GROUP BY 1, 2, 3, 4
)`

/**
 * The descriptive table (docs/specs/blind-probes.md, "Analysis"): what was probed, by arm, by what
 * the learner had met before the holdout, and by probe index. $1 = user id, $2 = holdout start.
 * NOT the headline: which concepts reach index 2 or 3 depends on the arm (see the spec), so the
 * arms' rows at a repeat index are different kinds of concept. The headline is `probeDifference`.
 *
 * - Each concept's rate is the mean over its scored probes in the row's index; `concepts`,
 *   `demonstrated` and `sd_demonstrated` are over concepts. Probes that are not scored are counted
 *   by reason, per arm: `no_answer_probes` and `explained_probes`.
 * - `probe_index`: 1, 2 or 3+ = how many times the concept had been probed, this probe included.
 * - `met_before`: the concept was taught or matched (not a bare mention) before the holdout started.
 * - `days_since_holdout`: mean days from the holdout start to the scored probes.
 */
export const PROBE_ANALYSIS_SQL = `
WITH ${PROBED_CTE}, ${CONCEPT_CTE}
SELECT probe_arm AS arm, met_before, probe_index,
  count(*) FILTER (WHERE probes > 0)::int AS concepts, COALESCE(sum(probes), 0)::int AS probes,
  COALESCE(sum(no_answer), 0)::int AS no_answer_probes, COALESCE(sum(explained), 0)::int AS explained_probes,
  avg(answered)::float8 AS answered, avg(demonstrated)::float8 AS demonstrated, stddev_samp(demonstrated)::float8 AS sd_demonstrated,
  avg(days)::float8 AS days_since_holdout
FROM concept GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`

/** Every probe delivered since the holdout started, one row each: the input of `probeDifference`. $1 = user id, $2 = holdout start. */
export const PROBE_ROWS_SQL = `
WITH ${PROBED_CTE}
SELECT probe_arm AS arm, probe_concept_id AS concept_id, met_before, k::int AS probe_index,
  CASE WHEN scored THEN 'scored' WHEN explained THEN 'explained' ELSE 'no_answer' END AS status,
  demonstrated, own_candidates::int AS own_candidates,
  (extract(epoch FROM created_at - $2::timestamptz) / 86400)::float8 AS days_since_holdout
FROM probed ORDER BY created_at, probe_concept_id`

export interface ProbeRow {
  arm: ProbeArm; concept_id: string; met_before: boolean
  /** 1 = the first probe of this concept since the holdout started. */
  probe_index: number
  status: 'scored' | 'explained' | 'no_answer'
  demonstrated: boolean
  /** Concepts the probe's arm had to pick from on that turn. Null on rows stored before the count was. */
  own_candidates: number | null
  days_since_holdout: number
}
export interface ProbeDifference {
  /** `not_enough_data`: no stratum has PROBE_MIN_CONCEPTS_PER_ARM concepts in both arms; every figure below is then null. */
  status: 'ok' | 'not_enough_data'
  /** Taught minus held-out share demonstrated, combined over the used strata. */
  difference: number | null
  /** Its standard error, with concepts as clusters. */
  se: number | null
  /** Welch-Satterthwaite degrees of freedom for a t interval on `difference`. Null when `se` is 0. */
  df: number | null
  /** `met_before` strata used, and strata left out for having too few concepts in an arm. */
  strata: number
  strataDropped: number
  /** Scored probes and their concepts in the used strata, per arm. */
  probes: Record<ProbeArm, number>
  concepts: Record<ProbeArm, number>
  /** Probes that were not scored, per arm and reason, over every stratum. */
  unscored: Record<ProbeArm, { noAnswer: number; explained: number }>
  /** `difference` again with every explained probe scored: as not demonstrated, then as demonstrated. */
  ifExplained: { notDemonstrated: number | null; demonstrated: number | null }
  /** Mean days from the holdout start to the probe, taught minus held-out, with the same weights. */
  daysGap: number | null
}

/** A stratum is compared only when each arm has at least this many concepts with a scored probe: below it an arm has no variance to estimate. */
export const PROBE_MIN_CONCEPTS_PER_ARM = 2

/**
 * The headline: the arms' difference in the share of probes demonstrated
 * (docs/specs/blind-probes.md, "The headline difference").
 *
 * - `unit: 'probe'` (default). Each scored probe counts with weight `own_candidates`. The coin
 *   picks the arm and the arm's concept is a uniform pick, so that weight is the inverse of the
 *   probe's pick chance and both arms estimate the same thing: the demonstrated rate of a candidate
 *   concept on a probed turn. Without it, a concept from the small held-out pool is over-represented.
 * - `unit: 'concept'`. Each concept counts once, with its mean over its scored probes. A sensitivity
 *   reading: which taught concepts get probed at all depends on how central they are.
 * - `firstProbeOnly`: only each concept's first probe, which has no earlier probe behind it. A
 *   sensitivity reading; it differs from the rest in timing, which `daysGap` reports.
 *
 * Strata are `met_before` only (fixed before the holdout). Within a stratum each arm's rate is a
 * weighted mean; its variance is the cluster-robust one with concepts as clusters and the
 * G / (G - 1) small-sample factor, which for one probe per concept and equal weights is exactly
 * s^2 / n. A stratum's weight is the number of concepts in its smaller arm. Concepts belong to one
 * arm and one stratum, so the strata are independent and the variances add.
 */
export function probeDifference(rows: readonly ProbeRow[], options: { unit?: 'probe' | 'concept'; firstProbeOnly?: boolean } = {}): ProbeDifference {
  const used = options.firstProbeOnly ? rows.filter((r) => r.probe_index === 1) : rows
  const count = (arm: ProbeArm, status: ProbeRow['status']) => used.filter((r) => r.arm === arm && r.status === status).length
  const unscored = { held_out: { noAnswer: count('held_out', 'no_answer'), explained: count('held_out', 'explained') }, taught: { noAnswer: count('taught', 'no_answer'), explained: count('taught', 'explained') } }

  type Obs = { arm: ProbeArm; concept: string; stratum: boolean; y: number; days: number; w: number }
  const observations = (explainedAs: 0 | 1 | null): Obs[] => {
    const kept = used.filter((r) => r.status === 'scored' || (explainedAs !== null && r.status === 'explained'))
    const perConcept = new Map<string, number>()
    for (const r of kept) perConcept.set(`${r.arm}|${r.concept_id}`, (perConcept.get(`${r.arm}|${r.concept_id}`) ?? 0) + 1)
    return kept.map((r) => ({ arm: r.arm, concept: r.concept_id, stratum: r.met_before, days: r.days_since_holdout,
      y: r.status === 'scored' ? Number(r.demonstrated) : explainedAs!,
      w: options.unit === 'concept' ? 1 / perConcept.get(`${r.arm}|${r.concept_id}`)! : r.own_candidates && r.own_candidates > 0 ? r.own_candidates : 1 }))
  }
  /** One arm of one stratum: the weighted mean of `field`, its clustered variance and its concept count. */
  const armRate = (obs: Obs[], field: 'y' | 'days') => {
    const clusters = new Map<string, { a: number; b: number }>()
    for (const o of obs) { const c = clusters.get(o.concept) ?? { a: 0, b: 0 }; c.a += o.w * o[field]; c.b += o.w; clusters.set(o.concept, c) }
    const g = clusters.size, total = [...clusters.values()].reduce((s, c) => s + c.b, 0)
    const rate = [...clusters.values()].reduce((s, c) => s + c.a, 0) / total
    const variance = g > 1 ? g / (g - 1) * [...clusters.values()].reduce((s, c) => s + ((c.a - rate * c.b) / total) ** 2, 0) : null
    return { rate, variance, concepts: g, probes: obs.length }
  }
  const combine = (obs: Obs[], field: 'y' | 'days') => {
    let sum = 0, weight = 0, strata = 0, dropped = 0
    const parts: Array<{ w: number; variance: number; concepts: number }> = []
    const probes = { held_out: 0, taught: 0 }, concepts = { held_out: 0, taught: 0 }
    for (const stratum of [false, true]) {
      const held = obs.filter((o) => o.stratum === stratum && o.arm === 'held_out'), taught = obs.filter((o) => o.stratum === stratum && o.arm === 'taught')
      if (!held.length && !taught.length) continue
      const h = armRate(held, field), t = armRate(taught, field)
      if (h.concepts < PROBE_MIN_CONCEPTS_PER_ARM || t.concepts < PROBE_MIN_CONCEPTS_PER_ARM) { dropped++; continue }
      const w = Math.min(h.concepts, t.concepts)
      sum += w * (t.rate - h.rate); weight += w; strata++
      parts.push({ w, variance: h.variance!, concepts: h.concepts }, { w, variance: t.variance!, concepts: t.concepts })
      probes.held_out += h.probes; probes.taught += t.probes; concepts.held_out += h.concepts; concepts.taught += t.concepts
    }
    if (!weight) return { value: null, se: null, df: null, strata, dropped, probes, concepts }
    const terms = parts.map((p) => ({ u: p.w ** 2 * p.variance / weight ** 2, df: p.concepts - 1 }))
    const variance = terms.reduce((s, t) => s + t.u, 0)
    return { value: sum / weight, se: Math.sqrt(variance), df: variance > 0 ? variance ** 2 / terms.reduce((s, t) => s + t.u ** 2 / t.df, 0) : null, strata, dropped, probes, concepts }
  }
  const scored = observations(null), point = combine(scored, 'y')
  return {
    status: point.value === null ? 'not_enough_data' : 'ok',
    difference: point.value, se: point.se, df: point.df, strata: point.strata, strataDropped: point.dropped, probes: point.probes, concepts: point.concepts, unscored,
    ifExplained: { notDemonstrated: combine(observations(0), 'y').value, demonstrated: combine(observations(1), 'y').value },
    daysGap: combine(scored, 'days').value,
  }
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
 * by whether the agent already had the probed concept in this session when it asked
 * (`seen_in_session`). For a taught concept that is the route by which the agent could guess the
 * arm; for a held-out concept it is contamination (the agent taught it unasked). $1 = user id,
 * $2 = holdout start. Concepts are the unit.
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
