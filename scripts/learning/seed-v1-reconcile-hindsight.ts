import { createHash } from 'node:crypto'
import { openLearnerDatabase, usage as printUsage } from './_db.js'
import { readFile } from 'node:fs/promises'

import { metaDbQuery, metaDbWithClient } from '@learner/core/lib/db-metadata/_shared.js'
import { loadBenchmarkCases } from '@learner/core/lib/learning/learning-extraction-benchmark.js'
import { validateClassifierV6Output, type ClassifierV6Output } from '@learner/core/lib/learning/learning-classifier-v6.js'

const [runId, rawPath, adaptedPath] = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
printUsage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/seed-v1-reconcile-hindsight.ts RUN_ID RAW_PATH ADAPTED_PATH
WRITES the learner database: marks a Hindsight-only seed-v1 benchmark run's 100
rows completed from an adapted receipt, after checking the receipt against the
immutable native result (sha256, zero new model calls, 100 valid cases).`, !runId || !rawPath || !adaptedPath)
const handle = openLearnerDatabase({ readOnly: false })
const [rawBytes, adaptedBytes] = await Promise.all([readFile(rawPath!), readFile(adaptedPath!)])
const raw = JSON.parse(rawBytes.toString('utf8')) as { terminalState?: string; native?: { facts?: unknown[]; usage?: Record<string, number> }; timing?: { modelAndValidationMs?: number } }
const derived = JSON.parse(adaptedBytes.toString('utf8')) as {
  terminalState?: string; adapterRevision?: string; input?: { rawSha256?: string }; validation?: { newModelCalls?: number; nativeRawMutated?: boolean }
  counts?: { caseRows?: number; mappedMatches?: number; nativeFacts?: number; unmappableFacts?: number }
  adapted?: { results?: Array<{ caseId: string; classification: ClassifierV6Output }> }
}
const rawSha256 = createHash('sha256').update(rawBytes).digest('hex')
if (raw.terminalState !== 'success' || derived.terminalState !== 'adapted' || derived.input?.rawSha256 !== rawSha256
  || derived.validation?.newModelCalls !== 0 || derived.validation.nativeRawMutated !== false
  || derived.counts?.caseRows !== 100 || derived.counts.nativeFacts !== raw.native?.facts?.length || derived.counts.unmappableFacts !== 0) {
  throw new Error('Derived Hindsight adapter receipt does not match the immutable successful native result')
}
const cases = await loadBenchmarkCases(runId!, 0, 500)
const byId = new Map(cases.map(row => [row.case_id, row]))
const results = derived.adapted?.results ?? []
if (results.length !== 100 || new Set(results.map(item => item.caseId)).size !== 100) throw new Error('Derived receipt must contain exactly 100 unique cases')
for (const item of results) {
  const row = byId.get(item.caseId)
  if (!row) throw new Error(`Unknown derived case ${item.caseId}`)
  validateClassifierV6Output(item.classification, row.input_snapshot)
}
const foreign = await metaDbQuery<{ count: string }>(
  `SELECT count(*)::text count FROM learning_extraction_benchmark_results WHERE run_id=$1 AND model <> 'hindsight:gpt-5.6-luna'`, [runId],
)
if (Number(foreign.rows[0]?.count ?? 0) !== 0) throw new Error('Hindsight-only reconciliation refuses a run with non-Hindsight results')
const durationMs = Math.round(Number(raw.timing?.modelAndValidationMs ?? 0))
const usage = raw.native?.usage ?? {}
await metaDbWithClient(async client => {
  await client.query('BEGIN')
  try {
    for (const item of results) {
      await client.query(`UPDATE learning_extraction_benchmark_results SET status='completed',extraction=$3::jsonb,error=NULL,
        duration_ms=$4,input_tokens=$5,output_tokens=$6 WHERE run_id=$1 AND case_id=$2 AND model='hindsight:gpt-5.6-luna' AND effort='high'`,
      [runId, item.caseId, JSON.stringify(item.classification), durationMs, usage.input_tokens ?? null, usage.output_tokens ?? null])
      await client.query(`UPDATE learning_extraction_benchmark_cases SET status='completed',error=NULL WHERE run_id=$1 AND case_id=$2`, [runId, item.caseId])
    }
    const correction = { state: 'reconciled', adapterRevision: derived.adapterRevision, rawPath, rawSha256,
      adaptedPath, adaptedSha256: createHash('sha256').update(adaptedBytes).digest('hex'), newModelCalls: 0,
      nativeRawMutated: false, nativeFacts: derived.counts?.nativeFacts, mappedMatches: derived.counts?.mappedMatches,
      unmappableFacts: derived.counts?.unmappableFacts, validRows: 100 }
    const summary = { reportDate: new Date().toISOString().slice(0, 10), dataset: 'seed V1', pairCount: 100, messageCount: 200,
      rerun: 'hindsight-only-420s', arms: { hindsight: { results: 100, completed: 100, failed: 0, durationMs,
        inputTokens: usage.input_tokens ?? null, outputTokens: usage.output_tokens ?? null, nativeFacts: derived.counts?.nativeFacts,
        mappedMatches: derived.counts?.mappedMatches, unmappableFacts: 0 } }, masteryPromotions: 0,
      semanticReview: 'pending', rawTranscriptPublication: 'private-only', adapterCorrection: 'hindsight-native-list-v2', adapterCorrectionModelCalls: 0 }
    await client.query(`UPDATE learning_extraction_benchmark_runs SET status='completed',summary=$2::jsonb,completed_at=now(),
      config=jsonb_set(config,'{hindsightAudit}',COALESCE(config->'hindsightAudit','[]'::jsonb) || $3::jsonb) WHERE run_id=$1`,
      [runId, JSON.stringify(summary), JSON.stringify([correction])])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
})
console.log(JSON.stringify({ runId, status: 'completed', rows: 100, nativeFacts: derived.counts?.nativeFacts,
  mappedMatches: derived.counts?.mappedMatches, newModelCalls: 0, rawSha256 }))
await handle.close()
