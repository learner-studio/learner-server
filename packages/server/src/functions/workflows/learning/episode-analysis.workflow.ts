import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'

import {
  CanonicalEpisodeArtifactSchema,
  CanonicalEpisodeInputSchema,
  OutcomeEvaluatorConfigSchema,
  OutcomeSteeringJudgmentSchema,
} from '@learner/core/lib/learning/outcome-steering.js'

export const LearningEpisodeAnalysisWorkflowInput = z.object({
  userId: z.string().min(1),
  episode: CanonicalEpisodeInputSchema,
  evaluator: OutcomeEvaluatorConfigSchema,
})

export const LearningEpisodeAnalysisWorkflowOutput = z.object({
  artifactId: z.string().uuid(),
  sourceFingerprint: z.string(),
  curriculum: z.object({
    artifactId: z.string().uuid(),
    sourceFingerprint: z.string(),
    status: z.literal('deferred'),
    reason: z.string(),
  }),
  outcomeSteering: z.object({
    evaluationId: z.string().uuid(),
    status: z.enum(['running', 'completed', 'abstained', 'failed']),
    judgment: OutcomeSteeringJudgmentSchema.nullable(),
    reused: z.boolean(),
    error: z.string().nullable(),
  }),
})

/**
 * The sole durable episode-analysis parent.
 *
 * Both sibling branches consume the identical canonical artifact. Neither may
 * read/regroup transcripts independently, and the curriculum handoff does not
 * manufacture mastery updates before its adjudication path exists.
 */
export const learningEpisodeAnalysisWorkflow = defineWorkflow({
  input: LearningEpisodeAnalysisWorkflowInput,
  output: LearningEpisodeAnalysisWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    const canonical = await workflow.do(
      '1. Build the shared canonical episode artifact',
      'canonicalizeLearningEpisodeStep',
      { episode: data.episode },
    )
    const curriculum = await workflow.do(
      '2A. Hand canonical episode to curriculum analysis',
      'curriculumLearningEpisodeHandoffStep',
      { artifactId: canonical.artifactId, sourceFingerprint: canonical.sourceFingerprint },
    )
    const outcomeSteering = await workflow.do(
      '2B. Evaluate post-episode outcome steering',
      'evaluateOutcomeSteeringStep',
      {
        artifactId: canonical.artifactId,
        sourceFingerprint: canonical.sourceFingerprint,
        evaluator: data.evaluator,
      },
      { retries: 2, retryDelay: '5s' },
    )
    return await workflow.do(
      '3. Finalize shared episode analysis',
      'finalizeLearningEpisodeAnalysisStep',
      {
        artifact: canonical,
        curriculum,
        outcomeSteering,
      },
    )
  },
})

// Exported only as the canonical step output contract for typed sibling input.
export const CanonicalLearningEpisodeArtifactOutput = CanonicalEpisodeArtifactSchema
