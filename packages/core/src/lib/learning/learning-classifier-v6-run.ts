import { createHash } from 'node:crypto'
import { metaDbQuery, metaDbWithClient } from '../db-metadata/_shared.js'
import { loadBenchmarkCases } from './learning-extraction-benchmark.js'
import { CLASSIFIER_V6_CATALOG_HASH, batchClassifierV6CasesForConfig, classifierV6OutputSchema, classifierV6PromptForConfig, parseClassifierV6Batch, parseClassifierV6BatchIndependently, type ClassifierV6Output } from './learning-classifier-v6.js'
import {
  THREE_TURN_CONTEXT_STRATEGY,
  THREE_TURN_ACTIVE_CONTEXT_TOKENS,
  THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
  THREE_TURN_EXPERIMENT_LABEL,
  THREE_TURN_MAX_BATCH_TOKENS,
  THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
  ONE_PAIR_CONTEXT_STRATEGY,
  ONE_PAIR_EXPERIMENT_LABEL,
  SEED_V1_CONTEXT_STRATEGY,
  SEED_V1_EFFECTIVE_CONTEXT_TOKENS,
  SEED_V1_EXPERIMENT_LABEL,
} from './learning-three-turn-context.js'
import { assertSelectableCombination, llmBackendSchema, cliEffortSchema } from '@learner/llm/lib/llm/model-catalog.js'

type Attempt = { number: number; batchId: string; state: 'started' | 'completed' | 'rejected'; error?: string }
type Audit = { judged: false; classifierVersion: 6; attempts: Attempt[] }
type Llm = { callLLMWithStructuredOutput: (input: Record<string, unknown>) => Promise<unknown> }
type RunConfig = {
  benchmarkVersion: number
  catalogHash: string
  classifierPromptRevision?: number
  model: string
  backend: string
  effort: string
  maxBatchTokens: number
  maxAttempts?: number
  experimentLabel?: string
  contextStrategy?: string
  activeContextTokens?: number
  nativeSchemaReserveTokens?: number
  effectiveBatchByteCeiling?: number
  replayRunId?: string | null
  attemptAudit?: Array<{ durationMs?: number; inputTokens?: number | null; outputTokens?: number | null }>
  attemptHardDeadlineMs?: number
}
export const CLASSIFIER_V6_RUNTIME = { outputFormat: 'native-json-schema', attemptLimitVersion: 1 } as const

