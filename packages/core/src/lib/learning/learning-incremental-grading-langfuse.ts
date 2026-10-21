import { learningExperimentApi as api, flushLangfuseWrites } from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { promptAbHash, promptAbId } from './learning-prompt-ab.js'
import { promptAbComparable, promptAbNativeJson, promptAbStats } from './learning-prompt-ab-langfuse.js'
import { percentToLevel } from './learning-mastery-model-comparison.js'
import { incrementalArmScores, quoteRejected, sliceHistoryTurns, type IncrementOutcome } from './learning-incremental-assessment.js'
import { FEEDBACK_CALL_KEY, armMetrics, readBackSince, feedbackFocusCases, feedbackPrompt, initialPrior, overrideSubsetStats, validateFeedbackCandidate, type FeedbackCandidateSchema } from './learning-incremental-grading-experiment.js'
import { callRow, callRunId, frozenHistory, gradingExperiment, incrementRunId, labelGolden, ownsSample, type CallRow, type GoldenEntry, type GradingItem, type GradingRow } from './learning-incremental-grading-store.js'
import type { z } from 'zod'

const WEB = 'https://dev.biztoolz.app/experiments/project/learning'
const PREFIX = 'incgrade.'
const TAGS = ['learning', 'incremental-grading']
const MAX_BYTES = 3_500_000
export const BASELINE_ARM = 'baseline-v5'
export const PROMPT_NAME = 'learning-incremental-grading'
export const SCORE_TYPES: Record<string, { dataType: 'BOOLEAN' | 'NUMERIC'; maxValue?: number }> = {
  percent_abs_error: { dataType: 'NUMERIC', maxValue: 100 }, level_agrees: { dataType: 'BOOLEAN' }, evidence_decision_agrees: { dataType: 'BOOLEAN' },
  quote_rejection_rate: { dataType: 'NUMERIC', maxValue: 1 }, grade_swing: { dataType: 'NUMERIC', maxValue: 100 }, failed_increments: { dataType: 'NUMERIC' },
  input_bytes: { dataType: 'NUMERIC' }, input_tokens: { dataType: 'NUMERIC' }, output_tokens: { dataType: 'NUMERIC' },
  concept_seconds: { dataType: 'NUMERIC' }, mean_context_bytes: { dataType: 'NUMERIC' },
}

const hex = (...parts: string[]) => promptAbId(...parts).replaceAll('-', '')
export const datasetName = (sampleRunId: string) => `Incremental grading · sample ${sampleRunId}`
export const gradingIds = (runId: string, sampleRunId: string, arm: string, conceptId: string) => ({
  datasetItemId: promptAbId('incgrade-item', sampleRunId, conceptId),
  // The baseline experiment belongs to the round that froze the sample; reuse rounds point at it.
  experimentId: hex('incgrade-arm', arm === BASELINE_ARM ? sampleRunId : runId, arm).slice(0, 16),
  traceId: hex('incgrade-trace', arm === BASELINE_ARM ? sampleRunId : runId, arm, conceptId),
  spanId: hex('incgrade-root', arm === BASELINE_ARM ? sampleRunId : runId, arm, conceptId).slice(0, 16),
})
const code = (row: GradingRow) => ({ gitRevision: row.manifest.code!.gitRevision, sourceHash: row.manifest.code!.sourceHash })

async function scoreConfigs() {
  const all: any[] = []
  for (let page = 1; ; page++) { const r = await api(`/api/public/score-configs?limit=100&page=${page}`); all.push(...r.data); if (page >= r.meta.totalPages) break }
  const ids: Record<string, string> = {}
  for (const [key, type] of Object.entries(SCORE_TYPES)) {
    const name = PREFIX + key
    const config = all.find(c => c.name === name && !c.isArchived) ?? await api('/api/public/score-configs', 'POST', { name, dataType: type.dataType,
      ...(type.dataType === 'NUMERIC' ? { minValue: 0, ...(type.maxValue === undefined ? {} : { maxValue: type.maxValue }) } : {}),
      description: 'Incremental grading optimization. Errors and agreement are against agent-golden labels (Claude Opus 5.5 reviewing the v5 full-history grade), NOT human gold.' })
    if (config.dataType !== type.dataType) throw new Error('Incremental grading score config mismatch')
    ids[key] = config.id
  }
  return ids
}

