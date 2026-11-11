import type { LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { metaDbQuery } from '../db-metadata/_shared.js'
import type { LearningCurriculumStore } from '../../services/learning-curriculum-store.js'
import type { LearningVectorTurnService } from '../../services/learning-vector-turn-service.js'
import { readRecentLiveFeedback } from './learning-feedback-history.js'
import { decideTurnInjection, NO_INTERVENTION_CONTEXT, recordProbeFailOpen } from './learning-intervention-policy.js'
import { LIVE_CATALOG, LIVE_FEEDBACK_INSTRUCTIONS, liveFeedbackPolicy, validateLiveFeedbackMessage, type BeginLearningFeedbackTurnInput, type SubmitLearningTurnFeedbackInput } from './learning-live-feedback.js'
import { LIVE, type LiveCatalog } from './learning-live-catalog.js'
import { prerequisitePolicy } from './learning-prerequisite-selection.js'
import { readReviewHistory } from './learning-spaced-repetition.js'
import { heldOutConcepts } from './learning-concept-holdout.js'
import { taskTeachingContext, TASK_TEACHING_DEFAULT } from './learning-teaching-default.js'

/** osmosis-concept-holdout at the default share: a pure function of the catalog and the share. */
export const LIVE_HELD_OUT: ReadonlySet<string> = heldOutConcepts(LIVE_CATALOG)

/** The live hook's begin path (at `now`, the wall clock except in the simulated learner's calendar): store the human turn once (a replay with the same identity is a no-op;
 * a different message under the same id is refused), then the packet the agent needs to submit. */
export async function beginLiveTurn(userId: string, input: BeginLearningFeedbackTurnInput, catalog: LiveCatalog = LIVE, now: Date = new Date()) {
  await metaDbQuery(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`, [userId, input.sessionId, input.turnId, input.message, input.foundationFirst, catalog.version, now.toISOString()])
  const row = (await metaDbQuery<{ message: string; foundation_first: boolean; catalog_version: string }>(`SELECT message,foundation_first,catalog_version FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`, [userId, input.sessionId, input.turnId])).rows[0]
  if (!row || row.message !== input.message || row.foundation_first !== input.foundationFirst || row.catalog_version !== catalog.version) throw new Error('Turn identity conflicts with the stored message or configuration')
  return { turnId: input.turnId, catalogVersion: catalog.version, catalog: input.catalogVersion === catalog.version ? null : [...catalog.concepts], instructions: LIVE_FEEDBACK_INSTRUCTIONS, recentFeedback: await readRecentLiveFeedback(userId, input.sessionId, catalog, now) }
}

export type LiveTurnServices = {
  learningVectorTurns: Pick<LearningVectorTurnService, 'lookupAssessments'>
  learningCurriculumStore: Pick<LearningCurriculumStore, 'listGraphs'>
}

/** The live hook's submit path: one atomic provisional write, then the turn's guidance under `policy`.
 * Retrying only repeats the read, never changes mastery. The RPC passes the stored policy; the
 * spaced-repetition experiment passes each case's policy through the same code. `heldOut` defaults to
 * the live holdout (1 in 5, a constant); the experiment replays fixed review cases, so it passes none (the holdout has its
 * own tests in learning-concept-holdout.test.ts). `catalog` defaults to the shipped one; the simulated-learner
 * experiment passes its fictional curriculum (with `heldOut` computed from it by the same hash). `now` is the turn's
 * time (submission, review intervals, the recent-feedback window); the simulated learner passes its own calendar,
 * where sessions are days apart, and every other caller the wall clock. */
export async function submitLiveTurnFeedback(services: LiveTurnServices, userId: string, input: SubmitLearningTurnFeedbackInput, policy: () => Promise<LearningPolicySettings>, heldOut?: ReadonlySet<string>, catalog: LiveCatalog = LIVE, now: Date = new Date()) {
  const row = (await metaDbQuery<{ message: string; foundation_first: boolean; catalog_version: string }>(`SELECT message,foundation_first,catalog_version FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`, [userId, input.sessionId, input.turnId])).rows[0]
  if (!row) throw new Error('Initialize the human turn before submitting feedback')
  if (row.catalog_version !== input.catalogVersion) throw new Error('Turn catalog version mismatch')
  validateLiveFeedbackMessage(input, row.message, row.catalog_version, catalog)
  const payload = JSON.stringify({ matches: input.matches, taughtConceptIds: input.taughtConceptIds })
  const inserted = await metaDbQuery(`UPDATE learning_live_feedback_turns SET feedback=$4::jsonb,submitted_at=$5 WHERE user_id=$1 AND session_id=$2 AND turn_id=$3 AND feedback IS NULL RETURNING turn_id`, [userId, input.sessionId, input.turnId, payload, now.toISOString()])
  if (!inserted.rowCount) {
    const same = (await metaDbQuery<{ same: boolean }>(`SELECT feedback=$4::jsonb AS same FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`, [userId, input.sessionId, input.turnId, payload])).rows[0]?.same
    if (!same) throw new Error('Conflicting feedback for an already submitted turn')
  }
  const started = Date.now()
  let settings: LearningPolicySettings | undefined
  const base = { datasetTag: 'dev1' as const, foundationFirst: row.foundation_first, policyRevision: 'task-teaching-v2' as const, requestId: input.turnId }
  try {
    settings = await policy()
    const recent = await readRecentLiveFeedback(userId, input.sessionId, catalog, now)
    const { suppressed, gaps } = liveFeedbackPolicy(recent)
    const graphs = await services.learningCurriculumStore.listGraphs()
    const projection = await services.learningVectorTurns.lookupAssessments(userId, graphs)
    const spacedRepetition = settings.spacedRepetition ? { hops: settings.reviewHops, now, history: await readReviewHistory(metaDbQuery, userId, now) } : null
    const teaching = taskTeachingContext({ ids: input.matches.map((match) => match.conceptId), catalog: [...catalog.concepts], assessments: projection.assessments, suppressed, gaps, edges: graphs.flatMap((graph) => graph.edges), foundationFirst: row.foundation_first, prerequisites: prerequisitePolicy(settings), spacedRepetition, heldOut: new Set(heldOut ?? LIVE_HELD_OUT), probe: settings.blindProbes ? { turnId: input.turnId, rate: settings.probeRate, hops: settings.probeHops } : null })
    const injected = await decideTurnInjection(metaDbQuery, { userId, sessionId: input.sessionId, turnId: input.turnId }, teaching.conceptIds.length > 0, settings.injectionRate, teaching.reviewConceptId, settings.randomizedInjection, teaching.probe, teaching.conceptIds)
    const guidance = injected ? { decision: 'influence' as const, context: teaching.context, conceptIds: teaching.conceptIds } : { decision: 'no_context' as const, context: NO_INTERVENTION_CONTEXT, conceptIds: [] }
    return { status: 'provisional' as const, replayed: !inserted.rowCount, guidance: { ...base, experimentId: projection.experimentId, ...guidance, durationMs: Date.now() - started } }
  } catch {
    // With probes on, say so on the turn: otherwise it reads as a turn decided with probes off.
    if (settings?.blindProbes) await recordProbeFailOpen(metaDbQuery, { userId, sessionId: input.sessionId, turnId: input.turnId }, settings.probeRate, settings.probeHops).catch(() => undefined)
    return { status: 'provisional' as const, replayed: !inserted.rowCount, guidance: { ...base, experimentId: null, decision: 'fail_open' as const, context: `Feedback saved; stored assessment lookup unavailable. ${TASK_TEACHING_DEFAULT}`, conceptIds: [], durationMs: Date.now() - started } }
  }
}
