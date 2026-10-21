import { metaDbQuery as q, metaDbWithClient } from '../db-metadata/_shared.js'
import { assessmentHash, buildConceptAssessmentInput, type AssessmentConcept, type LearningConceptAssessment } from './learning-concept-assessment.js'
import { GRADUAL_ASSESSMENT_REVISION } from './learning-gradual-assessment.js'
import { assertVectorPromptBudget, VectorTurnConfig } from './learning-vector-turns.js'
import { promptAbHash, promptAbId } from './learning-prompt-ab.js'
import { planIncrementalInput, sliceHistoryTurns, type HistoryTurn, type IncrementalVariant } from './learning-incremental-assessment.js'
import {
  FEEDBACK_CALL_KEY, FEEDBACK_REVISION,
  DEFAULT_HISTORY_BYTES, FEEDBACK_CONCEPT_ID, GOLDEN_CANDIDATE, INCREMENTAL_GRADING_CONCURRENCY, INCREMENTAL_GRADING_KIND, INCREMENTAL_GRADING_MODELS, LABEL_STATUS,
  MAX_INPUT_BYTES, SAMPLE_RULE, representativeSample, FeedbackCandidateSchema, feedbackCandidateSchema, goldenLabel, goldenReviewPrompt, goldenReviewSchema, gradeBand, historyFromSelection, stratifiedOrder,
  validateFeedbackCandidate, validateGoldenReview, type GoldenReview, type GradeBand,
  blindGradePrompt, ceilingSubset, initialPrior, poolSamples, withValidatorRetry, type PriorMode,
} from './learning-incremental-grading-experiment.js'
import { validateGradualAssessment } from './learning-gradual-assessment.js'
import { conceptFromGraphs } from '../../services/learning-concept-assessment.js'
import type { LearningVectorTurnService } from '../../services/learning-vector-turn-service.js'
import type { LearningCurriculumStore } from '../../services/learning-curriculum-store.js'
import type { LLMService } from '@learner/llm/services/llm-service.js'

type Assessment = LearningConceptAssessment['assessment']
/** `prior` absent = cold (every round before the warm/cold split). `source` names where hand-written instructions came from. */
export type GradingArm = IncrementalVariant & { name: string; contextAllowanceBytes: number; candidate: { candidateId: string; sourceRunId: string } | null; prior?: PriorMode; source?: string }
/** `warmPrior`: the published cache assessment read when this round froze. `ceilingRunId`: a second blind Opus grade (the Opus-vs-Opus ceiling). */
export type GradingItem = { conceptId: string; title: string; band: GradeBand; volume?: string | null; publishedPercent: number | null; ordinal: number; matchingTurns: number; turns: number; droppedTurns: number; historyBytes: number; baselineRunId: string; reviewRunId: string; warmPrior?: Assessment; ceilingRunId?: string }
export type CeilingEntry = { percent: number | null; status: 'completed' | 'failed'; runId: string }
export type GoldenEntry = ({ goldenPercent: number | null; goldenLevel: number; source: string; candidatePercent: number | null; agrees: boolean; rationale: string; reviewRunId: string } | { goldenPercent: null; source: 'review-failed'; reviewRunId: string; error: string | null }) & { repeat?: CeilingEntry }
export type GoldenMode = 'review' | 'blind'
export type GradingRequest = { seed: string; sampleSize: number; increments: number; historyBytes: number; conceptIds?: string[] | undefined; sampleRunId?: string | undefined; holdoutFrom?: string[] | undefined;
  sampleFrom?: string[] | undefined; golden?: GoldenMode | undefined; ceilingSize?: number | undefined; feedback: boolean
  arms: Array<{ name: string; contextAllowanceBytes?: number | undefined; candidateId?: string | undefined; candidateRunId?: string | undefined; prior?: PriorMode | undefined; instructions?: string[] | undefined; source?: string | undefined }> }
