import { defineSessionlessFunction } from '../../../runtime/define.js'
import { repoRoot } from '@learner/core/lib/repo-root.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { metaDbQuery, metaDbWithClient } from '@learner/core/lib/db-metadata/_shared.js'
import { runClassifierV6Attempt } from '@learner/core/lib/learning/learning-classifier-v6-run.js'
import { validateClassifierV6Output, type ClassifierV6Output } from '@learner/core/lib/learning/learning-classifier-v6.js'
import { loadBenchmarkCases } from '@learner/core/lib/learning/learning-extraction-benchmark.js'
import { SEED_V1_CONTEXT_STRATEGY, SEED_V1_EXPERIMENT_LABEL } from '@learner/core/lib/learning/learning-three-turn-context.js'
import { hindsightPython } from '@learner/core/lib/learning/hindsight-database.js'

const Input = z.object({ runId: z.string().uuid() })
const Output = z.record(z.string(), z.unknown())
export const PreflightLearningSeedV1StepInput = Input
export const PreflightLearningSeedV1StepOutput = Output
export const RunLearningSeedV1BizToolsArmStepInput = Input
export const RunLearningSeedV1BizToolsArmStepOutput = Output
export const RunLearningSeedV1HindsightArmStepInput = Input
export const RunLearningSeedV1HindsightArmStepOutput = Output
export const FinalizeLearningSeedV1StepInput = Input
export const FinalizeLearningSeedV1StepOutput = Output
export const FinalizeLearningSeedV1HindsightRerunStepInput = Input
export const FinalizeLearningSeedV1HindsightRerunStepOutput = Output
const execFileAsync = promisify(execFile)
const HINDSIGHT_MODEL = 'hindsight:gpt-5.6-luna'

async function assertPrepared(runId: string): Promise<void> {
  const result = await metaDbQuery<{ status: string; count: string; config: { contextStrategy?: string; experimentLabel?: string; hindsightOnly?: boolean; dataset?: { pairCount?: number; messageCount?: number; immutable?: boolean }; tokenPreflight?: { batches?: number; totalWithReserveTokens?: number; effectiveRuntimeContextTokens?: number; noSilentTruncation?: boolean } } }>(
    `SELECT r.status,r.config,count(c.*)::text count FROM learning_extraction_benchmark_runs r
     LEFT JOIN learning_extraction_benchmark_cases c ON c.run_id=r.run_id WHERE r.run_id=$1 GROUP BY r.run_id`, [runId],
  )
  const row = result.rows[0]
  if (!row || !['queued', 'running', 'completed', 'partial'].includes(row.status) || Number(row.count) !== 100
    || row.config.contextStrategy !== SEED_V1_CONTEXT_STRATEGY || (!row.config.hindsightOnly && row.config.experimentLabel !== SEED_V1_EXPERIMENT_LABEL)
    || row.config.dataset?.pairCount !== 100 || row.config.dataset?.messageCount !== 200 || row.config.dataset?.immutable !== true
    || row.config.tokenPreflight?.batches !== 1 || row.config.tokenPreflight.noSilentTruncation !== true
    || !row.config.tokenPreflight.totalWithReserveTokens || !row.config.tokenPreflight.effectiveRuntimeContextTokens
    || row.config.tokenPreflight.totalWithReserveTokens > row.config.tokenPreflight.effectiveRuntimeContextTokens) {
    throw new Error('Seed V1 run is not a frozen 100-pair/200-message immutable dataset')
  }
}

export const preflightLearningSeedV1Step = defineSessionlessFunction({
  title: 'Preflight frozen Learning seed V1 dataset',
  description: 'Verify immutable membership, exact pair/message counts, and the zero-call execution boundary.',
  input: PreflightLearningSeedV1StepInput, output: PreflightLearningSeedV1StepOutput,
  func: async (_services, input) => { await assertPrepared(input.runId); return { ok: true, paidCalls: 0 } },
})