/** The dataset belongs to the sample: items are the frozen concepts, expected outputs the golden labels. */
export async function setupIncrementalGradingDataset(runId: string) {
  const row = await gradingExperiment(runId)
  const name = datasetName(row.manifest.sampleRunId), itemsHash = promptAbHash(row.manifest.items)
  let dataset: Record<string, any>
  try { dataset = await api(`/api/public/v2/datasets/${encodeURIComponent(name)}`) } catch (error) {
    if (!(error instanceof Error) || !error.message.endsWith('(404)') || !ownsSample(row)) throw error
    dataset = await api('/api/public/v2/datasets', 'POST', { name, description: row.manifest.description,
      metadata: { kind: row.manifest.kind, sampleRunId: runId, itemsHash, seed: row.seed, labelStatus: row.manifest.labelStatus, goldenCandidate: row.manifest.goldenCandidate, code: code(row), tags: [...TAGS, runId], privacy: 'owner-only' } })
  }
  if (dataset.metadata?.itemsHash !== itemsHash || typeof dataset.id !== 'string') throw new Error('Langfuse dataset does not match the frozen sample')
  await q('UPDATE learning_consolidator_prompt_experiments SET dataset_id=$2 WHERE run_id=$1 AND (dataset_id IS NULL OR dataset_id=$2)', [runId, dataset.id])
  if (ownsSample(row)) for (const item of row.manifest.items) await upsertItem(row, item, undefined)
  return { datasetId: dataset.id, scoreConfigs: await scoreConfigs() }
}
async function upsertItem(row: GradingRow, item: GradingItem, golden: GoldenEntry | undefined) {
  await api('/api/public/dataset-items', 'POST', { id: gradingIds(row.run_id, row.manifest.sampleRunId, BASELINE_ARM, item.conceptId).datasetItemId, datasetName: datasetName(row.manifest.sampleRunId),
    input: { conceptId: item.conceptId, title: item.title, band: item.band, publishedPercent: item.publishedPercent, turns: item.turns, matchingTurns: item.matchingTurns, historyBytes: item.historyBytes, baselineRunId: item.baselineRunId },
    ...(golden === undefined ? {} : { expectedOutput: golden }),
    metadata: { sampleRunId: row.manifest.sampleRunId, conceptId: item.conceptId, ordinal: item.ordinal, reviewRunId: item.reviewRunId, expectedOutputStatus: golden === undefined ? 'pending-golden-review' : row.manifest.labelStatus } })
}
/** Golden labels are frozen once on the sample round (labelGolden) and written as expected outputs. */
export async function writeGoldenLabels(runId: string) {
  const row = await gradingExperiment(runId), golden = await labelGolden(runId)
  if (ownsSample(row)) for (const item of row.manifest.items) await upsertItem(row, item, golden[item.conceptId])
  const entries = Object.values(golden)
  return { labelled: entries.filter(g => g.goldenPercent !== null || g.source !== 'review-failed').length, agreed: entries.filter(g => 'agrees' in g && g.agrees).length, failedReviews: entries.filter(g => g.source === 'review-failed').length }
}