export async function runClassifierV6Attempt(llm: Llm, runId: string, attempt: number) {
  const run = (await metaDbQuery<{ status: string; config: RunConfig }>('SELECT status,config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [runId])).rows[0]
  if (!run || run.status === 'cancelled' || run.config.benchmarkVersion !== 6) throw new Error('No active v6 experiment run')
  if (run.config.catalogHash !== CLASSIFIER_V6_CATALOG_HASH) throw new Error('Frozen concept catalog changed; refusing to reinterpret short concept IDs')
  const isThreeTurn = run.config.contextStrategy === THREE_TURN_CONTEXT_STRATEGY
  const isOnePair = run.config.contextStrategy === ONE_PAIR_CONTEXT_STRATEGY
  const isSeedV1 = run.config.contextStrategy === SEED_V1_CONTEXT_STRATEGY
  const isContextExperiment = isThreeTurn || isOnePair || isSeedV1
  if (isSeedV1) {
    assertSelectableCombination(llmBackendSchema.parse(run.config.backend), run.config.model, cliEffortSchema.parse(run.config.effort))
  }
  if (isContextExperiment && (run.config.experimentLabel !== (isThreeTurn ? THREE_TURN_EXPERIMENT_LABEL : isOnePair ? ONE_PAIR_EXPERIMENT_LABEL : SEED_V1_EXPERIMENT_LABEL)
    || run.config.classifierPromptRevision !== (isSeedV1 ? 7 : 5)
    || (!isSeedV1 && run.config.model !== 'gpt-5.6-luna')
    || (!isSeedV1 && !['medium', 'high', 'xhigh'].includes(run.config.effort))
    || run.config.maxBatchTokens !== THREE_TURN_MAX_BATCH_TOKENS
    || run.config.maxAttempts !== 1
    || run.config.activeContextTokens !== (isSeedV1 ? run.config.maxBatchTokens : THREE_TURN_ACTIVE_CONTEXT_TOKENS)
    || run.config.nativeSchemaReserveTokens !== THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS
    || (isSeedV1 && run.config.effectiveBatchByteCeiling !== run.config.maxBatchTokens)
    || (!isSeedV1 && run.config.effectiveBatchByteCeiling !== THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING))) {
    throw new Error('Frozen matched-context experiment config is invalid')
  }
  const rows = await loadBenchmarkCases(runId, 0, 500)
  const maxAttempts = run.config.maxAttempts ?? 4
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 4) throw new Error('Invalid frozen attempt budget')
  if (attempt > maxAttempts) return { attempted: 0, completed: rows.filter(row => row.status === 'completed').length, failed: rows.filter(row => row.status === 'failed').length }
  const pending = rows.filter((row) => row.status !== 'completed' && row.status !== 'failed')
  const audits = new Map(rows.map((row) => [row.case_id, (row.judge_output ?? { judged: false, classifierVersion: 6, attempts: [] }) as Audit]))
  const eligible = pending.filter((row) => !(audits.get(row.case_id)?.attempts.some((item) => item.number >= attempt)))
  const batches = batchClassifierV6CasesForConfig(
    eligible.map((row) => ({ caseId: row.case_id, snapshot: row.input_snapshot })),
    isContextExperiment ? run.config : { effectiveBatchByteCeiling: run.config.maxBatchTokens },
  )
  for (const batch of batches) {
    const batchId = createHash('sha256').update(JSON.stringify([runId, attempt, batch.map((item) => item.caseId)])).digest('hex').slice(0, 20)
    // Reserve this numbered attempt before a paid call. A crashed attempt uses
    // its slot; replay cannot silently reset the four-attempt budget.
    const reserved = await metaDbWithClient(async (client) => {
      await client.query('BEGIN')
      try {
        for (const item of batch) {
          const claimed = await client.query(
            `UPDATE learning_extraction_benchmark_cases SET status='running',
             judge_output=jsonb_set(COALESCE(judge_output, '{"judged":false,"classifierVersion":6,"attempts":[]}'::jsonb),
               '{attempts}', COALESCE(judge_output->'attempts','[]'::jsonb) || $3::jsonb)
             WHERE run_id=$1 AND case_id=$2 AND status IN ('pending','running')
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(judge_output->'attempts','[]'::jsonb)) a WHERE (a->>'number')::int >= $4)`,
            [runId, item.caseId, JSON.stringify([{ number: attempt, batchId, state: 'started' }]), attempt],
          )
          if (!claimed.rowCount) { await client.query('ROLLBACK'); return false }
        }
        await client.query('COMMIT')
        return true
      } catch (error) { await client.query('ROLLBACK'); throw error }
    })
    if (!reserved) continue
    const previous = (await metaDbQuery<{ raw: string; error: string }>(
      `SELECT a->>'raw' AS raw,a->>'error' AS error FROM learning_extraction_benchmark_runs,
       jsonb_array_elements(COALESCE(config->'attemptAudit','[]'::jsonb)) a
       WHERE run_id=$1 AND a->>'state'='rejected' AND a->'caseIds' @> $2::jsonb ORDER BY (a->>'attempt')::int DESC LIMIT 1`, [runId, JSON.stringify([batch[0]!.caseId])],
    )).rows[0]
    const prompt = classifierV6PromptForConfig(batch, run.config, previous ? { raw: previous.raw.slice(0, 12_000), error: previous.error.slice(0, 4_000) } : undefined)
    const outputSchema = classifierV6OutputSchema(batch)
    const effectiveCeiling = isContextExperiment ? run.config.effectiveBatchByteCeiling! : run.config.maxBatchTokens
    const reserve = isContextExperiment ? run.config.nativeSchemaReserveTokens! : 20_000
    if (Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength(JSON.stringify(outputSchema), 'utf8') + reserve > effectiveCeiling) throw new Error('Prompt and native schema exceed frozen conservative byte ceiling')
    const started = Date.now()
    let raw = ''
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let results: Array<{ caseId: string; classification: ClassifierV6Output }> | null = null
    let error: string | null = null
    const rowErrors = new Map<string, string>()
    try {
      results = await llm.callLLMWithStructuredOutput({
        label: `Learning v6 batch ${runId} ${batchId} attempt ${attempt}/${maxAttempts}`,
        prompt,
        outputSchema,
        parseFn: (response: unknown) => {
          raw = typeof response === 'string' ? response : JSON.stringify(response)
          return parseClassifierV6Batch(response, batch)
        },
        callOptions: { backend: run.config.backend, model: run.config.model, effort: run.config.effort,
          timeout: (run.config.attemptHardDeadlineMs ?? 600_000) / 1_000, killMs: run.config.attemptHardDeadlineMs ?? 600_000,
          onUsage: (usage: { inputTokens?: number; outputTokens?: number }) => { inputTokens = usage.inputTokens ?? null; outputTokens = usage.outputTokens ?? null } },
        // Each correction is a separate durable Pikku step, not an inner retry.
        maxParseRetries: 0,
      }) as Array<{ caseId: string; classification: ClassifierV6Output }>
    } catch (failure) {
      error = failure instanceof Error ? failure.message : failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure)
      // A native one-batch response can contain useful, valid siblings beside
      // a row with a non-exact quote. Preserve the single-call outcome and
      // quarantine only failing rows; never spend a hidden retry to recover it.
      if (raw) {
        try {
          const independent = parseClassifierV6BatchIndependently(raw, batch)
          results = independent.accepted
          for (const item of independent.quarantined) if (item.caseId) rowErrors.set(item.caseId, item.error)
        } catch { /* the batch envelope itself is unusable; retain the original failure for every row */ }
      }
    }
    const durationMs = Date.now() - started
    const state = results && !error ? 'completed' : 'rejected'
    const resultMap = new Map<string, ClassifierV6Output>((results ?? []).map((item) => [item.caseId, item.classification]))
    await metaDbWithClient(async (client) => {
      await client.query('BEGIN')
      try {
        const currentRun = await client.query<{ status: string }>('SELECT status FROM learning_extraction_benchmark_runs WHERE run_id=$1 FOR UPDATE', [runId])
        if (!currentRun.rows[0] || currentRun.rows[0].status === 'cancelled') throw new Error('Run cancelled before persistence')
        await client.query(
          `UPDATE learning_extraction_benchmark_runs SET config=jsonb_set(config,'{attemptAudit}',COALESCE(config->'attemptAudit','[]'::jsonb) || $2::jsonb) WHERE run_id=$1`,
          [runId, JSON.stringify([{ attempt, batchId, caseIds: batch.map((item) => item.caseId), state, raw, error, inputTokens, outputTokens, durationMs,
            prompt, promptHash: createHash('sha256').update(prompt).digest('hex'), promptHashAlgorithm: 'sha256', promptBytes: Buffer.byteLength(prompt, 'utf8'),
            promptReconstruction: { classifierPromptRevision: run.config.classifierPromptRevision ?? 4, contextStrategy: run.config.contextStrategy ?? 'preceding-conversation-v1', catalogHash: run.config.catalogHash, caseIds: batch.map((item) => item.caseId) },
            outputSchema, outputSchemaHash: createHash('sha256').update(JSON.stringify(outputSchema)).digest('hex'), outputFormat: 'native-json-schema' }])],
        )
        for (const item of batch) {
          const classification = resultMap.get(item.caseId)
          const itemState = classification ? 'completed' : 'rejected'
          const itemError = classification ? null : rowErrors.get(item.caseId) ?? error
          const audit: Audit = { judged: false, classifierVersion: 6, attempts: [...(audits.get(item.caseId)?.attempts ?? []), { number: attempt, batchId, state: itemState, ...(itemError ? { error: itemError } : {}) }] }
          const status = classification ? 'completed' : attempt === maxAttempts ? 'failed' : 'pending'
          await client.query('UPDATE learning_extraction_benchmark_cases SET status=$3, judge_output=$4::jsonb,error=$5 WHERE run_id=$1 AND case_id=$2', [runId, item.caseId, status, JSON.stringify(audit), itemError])
          if (status !== 'pending') await client.query(
            `INSERT INTO learning_extraction_benchmark_results (run_id,case_id,model,effort,status,extraction,duration_ms,input_tokens,output_tokens,error)
             VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) ON CONFLICT (run_id,case_id,model,effort) DO NOTHING`,
            [runId, item.caseId, run.config.model, run.config.effort, status, classification ? JSON.stringify(classification) : null, durationMs, inputTokens, outputTokens, itemError],
          )
        }
        await client.query('COMMIT')
      } catch (failure) { await client.query('ROLLBACK'); throw failure }
    })
  }
  const after = await loadBenchmarkCases(runId, 0, 500)
  return { attempted: eligible.length, completed: after.filter((row) => row.status === 'completed').length, failed: after.filter((row) => row.status === 'failed').length }
}