export const runLearningSeedV1BizToolsArmStep = defineSessionlessFunction({
  title: 'Run Learning seed V1 BizTools arm',
  description: 'Execute one consolidated Luna-high native-schema classifier call over all 100 frozen pairs.',
  input: RunLearningSeedV1BizToolsArmStepInput, output: RunLearningSeedV1BizToolsArmStepOutput,
  func: async ({ llmService }, input) => {
    await assertPrepared(input.runId)
    await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='running' WHERE run_id=$1 AND status='queued'`, [input.runId])
    return runClassifierV6Attempt(llmService, input.runId, 1)
  },
})

type HindsightOutput = {
  terminalState?: string
  error?: string | null
  attempt?: { number?: number; limit?: number; nativeModelCallsObserved?: number; nativeSuccessfulModelCallsObserved?: number; retainHttpAttempts?: number }
  adapted?: { results?: Array<{ caseId: string; classification: ClassifierV6Output }>; unmappableFacts?: unknown[] }
  timing?: Record<string, unknown> & { modelAndValidationMs?: number }
  chunking?: Record<string, unknown>
  native?: { usage?: Record<string, number | null> }
  effective?: Record<string, unknown>
  preflight?: Record<string, unknown>
}

const readHindsightOutput = async (path: string): Promise<HindsightOutput | null> => {
  try { return JSON.parse(await readFile(path, 'utf8')) as HindsightOutput } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export const runLearningSeedV1HindsightArmStep = defineSessionlessFunction({
  title: 'Run Learning seed V1 native custom-Hindsight arm',
  description: 'Execute one isolated native Hindsight custom extraction and deterministically adapt its facts into the shared per-case view.',
  input: RunLearningSeedV1HindsightArmStepInput, output: RunLearningSeedV1HindsightArmStepOutput,
  func: async (_services, input) => {
    await assertPrepared(input.runId)
    const run = (await metaDbQuery<{ config: { privateManifestPath?: string; hindsightOutputPath?: string; hindsightAudit?: Array<{ state?: string }> } }>('SELECT config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [input.runId])).rows[0]
    const manifestPath = run?.config.privateManifestPath
    if (!manifestPath) throw new Error('Seed V1 private manifest path is not frozen')
    const outputPath = run.config.hindsightOutputPath ?? manifestPath.replace(/manifest-PRIVATE[.]json$/, 'hindsight-raw-PRIVATE.json')
    let result = await readHindsightOutput(outputPath)
    const prior = run.config.hindsightAudit ?? []
    if (result && prior.some(({ state }) => state === 'completed' || state === 'failed')) {
      const stored = await metaDbQuery<{ status: string; count: string }>(
        `SELECT status,count(*)::text count FROM learning_extraction_benchmark_results
         WHERE run_id=$1 AND model=$2 AND effort='high' GROUP BY status`, [input.runId, HINDSIGHT_MODEL],
      )
      const completed = Number(stored.rows.find(({ status }) => status === 'completed')?.count ?? 0)
      const failed = Number(stored.rows.find(({ status }) => status === 'failed')?.count ?? 0)
      return { completed, failed, replayed: true, nativeModelCallsObserved: 0 }
    }
    if (!result && prior.some(({ state }) => state === 'started')) {
      result = { terminalState: 'failed', error: 'Hindsight attempt was durably reserved but no terminal private output exists; refusing a hidden second model call', attempt: { number: 1, limit: 1, nativeModelCallsObserved: 0 } }
    }
    if (!result) {
      await metaDbQuery(
        `UPDATE learning_extraction_benchmark_runs SET config=jsonb_set(config,'{hindsightAudit}',COALESCE(config->'hindsightAudit','[]'::jsonb) || $2::jsonb) WHERE run_id=$1`,
        [input.runId, JSON.stringify([{ state: 'started', attempt: 1, outputPath }])],
      )
      try {
        await execFileAsync(hindsightPython(), [
          'scripts/hindsight/learning-seed-v1-hindsight.py', '--manifest', manifestPath, '--output', outputPath,
          '--base-url', 'http://127.0.0.1:18924',
        ], { cwd: repoRoot, timeout: 900_000, maxBuffer: 64 * 1024 })
      } catch { /* The private terminal artifact is authoritative, including classified failures. */ }
      result = await readHindsightOutput(outputPath) ?? { terminalState: 'failed', error: 'Hindsight runner returned without a private terminal artifact' }
    }
    const rows = await loadBenchmarkCases(input.runId, 0, 500)
    const adapted = new Map((result.adapted?.results ?? []).map((item) => [item.caseId, item.classification]))
    const nativeModelCallsObserved = result.attempt?.nativeSuccessfulModelCallsObserved ?? result.attempt?.nativeModelCallsObserved
    let validationError: string | null = null
    if (result.terminalState === 'success' && (result.attempt?.number !== 1 || result.attempt.limit !== 1 || nativeModelCallsObserved !== 1
      || (result.attempt.retainHttpAttempts != null && result.attempt.retainHttpAttempts !== 1) || adapted.size !== 100)) {
      validationError = 'Hindsight output violated one-call/one-attempt/100-result contract'
    }
    if (!validationError && result.terminalState === 'success') {
      try {
        for (const row of rows) validateClassifierV6Output(adapted.get(row.case_id), row.input_snapshot)
      } catch (error) { validationError = error instanceof Error ? error.message : String(error) }
    }
    const success = result.terminalState === 'success' && !validationError
    const error = validationError ?? result.error ?? (success ? null : `Hindsight terminal state ${result.terminalState ?? 'missing'}`)
    const durationMs = Math.round(Number(result.timing?.modelAndValidationMs ?? 0))
    const usage = result.native?.usage ?? {}
    const inputTokens = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || null
    const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || null
    await metaDbWithClient(async (client) => {
      await client.query('BEGIN')
      try {
        for (const row of rows) await client.query(
          `INSERT INTO learning_extraction_benchmark_results (run_id,case_id,model,effort,status,extraction,duration_ms,input_tokens,output_tokens,error)
           VALUES ($1,$2,$3,'high',$4,$5::jsonb,$6,$7,$8,$9)
           ON CONFLICT (run_id,case_id,model,effort) DO NOTHING`,
          [input.runId, row.case_id, HINDSIGHT_MODEL, success ? 'completed' : 'failed', success ? JSON.stringify(adapted.get(row.case_id)) : null, durationMs, inputTokens, outputTokens, error],
        )
        const outputBytes = await readFile(outputPath).catch(() => null)
        const audit = { state: success ? 'completed' : 'failed', attempt: 1, outputPath,
          outputSha256: outputBytes ? createHash('sha256').update(outputBytes).digest('hex') : null,
          error, inputTokens, outputTokens, durationMs, nativeModelCallsObserved: nativeModelCallsObserved ?? null,
          chunking: result.chunking ?? null, effective: result.effective ?? null, preflight: result.preflight ?? null,
          unmappableFacts: result.adapted?.unmappableFacts?.length ?? null }
        await client.query(`UPDATE learning_extraction_benchmark_runs SET config=jsonb_set(config,'{hindsightAudit}',COALESCE(config->'hindsightAudit','[]'::jsonb) || $2::jsonb) WHERE run_id=$1`, [input.runId, JSON.stringify([audit])])
        await client.query('COMMIT')
      } catch (failure) { await client.query('ROLLBACK'); throw failure }
    })
    return { completed: success ? 100 : 0, failed: success ? 0 : 100, error, nativeModelCallsObserved: nativeModelCallsObserved ?? null }
  },
})

export const finalizeLearningSeedV1Step = defineSessionlessFunction({
  title: 'Finalize Learning seed V1 extractor A/B',
  description: 'Persist terminal arm totals and the no-mastery-mutation boundary for the existing benchmark frontend.',
  input: FinalizeLearningSeedV1StepInput, output: FinalizeLearningSeedV1StepOutput,
  func: async (_services, input) => {
    const rows = await metaDbQuery<{ model: string; status: string; duration_ms: number; input_tokens: number | null; output_tokens: number | null }>(
      `SELECT model,status,duration_ms,input_tokens,output_tokens FROM learning_extraction_benchmark_results WHERE run_id=$1`, [input.runId],
    )
    const aggregate = (prefix: string) => {
      const values = rows.rows.filter(({ model }) => model.startsWith(prefix))
      return { results: values.length, completed: values.filter(({ status }) => status === 'completed').length,
        failed: values.filter(({ status }) => status === 'failed').length,
        durationMs: Math.max(0, ...values.map(({ duration_ms }) => duration_ms)),
        inputTokens: values[0]?.input_tokens ?? null, outputTokens: values[0]?.output_tokens ?? null }
    }
    const summary = { reportDate: new Date().toISOString().slice(0, 10), dataset: 'seed V1', pairCount: 100, messageCount: 200,
      arms: { biztools: aggregate('gpt-5.6-luna'), hindsight: aggregate('hindsight:gpt-5.6-luna') }, masteryPromotions: 0,
      semanticReview: 'pending', rawTranscriptPublication: 'private-only' }
    const terminal = summary.arms.biztools.completed === 100 && summary.arms.hindsight.completed === 100 ? 'completed' : 'partial'
    await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status=$2,summary=$3::jsonb,completed_at=now() WHERE run_id=$1`, [input.runId, terminal, JSON.stringify(summary)])
    return summary
  },
})

