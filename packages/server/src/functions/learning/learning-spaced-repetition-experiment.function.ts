import { defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { LIVE_CATALOG_VERSION } from '@learner/core/lib/learning/learning-live-feedback.js'
import { submitLiveTurnFeedback } from '@learner/core/lib/learning/learning-live-turn.js'
import {
  EXPERIMENT_SESSION, SPACED_REPETITION_FIXTURE, SPACED_REPETITION_FIXTURE_HASH, SpacedRepetitionResult, caseById, casePolicy,
  cleanupSpacedRepetitionExperiment, evaluateSpacedRepetitionCase, experimentTurnId, exportSpacedRepetitionExperiment,
  seedSpacedRepetitionCase, summarizeSpacedRepetition, verifySpacedRepetitionExport,
} from '@learner/core/lib/learning/learning-spaced-repetition-experiment.js'
import { beginLearningFeedbackTurn } from './learning-live-feedback.function.js'

export const SpacedRepetitionRun = z.object({ runId: z.string().uuid(), export: z.boolean().default(false) })
export const SpacedRepetitionCaseRef = z.object({ runId: z.string().uuid(), caseId: z.string() })
export const SpacedRepetitionResults = z.object({ runId: z.string().uuid(), results: z.array(SpacedRepetitionResult) })
export const SpacedRepetitionAny = z.record(z.string(), z.unknown())

export const prepareSpacedRepetitionExperimentStep = defineSessionlessFunction({
  input: SpacedRepetitionRun, output: z.object({ fixture: z.string(), caseIds: z.array(z.string()) }),
  func: async () => ({ fixture: SPACED_REPETITION_FIXTURE_HASH, caseIds: SPACED_REPETITION_FIXTURE.cases.map((c) => c.id) }),
})

/** One prompt end to end: seed its fixture user, open the turn, submit the matches through the live
 * submit path under the case's policy, read the stored decision back. Re-running reseeds from scratch. */
export const runSpacedRepetitionCaseStep = defineSessionlessFunction({
  input: SpacedRepetitionCaseRef, output: SpacedRepetitionResult,
  func: async (services, { runId, caseId }) => {
    const c = caseById(caseId)
    const graphs = await services.learningCurriculumStore.listGraphs()
    const { userId } = await seedSpacedRepetitionCase(runId, c, graphs, new Date())
    const session = { userId, scopes: ['admin'] }
    const turnId = experimentTurnId(runId, caseId)
    await beginLearningFeedbackTurn.func(services, { sessionId: EXPERIMENT_SESSION, turnId, message: c.message, foundationFirst: true, catalogVersion: LIVE_CATALOG_VERSION }, { session } as never)
    const started = Date.now()
    const submitted = await submitLiveTurnFeedback(services, userId, { sessionId: EXPERIMENT_SESSION, turnId, catalogVersion: LIVE_CATALOG_VERSION, matches: c.matches as never, taughtConceptIds: [] }, async () => casePolicy(c))
    const stored = (await metaDbQuery<{ review_concept_id: string | null }>('SELECT review_concept_id FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3', [userId, EXPERIMENT_SESSION, turnId])).rows[0]
    return evaluateSpacedRepetitionCase(c, submitted.guidance, stored?.review_concept_id ?? null, Date.now() - started)
  },
})

export const finishSpacedRepetitionExperimentStep = defineSessionlessFunction({
  input: SpacedRepetitionResults, output: SpacedRepetitionAny,
  func: async (_services, { runId, results }) => ({ ...summarizeSpacedRepetition(runId, results), removed: await cleanupSpacedRepetitionExperiment(runId) }),
})

export const exportSpacedRepetitionExperimentStep = defineSessionlessFunction({
  input: SpacedRepetitionResults, output: SpacedRepetitionAny,
  func: async (_services, { runId, results }) => exportSpacedRepetitionExperiment(runId, results),
})

export const verifySpacedRepetitionExportStep = defineSessionlessFunction({
  input: z.object({ runId: z.string().uuid(), expected: z.number().int() }), output: SpacedRepetitionAny,
  func: async (_services, { runId, expected }) => verifySpacedRepetitionExport(runId, expected),
})
