import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'

import {
  CanonicalEpisodeArtifactSchema,
  CanonicalEpisodeInputSchema,
  OutcomeEvaluatorConfigSchema,
  OutcomeSteeringJudgmentSchema,
  canonicalizeEpisode,
  outcomeSteeringPrompt,
  parseOutcomeSteeringJudgment,
} from '@learner/core/lib/learning/outcome-steering.js'
import type { LearningEpisodeStore } from '@learner/core/services/learning-episode-store.js'

export const CanonicalizeLearningEpisodeStepInput = z.object({ episode: CanonicalEpisodeInputSchema })
export const CanonicalizeLearningEpisodeStepOutput = CanonicalEpisodeArtifactSchema

export const CurriculumLearningEpisodeHandoffStepInput = z.object({
  artifactId: z.string().uuid(),
  sourceFingerprint: z.string(),
})
export const CurriculumLearningEpisodeHandoffStepOutput = z.object({
  artifactId: z.string().uuid(),
  sourceFingerprint: z.string(),
  status: z.literal('deferred'),
  reason: z.string(),
})

export const EvaluateOutcomeSteeringStepInput = z.object({
  artifactId: z.string().uuid(),
  sourceFingerprint: z.string(),
  evaluator: OutcomeEvaluatorConfigSchema,
})
export const EvaluateOutcomeSteeringStepOutput = z.object({
  evaluationId: z.string().uuid(),
  status: z.enum(['running', 'completed', 'abstained', 'failed']),
  judgment: OutcomeSteeringJudgmentSchema.nullable(),
  reused: z.boolean(),
  error: z.string().nullable(),
})

export const FinalizeLearningEpisodeAnalysisStepInput = z.object({
  artifact: CanonicalEpisodeArtifactSchema,
  curriculum: CurriculumLearningEpisodeHandoffStepOutput,
  outcomeSteering: EvaluateOutcomeSteeringStepOutput,
})
export const FinalizeLearningEpisodeAnalysisStepOutput = z.object({
  artifactId: z.string().uuid(),
  sourceFingerprint: z.string(),
  curriculum: CurriculumLearningEpisodeHandoffStepOutput,
  outcomeSteering: EvaluateOutcomeSteeringStepOutput,
})

type EpisodeArtifactStore = Pick<
  LearningEpisodeStore,
  'upsertCanonicalArtifact' | 'markArtifact'
>

type OutcomeEvaluationStore = Pick<
  LearningEpisodeStore,
  'getArtifact' | 'claimEvaluation' | 'completeEvaluation' | 'failEvaluation' | 'markArtifact'
>

export async function persistCanonicalLearningEpisode(
  store: EpisodeArtifactStore,
  episode: z.infer<typeof CanonicalEpisodeInputSchema>,
) {
  const artifact = canonicalizeEpisode(episode)
  const persisted = await store.upsertCanonicalArtifact(artifact)
  await store.markArtifact(persisted.artifactId, 'analyzing')
  return persisted
}

