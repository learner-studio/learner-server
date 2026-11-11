import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { LearningConceptAssessmentSchema, LearningAssessmentRunSchema } from '@learner/core/lib/learning/learning-concept-assessment.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const GetLearningConceptAssessmentInput = z.object({ conceptId: z.string().min(1) })
export const StartLearningConceptAssessmentInput = GetLearningConceptAssessmentInput.extend({ requestId: z.string().uuid() })
export const LearningAssessmentRunInput = z.object({ runId: z.string().uuid() })
export const LearningAssessmentStepOutput = z.object({ runId: z.string(), status: z.string() })
export const StartLearningConceptAssessmentOutput = z.object({ runId: z.string(), started: z.literal(true) })
export const getLearningConceptAssessment = defineFunction({
  expose: true, readonly: true, scopes: ['admin'], input: GetLearningConceptAssessmentInput, output: LearningConceptAssessmentSchema,
  func: async ({ learningConceptAssessment }, { conceptId }, { session }) => {
    assertLearningLocalMvpEnabled()
    return learningConceptAssessment.get(session.userId, conceptId)
  },
})
export const startLearningConceptAssessment = defineFunction({
  expose: true, scopes: ['admin'], input: StartLearningConceptAssessmentInput, output: StartLearningConceptAssessmentOutput,
  func: async ({ learningConceptAssessment, learningVectorTurns, workflowService }, { conceptId, requestId }, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    const { runId } = await learningConceptAssessment.prepare(session.userId, conceptId, requestId, learningVectorTurns)
    await workflowService.startWorkflow('learningConceptAssessmentWorkflow', { runId }, { type: 'http', userId: session.userId }, rpc)
    return { runId, started: true as const }
  },
})
export const getLearningAssessmentRun = defineFunction({
  expose: true, readonly: true, scopes: ['admin'], input: LearningAssessmentRunInput, output: LearningAssessmentRunSchema,
  func: async ({ learningConceptAssessment }, { runId }, { session }) => {
    assertLearningLocalMvpEnabled()
    return learningConceptAssessment.run(runId, session.userId)
  },
})
export const executeLearningConceptAssessmentStep = defineSessionlessFunction({
  input: LearningAssessmentRunInput, output: LearningAssessmentStepOutput,
  func: async ({ learningConceptAssessment }, { runId }) => {
    assertLearningLocalMvpEnabled()
    return learningConceptAssessment.execute(runId)
  },
})
export const publishLearningConceptAssessmentStep = defineSessionlessFunction({
  input: LearningAssessmentRunInput, output: LearningAssessmentStepOutput,
  func: async ({ learningConceptAssessment }, { runId }) => learningConceptAssessment.publish(runId),
})

// Replicate grading (docs/specs/mastery-change-statistics.md): with policy gradingReplicates = k > 1 a
// live reading is graded k times, each extra grading its own step and receipt, and published as the mean.
export const ReplicatePlanOutput = z.object({ runId: z.string(), replicates: z.array(z.number().int().min(2).max(5)) })
export const ReplicateStepInput = z.object({ runId: z.string().uuid(), replicate: z.number().int().min(2).max(5) })
export const ReplicateStepOutput = z.object({ runId: z.string(), replicate: z.number().int(), status: z.enum(['completed', 'failed', 'uncertain', 'skipped']) })
export const CombineReplicatesOutput = z.object({ runId: z.string(), replicates: z.number().int(), meanPercent: z.number().nullable() })
export const planLearningAssessmentReplicatesStep = defineSessionlessFunction({
  title: 'Plan independent replicate gradings for a live reading (policy gradingReplicates)',
  input: LearningAssessmentRunInput, output: ReplicatePlanOutput,
  func: async ({ learningConceptAssessment }, { runId }) => learningConceptAssessment.planReplicates(runId),
})
export const executeLearningAssessmentReplicateStep = defineSessionlessFunction({
  title: 'Grade one independent replicate of a reading (reserved first: a replay never pays twice)',
  input: ReplicateStepInput, output: ReplicateStepOutput,
  func: async ({ learningConceptAssessment }, { runId, replicate }) => {
    assertLearningLocalMvpEnabled()
    return learningConceptAssessment.executeReplicate(runId, replicate)
  },
})
export const combineLearningAssessmentReplicatesStep = defineSessionlessFunction({
  title: 'Publish a replicated reading as the mean of its gradings',
  input: LearningAssessmentRunInput, output: CombineReplicatesOutput,
  func: async ({ learningConceptAssessment }, { runId }) => learningConceptAssessment.combineReplicates(runId),
})
