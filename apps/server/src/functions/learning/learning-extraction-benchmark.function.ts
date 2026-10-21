import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import {
  createBenchmarkRun,
  readBenchmarkCorpusInventory,
  readBenchmarks,
  readLearningExtractions,
  readThreeTurnExperimentPreflight,
  saveBenchmarkHumanReview,
} from '@learner/core/lib/learning/learning-extraction-benchmark.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { StartLearningClassifierV6Input } from '@learner/core/lib/learning/learning-classifier-v6-schemas.js'
import { CLASSIFIER_V6_RUNTIME } from '@learner/core/lib/learning/learning-classifier-v6-run.js'

export const StartLearningExtractionBenchmarkOutput = z.object({
  runId: z.string().uuid(),
  sampleSize: z.number().int(),
})

export const startLearningExtractionBenchmark = defineFunction({
  title: 'Start learning extraction benchmark',
  description: 'Start durable v6 concept classification with a flat catalog, provisional evidence, and three correction attempts.',
  expose: true,
  scopes: ['admin'],
  input: StartLearningClassifierV6Input,
  output: StartLearningExtractionBenchmarkOutput,
  func: async ({ workflowService }, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    const manifestSize = input.manifestSize ?? input.sampleSize
    const sampleSeed = input.sampleSeed ?? (manifestSize > input.sampleSize ? randomUUID() : undefined)
    const inventory = input.replayRunId ? null : input.contextStrategy
      ? (await readThreeTurnExperimentPreflight(manifestSize, sampleSeed)).inventory
      : await readBenchmarkCorpusInventory(manifestSize)
    if (inventory && 'ready' in inventory && !inventory.ready) {
      throw new Error(`Corpus is not ready for a ${manifestSize}-message manifest: ${inventory.uniqueEligibleTurns} eligible, ${inventory.shortfall} short`)
    }
    const sampling = { manifestSize, ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }), ...(input.maxBatchTokens === undefined ? {} : { maxBatchTokens: input.maxBatchTokens }), ...(sampleSeed ? { sampleSeed } : {}), ...(input.replayRunId ? { replayRunId: input.replayRunId } : {}), ...(input.backend ? { backend: input.backend } : {}), ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.experimentLabel ? { experimentLabel: input.experimentLabel } : {}), ...(input.contextStrategy ? { contextStrategy: input.contextStrategy } : {}), ...(input.prepareOnly ? { prepareOnly: true } : {}) }
    const runId = await createBenchmarkRun(input.sampleSize, input.mode, sampling)
    await workflowService.startWorkflow(
      'learningExtractionBenchmarkWorkflow',
      { runId, sampleSize: input.sampleSize, mode: input.mode, manifestSize: sampling.manifestSize, sampleSeed: sampling.sampleSeed, replayRunId: sampling.replayRunId, prepareOnly: input.prepareOnly },
      { type: 'http', userId: session.userId },
      rpc,
    )
    return { runId, sampleSize: input.sampleSize }
  },
})

export const GetLearningExtractionCorpusInput = z.object({
  targetSize: z.number().int().min(9).max(500).default(500),
})
export const GetLearningExtractionCorpusOutput = z.object({
  targetSize: z.number().int(),
  totalTurnsRead: z.number().int(),
  verifiedHumanTurns: z.number().int(),
  uniqueEligibleTurns: z.number().int(),
  duplicateHumanTurns: z.number().int(),
  excludedNonHumanTurns: z.number().int(),
  shortfall: z.number().int(),
  ready: z.boolean(),
  byProvider: z.object({ google: z.number().int(), anthropic: z.number().int(), openai: z.number().int() }),
  byStratum: z.record(z.string(), z.number().int()),
  sourceErrors: z.array(z.string()),
})

export const getLearningExtractionCorpus = defineFunction({
  title: 'Get Learning extraction corpus readiness',
  description: 'Audit unique, provenance-verified local learner inputs before starting a paid extraction run.',
  expose: true,
  readonly: true,
  input: GetLearningExtractionCorpusInput,
  output: GetLearningExtractionCorpusOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    return readBenchmarkCorpusInventory(input.targetSize)
  },
})

export const startLearningExtractionBenchmarkCli = defineSessionlessFunction({
  title: 'Start learning extraction calibration',
  description: 'Start a provenance-verified, provider-aware Learning extraction calibration from the local operator CLI.',
  input: StartLearningClassifierV6Input,
  output: StartLearningExtractionBenchmarkOutput,
  func: async ({ workflowService }, input, { rpc }) => {
    assertLearningLocalMvpEnabled()
    const manifestSize = input.manifestSize ?? input.sampleSize
    const sampleSeed = input.sampleSeed ?? (manifestSize > input.sampleSize ? randomUUID() : undefined)
    const inventory = input.replayRunId ? null : input.contextStrategy
      ? (await readThreeTurnExperimentPreflight(manifestSize, sampleSeed)).inventory
      : await readBenchmarkCorpusInventory(manifestSize)
    if (inventory && 'ready' in inventory && !inventory.ready) {
      throw new Error(`Corpus is not ready for a ${manifestSize}-message manifest: ${inventory.uniqueEligibleTurns} eligible, ${inventory.shortfall} short`)
    }
    const sampling = { manifestSize, ...(input.maxAttempts === undefined ? {} : { maxAttempts: input.maxAttempts }), ...(input.maxBatchTokens === undefined ? {} : { maxBatchTokens: input.maxBatchTokens }), ...(sampleSeed ? { sampleSeed } : {}), ...(input.replayRunId ? { replayRunId: input.replayRunId } : {}), ...(input.backend ? { backend: input.backend } : {}), ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}), ...(input.experimentLabel ? { experimentLabel: input.experimentLabel } : {}), ...(input.contextStrategy ? { contextStrategy: input.contextStrategy } : {}), ...(input.prepareOnly ? { prepareOnly: true } : {}) }
    const runId = await createBenchmarkRun(input.sampleSize, input.mode, sampling)
    await workflowService.startWorkflow(
      'learningExtractionBenchmarkWorkflow',
      { runId, sampleSize: input.sampleSize, mode: input.mode, manifestSize: sampling.manifestSize, sampleSeed: sampling.sampleSeed, replayRunId: sampling.replayRunId, prepareOnly: input.prepareOnly },
      { type: 'cli' },
      rpc,
    )
    return { runId, sampleSize: input.sampleSize }
  },
})

