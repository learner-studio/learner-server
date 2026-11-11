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
 * The scheduler is ARM-BLIND: a probed turn picks one concept uniformly among ALL its candidates,
 * and the arm is whatever that concept's arm is. So a concept's chance of being probed on a turn
 * (one over the turn's candidate count) is the same whether it is held out or taught, and with it
 * when its first probe comes and which concepts get one. The earlier rule (a fair coin for the arm,
 * then a pick inside it) probed a held-out concept about four times as often as a taught one,
 * which put held-out first probes weeks earlier and made the taught probed set the most active
 * concepts: a bias in every later comparison. The candidate rule uses nothing that exists for
 * taught concepts only (no suppression, no packet contents).
 */
const PROBE_DRAW_SALT = 'learning-probe'
const PROBE_PICK_SALT = 'learning-probe-pick'
const PROBE_ARMS = ['held_out', 'taught'] as const
export type ProbeArm = (typeof PROBE_ARMS)[number]
export type Probe = { conceptId: string; arm: ProbeArm; hops: number; relatedTo: string }

/** Why a turn did or did not deliver a probe. Stored on the turn for every turn decided with probes on. */
/** `fail_open` is a turn whose guidance lookup failed with probes on: nothing was decided, and the row says so. */
const PROBE_OUTCOMES = ['not_drawn', 'no_target', 'packet_full', 'arm_empty', 'size', 'not_injected', 'delivered', 'fail_open'] as const
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number]
/** One turn's probe decision. The candidate counts are set on every drawn turn, also when nothing
 * was delivered; `arm` is the picked concept's arm, null when the turn had no candidate. The pick is
 * uniform over heldOutCandidates + taughtCandidates concepts, which can be audited from the table. */
export type ProbeDraw = {
  outcome: ProbeOutcome; rate: number; hops: number
  arm: ProbeArm | null; heldOutCandidates: number | null; taughtCandidates: number | null; conceptId: string | null
  /** The delivered concept's own distance from the turn (`hops` is the setting). The graph is not versioned, so it is stored. */
  conceptHops: number | null
}

/** Whether this turn draws a probe: a pure function of the turn id, independent of the injection coin. */
export const probeDrawn = (turnId: string, rate: number): boolean => turnDraw(PROBE_DRAW_SALT, turnId) < rate

/** How the agent treats the probe; sent only when one is delivered. The same words for both arms. */
export const PROBE_GUIDANCE = 'role "probe": a check, not a teaching target. End your reply with exactly ONE question in this form: "Quick check: in one sentence, what is <title>, and where would it matter in what we are doing?" Do not explain, define, hint at or teach that concept in this reply, do not answer the question yourself, and do not list it in taughtConceptIds. If the learner answers, acknowledge it in one line and carry on with the task; do not correct or expand on it.'

/**
 * Both arms' candidates for a turn: catalog concepts within `hops` of the turn's concepts (the
 * spaced-repetition relatedness), never the turn's own concepts. Nothing else is excluded: the
 * same rule for both arms. They are ordered by a hash of turn and concept that does not know the
 * arm; `pick` is the first of them all, a uniform pick over both arms together.
 */
export function probeCandidates(input: { turnId: string; hops: number; turnConceptIds: string[]; edges: DependencyEdge[]; catalogIds: string[]; heldOut: ReadonlySet<string> }): Record<ProbeArm, Probe[]> & { pick: Probe | null } {
  const limit = input.hops >= REVIEW_HOPS_ALL ? Infinity : input.hops
  const order = (conceptId: string) => createHash('md5').update(`${PROBE_PICK_SALT}:${input.turnId.toLowerCase()}:${conceptId}`).digest('hex')
  const all = [...relatedHops({ edges: input.edges, catalogIds: input.catalogIds, from: input.turnConceptIds })]
    .filter(([, related]) => related.hops <= limit)
    .map(([conceptId, related]) => ({ conceptId, arm: (input.heldOut.has(conceptId) ? 'held_out' : 'taught') as ProbeArm, hops: related.hops, relatedTo: related.relatedTo, key: order(conceptId) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ key: _key, ...probe }) => probe)
  return { held_out: all.filter((p) => p.arm === 'held_out'), taught: all.filter((p) => p.arm === 'taught'), pick: all[0] ?? null }
}

