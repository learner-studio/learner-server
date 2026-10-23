import type { LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { metaDbQuery } from '../db-metadata/_shared.js'
import type { LearningCurriculumStore } from '../../services/learning-curriculum-store.js'
import type { LearningVectorTurnService } from '../../services/learning-vector-turn-service.js'
import { readRecentLiveFeedback } from './learning-feedback-history.js'
import { decideTurnInjection, NO_INTERVENTION_CONTEXT } from './learning-intervention-policy.js'
import { LIVE_CATALOG, liveFeedbackPolicy, validateLiveFeedbackMessage, type SubmitLearningTurnFeedbackInput } from './learning-live-feedback.js'
import { prerequisitePolicy } from './learning-prerequisite-selection.js'
import { readReviewHistory } from './learning-spaced-repetition.js'
import { taskTeachingContext, TASK_TEACHING_DEFAULT } from './learning-teaching-default.js'

export type LiveTurnServices = {
  learningVectorTurns: Pick<LearningVectorTurnService, 'lookupAssessments'>
  learningCurriculumStore: Pick<LearningCurriculumStore, 'listGraphs'>
}

/** The live hook's submit path: one atomic provisional write, then the turn's guidance under `policy`.
 * Retrying only repeats the read, never changes mastery. The RPC passes the stored policy; the
 * spaced-repetition experiment passes each case's policy through the same code. */
export async function submitLiveTurnFeedback(services: LiveTurnServices, userId: string, input: SubmitLearningTurnFeedbackInput, policy: () => Promise<LearningPolicySettings>) {
  const row = (await metaDbQuery<{ message: string; foundation_first: boolean; catalog_version: string }>(`SELECT message,foundation_first,catalog_version FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`, [userId, input.sessionId, input.turnId])).rows[0]
  if (!row) throw new Error('Initialize the human turn before submitting feedback')
  if (row.catalog_version !== input.catalogVersion) throw new Error('Turn catalog version mismatch')
  validateLiveFeedbackMessage(input, row.message, row.catalog_version)
  const payload = JSON.stringify({ matches: input.matches, taughtConceptIds: input.taughtConceptIds })
  const inserted = await metaDbQuery(`UPDATE learning_live_feedback_turns SET feedback=$4::jsonb,submitted_at=now() WHERE user_id=$1 AND session_id=$2 AND turn_id=$3 AND feedback IS NULL RETURNING turn_id`, [userId, input.sessionId, input.turnId, payload])
  if (!inserted.rowCount) {
    const same = (await metaDbQuery<{ same: boolean }>(`SELECT feedback=$4::jsonb AS same FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`, [userId, input.sessionId, input.turnId, payload])).rows[0]?.same
    if (!same) throw new Error('Conflicting feedback for an already submitted turn')
  }
  const started = Date.now()
  const base = { datasetTag: 'dev1' as const, foundationFirst: row.foundation_first, policyRevision: 'task-teaching-v2' as const, requestId: input.turnId }
  try {
    const recent = await readRecentLiveFeedback(userId, input.sessionId)
    const { suppressed, gaps } = liveFeedbackPolicy(recent)
    const graphs = await services.learningCurriculumStore.listGraphs()
    const projection = await services.learningVectorTurns.lookupAssessments(userId, graphs)
    const settings = await policy()
    const now = new Date()
    const spacedRepetition = settings.spacedRepetition ? { hops: settings.reviewHops, now, history: await readReviewHistory(metaDbQuery, userId, now) } : null
    const teaching = taskTeachingContext({ ids: input.matches.map((match) => match.conceptId), catalog: LIVE_CATALOG, assessments: projection.assessments, suppressed, gaps, edges: graphs.flatMap((graph) => graph.edges), foundationFirst: row.foundation_first, prerequisites: prerequisitePolicy(settings), spacedRepetition })
    const injected = await decideTurnInjection(metaDbQuery, { userId, sessionId: input.sessionId, turnId: input.turnId }, teaching.conceptIds.length > 0, settings.injectionRate, teaching.reviewConceptId)
    const guidance = injected ? { decision: 'influence' as const, context: teaching.context, conceptIds: teaching.conceptIds } : { decision: 'no_context' as const, context: NO_INTERVENTION_CONTEXT, conceptIds: [] }
    return { status: 'provisional' as const, replayed: !inserted.rowCount, guidance: { ...base, experimentId: projection.experimentId, ...guidance, durationMs: Date.now() - started } }
  } catch {
    return { status: 'provisional' as const, replayed: !inserted.rowCount, guidance: { ...base, experimentId: null, decision: 'fail_open' as const, context: `Feedback saved; stored assessment lookup unavailable. ${TASK_TEACHING_DEFAULT}`, conceptIds: [], durationMs: Date.now() - started } }
  }
}