export async function finalizeClassifierV6(runId: string) {
  // Exhausted/interrupted attempts terminate explicitly, including crashes on
  // attempt four; no record can remain indefinitely pending or running.
  await metaDbQuery(`UPDATE learning_extraction_benchmark_cases SET status='failed',error=COALESCE(error,'Attempt budget exhausted or interrupted') WHERE run_id=$1 AND status IN ('pending','running')`, [runId])
  const cases = await loadBenchmarkCases(runId, 0, 500)
  const completed = cases.filter((row) => row.status === 'completed').length
  const failed = cases.filter((row) => row.status === 'failed').length
  const run = (await metaDbQuery<{ config: RunConfig }>('SELECT config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [runId])).rows[0]
  let comparison: Record<string, unknown> = {}
  if (run?.config.replayRunId) {
    type ResultRow = { run_id: string; case_id: string; input_hash: string; status: string; extraction: { matches?: Array<{ conceptId?: string }> } | null; duration_ms: number; input_tokens: number | null; output_tokens: number | null }
    const sourceRunId = run.config.replayRunId
    const sourceRun = (await metaDbQuery<{ config: RunConfig; summary: { arms?: { hindsight?: { durationMs?: number; inputTokens?: number | null; outputTokens?: number | null } } } | null }>('SELECT config,summary FROM learning_extraction_benchmark_runs WHERE run_id=$1', [sourceRunId])).rows[0]
    const rows = (await metaDbQuery<ResultRow>(
      `SELECT r.run_id,r.case_id,c.input_hash,r.status,r.extraction,r.duration_ms,r.input_tokens,r.output_tokens
       FROM learning_extraction_benchmark_results r JOIN learning_extraction_benchmark_cases c USING (run_id,case_id)
       WHERE r.run_id IN ($1,$2) ORDER BY r.run_id,r.case_id`, [runId, sourceRunId],
    )).rows
    const stats = (selected: ResultRow[], attempts: RunConfig['attemptAudit']) => {
      const complete = selected.filter((row) => row.status === 'completed')
      const concepts = complete.flatMap((row) => row.extraction?.matches ?? []).flatMap((match) => match.conceptId ? [match.conceptId] : [])
      return { results: selected.length, completed: complete.length, failed: selected.filter((row) => row.status === 'failed').length,
        calls: attempts?.length ?? (selected.length ? 1 : 0), durationMs: attempts?.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) ?? Math.max(0, ...selected.map((row) => row.duration_ms)),
        inputTokens: attempts?.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0) ?? selected[0]?.input_tokens ?? null,
        outputTokens: attempts?.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0) ?? selected[0]?.output_tokens ?? null,
        matches: concepts.length, uniqueConcepts: new Set(concepts).size, casesWithMatches: complete.filter((row) => (row.extraction?.matches?.length ?? 0) > 0).length }
    }
    const currentRows = rows.filter((row) => row.run_id === runId)
    const sourceRows = rows.filter((row) => row.run_id === sourceRunId)
    const sourceByInput = new Map(sourceRows.map((row) => [row.input_hash, row]))
    let exactCaseConceptSets = 0
    let intersection = 0
    let union = 0
    for (const row of currentRows) {
      const current = new Set((row.extraction?.matches ?? []).flatMap((match) => match.conceptId ? [match.conceptId] : []))
      const source = new Set((sourceByInput.get(row.input_hash)?.extraction?.matches ?? []).flatMap((match) => match.conceptId ? [match.conceptId] : []))
      const shared = [...current].filter((conceptId) => source.has(conceptId)).length
      intersection += shared
      union += new Set([...current, ...source]).size
      if (shared === current.size && shared === source.size) exactCaseConceptSets += 1
    }
    const hindsight = sourceRun?.summary?.arms?.hindsight
    const sourceAttempts = sourceRun?.config.attemptAudit?.length ? sourceRun.config.attemptAudit : hindsight ? [hindsight] : undefined
    comparison = { reportDate: new Date().toISOString().slice(0, 10), dataset: 'frozen', sourceRunId,
      arm: stats(currentRows, run.config.attemptAudit), source: stats(sourceRows, sourceAttempts),
      comparison: { exactCaseConceptSets, totalCases: currentRows.length, conceptJaccard: union ? intersection / union : 1 } }
  }
  const summary = { classifierVersion: 6, total: cases.length, completed, failed, ...comparison, semanticReview: 'pending', masteryPromotions: 0 }
  const runOutputTokens = typeof (comparison.arm as { outputTokens?: unknown } | undefined)?.outputTokens === 'number'
    ? (comparison.arm as { outputTokens: number }).outputTokens : null
  await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status=$2,summary=$3::jsonb,output_tokens=$4,completed_at=now() WHERE run_id=$1 AND status <> 'cancelled'`,
    [runId, summary.failed ? 'partial' : 'completed', JSON.stringify(summary), runOutputTokens])
  return summary
}
