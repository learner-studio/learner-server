import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'

import {
  completePrototypeExtractionCase,
  extractionPrompt,
  finalizeBenchmarkRun,
  finalizePreparedBenchmarkManifest,
  judgePrompt,
  loadCompletedModelResult,
  loadBenchmarkCases,
  parseExtraction,
  parseJudge,
  prepareBenchmarkRun,
  saveJudgeResult,
  saveModelResult,
  type BenchmarkCaseRow,
  type BenchmarkRunMode,
  type LearningExtraction,
  type UsageTotals,
} from '@learner/core/lib/learning/learning-extraction-benchmark.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { runClassifierV6Attempt, finalizeClassifierV6 } from '@learner/core/lib/learning/learning-classifier-v6-run.js'
import { RunLearningClassifierV6AttemptInput } from '@learner/core/lib/learning/learning-classifier-v6-schemas.js'

export const PrepareLearningExtractionBenchmarkStepInput = z.object({
  runId: z.string().uuid(),
  sampleSize: z.number().int().min(1).max(1_000),
  manifestSize: z.number().int().min(1).max(1_000).optional(),
  sampleSeed: z.string().min(1).max(200).optional(),
  replayRunId: z.string().uuid().optional(),
})
export const PrepareLearningExtractionBenchmarkStepOutput = z.object({ cases: z.number().int() })
export const RunLearningExtractionBenchmarkBatchStepOutput = z.object({ attempted: z.number(), completed: z.number(), failed: z.number() })
export const FinalizeLearningExtractionBenchmarkStepInput = z.object({ runId: z.string().uuid() })
export const FinalizeLearningExtractionBenchmarkStepOutput = z.record(z.string(), z.unknown())

