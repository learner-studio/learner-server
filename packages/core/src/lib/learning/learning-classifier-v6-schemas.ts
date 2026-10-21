import { z } from 'zod'
import {
  THREE_TURN_CONTEXT_STRATEGY,
  THREE_TURN_EXPERIMENT_LABEL,
  THREE_TURN_MAX_BATCH_TOKENS,
  ONE_PAIR_CONTEXT_STRATEGY,
  ONE_PAIR_EXPERIMENT_LABEL,
  SEED_V1_CONTEXT_STRATEGY,
  SEED_V1_EXPERIMENT_LABEL,
} from './learning-three-turn-context.js'
import { assertSelectableCombination, cliEffortSchema, llmBackendSchema } from '@learner/llm/lib/llm/model-catalog.js'

export const StartLearningClassifierV6Input = z.object({
  sampleSize: z.number().int().min(1).max(500).default(5),
  mode: z.literal('prototype-extraction').default('prototype-extraction'),
  manifestSize: z.number().int().min(1).max(500).optional(),
  sampleSeed: z.string().min(1).max(200).optional(),
  replayRunId: z.string().uuid().optional(),
  backend: llmBackendSchema.optional(),
  model: z.string().min(1).optional(),
  effort: cliEffortSchema.optional(),
  maxAttempts: z.number().int().min(1).max(4).optional(),
  maxBatchTokens: z.number().int().min(1).max(THREE_TURN_MAX_BATCH_TOKENS).optional(),
  experimentLabel: z.enum([THREE_TURN_EXPERIMENT_LABEL, ONE_PAIR_EXPERIMENT_LABEL, SEED_V1_EXPERIMENT_LABEL]).optional(),
  contextStrategy: z.enum([THREE_TURN_CONTEXT_STRATEGY, ONE_PAIR_CONTEXT_STRATEGY, SEED_V1_CONTEXT_STRATEGY]).optional(),
  prepareOnly: z.boolean().optional(),
}).superRefine((input, context) => {
  const backend = input.backend ?? (input.model ? 'codex' : undefined)
  if (backend || input.model || input.effort) {
    if (!backend) context.addIssue({ code: 'custom', path: ['backend'], message: 'Backend is required when selecting a model' })
    if (!input.model) context.addIssue({ code: 'custom', path: ['model'], message: 'Model is required when selecting a backend' })
    if (!input.effort) context.addIssue({ code: 'custom', path: ['effort'], message: 'Effort is required when selecting a model' })
    if (backend && input.model && input.effort) {
      try { assertSelectableCombination(backend, input.model, input.effort) }
      catch (error) { context.addIssue({ code: 'custom', path: ['model'], message: error instanceof Error ? error.message : String(error) }) }
    }
  }
  const selected = input.experimentLabel !== undefined || input.contextStrategy !== undefined
  if (!selected) return
  const isSeedV1 = input.contextStrategy === SEED_V1_CONTEXT_STRATEGY
  const expectedLabel = isSeedV1 ? SEED_V1_EXPERIMENT_LABEL : input.contextStrategy === ONE_PAIR_CONTEXT_STRATEGY ? ONE_PAIR_EXPERIMENT_LABEL : THREE_TURN_EXPERIMENT_LABEL
  if (input.experimentLabel !== expectedLabel) context.addIssue({ code: 'custom', path: ['experimentLabel'], message: 'Experiment label must match the selected context strategy' })
  if (!isSeedV1 && input.model !== 'gpt-5.6-luna') context.addIssue({ code: 'custom', path: ['model'], message: 'Three-turn experiment requires gpt-5.6-luna' })
  if (!input.effort) context.addIssue({ code: 'custom', path: ['effort'], message: 'Three-turn experiment effort is required' })
  if (input.maxAttempts !== 1) context.addIssue({ code: 'custom', path: ['maxAttempts'], message: 'Three-turn experiment requires maxAttempts 1' })
  if (input.maxBatchTokens !== THREE_TURN_MAX_BATCH_TOKENS) context.addIssue({ code: 'custom', path: ['maxBatchTokens'], message: 'Three-turn experiment freezes the 400000 upper ceiling' })
  if (isSeedV1 ? input.sampleSize !== 100 : input.sampleSize !== 1 && input.sampleSize !== 50) context.addIssue({ code: 'custom', path: ['sampleSize'], message: isSeedV1 ? 'Seed V1 comparison requires all 100 frozen pairs' : 'Three-turn experiment permits only the one-sequence pilot or frozen 50-sequence run' })
  if (input.prepareOnly && input.sampleSize !== 50) context.addIssue({ code: 'custom', path: ['prepareOnly'], message: 'Three-turn prepare-only runs must freeze all 50 sequences' })
  if ((input.contextStrategy === ONE_PAIR_CONTEXT_STRATEGY || isSeedV1) && !input.replayRunId) context.addIssue({ code: 'custom', path: ['replayRunId'], message: 'This experiment requires its frozen source run' })
})
export const LearningClassifierV6WorkflowInput = StartLearningClassifierV6Input.safeExtend({ runId: z.string().uuid() })
export const RunLearningClassifierV6AttemptInput = z.object({
  runId: z.string().uuid(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(50),
  mode: z.literal('prototype-extraction').default('prototype-extraction'),
  attempt: z.number().int().min(1).max(4),
})