export const finalizeLearningSeedV1HindsightRerunStep = defineSessionlessFunction({
  title: 'Finalize Learning seed V1 Hindsight-only rerun',
  description: 'Persist the isolated Hindsight-only terminal result without executing or relabeling BizTools.',
  input: FinalizeLearningSeedV1HindsightRerunStepInput, output: FinalizeLearningSeedV1HindsightRerunStepOutput,
  func: async (_services, input) => {
    const values = (await metaDbQuery<{ status: string; duration_ms: number; input_tokens: number | null; output_tokens: number | null }>(
      `SELECT status,duration_ms,input_tokens,output_tokens FROM learning_extraction_benchmark_results
       WHERE run_id=$1 AND model=$2 AND effort='high'`, [input.runId, HINDSIGHT_MODEL],
    )).rows
    const hindsight = { results: values.length, completed: values.filter(({ status }) => status === 'completed').length,
      failed: values.filter(({ status }) => status === 'failed').length, durationMs: Math.max(0, ...values.map(({ duration_ms }) => duration_ms)),
      inputTokens: values[0]?.input_tokens ?? null, outputTokens: values[0]?.output_tokens ?? null }
    const summary = { reportDate: new Date().toISOString().slice(0, 10), dataset: 'seed V1', pairCount: 100, messageCount: 200,
      rerun: 'hindsight-only-420s', arms: { hindsight }, masteryPromotions: 0, semanticReview: 'single-arm-structural-only', rawTranscriptPublication: 'private-only' }
    const terminal = hindsight.completed === 100 ? 'completed' : 'partial'
    await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status=$2,summary=$3::jsonb,completed_at=now() WHERE run_id=$1`, [input.runId, terminal, JSON.stringify(summary)])
    return summary
  },
})