export async function runOutcomeSteeringEvaluation(
  store: OutcomeEvaluationStore,
  llm: { callLLMWithStructuredOutput: (input: Record<string, unknown>) => Promise<unknown> },
  input: z.infer<typeof EvaluateOutcomeSteeringStepInput>,
): Promise<z.infer<typeof EvaluateOutcomeSteeringStepOutput>> {
  const artifact = await store.getArtifact(input.artifactId)
  if (!artifact || artifact.sourceFingerprint !== input.sourceFingerprint) {
    throw new Error(`Canonical Learning episode artifact ${input.artifactId} is unavailable or changed`)
  }
  const claim = await store.claimEvaluation(artifact, input.evaluator)
  if (!claim.shouldEvaluate) {
    return {
      evaluationId: claim.evaluationId,
      status: claim.existing?.status ?? 'running',
      judgment: claim.existing?.judgment ?? null,
      reused: true,
      error: claim.existing?.error ?? null,
    }
  }
  if (!claim.claimToken) throw new Error(`Outcome evaluation ${claim.evaluationId} has no claim token`)
  try {
    const judgment = await llm.callLLMWithStructuredOutput({
      label: `Post-episode outcome steering ${artifact.artifactId}`,
      prompt: outcomeSteeringPrompt(artifact),
      parseFn: (raw: unknown) => parseOutcomeSteeringJudgment(raw, artifact),
      callOptions: {
        backend: input.evaluator.backend,
        model: input.evaluator.model,
        effort: input.evaluator.effort,
        timeout: 240,
      },
      maxParseRetries: 1,
    })
    const stored = await store.completeEvaluation(
      claim.evaluationId,
      claim.claimToken,
      OutcomeSteeringJudgmentSchema.parse(judgment),
    )
    return {
      evaluationId: stored.evaluationId,
      status: stored.status,
      judgment: stored.judgment,
      reused: false,
      error: stored.error,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await store.failEvaluation(claim.evaluationId, claim.claimToken, message)
    await store.markArtifact(artifact.artifactId, 'failed', message)
    throw error
  }
}

export const canonicalizeLearningEpisodeStep = defineSessionlessFunction({
  title: 'Canonicalize Learning episode',
  description: 'Normalize one already-adapted provider/harness episode bundle into the sole shared analysis artifact.',
  input: CanonicalizeLearningEpisodeStepInput,
  output: CanonicalizeLearningEpisodeStepOutput,
  func: async ({ learningEpisodeStore }, input) => persistCanonicalLearningEpisode(learningEpisodeStore, input.episode),
})

export const curriculumLearningEpisodeHandoffStep = defineSessionlessFunction({
  title: 'Prepare curriculum Learning episode handoff',
  description: 'Expose the shared artifact to the future curriculum adjudicator without assigning mastery.',
  input: CurriculumLearningEpisodeHandoffStepInput,
  output: CurriculumLearningEpisodeHandoffStepOutput,
  func: async ({ learningEpisodeStore }, input) => {
    const artifact = await learningEpisodeStore.getArtifact(input.artifactId)
    if (!artifact || artifact.sourceFingerprint !== input.sourceFingerprint) {
      throw new Error(`Canonical Learning episode artifact ${input.artifactId} is unavailable or changed`)
    }
    return {
      ...input,
      status: 'deferred' as const,
      reason: 'Typed sibling handoff only; curriculum evidence adjudication and mastery promotion are not implemented here.',
    }
  },
})

export const evaluateOutcomeSteeringStep = defineSessionlessFunction({
  title: 'Evaluate post-episode outcome steering',
  description: 'Use an evidence-grounded LLM judgment to build a curriculum-independent steering profile.',
  input: EvaluateOutcomeSteeringStepInput,
  output: EvaluateOutcomeSteeringStepOutput,
  func: async ({ learningEpisodeStore, llmService }, input) => runOutcomeSteeringEvaluation(
    learningEpisodeStore,
    llmService,
    input,
  ),
})

export const finalizeLearningEpisodeAnalysisStep = defineSessionlessFunction({
  title: 'Finalize Learning episode analysis',
  description: 'Record whether both typed sibling handoffs reached a durable terminal state.',
  input: FinalizeLearningEpisodeAnalysisStepInput,
  output: FinalizeLearningEpisodeAnalysisStepOutput,
  func: async ({ learningEpisodeStore }, input) => {
    const terminal = input.outcomeSteering.status === 'completed' || input.outcomeSteering.status === 'abstained'
    await learningEpisodeStore.markArtifact(
      input.artifact.artifactId,
      terminal ? 'completed' : 'partial',
      input.outcomeSteering.error,
    )
    return {
      artifactId: input.artifact.artifactId,
      sourceFingerprint: input.artifact.sourceFingerprint,
      curriculum: input.curriculum,
      outcomeSteering: input.outcomeSteering,
    }
  },
})
