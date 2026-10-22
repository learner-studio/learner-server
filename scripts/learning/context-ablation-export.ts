/**
 * Read-only matched export for the frozen three-pair vs one-pair Luna Medium
 * experiment. The private file contains transcript/model bytes and must never
 * be copied to a public artifact. Summary files contain IDs and aggregates.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { parseClassifierV6Response } from '@learner/core/lib/learning/learning-classifier-v6.js'
import {
  ONE_PAIR_CONTEXT_STRATEGY,
  ONE_PAIR_EXPERIMENT_LABEL,
  THREE_TURN_CONTEXT_STRATEGY,
  THREE_TURN_EXPERIMENT_LABEL,
} from '@learner/core/lib/learning/learning-three-turn-context.js'
import { openLearnerDatabase, usage } from './_db.js'

type DbRun = {
  run_id: string
  status: string
  sample_size: number
  config: Record<string, any>
  summary: Record<string, any> | null
  source_counts: Record<string, number> | null
  started_at: string
  completed_at: string | null
}
type DbCase = {
  case_id: string
  ordinal: number
  turn_id: string
  input_hash: string
  input_snapshot: Record<string, any>
  status: string
  error: string | null
}
type Review = {
  ordinal: number
  score: 0 | 1 | 2
  verdict: 'unusable' | 'mixed' | 'acceptable'
  note: string
  falseEvidence: boolean
  falseAssistance: boolean
}

const [threePairRunId, onePairRunId, destination, reviewsPath] = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/context-ablation-export.ts THREE_PAIR_RUN ONE_PAIR_RUN OUTPUT_DIR [ONE_PAIR_REVIEWS.json]
Checks that two 50-row benchmark runs are the matched three-pair / one-pair arms
of the frozen context experiment, then writes summary.json (ids + aggregates)
and raw-PRIVATE.json (transcript/model bytes, mode 600) to OUTPUT_DIR. Read-only.`,
!threePairRunId || !onePairRunId || !destination)

const handle = openLearnerDatabase({ readOnly: true })

const load = async (runId: string) => {
  const run = (await metaDbQuery<DbRun>(
    'SELECT run_id,status,sample_size,config,summary,source_counts,started_at::text,completed_at::text FROM learning_extraction_benchmark_runs WHERE run_id=$1',
    [runId],
  )).rows[0]
  if (!run) throw new Error(`Run not found: ${runId}`)
  const cases = (await metaDbQuery<DbCase>(
    'SELECT case_id,ordinal,turn_id,input_hash,input_snapshot,status,error FROM learning_extraction_benchmark_cases WHERE run_id=$1 ORDER BY ordinal',
    [runId],
  )).rows
  const results = (await metaDbQuery<any>(
    'SELECT case_id,model,effort,status,extraction,duration_ms,input_tokens,output_tokens,error FROM learning_extraction_benchmark_results WHERE run_id=$1 ORDER BY case_id',
    [runId],
  )).rows
  return { run, cases, results }
}

const [threePair, onePair] = await Promise.all([load(threePairRunId!), load(onePairRunId!)]).finally(() => handle.close())
const expectedSourceRunId = threePair.run.config.replayRunId
const invariant = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }

invariant(threePair.run.sample_size === 50 && onePair.run.sample_size === 50, 'Both arms must contain exactly 50 requested rows')
invariant(threePair.run.config.experimentLabel === THREE_TURN_EXPERIMENT_LABEL, 'Left run is not the frozen three-pair experiment')
invariant(threePair.run.config.contextStrategy === THREE_TURN_CONTEXT_STRATEGY, 'Left run has the wrong context strategy')
invariant(onePair.run.config.experimentLabel === ONE_PAIR_EXPERIMENT_LABEL, 'Right run is not clearly labeled one-pair')
invariant(onePair.run.config.contextStrategy === ONE_PAIR_CONTEXT_STRATEGY, 'Right run has the wrong context strategy')
invariant(onePair.run.config.replayRunId === expectedSourceRunId, 'Arms do not replay the same frozen authority')

const matchedConfigKeys = [
  'benchmarkVersion', 'classifierPromptRevision', 'outputFormat', 'outputSchemaRevision', 'catalogHash',
  'backend', 'model', 'effort', 'maxAttempts', 'maxBatchTokens', 'attemptHardDeadlineMs',
  'activeContextTokens', 'nativeSchemaReserveTokens', 'effectiveBatchByteCeiling',
]
for (const key of matchedConfigKeys) invariant(threePair.run.config[key] === onePair.run.config[key], `Configuration differs at ${key}`)
invariant(threePair.run.config.model === 'gpt-5.6-luna' && threePair.run.config.effort === 'medium', 'Expected Luna Medium')
invariant(threePair.run.config.maxAttempts === 1, 'Expected one attempt per batch')
invariant(threePair.cases.length === 50 && onePair.cases.length === 50, 'Both arms must persist 50 rows')

for (let ordinal = 0; ordinal < 50; ordinal += 1) {
  const oldCase = threePair.cases[ordinal]!
  const newCase = onePair.cases[ordinal]!
  invariant(oldCase.ordinal === ordinal && newCase.ordinal === ordinal, `Ordinal mismatch at ${ordinal}`)
  invariant(oldCase.case_id === newCase.case_id && oldCase.turn_id === newCase.turn_id, `Target identity mismatch at ${ordinal}`)
  invariant(JSON.stringify(oldCase.input_snapshot.current) === JSON.stringify(newCase.input_snapshot.current), `Target bytes/provenance mismatch at ${ordinal}`)
  const sourcePair = oldCase.input_snapshot.threeTurnSequence?.messages?.slice(2, 4)
  const newPair = newCase.input_snapshot.onePairSequence?.messages
  invariant(Array.isArray(sourcePair) && sourcePair.length === 2 && Array.isArray(newPair) && newPair.length === 2, `Pair shape mismatch at ${ordinal}`)
  for (let index = 0; index < 2; index += 1) {
    const comparable = (message: Record<string, any>) => {
      const { sequenceNumber: _sequenceNumber, ...rest } = message
      return rest
    }
    invariant(JSON.stringify(comparable(sourcePair[index])) === JSON.stringify(comparable(newPair[index])), `Pair content/provenance mismatch at ${ordinal}/${index}`)
  }
}

const rawRows = (data: typeof threePair) => {
  const cases = new Map(data.cases.map(item => [item.case_id, item]))
  return (data.run.config.attemptAudit ?? []).flatMap((attempt: any) => {
    let parsed: any
    try { parsed = JSON.parse(attempt.raw) } catch { parsed = { results: [] } }
    const byId = new Map((parsed.results ?? []).map((item: any) => [item.caseId, item.classification]))
    return attempt.caseIds.map((caseId: string) => {
      const source = cases.get(caseId)!
      const classification = byId.get(caseId)
      let deterministicError: string | null = null
      try { parseClassifierV6Response(classification, source.input_snapshot as any) }
      catch (error) { deterministicError = error instanceof Error ? error.message : String(error) }
      return { caseId, ordinal: source.ordinal, batchId: attempt.batchId, classification, deterministicValid: deterministicError === null, deterministicError }
    })
  }).sort((left: any, right: any) => left.ordinal - right.ordinal)
}

const summarize = (data: typeof threePair, raw: ReturnType<typeof rawRows>) => {
  const attempts = data.run.config.attemptAudit ?? []
  const completed = data.results.filter((item: any) => item.status === 'completed')
  const elapsedMs = data.run.completed_at ? Date.parse(data.run.completed_at) - Date.parse(data.run.started_at) : null
  return {
    runId: data.run.run_id,
    label: data.run.config.experimentLabel,
    contextStrategy: data.run.config.contextStrategy,
    status: data.run.status,
    requestedRows: data.run.sample_size,
    rawRows: raw.length,
    structurallyValidRawRows: raw.filter((item: { deterministicValid: boolean }) => item.deterministicValid).length,
    acceptedRows: completed.length,
    failedRows: data.cases.filter(item => item.status === 'failed').length,
    calls: attempts.length,
    rejectedCalls: attempts.filter((item: any) => item.state === 'rejected').length,
    batchSizes: attempts.map((item: any) => item.caseIds.length),
    summedCallDurationMs: attempts.reduce((sum: number, item: any) => sum + (item.durationMs ?? 0), 0),
    runElapsedMs: elapsedMs,
    inputTokens: attempts.reduce((sum: number, item: any) => sum + (item.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((sum: number, item: any) => sum + (item.outputTokens ?? 0), 0),
    callsMissingTokenUsage: attempts.filter((item: any) => item.inputTokens == null || item.outputTokens == null).length,
    emptyClassifications: raw.filter((item: { deterministicValid: boolean; classification: any }) => item.deterministicValid && (item.classification?.matches?.length ?? 0) === 0).length,
  }
}

const oldRaw = rawRows(threePair)
const newRaw = rawRows(onePair)
const oldSummary = summarize(threePair, oldRaw)
const newSummary = summarize(onePair, newRaw)
let reviews: Review[] | null = null
let semantic: Record<string, unknown> = { status: 'pending' }
if (reviewsPath) {
  reviews = JSON.parse(readFileSync(reviewsPath, 'utf8')) as Review[]
  invariant(reviews.length === 50 && reviews.every((item, index) => item.ordinal === index), 'One-pair reviews must cover ordinals 0..49 in order')
  const oldReviews = (threePair.run.summary?.caseReviews ?? []) as Review[]
  invariant(oldReviews.length === 50, 'Three-pair Medium run lacks the frozen 50-row review')
  const outcomes = reviews.map((review, index) => review.score - oldReviews[index]!.score)
  semantic = {
    status: 'completed-unblinded-agent-raw-row-review',
    rubric: '2 useful supported tags or appropriate abstention; 1 mixed or thin; 0 unusable or row structural failure',
    onePairMean: reviews.reduce((sum, item) => sum + item.score, 0) / 50,
    threePairMean: oldReviews.reduce((sum, item) => sum + item.score, 0) / 50,
    meanPairedDelta: outcomes.reduce((sum, item) => sum + item, 0) / 50,
    onePairWins: outcomes.filter(item => item > 0).length,
    ties: outcomes.filter(item => item === 0).length,
    threePairWins: outcomes.filter(item => item < 0).length,
    onePairUsefulMixedUnusable: [2, 1, 0].map(score => reviews!.filter(item => item.score === score).length),
    onePairFalseEvidence: reviews.filter(item => item.falseEvidence).length,
    onePairFalseAssistance: reviews.filter(item => item.falseAssistance).length,
    limitations: 'Exploratory unblinded agent review, not independent human annotation or causal learning-outcome evidence.',
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  frozenAuthorityRunId: expectedSourceRunId,
  identicalTargetIdsAndOrder: true,
  targetPairBytesAndProvenancePreserved: true,
  matchedConfig: Object.fromEntries(matchedConfigKeys.map(key => [key, onePair.run.config[key]])),
  intentionalDifference: 'The three-pair arm receives before, target, and after exchanges (6 messages); the one-pair arm receives only the matched target user and assistant response (2 messages). Context-specific framing necessarily names those shapes; the base v6 rubric/catalog/schema and runtime settings are unchanged.',
  arms: { threePair: oldSummary, onePair: newSummary },
  semantic,
  caveats: [
    'Whole-batch rejection makes accepted-row rate different from individual raw-row structural validity.',
    'Raw outputs are graded independently even when another row caused their batch to be rejected.',
    'Rows are overlapping conversation windows and are not independent observations.',
    'The assistant response is retrospective context and is never counted as prior assistance.',
    'Token counts and durations are per batch call; no per-row latency or token allocation is inferred.',
  ],
}

const outputDir = resolve(destination!)
mkdirSync(outputDir, { recursive: true })
writeFileSync(resolve(outputDir, 'raw-PRIVATE.json'), JSON.stringify({ threePair, onePair, rawRows: { threePair: oldRaw, onePair: newRaw } }, null, 2), { mode: 0o600 })
writeFileSync(resolve(outputDir, 'summary.json'), JSON.stringify(summary, null, 2))
if (reviews) writeFileSync(resolve(outputDir, 'matched-scores.json'), JSON.stringify({ onePair: reviews, threePair: threePair.run.summary?.caseReviews }, null, 2))
console.log(JSON.stringify(summary, null, 2))