type Call = { run: CallRow; increment: number; kind: string }
const outcome = (call: CallRow): IncrementOutcome => {
  const r = call.receipt!
  return { status: r.status, percent: r.status === 'completed' ? r.assessment?.understandingPercent ?? null : null,
    quoteRejected: r.status === 'failed' && call.snapshot.context ? quoteRejected(r.raw, call.snapshot.context) : false,
    inputBytes: call.snapshot.plan?.inputBytes ?? Buffer.byteLength(call.snapshot.prompt) + Buffer.byteLength(JSON.stringify(call.snapshot.schema)), inputTokens: r.inputTokens, outputTokens: r.outputTokens }
}
/** The calls behind one item×arm, in replay order. A chain shorter than K turns ends early; its unused increments are not calls. */
async function armCalls(row: GradingRow, item: GradingItem, arm: string): Promise<Call[]> {
  const calls: Call[] = []
  if (arm === BASELINE_ARM) {
    calls.push({ run: (await callRow(item.baselineRunId))!, increment: 0, kind: 'baseline' })
    const review = await callRow(item.reviewRunId)
    if (review) calls.push({ run: review, increment: 0, kind: 'golden-review' })
  } else {
    const slices = sliceHistoryTurns((await frozenHistory(item)).turns, row.manifest.increments).length
    for (let i = 0; i < slices; i++) {
      const run = await callRow(incrementRunId(row.run_id, arm, item.conceptId, i))
      if (!run) throw new Error(`Increment ${i} was never prepared`)
      calls.push({ run, increment: i, kind: 'increment' })
    }
  }
  if (calls.some(c => !c.run.receipt)) throw new Error('Every call must have a terminal receipt before export')
  return calls
}
function attr(key: string, value: unknown) {
  return { key, value: typeof value === 'number' ? { doubleValue: value } : typeof value === 'boolean' ? { boolValue: value } : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) } }
}
const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1000000n)
/** One trace per item×arm: a root experiment-item span plus one generation per paid call. */
export function gradingObservation(row: GradingRow, item: GradingItem, arm: string, calls: Call[], golden: GoldenEntry | undefined) {
  const ids = gradingIds(row.run_id, row.manifest.sampleRunId, arm, item.conceptId)
  const graded = calls.filter(c => c.kind !== 'golden-review'), outcomes = graded.map(c => outcome(c.run))
  const armConfig = row.manifest.arms.find(a => a.name === arm)
  // A warm chain publishes its starting grade until an increment completes (see incrementalArmScores).
  const startPercent = armConfig ? initialPrior(armConfig, item)?.understandingPercent ?? null : null
  const completed = outcomes.filter(o => o.status === 'completed'), finalPercent = completed.length ? completed.at(-1)!.percent : startPercent
  const input = { conceptId: item.conceptId, title: item.title, band: item.band, arm, calls: graded.length }
  const output = { finalPercent, finalLevel: percentToLevel(finalPercent), goldenPercent: golden?.goldenPercent ?? null, startPercent,
    trajectory: graded.map((c, i) => ({ increment: c.increment, status: outcomes[i]!.status, percent: outcomes[i]!.percent, quoteRejected: outcomes[i]!.quoteRejected, inputBytes: outcomes[i]!.inputBytes,
      contextTurns: c.run.snapshot.plan?.contextTurns ?? null, contextBytes: c.run.snapshot.plan?.contextBytes ?? 0, durationMs: c.run.receipt!.durationMs, paid: c.run.reserved_at !== null, assessmentRunId: c.run.run_id,
      inputTokens: outcomes[i]!.inputTokens, quoteRetried: c.run.receipt!.quoteRetry?.attempted === true, quoteRecovered: c.run.receipt!.quoteRetry?.recovered === true,
      nodeRetried: c.run.receipt!.nodeVersionRetry?.attempted === true, nodeRecovered: c.run.receipt!.nodeVersionRetry?.recovered === true })) }
  const revision = armConfig?.revision ?? graded[0]!.run.snapshot.promptRevision
  const name = `${datasetName(row.manifest.sampleRunId)} · ${arm}${arm === BASELINE_ARM ? '' : ` · ${row.run_id.slice(0, 8)}`}`
  const ends = calls.map(c => Date.parse(c.run.receipt!.completedAt)), starts = calls.map((c, i) => ends[i]! - c.run.receipt!.durationMs)
  const spans = calls.map((c, i) => {
    const r = c.run.receipt!, paid = c.run.reserved_at !== null
    const attributes = [attr('langfuse.observation.type', paid ? 'generation' : 'span'), attr('langfuse.observation.input', { assessmentRunId: c.run.run_id, increment: c.increment, plan: c.run.snapshot.plan ?? null, inputBytes: Buffer.byteLength(c.run.snapshot.prompt), evidenceIds: (c.run.snapshot.evidence ?? []).map((e: { id: string }) => e.id) }),
      attr('langfuse.observation.output', { status: r.status, assessment: r.assessment, result: r.result ?? null, error: r.error, quoteRejected: c.kind === 'golden-review' ? false : outcome(c.run).quoteRejected }),
      attr('langfuse.observation.metadata', { kind: c.kind, promptRevision: c.run.snapshot.promptRevision, durationMs: r.durationMs, reservedAttempt: paid, costBasis: 'subscription CLI, not priced' })]
    if (paid) attributes.push(attr('langfuse.observation.model.name', String(c.run.snapshot.model.model)), attr('langfuse.observation.model.parameters', c.run.snapshot.model),
      attr('langfuse.observation.usage_details', { ...(r.inputTokens === null ? {} : { input: r.inputTokens }), ...(r.outputTokens === null ? {} : { output: r.outputTokens }) }))
    return { traceId: ids.traceId, spanId: hex('incgrade-call', c.run.run_id).slice(0, 16), parentSpanId: ids.spanId, name: `${c.kind}${c.kind === 'increment' ? ` ${c.increment}` : ''}`, kind: 1,
      startTimeUnixNano: nanos(starts[i]!), endTimeUnixNano: nanos(ends[i]!), attributes, status: { code: r.status === 'failed' ? 2 : 1 } }
  })
  const root = { traceId: ids.traceId, spanId: ids.spanId, name: `${arm}: ${item.title}`, kind: 1, startTimeUnixNano: nanos(Math.min(...starts)), endTimeUnixNano: nanos(Math.max(...ends)), status: { code: 1 },
    attributes: [attr('langfuse.observation.type', 'span'), attr('langfuse.trace.name', `${name} · ${item.title}`), attr('langfuse.trace.tags', [...TAGS, row.run_id, arm, revision]), attr('langfuse.environment', 'learning-dev'), attr('session.id', row.run_id),
      attr('langfuse.observation.input', input), attr('langfuse.observation.output', output),
      attr('langfuse.observation.metadata', { runId: row.run_id, sampleRunId: row.manifest.sampleRunId, conceptId: item.conceptId, arm, revision, contextAllowanceBytes: armConfig?.contextAllowanceBytes ?? null, increments: row.manifest.increments, labelStatus: row.manifest.labelStatus, code: code(row), privacy: 'owner-only' }),
      attr('langfuse.experiment.id', ids.experimentId), attr('langfuse.experiment.name', name),
      attr('langfuse.experiment.description', arm === BASELINE_ARM ? 'v5 prior-blind full-history read (one call per concept); the candidate the golden reviewer judged.' : `${revision}, context allowance ${armConfig?.contextAllowanceBytes} bytes, ${row.manifest.increments} chronological increments.`),
      attr('langfuse.experiment.dataset.id', row.dataset_id!), attr('langfuse.experiment.item.id', ids.datasetItemId), attr('langfuse.experiment.item.root_observation_id', ids.spanId)] }
  return { ids, input, output, outcomes, startedAtMs: Math.min(...starts), payload: { resourceSpans: [{ resource: { attributes: [attr('service.name', 'biztools-learning-incremental-grading')] }, scopeSpans: [{ scope: { name: 'biztools-learning-incremental-grading', version: '1' }, spans: [root, ...spans] }] }] } }
}

