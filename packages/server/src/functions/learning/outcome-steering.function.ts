import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import { isRunActive } from '@learner/core/lib/workflow/workflow-runs.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import {
  CanonicalEpisodeArtifactSchema,
  CanonicalEpisodeInputSchema,
  DEFAULT_OUTCOME_EVALUATOR_CONFIG,
  OutcomeEvaluatorConfigSchema,
  OutcomeSteeringJudgmentSchema,
  stableJson,
} from '@learner/core/lib/learning/outcome-steering.js'
import { LearningEpisodeAnalysisWorkflowInput } from '../workflows/learning/episode-analysis.workflow.js'
import { assertSelectableCombination } from '@learner/llm/lib/llm/model-catalog.js'

const WORKFLOW_NAME = 'learningEpisodeAnalysisWorkflow'

export const StartLearningEpisodeAnalysisInput = z.object({
  episode: CanonicalEpisodeInputSchema,
  evaluator: OutcomeEvaluatorConfigSchema.default(DEFAULT_OUTCOME_EVALUATOR_CONFIG),
})
export const StartLearningEpisodeAnalysisOutput = z.object({
  runId: z.string(),
  alreadyRunning: z.boolean(),
  sourceEpisodeKey: z.string(),
  evaluator: OutcomeEvaluatorConfigSchema,
})

export const startLearningEpisodeAnalysis = defineFunction({
  title: 'Start Learning episode analysis',
  description: 'Start the single durable parent that shares one canonical episode artifact across curriculum and outcome-steering branches.',
  expose: true,
  audit: true,
  scopes: ['admin'],
  input: StartLearningEpisodeAnalysisInput,
  output: StartLearningEpisodeAnalysisOutput,
  func: async ({ workflowRunService, workflowService }, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    assertSelectableCombination(input.evaluator.backend, input.evaluator.model, input.evaluator.effort)
    const active = (await workflowRunService.listRuns({ workflowName: WORKFLOW_NAME, limit: 100 }))
      .find((run) => {
        const parsed = LearningEpisodeAnalysisWorkflowInput.safeParse(run.input)
        return parsed.success
          && parsed.data.episode.sourceEpisodeKey === input.episode.sourceEpisodeKey
          && stableJson(parsed.data.evaluator) === stableJson(input.evaluator)
          && isRunActive(run)
      })
    if (active) {
      return {
        runId: active.id,
        alreadyRunning: true,
        sourceEpisodeKey: input.episode.sourceEpisodeKey,
        evaluator: input.evaluator,
      }
    }
    const { runId } = await workflowService.startWorkflow(
      WORKFLOW_NAME,
      { userId: session.userId, episode: input.episode, evaluator: input.evaluator },
      { type: 'http', userId: session.userId },
      rpc,
    )
    return {
      runId,
      alreadyRunning: false,
      sourceEpisodeKey: input.episode.sourceEpisodeKey,
      evaluator: input.evaluator,
    }
  },
})

const OutcomeEvaluationRecordSchema = z.object({
  evaluationId: z.string().uuid(),
  artifactId: z.string().uuid(),
  evaluatorVersion: z.string(),
  backend: z.string(),
  model: z.string(),
  effort: z.string(),
  status: z.enum(['running', 'completed', 'abstained', 'failed']),
  judgment: OutcomeSteeringJudgmentSchema.nullable(),
  error: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  artifact: CanonicalEpisodeArtifactSchema,
})

export const GetOutcomeSteeringEvaluationsInput = z.object({
  sourceEpisodeKey: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(200).default(50),
})
export const GetOutcomeSteeringEvaluationsOutput = z.object({
  evaluations: z.array(OutcomeEvaluationRecordSchema),
})

export const getOutcomeSteeringEvaluations = defineFunction({
  title: 'Audit outcome-steering evaluations',
  description: 'Read stored canonical episode artifacts and evidence-grounded dimension profiles without invoking a model.',
  expose: true,
  readonly: true,
  scopes: ['admin'],
  input: GetOutcomeSteeringEvaluationsInput,
  output: GetOutcomeSteeringEvaluationsOutput,
  func: async ({ learningEpisodeStore }, input) => {
    assertLearningLocalMvpEnabled()
    const evaluations = await learningEpisodeStore.listEvaluations(input.limit)
    return {
      evaluations: input.sourceEpisodeKey
        ? evaluations.filter((item) => item.artifact.sourceEpisodeKey === input.sourceEpisodeKey)
        : evaluations,
    }
  },
})