export const prepareLearningExtractionBenchmarkStep = defineSessionlessFunction({
  title: 'Prepare learning extraction benchmark',
  description: 'Freeze a balanced, redacted benchmark manifest from local Claude and Codex conversation sources.',
  input: PrepareLearningExtractionBenchmarkStepInput,
  output: PrepareLearningExtractionBenchmarkStepOutput,
  func: async (_services, input) => {
    try { return await prepareBenchmarkRun(input.runId, input.sampleSize, input.manifestSize, input.sampleSeed, input.replayRunId) }
    catch (error) {
      await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='failed',error=$2,completed_at=now() WHERE run_id=$1`, [input.runId, error instanceof Error ? error.message : String(error)])
      throw error
    }
  },
})

const MODEL_CONFIGS = [
  { model: 'gpt-5.4-mini', effort: 'medium' },
  { model: 'gpt-5.6-luna', effort: 'medium' },
] as const

async function runExtraction(
  llmService: {
    callLLMWithStructuredOutput: (input: Record<string, unknown>) => Promise<unknown>
  },
  row: BenchmarkCaseRow,
  model: string,
  effort: string,
): Promise<{ extraction: LearningExtraction; durationMs: number; usage: UsageTotals }> {
  let inputTokens: number | null = null
  let outputTokens: number | null = null
  const started = Date.now()
  const extraction = await llmService.callLLMWithStructuredOutput({
    label: 'Learning benchmark extractor ' + model,
    prompt: extractionPrompt(row.input_snapshot),
    parseFn: (raw: unknown) => parseExtraction(raw, row.input_snapshot),
    callOptions: {
      backend: 'codex',
      model,
      effort,
      timeout: 180,
      onUsage: (usage: { inputTokens?: number; outputTokens?: number }) => {
        inputTokens = usage.inputTokens ?? null
        outputTokens = usage.outputTokens ?? null
      },
    },
    maxParseRetries: 1,
    includeParseFailureFeedback: true,
  }) as LearningExtraction
  return { extraction, durationMs: Date.now() - started, usage: { inputTokens, outputTokens } }
}

async function processCase(
  llmService: {
    callLLMWithStructuredOutput: (input: Record<string, unknown>) => Promise<unknown>
  },
  row: BenchmarkCaseRow,
  runId: string,
  mode: BenchmarkRunMode,
): Promise<boolean> {
  if (row.status === 'completed') return true
  await metaDbQuery(
    'UPDATE learning_extraction_benchmark_cases SET status=\'running\', error=NULL WHERE run_id=$1 AND case_id=$2',
    [runId, row.case_id],
  )
  try {
    const modelConfigs = mode === 'prototype-extraction' ? MODEL_CONFIGS.slice(0, 1) : MODEL_CONFIGS
    const extracted = await Promise.all(modelConfigs.map(async ({ model, effort }) => {
      const completed = await loadCompletedModelResult({ runId, caseId: row.case_id, model, effort })
      if (completed) return { model, effort, extraction: completed }
      const started = Date.now()
      try {
        const result = await runExtraction(llmService, row, model, effort)
        await saveModelResult({ runId, caseId: row.case_id, model, effort, status: 'completed', ...result })
        return { model, effort, extraction: result.extraction }
      } catch (error) {
        await saveModelResult({
          runId,
          caseId: row.case_id,
          model,
          effort,
          status: 'failed',
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    }))
    if (mode === 'prototype-extraction') {
      await completePrototypeExtractionCase(runId, row.case_id)
      return true
    }
    const reverse = row.ordinal % 2 === 1
    const first = extracted[reverse ? 1 : 0]
    const second = extracted[reverse ? 0 : 1]
    if (!first || !second) throw new Error('Both extractor outputs are required for paired judging')
    const labels = {
      A: { model: first.model, effort: first.effort },
      B: { model: second.model, effort: second.effort },
    }
    const judgeStarted = Date.now()
    try {
      const verdict = await llmService.callLLMWithStructuredOutput({
        label: 'Learning benchmark paired judge',
        prompt: judgePrompt(row.input_snapshot, first.extraction, second.extraction),
        parseFn: parseJudge,
        callOptions: {
          backend: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high',
          timeout: 240,
        },
        maxParseRetries: 1,
      })
      await saveJudgeResult({
        runId,
        caseId: row.case_id,
        labels,
        verdict: verdict as ReturnType<typeof parseJudge>,
        durationMs: Date.now() - judgeStarted,
      })
      return true
    } catch (error) {
      await saveJudgeResult({
        runId,
        caseId: row.case_id,
        labels,
        durationMs: Date.now() - judgeStarted,
        error: error instanceof Error ? error.message : String(error),
      })
      return false
    }
  } catch (error) {
    await metaDbQuery(
      'UPDATE learning_extraction_benchmark_cases SET status=\'failed\', error=$3 WHERE run_id=$1 AND case_id=$2',
      [runId, row.case_id, error instanceof Error ? error.message : String(error)],
    )
    return false
  }
}

const processCaseWithBoundedRetries = async (
  llmService: Parameters<typeof processCase>[0],
  row: BenchmarkCaseRow,
  runId: string,
  mode: BenchmarkRunMode,
): Promise<boolean> => {
  // runExtraction already performs one validator-informed repair. Repeating
  // the entire pair three times obscured the first-attempt failure rate and
  // could spend six model calls on one malformed extraction.
  return processCase(llmService, row, runId, mode)
}

export const runLearningExtractionBenchmarkBatchStep = defineSessionlessFunction({
  title: 'Run learning extraction benchmark batch',
  description: 'Run a resumable Mini extraction batch, optionally adding Luna and a blinded paired judge for comparison mode.',
  input: RunLearningClassifierV6AttemptInput,
  output: RunLearningExtractionBenchmarkBatchStepOutput,
  func: async ({ llmService }, input) => {
    const run = await metaDbQuery<{ config: { benchmarkVersion?: number } }>('SELECT config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [input.runId])
    if (run.rows[0]?.config.benchmarkVersion === 6) return runClassifierV6Attempt(llmService, input.runId, input.attempt)
    const rows = await loadBenchmarkCases(input.runId, input.offset, input.limit)
    const outcomes: boolean[] = []
    for (let index = 0; index < rows.length; index += 3) {
      const group = rows.slice(index, index + 3)
      outcomes.push(...await Promise.all(group.map((row) => processCaseWithBoundedRetries(llmService, row, input.runId, input.mode))))
    }
    return {
      attempted: rows.length,
      completed: outcomes.filter(Boolean).length,
      failed: outcomes.filter((value) => !value).length,
    }
  },
})

export const finalizeLearningExtractionBenchmarkStep = defineSessionlessFunction({
  title: 'Finalize learning extraction benchmark',
  description: 'Aggregate model component pass rates and latency percentiles for the Learning benchmark UI.',
  input: FinalizeLearningExtractionBenchmarkStepInput,
  output: FinalizeLearningExtractionBenchmarkStepOutput,
  func: async (_services, input) => {
    const run = await metaDbQuery<{ config: { benchmarkVersion?: number } }>('SELECT config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [input.runId])
    return run.rows[0]?.config.benchmarkVersion === 6 ? finalizeClassifierV6(input.runId) : finalizeBenchmarkRun(input.runId)
  },
})

export const finalizeLearningExtractionBenchmarkManifestStep = defineSessionlessFunction({
  title: 'Finalize prepared learning benchmark manifest',
  description: 'Mark a frozen benchmark manifest ready without making any model call.',
  input: FinalizeLearningExtractionBenchmarkStepInput,
  output: FinalizeLearningExtractionBenchmarkStepOutput,
  func: async (_services, input) => finalizePreparedBenchmarkManifest(input.runId),
})