export const GetLearningExtractionBenchmarksInput = z.object({
  runId: z.string().uuid().optional(),
})

export const GetLearningExtractionBenchmarksOutput = z.object({
  runtime: z.object({ outputFormat: z.literal('native-json-schema'), attemptLimitVersion: z.literal(1) }),
  runs: z.array(z.object({
    runId: z.string(),
    status: z.string(),
    sampleSize: z.number(),
    outputTokens: z.number().int().nonnegative().nullable(),
    config: z.unknown(),
    sourceCounts: z.unknown(),
    summary: z.unknown(),
    error: z.string().nullable(),
    startedAt: z.string(),
    completedAt: z.string().nullable(),
  })),
  cases: z.array(z.object({
    run_id: z.string(),
    case_id: z.string(),
    ordinal: z.number(),
    provider: z.string(),
    agent: z.string(),
    thread_id: z.string(),
    turn_id: z.string(),
    occurred_at: z.string(),
    input_hash: z.string(),
    input_snapshot: z.unknown(),
    status: z.string(),
    judge_output: z.unknown(),
    judge_duration_ms: z.number().nullable(),
    error: z.string().nullable(),
    humanReview: z.object({
      status: z.string(),
      preferredWinner: z.string().nullable(),
      componentReviews: z.record(z.string(), z.unknown()),
      notes: z.string(),
      reviewerId: z.string(),
      updatedAt: z.string(),
    }).nullable(),
    results: z.array(z.object({
      model: z.string(),
      effort: z.string(),
      status: z.string(),
      extraction: z.unknown(),
      durationMs: z.number(),
      inputTokens: z.number().nullable(),
      outputTokens: z.number().nullable(),
      error: z.string().nullable(),
    })),
  })),
})

export const getLearningExtractionBenchmarks = defineFunction({
  title: 'Get learning extraction benchmarks',
  description: 'Read durable extractor comparison summaries and case-level component judgments.',
  expose: true,
  readonly: true,
  input: GetLearningExtractionBenchmarksInput,
  output: GetLearningExtractionBenchmarksOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    return { ...await readBenchmarks(input.runId), runtime: CLASSIFIER_V6_RUNTIME }
  },
})

export const GetLearningExtractionsInput = z.object({
  limit: z.number().int().min(1).max(500).default(500),
})

export const GetLearningExtractionsOutput = z.object({
  records: z.array(z.object({
    id: z.string(), processType: z.enum(['benchmark', 'shadow']),
    runId: z.string().nullable(), runStatus: z.string().nullable(), runValidity: z.string().nullable(), invalidReason: z.string().nullable(), caseId: z.string().nullable(),
    eventId: z.string().nullable(), decisionId: z.string().nullable(),
    ordinal: z.number().nullable(), provider: z.string(), agent: z.string(),
    stratum: z.string().nullable(), threadId: z.string(), turnId: z.string(),
    occurredAt: z.string(), status: z.string(), model: z.string().nullable(),
    backend: z.string().nullable(), effort: z.string().nullable(),
    benchmarkVersion: z.number().nullable(), promptVersion: z.union([z.string(), z.number()]).nullable(),
    policyVersion: z.string().nullable(), extraction: z.unknown(), inputSnapshot: z.unknown(),
    runConfig: z.unknown(), packet: z.unknown(), judgeOutput: z.unknown(),
    durationMs: z.number().nullable(), inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(), error: z.string().nullable(),
  })),
})

export const getLearningExtractions = defineFunction({
  title: 'Get learning extractions',
  description: 'Read up to 500 persisted message-level Learning extraction artifacts without running models.',
  expose: true,
  readonly: true,
  input: GetLearningExtractionsInput,
  output: GetLearningExtractionsOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    return readLearningExtractions(input.limit)
  },
})

const HumanComponentVerdict = z.enum(['pass', 'fail', 'unsure'])
export const SaveLearningExtractionHumanReviewInput = z.object({
  runId: z.string().uuid(),
  caseId: z.string().min(1),
  preferredWinner: z.enum(['A', 'B', 'tie', 'unsure']),
  componentReviews: z.record(z.string(), z.object({
    A: HumanComponentVerdict,
    B: HumanComponentVerdict,
  })),
  notes: z.string().max(4_000),
})
export const SaveLearningExtractionHumanReviewOutput = z.object({
  status: z.literal('completed'),
  updatedAt: z.string(),
})

export const saveLearningExtractionHumanReview = defineFunction({
  title: 'Save Learning extraction human review',
  description: 'Persist a human calibration verdict without mutating the frozen benchmark or LLM judge artifacts.',
  expose: true,
  audit: true,
  scopes: ['admin'],
  input: SaveLearningExtractionHumanReviewInput,
  output: SaveLearningExtractionHumanReviewOutput,
  func: async (_services, input, { session }) => {
    assertLearningLocalMvpEnabled()
    return saveBenchmarkHumanReview({ ...input, reviewerId: session.userId })
  },
})