/**
 * The turn's probe decision from its candidates alone (the packet rules are applied by the
 * caller, on the turn; none of them looks at the arm). Not drawn: nothing is computed. Drawn: both
 * counts are recorded and one concept is picked uniformly among all candidates, whatever its arm.
 * A turn with a candidate in one arm only is probed like any other: requiring both arms would make
 * a taught concept eligible on fewer turns than a held-out one (a turn often has no held-out
 * concept in range) and so bring the unequal rates back. `arm_empty` (the name is from the earlier
 * two-arm rule) now means the turn had no candidate at all.
 */
export function selectProbe(input: { turnId: string; rate: number; hops: number; turnConceptIds: string[]; edges: DependencyEdge[]; catalogIds: string[]; heldOut: ReadonlySet<string> }): { draw: ProbeDraw; probe: Probe | null; candidates: (Record<ProbeArm, Probe[]> & { pick: Probe | null }) | null } {
  const base = { rate: input.rate, hops: input.hops }
  if (!probeDrawn(input.turnId, input.rate)) return { draw: { ...base, outcome: 'not_drawn', arm: null, heldOutCandidates: null, taughtCandidates: null, conceptId: null, conceptHops: null }, probe: null, candidates: null }
  const candidates = probeCandidates(input), probe = candidates.pick
  const counts = { arm: probe?.arm ?? null, heldOutCandidates: candidates.held_out.length, taughtCandidates: candidates.taught.length }
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
 * - `candidates`: how many concepts the turn had to pick from, both arms together. The pick is
 *   uniform over them, so this is the inverse of the chance that this concept was the one picked.
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
    p.probe_held_out_candidates + p.probe_taught_candidates AS candidates,
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
  demonstrated, candidates::int AS candidates,
  (extract(epoch FROM created_at - $2::timestamptz) / 86400)::float8 AS days_since_holdout
FROM probed ORDER BY created_at, probe_concept_id`

export interface ProbeRow {
  arm: ProbeArm; concept_id: string; met_before: boolean
  /** 1 = the first probe of this concept since the holdout started. */
  probe_index: number
  status: 'scored' | 'explained' | 'no_answer'
  demonstrated: boolean
  /** Concepts the turn had to pick from, held-out and taught together: the inverse of this probe's pick chance. Null on rows stored before the count was. */
  candidates: number | null
  days_since_holdout: number
}
export type ProbeReading = 'first' | 'all' | 'concept'
export interface ProbeDifference {
  /** Which probes were compared (see `probeDifference`). */
  reading: ProbeReading
  /** `not_enough_data`: no stratum has PROBE_MIN_CONCEPTS_PER_ARM concepts in both arms; every figure below is then null. */
  status: 'ok' | 'not_enough_data'
  /** Taught minus held-out share demonstrated, combined over the used strata. */
  difference: number | null
  /** Its standard error, with concepts as clusters. Never 0: an arm with no spread gets a floor. */
  se: number | null
  /** Welch-Satterthwaite degrees of freedom. */
  df: number | null
  /** The 95 % t interval for `difference` with `df`. */
  interval: [number, number] | null
  /** `met_before` strata used, and strata left out for having too few concepts in an arm. */
  strata: number
  strataDropped: number
  /** Per arm, in the used strata: delivered = probes (scored) + unscored.noAnswer + unscored.explained + missingWeight. */
  delivered: Record<ProbeArm, number>
  probes: Record<ProbeArm, number>
  concepts: Record<ProbeArm, number>
  unscored: Record<ProbeArm, { noAnswer: number; explained: number }>
  /** Reading `all` only: scored probes left out because their candidate count was not stored. */
  missingWeight: Record<ProbeArm, number>
  /** Delivered probes of this reading that sit in a stratum that was not compared. */
  deliveredInDroppedStrata: Record<ProbeArm, number>
  /** `difference` again with every explained probe scored: as not demonstrated, then as demonstrated. */
  ifExplained: { notDemonstrated: number | null; demonstrated: number | null }
  /** Mean days from the holdout start to the scored probes, taught minus held-out, with the same weights. */
  daysGap: number | null
  /** Mean number of EARLIER probes of the same concept behind a scored probe, taught minus held-out, with the same weights. 0 by construction for `first`. */
  priorProbesGap: number | null
}

/** A stratum is compared only when each arm has at least this many concepts with a scored probe: below it an arm has no variance to estimate. */
export const PROBE_MIN_CONCEPTS_PER_ARM = 2

const lnGamma = (x: number) => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let series = 1.000000000190015; for (const cj of c) series += cj / ++y; return -t + Math.log(2.5066282746310005 * series / x) }
/** Regularized incomplete beta function I_x(a, b), by its continued fraction. */
const incompleteBeta = (a: number, b: number, x: number): number => {
  if (x <= 0) return 0
  if (x >= 1) return 1
  if (x > (a + 1) / (a + b + 2)) return 1 - incompleteBeta(b, a, 1 - x)
  const tiny = 1e-30, clamp = (v: number) => (Math.abs(v) < tiny ? tiny : v)
  let c = 1, d = 1 / clamp(1 - (a + b) * x / (a + 1)), h = d
  for (let m = 1; m <= 500; m++) {
    const even = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m))
    d = 1 / clamp(1 + even * d); c = clamp(1 + even / c); h *= d * c
    const odd = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1))
    d = 1 / clamp(1 + odd * d); c = clamp(1 + odd / c); const step = d * c; h *= step
    if (Math.abs(step - 1) < 1e-13) break
  }
  return Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x)) * h / a
}
/** The two-sided 95 % critical value of Student's t with `df` degrees of freedom (df may be fractional). */
export function tCritical95(df: number): number {
  const upperTail = (t: number) => 0.5 * incompleteBeta(df / 2, 0.5, df / (df + t * t))
  let low = 0, high = 1e7
  for (let i = 0; i < 200; i++) { const mid = (low + high) / 2; if (upperTail(mid) > 0.025) low = mid; else high = mid }
  return (low + high) / 2
}

interface ProbeExposure {
  hops: number
  /** Turns with at least one candidate. */
  turns: number
  arms: Record<ProbeArm, {
    /** Catalog concepts of the arm, and those of them that were a candidate on some turn. */
    concepts: number; inRange: number
    /** Probes the arm would get if every one of the turns were probed: the sum over turns of its share of the candidates. */
    expectedProbes: number
    /** That, per catalog concept of the arm: the arm's per-concept probe rate over these turns. */
    perConcept: number
    /** Times a concept of the arm was one of a turn's OWN concepts (and so not a candidate there), per catalog concept of the arm. */
    asTurnConcept: number
  }>
  /** Held-out `perConcept` over taught `perConcept`: 1 when a concept's arm does not decide how often it is probed. */
  ratio: number | null
}

/**
 * How often the scheduler WOULD probe each arm's concepts over these turns: no draw, no pick and no
 * answer, only who was a candidate. It is the check on the one thing the uniform pick cannot
 * equalize: which concepts come near the conversation. A turn's own concepts are never candidates,
 * so a concept the conversation keeps returning to is probed LESS, and teaching can make the
 * learner return to a concept (docs/specs/blind-probes.md, "Limits"). The candidate ids are not
 * stored, so this recomputes them from the turns' concepts and the edges as they are NOW.
 */
export function probeExposure(input: { turns: ReadonlyArray<{ turnId: string; conceptIds: string[] }>; hops: number; edges: DependencyEdge[]; catalogIds: string[]; heldOut: ReadonlySet<string> }): ProbeExposure {
  const catalog = new Set(input.catalogIds), expected = new Map<string, number>(), own = new Map<string, number>()
  let turns = 0
  for (const turn of input.turns) {
    for (const id of new Set(turn.conceptIds)) if (catalog.has(id)) own.set(id, (own.get(id) ?? 0) + 1)
    const c = probeCandidates({ turnId: turn.turnId, hops: input.hops, turnConceptIds: turn.conceptIds, edges: input.edges, catalogIds: input.catalogIds, heldOut: input.heldOut }), all = [...c.held_out, ...c.taught]
    if (!all.length) continue
    turns++
    for (const p of all) expected.set(p.conceptId, (expected.get(p.conceptId) ?? 0) + 1 / all.length)
  }
  const arm = (heldOut: boolean) => {
    const ids = input.catalogIds.filter((id) => input.heldOut.has(id) === heldOut), sum = (of: Map<string, number>) => ids.reduce((total, id) => total + (of.get(id) ?? 0), 0)
    return { concepts: ids.length, inRange: ids.filter((id) => expected.has(id)).length, expectedProbes: sum(expected), perConcept: ids.length ? sum(expected) / ids.length : 0, asTurnConcept: ids.length ? sum(own) / ids.length : 0 }
  }
  const held_out = arm(true), taught = arm(false)
  return { hops: input.hops, turns, arms: { held_out, taught }, ratio: taught.perConcept > 0 ? held_out.perConcept / taught.perConcept : null }
}

/**
 * The arms' difference in the share of probes demonstrated (docs/specs/blind-probes.md, "The
 * headline difference"). Three readings:
 *
 * - `first` (default, the HEADLINE). Each concept's first probe since the holdout started, every
 *   concept counting once. It is the only reading with no earlier probe of the concept behind it
 *   (being asked is itself a treatment). A concept whose first probe was not scored is not in it.
 * - `all` (sensitivity). Every scored probe, weighted by `candidates` (the inverse of its pick
 *   chance), a concept's probes as one cluster.
 * - `concept` (sensitivity). Each concept's mean over all its scored probes.
 *
 * The scheduler probes both arms' concepts at the same rate, so in expectation `daysGap` and
 * `priorProbesGap` are 0 and the three readings agree; a gap far from 0 on real data means the
 * arms were not probed alike (chance with few concepts, or probes from the earlier two-arm rule).
 *
 * Strata are `met_before` only (fixed before the holdout); a stratum's weight is the number of
 * concepts in its smaller arm. Within a stratum each arm's rate is a weighted mean over concept
 * clusters. Its variance is the leverage-adjusted cluster-robust one (each cluster's squared
 * residual divided by 1 - its share of the arm's weight), which with one probe per concept and equal
 * weights is exactly s^2 / n, so the headline's standard error is Welch's. An arm whose concepts
 * all gave the same answer has no spread in the sample, not in truth: its variance is floored at
 * p(1 - p) / (m + 2) with p = (successes + 1) / (m + 2), m being the arm's effective number of
 * probes, (sum w)^2 / sum w^2 over probes (for the headline, its number of concepts). The arm's
 * degrees of freedom are its effective number of concepts, the same sum over clusters, minus one.
 * Concepts belong to one arm and one stratum, so the pieces are independent and their variances add.
 */
export function probeDifference(rows: readonly ProbeRow[], options: { reading?: ProbeReading } = {}): ProbeDifference {
  const reading = options.reading ?? 'first'
  const used = reading === 'first' ? rows.filter((r) => r.probe_index === 1) : rows
  const weighable = (r: ProbeRow) => reading !== 'all' || (r.candidates !== null && r.candidates > 0)

  type Obs = { arm: ProbeArm; concept: string; stratum: boolean; y: number; days: number; prior: number; w: number }
  const observations = (explainedAs: 0 | 1 | null): Obs[] => {
    const kept = used.filter((r) => (r.status === 'scored' || (explainedAs !== null && r.status === 'explained')) && weighable(r))
    const perConcept = new Map<string, number>()
    for (const r of kept) perConcept.set(`${r.arm}|${r.concept_id}`, (perConcept.get(`${r.arm}|${r.concept_id}`) ?? 0) + 1)
    return kept.map((r) => ({ arm: r.arm, concept: r.concept_id, stratum: r.met_before, days: r.days_since_holdout, prior: r.probe_index - 1,
      y: r.status === 'scored' ? Number(r.demonstrated) : explainedAs!,
      w: reading === 'all' ? r.candidates! : 1 / perConcept.get(`${r.arm}|${r.concept_id}`)! }))
  }
  /** One arm of one stratum: the weighted mean of `field` over concept clusters, its variance and its effective size. */
  const armRate = (obs: Obs[], field: 'y' | 'days' | 'prior') => {
    const clusters = new Map<string, { a: number; b: number }>()
    for (const o of obs) { const c = clusters.get(o.concept) ?? { a: 0, b: 0 }; c.a += o.w * o[field]; c.b += o.w; clusters.set(o.concept, c) }
    const all = [...clusters.values()], total = all.reduce((s, c) => s + c.b, 0), rate = all.reduce((s, c) => s + c.a, 0) / total
    const effective = total ** 2 / all.reduce((s, c) => s + c.b ** 2, 0)
    const robust = all.length > 1 ? all.reduce((s, c) => s + ((c.a - rate * c.b) / total) ** 2 / (1 - c.b / total), 0) : 0
    // The floor: what the arm's probes would give as independent draws, with one success and one failure added.
    const draws = total ** 2 / obs.reduce((s, o) => s + o.w ** 2, 0), p = (rate * draws + 1) / (draws + 2)
    return { rate, variance: Math.max(robust, p * (1 - p) / (draws + 2)), effective, concepts: all.length, probes: obs.length }
  }
  const combine = (obs: Obs[], field: 'y' | 'days' | 'prior') => {
    let sum = 0, weight = 0
    const parts: Array<{ w: number; variance: number; df: number }> = [], usedStrata: boolean[] = [], dropped: boolean[] = []
    const probes = { held_out: 0, taught: 0 }, concepts = { held_out: 0, taught: 0 }
    for (const stratum of [false, true]) {
      const held = obs.filter((o) => o.stratum === stratum && o.arm === 'held_out'), taught = obs.filter((o) => o.stratum === stratum && o.arm === 'taught')
      if (!held.length && !taught.length) continue
      const h = armRate(held, field), t = armRate(taught, field)
      if (h.concepts < PROBE_MIN_CONCEPTS_PER_ARM || t.concepts < PROBE_MIN_CONCEPTS_PER_ARM) { dropped.push(stratum); continue }
      const w = Math.min(h.concepts, t.concepts)
      sum += w * (t.rate - h.rate); weight += w; usedStrata.push(stratum)
      parts.push({ w, variance: h.variance, df: h.effective - 1 }, { w, variance: t.variance, df: t.effective - 1 })
      probes.held_out += h.probes; probes.taught += t.probes; concepts.held_out += h.concepts; concepts.taught += t.concepts
    }
    if (!weight) return { value: null, se: null, df: null, usedStrata, dropped, probes, concepts }
    const terms = parts.map((p) => ({ u: p.w ** 2 * p.variance / weight ** 2, df: p.df })), variance = terms.reduce((s, t) => s + t.u, 0)
    return { value: sum / weight, se: Math.sqrt(variance), df: variance ** 2 / terms.reduce((s, t) => s + t.u ** 2 / t.df, 0), usedStrata, dropped, probes, concepts }
  }
  const scored = observations(null), point = combine(scored, 'y')
  const perArm = (keep: (r: ProbeRow) => boolean) => ({ held_out: used.filter((r) => r.arm === 'held_out' && keep(r)).length, taught: used.filter((r) => r.arm === 'taught' && keep(r)).length })
  const inUse = (r: ProbeRow) => point.usedStrata.includes(r.met_before)
  const noAnswer = perArm((r) => inUse(r) && r.status === 'no_answer'), explained = perArm((r) => inUse(r) && r.status === 'explained')
  const half = point.se === null ? null : tCritical95(point.df!) * point.se
  return {
    reading, status: point.value === null ? 'not_enough_data' : 'ok',
    difference: point.value, se: point.se, df: point.df, interval: half === null ? null : [point.value! - half, point.value! + half],
    strata: point.usedStrata.length, strataDropped: point.dropped.length,
    delivered: perArm(inUse), probes: point.probes, concepts: point.concepts,
    unscored: { held_out: { noAnswer: noAnswer.held_out, explained: explained.held_out }, taught: { noAnswer: noAnswer.taught, explained: explained.taught } },
    missingWeight: perArm((r) => inUse(r) && r.status === 'scored' && !weighable(r)),
    deliveredInDroppedStrata: perArm((r) => !inUse(r)),
    ifExplained: { notDemonstrated: combine(observations(0), 'y').value, demonstrated: combine(observations(1), 'y').value },
    daysGap: combine(scored, 'days').value, priorProbesGap: combine(scored, 'prior').value,
  }
}

/**
 * The interval as a report prints it. A difference of two shares lies in [-1, 1], so the printed
 * interval is clipped to it; and below two degrees of freedom the t multiplier is so large (12.7 at
 * one, unbounded below it) that the interval says nothing, which is said in words.
 */
export function probeIntervalText(d: Pick<ProbeDifference, 'interval' | 'df'>, digits = 3): string {
  if (!d.interval || d.df === null) return 'no interval'
  if (d.df < 2) return `uninformative (df ${d.df.toFixed(1)} < 2)`
  const [low, high] = [Math.max(-1, d.interval[0]), Math.min(1, d.interval[1])]
  return `${low.toFixed(digits)} to ${high.toFixed(digits)}${low === -1 && high === 1 ? ' (the whole range: uninformative)' : low === -1 || high === 1 ? ' (clipped to the possible range)' : ''}`
}

/**
 * True when a time is a probe answer's: after a delivered, scored probe of the concept and no later
 * than two minutes after its answer turn began (the answer is the human message that begins that
 * turn). The same rule and the same turn order (created_at, then turn_id) as PROBE_ANALYSIS_SQL,
 * for evidence that carries a time and not a turn (mastery readings). An EXISTS fragment; $1 = user id.
 *
 * With `firstSince` (an SQL timestamptz expression: the holdout start) only the concept's FIRST
 * delivered probe since then counts, the headline's `k = 1` of PROBED_CTE: delivered at or after it
 * with no earlier delivered probe of the concept since it, by (created_at, turn_id), scored or not.
 * Evidence answering a later probe is not a first answer, so a concept whose first probe produced no
 * reading never gets one from probe 2 (review round 6, S-1: that brought the testing effect back).
 */
export const probeAnswerEvidenceSql = (concept: string, at: string, firstSince?: string) => `EXISTS (SELECT 1 FROM learning_live_feedback_turns p
  CROSS JOIN LATERAL (SELECT a.created_at, a.feedback FROM learning_live_feedback_turns a WHERE a.user_id = p.user_id AND a.session_id = p.session_id AND (a.created_at, a.turn_id) > (p.created_at, p.turn_id) ORDER BY a.created_at, a.turn_id LIMIT 1) a
  WHERE p.user_id = $1 AND p.probe_outcome = 'delivered' AND p.probe_concept_id = ${concept}
    AND a.feedback IS NOT NULL AND NOT ${TAUGHT('a', 'p.probe_concept_id')}
    AND ${at} > p.created_at AND ${at} <= a.created_at + interval '2 minutes'${firstSince === undefined ? '' : `
    AND p.created_at >= ${firstSince} AND NOT EXISTS (SELECT 1 FROM learning_live_feedback_turns q
      WHERE q.user_id = p.user_id AND q.probe_outcome = 'delivered' AND q.probe_concept_id = p.probe_concept_id
        AND q.created_at >= ${firstSince} AND (q.created_at, q.turn_id) < (p.created_at, p.turn_id))`})`

/** Concepts with a delivered probe since `$2` (the holdout start): the probe headline's population. $1 = user id. */
export const FIRST_PROBED_SQL = `SELECT DISTINCT probe_concept_id AS concept_id FROM learning_live_feedback_turns
  WHERE user_id = $1 AND probe_outcome = 'delivered' AND created_at >= $2::timestamptz`

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