export type GradingManifest = {
  kind: string; name: string; description: string; request: GradingRequest; frozen: boolean; sampleRunId: string; increments: number; arms: GradingArm[]
  models: typeof INCREMENTAL_GRADING_MODELS; concurrency: typeof INCREMENTAL_GRADING_CONCURRENCY; labelStatus: string; goldenCandidate: string
  items: GradingItem[]; skipped: Array<{ conceptId: string; reason: string }>; selection?: unknown; code?: { gitRevision: string; sourceHash: string; files?: Record<string, string> }; golden?: Record<string, GoldenEntry>
}
export type GradingRow = { run_id: string; user_id: string; seed: string; manifest: GradingManifest; dataset_id: string | null; status: string; summary: any; created_at: Date }
type Receipt = { status: string; assessment: Assessment; result?: unknown; raw: string; error: string | null; durationMs: number; inputTokens: number | null; outputTokens: number | null; completedAt: string; masteryWrites: 0; quoteRetry?: { attempted: boolean; recovered: boolean; firstError: string } | null; nodeVersionRetry?: { attempted: boolean; recovered: boolean; firstError: string } | null }
export type CallRow = { run_id: string; concept_id: string; snapshot: any; receipt: Receipt | null; reserved_at: Date | null; created_at: Date }

export const CODE_FILES = [
  'packages/core/src/lib/learning/learning-incremental-assessment.ts',
  'packages/core/src/lib/learning/learning-incremental-grading-experiment.ts',
  'packages/core/src/lib/learning/learning-incremental-grading-store.ts',
  'packages/core/src/lib/learning/learning-incremental-grading-langfuse.ts',
  'packages/core/src/lib/learning/learning-gradual-assessment.ts',
  'packages/core/src/services/learning-concept-assessment.ts',
  'apps/server/src/functions/learning/learning-incremental-grading-experiment.function.ts',
  'apps/server/src/wirings/learning-incremental-grading-experiment.workflow.ts',
]

export const callRunId = (runId: string, ...parts: string[]) => promptAbId('incgrade', runId, ...parts)
export const incrementRunId = (runId: string, arm: string, conceptId: string, increment: number) => callRunId(runId, 'increment', arm, conceptId, String(increment))

export async function gradingExperiment(runId: string, frozen = true): Promise<GradingRow> {
  const row = (await q<GradingRow>('SELECT run_id,user_id,seed,manifest,dataset_id,status,summary,created_at FROM learning_consolidator_prompt_experiments WHERE run_id=$1', [runId])).rows[0]
  if (!row || row.manifest.kind !== INCREMENTAL_GRADING_KIND) throw new Error('Incremental grading experiment not found')
  if (frozen && !row.manifest.frozen) throw new Error('Experiment sample is not frozen yet')
  return row
}
export const ownsSample = (row: GradingRow) => row.manifest.sampleRunId === row.run_id
export async function callRow(runId: string) {
  return (await q<CallRow>(`SELECT r.run_id,r.concept_id,r.snapshot,r.created_at,t.receipt,a.reserved_at FROM learning_concept_assessment_runs r
    LEFT JOIN learning_concept_assessment_attempts a USING(run_id) LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.run_id=$1`, [runId])).rows[0]
}
async function insertCall(query: typeof q, input: { runId: string; userId: string; conceptId: string; nodeVersion: string; inputHash: string; snapshot: unknown }) {
  await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot)
    VALUES($1,$2,$1,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`, [input.runId, input.userId, input.conceptId, input.nodeVersion, input.inputHash, JSON.stringify(input.snapshot)])
}
/** The frozen history lives in the baseline call's snapshot, which the immutability trigger protects. */
export async function frozenHistory(item: GradingItem) {
  const row = (await q<{ turns: HistoryTurn[]; concept: AssessmentConcept }>(`SELECT snapshot->'turns' AS turns,snapshot#>'{context,nodeStates,0}' AS concept FROM learning_concept_assessment_runs WHERE run_id=$1`, [item.baselineRunId])).rows[0]
  if (!row?.turns?.length) throw new Error('Frozen history missing')
  const { nodeVersion: _, understandingPercent: __, ...concept } = row.concept as AssessmentConcept & { nodeVersion: string; understandingPercent: null }
  return { turns: row.turns, concept: concept as AssessmentConcept }
}

/**
 * Freeze once: arms, stratified sample, per-concept history and the baseline call. A round that names a
 * sampleRunId copies that round's items instead, so the history, baseline and golden set are shared.
 */
