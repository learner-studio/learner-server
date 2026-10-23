import { REVIEW_HOPS_ALL, reviewIntervalDays } from '@learner/contract/learning/learning-policy.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import type { DependencyEdge } from './learning-foundation-priority.js'

const DAY_MS = 86_400_000

/** What the learner has met: each concept's last exposure, and the reviews offered in the last 24 hours. */
export type ReviewHistory = { exposures: Map<string, Date>; offered: Set<string> }
export type ReviewEntry = {
  conceptId: string; lastExposedAt: Date; intervalDays: number; overdue: number
  understandingPercent: number | null; hops: number | null; relatedTo: string | null
}

/** Shortest hop distance from the turn's concepts to every connected catalog concept, over the whole
 * concept network: both edge kinds, undirected (a prerequisite and a dependent are both related).
 * Breadth first, so cycles are harmless; the turn's own concepts are not listed. */
export function relatedHops(input: { edges: DependencyEdge[]; catalogIds: string[]; from: string[] }) {
  const valid = new Set(input.catalogIds)
  const neighbours = new Map<string, Set<string>>()
  for (const edge of input.edges) {
    if (edge.from === edge.to || !valid.has(edge.from) || !valid.has(edge.to)) continue
    for (const [a, b] of [[edge.from, edge.to], [edge.to, edge.from]] as const) {
      if (!neighbours.has(a)) neighbours.set(a, new Set())
      neighbours.get(a)!.add(b)
    }
  }
  const sources = [...new Set(input.from)].filter((id) => valid.has(id)).sort()
  const reached = new Map<string, { hops: number; relatedTo: string }>()
  const seen = new Set(sources)
  let frontier = sources.map((id) => ({ id, relatedTo: id }))
  for (let hops = 1; frontier.length; hops++) {
    const next: typeof frontier = []
    for (const { id, relatedTo } of frontier) for (const neighbour of [...(neighbours.get(id) ?? [])].sort()) {
      if (seen.has(neighbour)) continue
      seen.add(neighbour)
      reached.set(neighbour, { hops, relatedTo })
      next.push({ id: neighbour, relatedTo })
    }
    frontier = next
  }
  return reached
}

/** Every due concept, most overdue first (then nearer to the turn, then ID). A concept is due once the
 * time since its last exposure reaches the interval its mastery sets. Never-exposed concepts, concepts
 * outside the catalog, the turn's own concepts and `excluded` ones are not in the queue. */
export function reviewQueue(input: {
  now: Date; history: ReviewHistory; scores: Map<string, number>; edges: DependencyEdge[]; catalogIds: string[]
  turnConceptIds: string[]; excluded: Set<string>
}): ReviewEntry[] {
  const valid = new Set(input.catalogIds)
  const turn = new Set(input.turnConceptIds)
  const hops = relatedHops({ edges: input.edges, catalogIds: input.catalogIds, from: input.turnConceptIds })
  const queue: ReviewEntry[] = []
  for (const [conceptId, lastExposedAt] of input.history.exposures) {
    if (!valid.has(conceptId) || turn.has(conceptId) || input.excluded.has(conceptId) || input.history.offered.has(conceptId)) continue
    const understandingPercent = input.scores.get(conceptId) ?? null
    const intervalDays = reviewIntervalDays(understandingPercent)
    const overdue = (input.now.getTime() - lastExposedAt.getTime()) / (intervalDays * DAY_MS)
    if (overdue < 1) continue
    const related = hops.get(conceptId)
    queue.push({ conceptId, lastExposedAt, intervalDays, overdue, understandingPercent, hops: related?.hops ?? null, relatedTo: related?.relatedTo ?? null })
  }
  return queue.sort((a, b) => b.overdue - a.overdue || (a.hops ?? Infinity) - (b.hops ?? Infinity) || (a.conceptId < b.conceptId ? -1 : a.conceptId > b.conceptId ? 1 : 0))
}

/** The review to inject: the first queue entry within `maxHops` of the turn (5 = any distance; an
 * unconnected concept never qualifies). Walking past an unrelated head keeps one stale concept from
 * blocking every review. `skip` holds concepts the guidance already carries. */
export function selectReview(queue: ReviewEntry[], maxHops: number, skip: Set<string> = new Set()): ReviewEntry | null {
  const limit = maxHops >= REVIEW_HOPS_ALL ? Infinity : maxHops
  return queue.find((entry) => entry.hops !== null && entry.hops <= limit && !skip.has(entry.conceptId)) ?? null
}

/** One query for the learner's review history. An exposure is a submitted live turn that taught the
 * concept or matched it as task context, learner evidence or a misconception (a bare mention is not),
 * or an archived message the published assessment cites for it. `offered` holds reviews delivered in
 * any of the learner's turns during the 24 hours before `now`. */
export async function readReviewHistory(query: MetaPgQueryFn, userId: string, now: Date = new Date()): Promise<ReviewHistory> {
  const rows = (await query<{ concept_id: string; last_exposed_at: Date | null; offered: boolean }>(`
    WITH exposure AS (
      SELECT m->>'conceptId' AS concept_id, COALESCE(t.submitted_at, t.created_at) AS at
        FROM learning_live_feedback_turns t, jsonb_array_elements(t.feedback->'matches') m
       WHERE t.user_id = $1 AND jsonb_typeof(t.feedback->'matches') = 'array'
         AND m->>'relationship' IN ('task_context', 'learner_evidence', 'misconception')
      UNION ALL
      SELECT x, COALESCE(t.submitted_at, t.created_at)
        FROM learning_live_feedback_turns t, jsonb_array_elements_text(t.feedback->'taughtConceptIds') x
       WHERE t.user_id = $1 AND jsonb_typeof(t.feedback->'taughtConceptIds') = 'array'
      UNION ALL
      SELECT c.concept_id, s.observed_at
        FROM learning_concept_assessment_cache c
        CROSS JOIN LATERAL (
          SELECT e->>'sourceId' AS source_id FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.assessment->'demonstrated') = 'array' THEN c.assessment->'demonstrated' ELSE '[]' END) e
          UNION SELECT e->>'sourceId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.assessment->'gaps') = 'array' THEN c.assessment->'gaps' ELSE '[]' END) e
        ) cited
        JOIN learning_semantic_index_messages s ON s.message_id = cited.source_id
       WHERE c.user_id = $1
    ), offered AS (
      SELECT DISTINCT review_concept_id AS concept_id FROM learning_live_feedback_turns
       WHERE user_id = $1 AND review_concept_id IS NOT NULL AND created_at > $2::timestamptz - interval '24 hours' AND created_at <= $2::timestamptz
    )
    SELECT concept_id, max(at) AS last_exposed_at, bool_or(is_offered) AS offered FROM (
      SELECT concept_id, at, false AS is_offered FROM exposure WHERE at <= $2::timestamptz
      UNION ALL SELECT concept_id, NULL, true FROM offered
    ) x WHERE concept_id IS NOT NULL GROUP BY concept_id`, [userId, now.toISOString()])).rows
  return {
    exposures: new Map(rows.filter((row) => row.last_exposed_at).map((row) => [row.concept_id, new Date(row.last_exposed_at!)])),
    offered: new Set(rows.filter((row) => row.offered).map((row) => row.concept_id)),
  }
}