/** Ledgered once per item×arm, keyed by the call that ends the chain. Same pending→queued→exported states as the other experiments. */
async function exportOnce(row: GradingRow, ledgerRunId: string, traceId: string, payload: unknown) {
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_BYTES) throw new Error('Observation exceeds Langfuse safe size ceiling')
  await q('INSERT INTO learning_consolidator_prompt_exports(assessment_run_id,experiment_id,trace_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [ledgerRunId, row.run_id, traceId])
  const state = (await q<{ state: string }>('SELECT state FROM learning_consolidator_prompt_exports WHERE assessment_run_id=$1 AND experiment_id=$2', [ledgerRunId, row.run_id])).rows[0]?.state
  if (state === 'exported') return []
  if (!state || !['pending', 'queued'].includes(state)) throw new Error('Langfuse send already claimed or uncertain; reconcile before replay')
  const admitted = await api('/api/public/otel/v1/traces', 'POST', payload)
  await q("UPDATE learning_consolidator_prompt_exports SET state='queued',updated_at=now() WHERE assessment_run_id=$1 AND state IN ('pending','queued')", [ledgerRunId])
  return [admitted.id as string]
}
async function pages(path: string) {
  const out: any[] = []
  let cursor: string | undefined
  for (let i = 0; i < 50; i++) { const r = await api(`${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); out.push(...(r.data ?? [])); cursor = r.meta?.cursor; if (!cursor) break }
  return out
}

type ItemResult = { conceptId: string; title: string; band: string; arm: string; goldenPercent: number | null; finalPercent: number | null; scores: Record<string, number | boolean>
  trajectory: Array<{ increment: number; assessmentRunId: string; status: string; percent: number | null; durationMs: number; paid: boolean; contextBytes: number; inputTokens: number | null; quoteRetried: boolean; quoteRecovered: boolean; quoteRejected: boolean; nodeRetried: boolean; nodeRecovered: boolean }> }

/** A flush can come back incomplete with nothing wrong: the outbox scheduler's own drain may hold a lease on
 * some of these rows ('delivering'). Wait those out, bounded; anything still undelivered fails the export phase. */
async function flushSettled(ids: string[], attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try { return await flushLangfuseWrites(ids) } catch (error) {
      if (attempt >= attempts || (error as Error).name !== 'TelemetryFlushIncompleteError') throw error
      await new Promise(resolve => setTimeout(resolve, 2_000 * attempt))
    }
  }
}

/** Score every item×arm from the database and store the round summary FIRST; the Langfuse export, native
 * read-back and score writes follow as a separate phase whose outcome is recorded on the summary and retried
 * by refinalizing. A Langfuse failure never fails the round or re-pays a call. */
export async function finalizeIncrementalGrading(runId: string) {
  const row = await gradingExperiment(runId)
  if (!row.dataset_id) throw new Error('Dataset has not been set up')
  const golden = await labelGolden(runId)
  const arms = [...(ownsSample(row) ? [BASELINE_ARM] : []), ...row.manifest.arms.map(a => a.name)]
  const prepared: Array<{ item: GradingItem; arm: string; ledgerRunId: string; obs: ReturnType<typeof gradingObservation>; result: ItemResult }> = []
  for (const item of row.manifest.items) for (const arm of arms) {
    const calls = await armCalls(row, item, arm), obs = gradingObservation(row, item, arm, calls, golden[item.conceptId])
    const goldenPercent = golden[item.conceptId]?.goldenPercent ?? null, reviewFailed = golden[item.conceptId]?.source === 'review-failed'
    const paid = obs.output.trajectory.filter(t => t.paid)
    const scores: Record<string, number | boolean> = { ...(reviewFailed ? {} : incrementalArmScores({ goldenPercent, increments: obs.outcomes, startPercent: obs.output.startPercent })),
      concept_seconds: paid.reduce((n, t) => n + t.durationMs, 0) / 1000, mean_context_bytes: obs.output.trajectory.reduce((n, t) => n + t.contextBytes, 0) / obs.output.trajectory.length }
    // The export ledger is keyed by call alone: a pooled round's baseline call already belongs to the round that froze it.
    const baselineLedger = row.manifest.request.sampleFrom?.length ? item.reviewRunId : item.baselineRunId
    prepared.push({ item, arm, obs, ledgerRunId: arm === BASELINE_ARM ? baselineLedger : calls.at(-1)!.run.run_id,
      result: { conceptId: item.conceptId, title: item.title, band: item.band, arm, goldenPercent, finalPercent: obs.output.finalPercent, scores, trajectory: obs.output.trajectory } })
  }
  // Wall-clock ends at the last grading receipt, so a refinalize or a failed export does not stretch it.
  const ended = (await q<{ at: Date | null }>(`SELECT max((t.receipt->>'completedAt')::timestamptz) AS at FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_receipts t USING(run_id)
    WHERE r.snapshot->>'experimentId'=$1 AND r.snapshot->>'callKind' IN ('baseline','increment','golden-review')`, [runId])).rows[0]?.at ?? null
  const summary = { ...summarize(row, prepared.map(p => p.result), golden, ended), langfuse: { status: 'pending' as string, error: null as string | null, at: new Date().toISOString() } }
  await q("UPDATE learning_consolidator_prompt_experiments SET status='scored',summary=$2::jsonb WHERE run_id=$1", [runId, JSON.stringify(summary)])
  let langfuse: typeof summary.langfuse
  try {
    await exportToLangfuse(row, runId, arms, prepared)
    langfuse = { status: 'exported', error: null, at: new Date().toISOString() }
  } catch (error) {
    langfuse = { status: 'failed', error: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 500), at: new Date().toISOString() }
  }
  await q("UPDATE learning_consolidator_prompt_experiments SET summary=jsonb_set(summary,'{langfuse}',$2::jsonb) WHERE run_id=$1", [runId, JSON.stringify(langfuse)])
  return { runId, failures: summary.failures, arms: Object.keys(summary.arms), langfuse: langfuse.status }
}

async function exportToLangfuse(row: GradingRow, runId: string, arms: string[], prepared: Array<{ item: GradingItem; arm: string; ledgerRunId: string; obs: ReturnType<typeof gradingObservation>; result: ItemResult }>) {
  const outbox: string[] = []
  for (const { ledgerRunId, obs } of prepared) outbox.push(...await exportOnce(row, ledgerRunId, obs.ids.traceId, obs.payload))
  if (outbox.length) await flushSettled(outbox)
  const scoreIds: string[] = [], since = readBackSince(row.created_at, prepared.map(p => p.obs.startedAtMs))
  for (const arm of arms) {
    const native = await pages(`/api/public/experiment-items?fromStartTime=${encodeURIComponent(since.toISOString())}&experimentId=${gradingIds(runId, row.manifest.sampleRunId, arm, row.manifest.items[0]!.conceptId).experimentId}&limit=100&fields=core,dataset,io,metadata`)
    if (native.length !== row.manifest.items.length) throw new Error(`Native ${arm} item coverage incomplete (${native.length}/${row.manifest.items.length}); read-back may be retried`)
    for (const { item, obs, result } of prepared.filter(p => p.arm === arm)) {
      const found = native.find((i: any) => i.experimentItemId === obs.ids.datasetItemId)
      if (found?.traceId !== obs.ids.traceId || promptAbComparable(promptAbNativeJson(found.output)) !== promptAbComparable(obs.output)) throw new Error(`Native ${arm} output provenance mismatch`)
      for (const [key, value] of Object.entries(result.scores)) scoreIds.push((await api('/api/public/scores', 'POST', { id: promptAbId('incgrade-score', runId, arm, item.conceptId, key), traceId: obs.ids.traceId, observationId: obs.ids.spanId,
        name: PREFIX + key, value: typeof value === 'boolean' ? (value ? 1 : 0) : value, dataType: SCORE_TYPES[key]!.dataType, environment: 'learning-dev',
        comment: 'Against the agent-golden label (Claude Opus 5.5 review of the v5 full-history grade), not human gold.' })).id)
    }
  }
  if (scoreIds.length) await flushSettled(scoreIds)
  await q("UPDATE learning_consolidator_prompt_exports SET state='exported',updated_at=now() WHERE experiment_id=$1 AND state='queued'", [runId])
}

/** Opus vs Opus: the second blind grade scored as an arm against the first, over every concept where both completed. */
function ceilingStats(golden: Record<string, GoldenEntry>) {
  const pairs = Object.entries(golden).flatMap(([conceptId, g]) => g.repeat ? [{ conceptId, g, repeat: g.repeat }] : [])
  if (!pairs.length) return null
  const both = pairs.filter(p => p.g.source !== 'review-failed' && p.repeat.status === 'completed')
  const metrics = armMetrics(both.map(p => ({ conceptId: p.conceptId, band: '', goldenPercent: p.g.goldenPercent, finalPercent: p.repeat.percent, scores: {}, trajectory: [] })), 'ceiling')
  return { pairs: pairs.length, scored: both.length, levelAgreement: metrics.levelAgreement, within10: metrics.within10, mae: metrics.mae, signedBias: metrics.signedBias, nullAgreement: metrics.nullAgreement, ci: metrics.ci,
    items: both.map(p => ({ conceptId: p.conceptId, first: p.g.goldenPercent, second: p.repeat.percent })) }
}

function summarize(row: GradingRow, results: ItemResult[], golden: Record<string, GoldenEntry>, gradingEndedAt: Date | null) {
  const pct = (values: number[], q: number) => { const v = [...values].sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(q * v.length))]! : null }
  const speed = (rows: ItemResult[]) => {
    const calls = rows.flatMap(r => r.trajectory.filter(t => t.paid).map(t => t.durationMs / 1000)), concepts = rows.map(r => Number(r.scores.concept_seconds ?? 0))
    const context = rows.flatMap(r => r.trajectory.map(t => t.contextBytes))
    return { paidCalls: calls.length, callSecondsP50: pct(calls, 0.5), callSecondsP90: pct(calls, 0.9), conceptSecondsMean: concepts.length ? concepts.reduce((a, b) => a + b, 0) / concepts.length : null,
      conceptSecondsP90: pct(concepts, 0.9), meanContextBytes: context.length ? context.reduce((a, b) => a + b, 0) / context.length : 0 }
  }
  const rate = (rows: ItemResult[], key: string) => { const v = rows.flatMap(r => key in r.scores ? [r.scores[key]] : []); return v.length ? v.filter(Boolean).length / v.length : null }
  const stats = (rows: ItemResult[], key: string) => promptAbStats(rows.flatMap(r => typeof r.scores[key] === 'number' ? [r.scores[key] as number] : []))
  const arms = Object.fromEntries([...new Set(results.map(r => r.arm))].map(arm => {
    const rows = results.filter(r => r.arm === arm), config = row.manifest.arms.find(a => a.name === arm)
    return [arm, { revision: config?.revision ?? 'gradual-understanding-v5-prior-blind-attribution', contextAllowanceBytes: config?.contextAllowanceBytes ?? null, candidate: config?.candidate ?? null, items: rows.length,
      scoredItems: rows.filter(r => Object.keys(r.scores).length).length, meanAbsError: stats(rows, 'percent_abs_error'), levelAgreement: rate(rows, 'level_agrees'), evidenceDecisionAgreement: rate(rows, 'evidence_decision_agrees'),
      quoteRejectionRate: stats(rows, 'quote_rejection_rate').mean, meanGradeSwing: stats(rows, 'grade_swing').mean, failedIncrements: rows.reduce((n, r) => n + Number(r.scores.failed_increments ?? 0), 0),
      overrideSubset: overrideSubsetStats(rows, golden), ...speed(rows), nullAgreement: (() => { const blanks = rows.filter(r => r.goldenPercent === null && Object.keys(r.scores).includes('level_agrees')); return blanks.length ? blanks.filter(r => r.finalPercent === null).length / blanks.length : null })(),
      blanksAnsweredNull: (() => { const blanks = rows.filter(r => r.band === 'unknown'); return blanks.length ? blanks.filter(r => r.finalPercent === null).length / blanks.length : null })(),
      inputTokens: rows.reduce((n, r) => n + Number(r.scores.input_tokens ?? 0), 0), outputTokens: rows.reduce((n, r) => n + Number(r.scores.output_tokens ?? 0), 0), inputBytes: rows.reduce((n, r) => n + Number(r.scores.input_bytes ?? 0), 0),
      prior: config?.prior ?? 'cold', source: config?.source ?? null, metrics: armMetrics(rows, `${row.run_id}:${arm}`) }]
  }))
  const first = row.manifest.items[0]!.conceptId, exp = (arm: string) => gradingIds(row.run_id, row.manifest.sampleRunId, arm, first).experimentId
  const candidates = row.manifest.arms.map(a => exp(a.name))
  return { runId: row.run_id, sampleRunId: row.manifest.sampleRunId, labelStatus: row.manifest.labelStatus, goldenCandidate: row.manifest.goldenCandidate,
    datasetId: row.dataset_id, datasetUrl: row.dataset_id ? `${WEB}/datasets/${encodeURIComponent(row.dataset_id)}` : null,
    experimentIds: Object.fromEntries([BASELINE_ARM, ...row.manifest.arms.map(a => a.name)].map(a => [a, exp(a)])),
    compareUrl: `${WEB}/experiments/results?baseline=${exp(BASELINE_ARM)}${candidates.map(c => `&c=${c}`).join('')}`,
    golden: { mode: row.manifest.request.golden ?? 'review', agreed: Object.values(golden).filter(g => 'agrees' in g && g.agrees).length, overridden: Object.values(golden).filter(g => g.source === 'reviewer-own-grade').length, failed: Object.values(golden).filter(g => g.source === 'review-failed').length,
      ceiling: ceilingStats(golden) },
    arms, items: results, failures: results.reduce((n, r) => n + Number(r.scores.failed_increments ?? 0), 0),
    concurrency: row.manifest.concurrency, roundWallClockSeconds: gradingEndedAt ? Math.round((gradingEndedAt.getTime() - row.created_at.getTime()) / 1000) : null, selection: row.manifest.selection ?? null,
    verdictScope: 'Agreement with agent-golden labels on each concept\'s frozen newest-320KB history; the baseline arm is the reviewed candidate, so its error measures only the reviewer\'s overrides.', code: code(row), elapsedMs: Date.now() - row.created_at.getTime() }
}

/** The feedback call reads the round's summary and the worst disagreements, with the human text of each increment. */
export async function feedbackInput(runId: string) {
  const row = await gradingExperiment(runId), golden = await labelGolden(runId)
  const summary = row.summary
  if (!summary?.arms) throw new Error('Round is not scored yet')
  const v6 = row.manifest.arms.map(a => ({ arm: a, s: summary.arms[a.name] })).sort((a, b) => (b.s.levelAgreement ?? 0) - (a.s.levelAgreement ?? 0) || (a.s.meanAbsError.mean ?? 1e9) - (b.s.meanAbsError.mean ?? 1e9))
  const best = v6[0]!.arm
  const cases = await Promise.all(feedbackFocusCases(summary.items as ItemResult[], best.name).map(async r => {
    const item = row.manifest.items.find(i => i.conceptId === r.conceptId)!, g = golden[r.conceptId]!
    const increments = await Promise.all(r.trajectory.map(async t => {
      const call = (await callRow(t.assessmentRunId))!
      return { ...t, newHumanText: (call.snapshot.evidence ?? []).filter((e: { role: string }) => e.role === 'user').map((e: { text: string }) => e.text).join('\n---\n').slice(0, 2_000),
        prior: call.snapshot.prior?.understandingPercent ?? null, demonstrated: call.receipt?.assessment?.demonstrated?.map((d: { description: string }) => d.description) ?? [], gaps: call.receipt?.assessment?.gaps?.map((x: { description: string }) => x.description) ?? [], error: call.receipt?.error ?? null }
    }))
    return { why: r.why, conceptId: r.conceptId, title: r.title, band: r.band, arm: r.arm, publishedPercent: item.publishedPercent, golden: { percent: g.goldenPercent, source: g.source, rationale: 'rationale' in g ? g.rationale : null }, finalPercent: r.finalPercent, scores: r.scores, increments }
  }))
  if (!cases.length) return null
  return { prompt: feedbackPrompt({ arm: best, arms: summary.arms, cases }), context: { arm: best.name, cases: cases.map(c => ({ conceptId: c.conceptId, arm: c.arm })) } }
}

/** Versioned candidate, never promoted: stored on the round and as a Langfuse prompt version with no label. */
export async function recordFeedbackCandidate(runId: string) {
  const row = await gradingExperiment(runId), id = callRunId(runId, FEEDBACK_CALL_KEY), call = await callRow(id)
  if ((row.summary?.feedback?.runId === id && row.summary.feedback.langfusePrompt) || !call) return row.summary?.feedback ?? { status: 'skipped' }
  // An earlier feedback revision's candidate stays on record beside the new one.
  if (row.summary?.feedback && row.summary.feedback.runId !== id) await q("UPDATE learning_consolidator_prompt_experiments SET summary=jsonb_set(summary,'{feedbackPrevious}',summary->'feedback') WHERE run_id=$1", [runId])
  if (!call.receipt) throw new Error('Feedback call has no receipt yet')
  if (call.receipt.status !== 'completed') {
    const feedback = { runId: id, status: call.receipt.status, error: call.receipt.error }
    await q("UPDATE learning_consolidator_prompt_experiments SET summary=jsonb_set(summary,'{feedback}',$2::jsonb) WHERE run_id=$1", [runId, JSON.stringify(feedback)])
    return feedback
  }
  const result = validateFeedbackCandidate(call.receipt.result) as z.infer<typeof FeedbackCandidateSchema> & { variant: { revision: string } }
  const candidate = { candidateId: id, sourceRunId: runId, revision: result.variant.revision, contextAllowanceBytes: result.contextAllowanceBytes, instructions: result.instructions, changes: result.changes, rationale: result.rationale, approved: false }
  const prompt = await api('/api/public/v2/prompts', 'POST', { name: PROMPT_NAME, type: 'text', prompt: result.instructions.join('\n\n'), labels: [], tags: [...TAGS, 'candidate', runId],
    config: { candidateId: id, sourceRunId: runId, revision: candidate.revision, contextAllowanceBytes: candidate.contextAllowanceBytes, changes: candidate.changes, rationale: candidate.rationale, approved: false },
    commitMessage: `Opus 5.5 candidate from round ${runId}; operator approval required, nothing promotes automatically` })
  const feedback = { runId: id, status: 'completed', candidate, langfusePrompt: { name: PROMPT_NAME, version: prompt.version } }
  await q("UPDATE learning_consolidator_prompt_experiments SET summary=jsonb_set(summary,'{feedback}',$2::jsonb) WHERE run_id=$1", [runId, JSON.stringify(feedback)])
  return feedback
}