export async function freezeIncrementalGrading(runId: string, deps: { vectors: LearningVectorTurnService; curricula: LearningCurriculumStore }) {
  const row = await gradingExperiment(runId, false)
  if (row.manifest.frozen) return summaryOfFreeze(row.manifest)
  const request = row.manifest.request
  const arms = row.manifest.arms
  const code = await codeIdentity()
  const cache = await publishedAssessments(row.user_id)
  if (request.sampleFrom?.length) return freezePooled(row, request.sampleFrom, cache, code)
  if (request.sampleRunId) {
    const sample = await gradingExperiment(request.sampleRunId)
    if (!ownsSample(sample) || sample.user_id !== row.user_id) throw new Error('Sample round must be an owned round that froze its own sample')
    const manifest: GradingManifest = { ...row.manifest, frozen: true, sampleRunId: sample.run_id, increments: request.increments, items: sample.manifest.items, skipped: [], code,
      description: `${row.manifest.description} Reuses sample ${sample.run_id}: same frozen histories, v5 baseline and golden set.` }
    await q('UPDATE learning_consolidator_prompt_experiments SET manifest=$2::jsonb,status=$3 WHERE run_id=$1 AND NOT (manifest->>\'frozen\')::boolean', [runId, JSON.stringify(manifest), 'frozen'])
    return summaryOfFreeze((await gradingExperiment(runId)).manifest)
  }
  const graphs = await deps.curricula.listGraphs()
  const current = new Set(graphs.flatMap(g => g.concepts.map(c => c.id)))
  // A holdout never sees a concept any named round sampled, so a candidate tuned on those rounds is confirmed out of sample.
  const heldOut = new Set<string>()
  for (const id of request.holdoutFrom ?? []) {
    const sample = await gradingExperiment(id)
    if (sample.user_id !== row.user_id || !sample.manifest.frozen) throw new Error('A holdout source must be an owned, frozen round')
    for (const item of sample.manifest.items) heldOut.add(item.conceptId)
  }
  const published = (await q<{ concept_id: string; percent: number | null }>(`SELECT concept_id,(assessment->>'understandingPercent')::int AS percent FROM learning_concept_assessment_cache WHERE user_id=$1`, [row.user_id])).rows
    .filter(r => current.has(r.concept_id) && !heldOut.has(r.concept_id)).map(r => ({ conceptId: r.concept_id, band: gradeBand(r.percent), percent: r.percent }))
  // Probe slice: exactly the named concepts. Otherwise every graded concept plus a seeded slice of the
  // unknowns (the blanks), so the representative rule below can see each band's whole volume spread.
  const pool = request.conceptIds?.length
    ? request.conceptIds.map(id => { if (!current.has(id)) throw new Error(`Unknown concept ${id}`); const p = published.find(c => c.conceptId === id); return { conceptId: id, band: gradeBand(p?.percent ?? null), percent: p?.percent ?? null } })
    : [...published.filter(c => c.band !== 'unknown'), ...stratifiedOrder(published.filter(c => c.band === 'unknown'), request.seed).slice(0, Math.max(40, request.sampleSize * 3))]
  // One read-only selection for the whole pool: one embedding batch, one repeatable-read message snapshot.
  const reactive = (await q<{ threshold: number | null }>(`SELECT (config->>'threshold')::float8 AS threshold FROM learning_reactive_settings WHERE user_id=$1`, [row.user_id])).rows[0]
  const selected = await deps.vectors.selectEvidence(VectorTurnConfig.parse({ purpose: 'experiment', selection: 'all', conceptIds: pool.map(c => c.conceptId), threshold: reactive?.threshold ?? 0.65, concurrency: 1 }), row.user_id, runId)
  const messages = new Map(selected.messages.map(m => [m.id, m]))
  const skipped: GradingManifest['skipped'] = []
  const eligible = pool.flatMap(candidate => {
    const selection = selected.selections.find(s => s.concept.conceptId === candidate.conceptId)!
    const history = historyFromSelection(selection.turns, messages, request.historyBytes)
    const human = history.turns.filter(t => t.messages.some(m => m.role === 'user' && m.text.trim()))
    if (human.length < 2) { skipped.push({ conceptId: candidate.conceptId, reason: `only ${human.length} matching human turn(s)` }); return [] }
    const concept = conceptFromGraphs(graphs, candidate.conceptId), evidence = history.turns.flatMap(t => t.messages)
    try { assertVectorPromptBudget(concept, evidence, null, MAX_INPUT_BYTES) } catch { skipped.push({ conceptId: candidate.conceptId, reason: 'v5 full-history read exceeds the input budget' }); return [] }
    return [{ ...candidate, concept, evidence, history, historyBytes: history.historyBytes, droppedTurns: history.droppedTurns }]
  })
  const choice = request.conceptIds?.length
    ? { picked: eligible.slice(0, request.sampleSize).map(c => ({ ...c, volume: null })), quotas: null, strata: null }
    : representativeSample(eligible, request.sampleSize, request.seed)
  if (choice.picked.length < request.sampleSize) throw new Error(`Only ${choice.picked.length} eligible concepts; ${request.sampleSize} requested`)
  const items: GradingItem[] = []
  await metaDbWithClient(async client => {
    await client.query('BEGIN')
    try {
      const query = ((text: string, values?: unknown[]) => client.query(text, values)) as typeof q
      for (const candidate of choice.picked) {
        const { concept, evidence, history } = candidate
        const built = buildConceptAssessmentInput(concept, evidence, null)
        const baselineRunId = callRunId(runId, 'baseline', candidate.conceptId)
        await insertCall(query, { runId: baselineRunId, userId: row.user_id, conceptId: candidate.conceptId, nodeVersion: built.nodeVersion, inputHash: promptAbHash([runId, 'baseline', built.inputHash]),
          snapshot: { ...built, evidence, prior: null, experimentId: runId, callKind: 'baseline', turns: history.turns, model: INCREMENTAL_GRADING_MODELS.luna, promptRevision: GRADUAL_ASSESSMENT_REVISION, indexStartedAt: new Date().toISOString(),
            provenance: { origin: INCREMENTAL_GRADING_KIND, selectionRunId: runId, matchingTurns: history.matchingTurns, droppedTurns: history.droppedTurns, historyBytes: history.historyBytes } } })
        items.push({ conceptId: candidate.conceptId, title: concept.title, band: candidate.band, volume: candidate.volume, publishedPercent: candidate.percent, ordinal: items.length, matchingTurns: history.matchingTurns,
          turns: history.turns.length, droppedTurns: history.droppedTurns, historyBytes: history.historyBytes, baselineRunId, reviewRunId: callRunId(runId, 'review', candidate.conceptId), warmPrior: cache.get(candidate.conceptId)?.assessment ?? null })
      }
      withCeiling(runId, items, request.ceilingSize)
      const bands = Object.fromEntries(['unknown', 'low', 'mid', 'high'].map(b => [b, items.filter(i => i.band === b).length]))
      const manifest: GradingManifest = { ...row.manifest, frozen: true, sampleRunId: runId, increments: request.increments, items, skipped, code,
        selection: { rule: request.conceptIds?.length ? 'probe-slice: the named concepts, in order' : SAMPLE_RULE, poolSize: pool.length, eligible: eligible.length, quotas: choice.quotas, strata: choice.strata, bands },
        description: `${row.manifest.description} Sample: ${items.length} concepts (${JSON.stringify(bands)}), each history = newest whole matching turns within ${request.historyBytes} bytes, replayed in time order.` }
      await client.query('UPDATE learning_consolidator_prompt_experiments SET manifest=$2::jsonb,status=$3 WHERE run_id=$1', [runId, JSON.stringify(manifest), 'frozen'])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
  })
  return summaryOfFreeze((await gradingExperiment(runId)).manifest)
}
/** The published grade per concept, read once at freeze: it is what a warm arm starts from (live starts warm). */
async function publishedAssessments(userId: string) {
  const rows = (await q<{ concept_id: string; assessment: Assessment; assessed_at: Date | null }>('SELECT concept_id,assessment,assessed_at FROM learning_concept_assessment_cache WHERE user_id=$1', [userId])).rows
  return new Map(rows.map(r => [r.concept_id, { assessment: r.assessment, assessedAt: r.assessed_at }]))
}
function withCeiling(runId: string, items: GradingItem[], size: number | undefined) {
  for (const item of ceilingSubset(items, size ?? 0)) item.ceilingRunId = callRunId(runId, 'review-repeat', item.conceptId)
}
/**
 * TUNE: the union of earlier rounds' frozen samples. Histories and the v5 baselines stay where they were frozen
 * (the items keep their baselineRunId); this round owns a fresh golden call per concept and the warm priors.
 */
async function freezePooled(row: GradingRow, sources: string[], cache: Awaited<ReturnType<typeof publishedAssessments>>, code: NonNullable<GradingManifest['code']>) {
  const runId = row.run_id, rounds = await Promise.all(sources.map(id => gradingExperiment(id)))
  if (rounds.some(r => !ownsSample(r) || r.user_id !== row.user_id)) throw new Error('Every pooled source must be an owned round that froze its own sample')
  const items: GradingItem[] = poolSamples(rounds.map(r => r.manifest.items.map(({ warmPrior: _, ceilingRunId: __, ...item }) => item)), id => callRunId(runId, 'review', id))
    .map(item => ({ ...item, warmPrior: cache.get(item.conceptId)?.assessment ?? null }))
  withCeiling(runId, items, row.manifest.request.ceilingSize)
  // The cache is the warm prior; say how far it has moved from the grade each source round saw at its own freeze.
  const drift = items.filter(i => (i.warmPrior?.understandingPercent ?? null) !== i.publishedPercent).map(i => ({ conceptId: i.conceptId, frozen: i.publishedPercent, warm: i.warmPrior?.understandingPercent ?? null }))
  const assessedAt = items.flatMap(i => { const at = cache.get(i.conceptId)?.assessedAt; return at ? [at.getTime()] : [] })
  const bands = Object.fromEntries(['unknown', 'low', 'mid', 'high'].map(b => [b, items.filter(i => i.band === b).length]))
  const manifest: GradingManifest = { ...row.manifest, frozen: true, sampleRunId: runId, increments: row.manifest.request.increments, items, skipped: [], code,
    selection: { rule: 'pooled: the union of the named rounds\' frozen samples, first occurrence wins', sources, bands, ceiling: items.filter(i => i.ceilingRunId).map(i => i.conceptId),
      warmPrior: { source: 'learning_concept_assessment_cache at freeze', newestAssessedAt: assessedAt.length ? new Date(Math.max(...assessedAt)).toISOString() : null, missing: items.filter(i => !i.warmPrior).length, driftFromFrozenPublished: drift } },
    description: `${row.manifest.description} Pooled sample of ${items.length} concepts from ${sources.join(', ')} (${JSON.stringify(bands)}): same frozen histories and v5 baselines; golden graded afresh by this round.` }
  await q('UPDATE learning_consolidator_prompt_experiments SET manifest=$2::jsonb,status=$3 WHERE run_id=$1 AND NOT (manifest->>\'frozen\')::boolean', [runId, JSON.stringify(manifest), 'frozen'])
  return summaryOfFreeze((await gradingExperiment(runId)).manifest)
}
const summaryOfFreeze = (m: GradingManifest) => ({ items: m.items.length, increments: Array.from({ length: m.increments }, (_, i) => i), arms: m.arms.map(a => a.name), sampleRunId: m.sampleRunId })
async function codeIdentity() {
  const files = Object.fromEntries(await Promise.all(CODE_FILES.map(async path => [path, await Bun.file(path).text()])))
  const git = Bun.spawn(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' })
  const gitRevision = (await new Response(git.stdout).text()).trim()
  if (await git.exited !== 0) throw new Error('Cannot freeze Git identity')
  return { gitRevision, sourceHash: promptAbHash(files), files }
}

/** The chain's estimate before `increment`: the last completed earlier increment, carried over failures. */
async function chainPrior(runId: string, arm: GradingArm, item: GradingItem, increment: number) {
  const conceptId = item.conceptId
  let prior: Assessment = initialPrior(arm, item)
  for (let i = 0; i < increment; i++) {
    const call = await callRow(incrementRunId(runId, arm.name, conceptId, i))
    if (!call) throw new Error('An earlier increment was never prepared')
    if (!call.receipt) {
      // A reservation with no receipt past the kill deadline is uncertain: it published nothing, like a failed pass.
      if (call.reserved_at && Date.now() - call.reserved_at.getTime() > INCREMENTAL_GRADING_MODELS.luna.killMs + 30_000) continue
      throw new Error('An earlier increment is still in flight')
    }
    if (call.receipt.status === 'completed' && call.receipt.assessment) prior = call.receipt.assessment
  }
  return prior
}

export async function prepareIncrement(runId: string, conceptId: string, armName: string, increment: number) {
  const id = incrementRunId(runId, armName, conceptId, increment)
  if (await callRow(id)) return id
  const row = await gradingExperiment(runId)
  const item = row.manifest.items.find(i => i.conceptId === conceptId), arm = row.manifest.arms.find(a => a.name === armName)
  if (!item || !arm) throw new Error('Unknown concept or arm')
  const { turns, concept } = await frozenHistory(item)
  const slices = sliceHistoryTurns(turns, row.manifest.increments)
  // Fewer turns than increments: the chain simply ends early, every later increment is a no-op receipt.
  const evidence = slices[increment] ?? []
  const prior = await chainPrior(runId, arm, item, increment)
  const plan = evidence.length ? planIncrementalInput({ concept, prior, evidence, earlier: slices.slice(0, increment).flat(), contextAllowanceBytes: arm.contextAllowanceBytes, maxInputBytes: MAX_INPUT_BYTES, variant: arm }) : null
  const built = plan?.built ?? planIncrementalInput({ concept, prior, evidence: [], earlier: [], contextAllowanceBytes: 0, maxInputBytes: MAX_INPUT_BYTES, variant: arm }).built
  await insertCall(q, { runId: id, userId: row.user_id, conceptId, nodeVersion: built.nodeVersion, inputHash: promptAbHash([runId, armName, increment, built.inputHash]),
    snapshot: { ...built, evidence: evidence.flatMap(t => t.messages), prior, experimentId: runId, callKind: 'increment', arm: armName, increment, model: INCREMENTAL_GRADING_MODELS.luna, promptRevision: arm.revision, indexStartedAt: new Date().toISOString(),
      plan: plan ? { inputBytes: plan.inputBytes, fixedBytes: plan.fixedBytes, contextAllowanceBytes: arm.contextAllowanceBytes, contextTurns: plan.context.turns.length, contextBytes: plan.context.bytes, contextOmitted: plan.context.omitted, evidenceTurns: evidence.length } : null } })
  return id
}

/** The golden review is prepared only once the baseline it reviews has a receipt. */
export async function prepareGoldenReview(runId: string, conceptId: string, repeat = false) {
  const row = await gradingExperiment(runId)
  const item = row.manifest.items.find(i => i.conceptId === conceptId)
  if (!item) throw new Error('Unknown concept')
  const id = repeat ? item.ceilingRunId : item.reviewRunId
  if (!id) throw new Error('Concept is not in the ceiling subset')
  if (await callRow(id)) return id
  if (row.manifest.request.golden === 'blind') {
    // Blind: no candidate is shown or waited for. A repeat is the identical prompt, made as an independent call.
    const { turns, concept } = await frozenHistory(item)
    const prompt = blindGradePrompt(concept, turns)
    await insertCall(q, { runId: id, userId: row.user_id, conceptId, nodeVersion: assessmentHash(concept), inputHash: promptAbHash([runId, repeat ? 'review-repeat' : 'review', prompt]),
      snapshot: { prompt, schema: goldenReviewSchema(), candidate: null, candidateRunId: null, repeat, evidence: turns.flatMap(t => t.messages), experimentId: runId, callKind: 'golden-review', model: INCREMENTAL_GRADING_MODELS.opus, promptRevision: BLIND_GOLDEN_REVISION, indexStartedAt: new Date().toISOString() } })
    return id
  }
  if (repeat) throw new Error('The ceiling repeat is defined for blind golden only')
  const baseline = await callRow(item.baselineRunId)
  if (!baseline?.receipt) throw new Error('Baseline has no receipt yet; the golden review waits for it')
  const { turns, concept } = await frozenHistory(item)
  const candidate = baseline.receipt.status === 'completed' ? baseline.receipt.assessment : null
  const prompt = goldenReviewPrompt(concept, turns, candidate)
  await insertCall(q, { runId: item.reviewRunId, userId: row.user_id, conceptId, nodeVersion: assessmentHash(concept), inputHash: promptAbHash([runId, 'review', prompt]),
    snapshot: { prompt, schema: goldenReviewSchema(), candidate, candidateRunId: item.baselineRunId, evidence: turns.flatMap(t => t.messages), experimentId: runId, callKind: 'golden-review', model: INCREMENTAL_GRADING_MODELS.opus, promptRevision: 'incremental-grading-golden-review-v1', indexStartedAt: new Date().toISOString() } })
  return item.reviewRunId
}

export const BLIND_GOLDEN_REVISION = 'incremental-grading-golden-blind-v1'

export async function prepareFeedback(runId: string, prompt: string, context: unknown) {
  const id = callRunId(runId, FEEDBACK_CALL_KEY)
  if (await callRow(id)) return id
  const row = await gradingExperiment(runId)
  await insertCall(q, { runId: id, userId: row.user_id, conceptId: FEEDBACK_CONCEPT_ID, nodeVersion: assessmentHash(FEEDBACK_CONCEPT_ID), inputHash: promptAbHash([runId, 'feedback', prompt]),
    snapshot: { prompt, schema: feedbackCandidateSchema(), context, evidence: [], experimentId: runId, callKind: 'feedback', model: INCREMENTAL_GRADING_MODELS.opus, promptRevision: FEEDBACK_REVISION, indexStartedAt: new Date().toISOString() } })
  return id
}

/**
 * Same paid-call fence as LearningConceptAssessmentService.execute, for calls whose answer is not an
 * assessment proposal: a receipt returns as-is, a reservation without one reports uncertain, never pays twice.
 */
export async function executeReviewCall(runId: string, llm: Pick<LLMService, 'callLLMWithStructuredOutput'>) {
  const row = await callRow(runId)
  if (!row) throw new Error('Experiment call not found')
  if (row.receipt) return { runId, status: row.receipt.status }
  if (row.reserved_at) return { runId, status: 'uncertain' }
  const kind = row.snapshot.callKind as string
  if (!['golden-review', 'feedback'].includes(kind)) throw new Error('Not an Opus experiment call')
  const reserved = await q('INSERT INTO learning_concept_assessment_attempts(run_id,scope_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING run_id', [runId, assessmentHash(['incgrade', runId])])
  if (!reserved.rowCount) return { runId, status: 'uncertain' }
  // Validated once, inside parseFn; the receipt keeps the plain answer (a candidate's variant is re-derived on read).
  const validate = (value: unknown) => kind === 'feedback' ? (validateFeedbackCandidate(value), FeedbackCandidateSchema.parse(value)) : validateGoldenReview(value, row.snapshot.candidate)
  const started = Date.now()
  let raw = '', inputTokens: number | null = null, outputTokens: number | null = null, receipt: Receipt
  try {
    const result = await llm.callLLMWithStructuredOutput({ label: `Incremental grading ${kind} ${runId}`, prompt: row.snapshot.prompt, outputSchema: row.snapshot.schema,
      parseFn: (value: unknown) => { raw = typeof value === 'string' ? value : JSON.stringify(value); return validate(typeof value === 'string' ? JSON.parse(value) : value) },
      callOptions: { ...row.snapshot.model, onUsage: (usage: Record<string, unknown>) => { inputTokens = typeof usage.inputTokens === 'number' ? usage.inputTokens : null; outputTokens = typeof usage.outputTokens === 'number' ? usage.outputTokens : null } },
      maxParseRetries: row.snapshot.model.maxParseRetries })
    receipt = { status: 'completed', assessment: null, result, raw, error: null, durationMs: Date.now() - started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0 }
  } catch (error) {
    receipt = { status: 'failed', assessment: null, raw, error: `Provider call or validation failed: ${error instanceof Error ? error.message.slice(0, 300) : 'unknown'}. No automatic retry.`, durationMs: Date.now() - started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0 }
  }
  await q('INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [runId, JSON.stringify(receipt)])
  return { runId, status: receipt.status }
}

/**
 * Experiment-only increment executor: LearningConceptAssessmentService.execute's fence (receipt returns as-is, a
 * reservation without one is uncertain, never pays twice) plus B1a, one quotation retry with the validator error
 * fed back. The receipt records the retry so a round reports retries and recoveries; tokens and seconds cover both calls.
 */
export async function executeIncrementCall(runId: string, llm: Pick<LLMService, 'callLLMWithStructuredOutput'>) {
  const row = await callRow(runId)
  if (!row) throw new Error('Experiment call not found')
  if (row.receipt) return { runId, status: row.receipt.status }
  if (row.reserved_at) return { runId, status: 'uncertain' }
  if (row.snapshot.callKind !== 'increment') throw new Error('Not an increment call')
  const blank = (status: string, error: string | null) => ({ status, assessment: null, raw: '', error, durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 as const })
  if (!row.snapshot.evidence.some((m: { role: string; text: string }) => m.role === 'user' && m.text.trim())) {
    await q('INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [runId, JSON.stringify(blank('no_evidence', null))])
    return { runId, status: 'no_evidence' }
  }
  const reserved = await q('INSERT INTO learning_concept_assessment_attempts(run_id,scope_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING run_id', [runId, assessmentHash(['incgrade', runId])])
  if (!reserved.rowCount) return { runId, status: 'uncertain' }
  const started = Date.now(), context = row.snapshot.context
  let raw = '', inputTokens: number | null = null, outputTokens: number | null = null
  const add = (a: number | null, b: unknown) => typeof b === 'number' ? (a ?? 0) + b : a
  const attempt = async (prompt: string) => {
    const parsed = await llm.callLLMWithStructuredOutput({ label: `Incremental grading increment ${runId}`, prompt, outputSchema: row.snapshot.schema,
      parseFn: (value: unknown) => { raw = typeof value === 'string' ? value : JSON.stringify(value); return validateGradualAssessment(typeof value === 'string' ? JSON.parse(value) : value, context) },
      callOptions: { ...row.snapshot.model, onUsage: (usage: Record<string, unknown>) => { inputTokens = add(inputTokens, usage.inputTokens); outputTokens = add(outputTokens, usage.outputTokens) } },
      maxParseRetries: row.snapshot.model.maxParseRetries })
    return validateGradualAssessment({ proposals: parsed }, context)[0]!
  }
  const result = await withValidatorRetry(row.snapshot.prompt, attempt, () => raw)
  const retry = { attempted: true, recovered: result.ok, firstError: (result.firstError ?? '').slice(0, 300) }
  const quoteRetry = result.retried === 'quote' ? retry : null, nodeVersionRetry = result.retried === 'nodeVersion' ? retry : null
  const receipt: Receipt = result.ok
    ? { status: 'completed', assessment: result.value, raw, error: null, durationMs: Date.now() - started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0, quoteRetry, nodeVersionRetry }
    : { status: 'failed', assessment: null, raw, error: `Provider call or source validation failed: ${result.error.slice(0, 300)}${result.retried ? ` (after one ${result.retried} retry)` : ''}. No further retry.`, durationMs: Date.now() - started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0, quoteRetry, nodeVersionRetry }
  await q('INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [runId, JSON.stringify(receipt)])
  return { runId, status: receipt.status }
}

/** Freeze the golden set onto the sample round, once; later rounds read it from there. */
export async function labelGolden(runId: string) {
  const row = await gradingExperiment(runId)
  if (!ownsSample(row)) return (await gradingExperiment(row.manifest.sampleRunId)).manifest.golden ?? (() => { throw new Error('Sample round has no golden set') })()
  if (row.manifest.golden) return row.manifest.golden
  const golden: Record<string, GoldenEntry> = {}
  for (const item of row.manifest.items) {
    const review = await callRow(item.reviewRunId)
    if (!review?.receipt) throw new Error('A golden review is unfinished; label after every review is terminal')
    golden[item.conceptId] = review.receipt.status === 'completed'
      ? { ...goldenLabel(review.receipt.result as GoldenReview, review.snapshot.candidate), reviewRunId: item.reviewRunId }
      : { goldenPercent: null, source: 'review-failed', reviewRunId: item.reviewRunId, error: review.receipt.error }
    if (item.ceilingRunId) {
      const repeat = await callRow(item.ceilingRunId)
      if (!repeat?.receipt) throw new Error('A ceiling repeat is unfinished; label after every review is terminal')
      golden[item.conceptId]!.repeat = repeat.receipt.status === 'completed'
        ? { percent: goldenLabel(repeat.receipt.result as GoldenReview, null).goldenPercent, status: 'completed', runId: item.ceilingRunId }
        : { percent: null, status: 'failed', runId: item.ceilingRunId }
    }
  }
  await q(`UPDATE learning_consolidator_prompt_experiments SET manifest=jsonb_set(manifest,'{golden}',$2::jsonb),status='golden_labelled' WHERE run_id=$1 AND manifest->'golden' IS NULL`, [runId, JSON.stringify(golden)])
  return (await gradingExperiment(runId)).manifest.golden!
}

export const DEFAULTS = { historyBytes: DEFAULT_HISTORY_BYTES, labelStatus: LABEL_STATUS, goldenCandidate: GOLDEN_CANDIDATE }
