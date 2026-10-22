import { randomUUID } from 'node:crypto'
import { metaDbQuery } from '../lib/db-metadata/_shared.js'
import type { LearningCurriculumStore } from './learning-curriculum-store.js'
import type { LearningGraph } from '../functions/learning/learning-seed.js'
import type { LLMService } from '@learner/llm/services/llm-service.js'
import { TagProviderFailure, type TypeSafeDecisionService } from '@learner/llm/services/typesafe-decision-service.js'
import { decisionFromAnswer, jevBilledUsage } from '../lib/learning/learning-mastery-model-comparison.js'
import { GRADUAL_ASSESSMENT_REVISION, validateGradualAssessment } from '../lib/learning/learning-gradual-assessment.js'
import { withValidatorRetry } from '../lib/learning/learning-incremental-grading-experiment.js'
import { isCurrentAssessmentRevision } from '../lib/learning/learning-live-incremental-variant.js'
import { persistAssessmentCache } from '../lib/learning/learning-assessment-persistence.js'
import { ASSESSMENT_MODEL, assessmentHash, assessmentTriggerDue, buildConceptAssessmentInput, nodeVersionMatches, LearningAssessmentRunSchema, type AssessmentConcept, type AssessmentSource, type LearningAssessmentRun, type LearningConceptAssessment } from '../lib/learning/learning-concept-assessment.js'
import { providedAssessmentHash } from '../lib/learning/learning-concept-assessment.js'
import { assessmentEvidenceProvenance, type AssessmentEvidenceProvenance } from '../lib/learning/learning-assessment-evidence.js'
import { VectorTurnConfig, VECTOR_SELECTION_REVISION, assertVectorPromptBudget, type VectorTurn } from '../lib/learning/learning-vector-turns.js'
import type { LearningVectorTurnService } from './learning-vector-turn-service.js'

type Snapshot = { experimentId?: string; provenance?:AssessmentEvidenceProvenance; prompt: string; schema: ReturnType<typeof buildConceptAssessmentInput>['schema']; context: ReturnType<typeof buildConceptAssessmentInput>['context']; evidence: AssessmentSource[]; prior: LearningConceptAssessment['assessment']; model: LearningAssessmentRun['model']; promptRevision: string; indexStartedAt: string }
type RunRow = { run_id: string; user_id: string; request_id: string; concept_id: string; node_version: string; input_hash: string; snapshot: Snapshot; created_at: Date; reserved_at: Date | null; receipt: LearningAssessmentRun['receipt'] }
export function conceptFromGraphs(graphs: LearningGraph[], conceptId: string): AssessmentConcept {
  const concept = graphs.flatMap(graph => graph.concepts).find(item => item.id === conceptId)
  if (!concept) throw new Error('Unknown Learning concept')
  return { conceptId, title: concept.title, description: concept.summary + '\n' + concept.explanation,
    objectives: [...new Set(graphs.flatMap(graph => graph.curriculum.modules.filter(module => module.conceptIds.includes(conceptId)).flatMap(module => module.masteryGoals)))].sort() }
}

/** Retrieval is replaceable; the assessment contract and immutable evidence are not. */
export class LearningConceptAssessmentService {
  readonly reactiveRevision='reactive-v1'
  constructor(private readonly curricula: LearningCurriculumStore, private readonly llm: LLMService, private readonly decisions?: Pick<TypeSafeDecisionService,'evaluate'>) {}

  async list(userId: string): Promise<Array<LearningConceptAssessment & { sourceIds: string[] }>> {
    const rows = (await metaDbQuery<{ concept_id: string; node_version: string; assessment: LearningConceptAssessment['assessment']; run_id: string; assessed_at: Date; pending: boolean; source_ids: string[]; prompt_revision:string|null }>(
      `SELECT c.concept_id,c.node_version,c.assessment,c.run_id,c.assessed_at,
        (SELECT r.snapshot->>'promptRevision' FROM learning_concept_assessment_runs r WHERE r.run_id=c.run_id) prompt_revision,
        COALESCE((SELECT jsonb_agg(source->>'id') FROM learning_concept_assessment_runs r,
          LATERAL jsonb_array_elements(r.snapshot->'evidence') source WHERE r.run_id=c.run_id),'[]'::jsonb) source_ids,
        (EXISTS(SELECT 1 FROM learning_reactive_targets target JOIN learning_reactive_admission admission USING(user_id,session_id)
          WHERE target.user_id=c.user_id AND target.concept_id=c.concept_id AND admission.requested_generation>admission.captured_generation)
        OR (NOT EXISTS(SELECT 1 FROM learning_reactive_settings WHERE user_id=c.user_id AND enabled) AND EXISTS(SELECT 1 FROM learning_concept_assessment_active a
        JOIN learning_semantic_index_messages m ON m.current_canonical AND m.status='indexed' AND m.indexed_at>COALESCE(a.last_indexed_at,a.selected_at)
        WHERE a.user_id=c.user_id AND a.concept_id=c.concept_id))) pending FROM learning_concept_assessment_cache c WHERE c.user_id=$1`, [userId])).rows
    const graphs = await this.curricula.listGraphs()
    const currentIds = new Set(graphs.flatMap(graph => graph.concepts.map(concept => concept.id)))
    return rows.map(row => ({ conceptId: row.concept_id, assessment: row.assessment, runId: row.run_id, sourceIds: row.source_ids,
      status: !isCurrentAssessmentRevision(row.prompt_revision) || !currentIds.has(row.concept_id) || !nodeVersionMatches(row.node_version, conceptFromGraphs(graphs, row.concept_id)) ? 'stale' as const : row.pending ? 'pending' as const : 'ready' as const, assessedAt: row.assessed_at.toISOString() }))
  }

  async concept(conceptId: string): Promise<AssessmentConcept> {
    return conceptFromGraphs(await this.curricula.listGraphs(), conceptId)
  }

  async get(userId: string, conceptId: string): Promise<LearningConceptAssessment> {
    const concept = await this.concept(conceptId)
    const cache = (await metaDbQuery<{ assessment: LearningConceptAssessment['assessment']; run_id: string; node_version: string; assessed_at: Date; prompt_revision:string|null }>(
      `SELECT c.assessment,c.run_id,c.node_version,c.assessed_at,r.snapshot->>'promptRevision' AS prompt_revision FROM learning_concept_assessment_cache c
       JOIN learning_concept_assessment_runs r USING(run_id) WHERE c.user_id=$1 AND c.concept_id=$2`, [userId, conceptId])).rows[0]
    const pending = (await metaDbQuery(`SELECT 1 FROM learning_concept_assessment_runs r LEFT JOIN learning_concept_assessment_receipts t USING(run_id)
      WHERE r.user_id=$1 AND r.concept_id=$2 AND t.run_id IS NULL
      UNION ALL SELECT 1 FROM learning_concept_assessment_active a JOIN learning_semantic_index_messages m ON m.current_canonical AND m.status='indexed'
        AND m.indexed_at>COALESCE(a.last_indexed_at,a.selected_at) WHERE a.user_id=$1 AND a.concept_id=$2 LIMIT 1`, [userId, conceptId])).rowCount > 0
    return { conceptId, assessment: cache?.assessment ?? null, runId: cache?.run_id ?? null,
      status: cache && (!isCurrentAssessmentRevision(cache.prompt_revision) || !nodeVersionMatches(cache.node_version, concept)) ? 'stale' : pending ? 'pending' : cache ? 'ready' : 'unknown', assessedAt: cache?.assessed_at.toISOString() ?? null }
  }

  async prepare(userId: string, conceptId: string, requestId: string, vectors:Pick<LearningVectorTurnService,'selectEvidence'>): Promise<{ runId: string }> {
    const previous = (await metaDbQuery<{ run_id: string; concept_id: string }>('SELECT run_id,concept_id FROM learning_concept_assessment_runs WHERE user_id=$1 AND request_id=$2', [userId, requestId])).rows[0]
    if (previous) {
      if (previous.concept_id !== conceptId) throw new Error('Assessment requestId belongs to another concept')
      return { runId: previous.run_id }
    }
    const indexStartedAt = new Date().toISOString()
    const concept = await this.concept(conceptId)
    const prior = await this.get(userId, conceptId)
    const selected = await vectors.selectEvidence(VectorTurnConfig.parse({purpose:'live',conceptIds:[conceptId],selection:'relevant',latestTurns:50}),userId,requestId)
    const turns=selected.selections[0]!.turns
    const ids=new Set(turns.flatMap(turn=>turn.messageIds))
    const sources=new Map(selected.messages.map(message=>[message.id,message]))
    const evidence=[...ids].map(id=>{const source=sources.get(id);if(!source) throw new Error('A selected source is missing from the immutable snapshot');return source})
    const provenance=assessmentEvidenceProvenance(evidence,{origin:'manual-vector-selection',experimentId:null,revision:VECTOR_SELECTION_REVISION,turns})
    // Preserve original messages, never truncate a quote's source. Oversize input refuses before reservation.
    assertVectorPromptBudget(concept,evidence,prior.assessment,400_000)
    const built = buildConceptAssessmentInput(concept, evidence, prior.assessment)
    const runId = randomUUID()
    const snapshot: Snapshot = { ...built, evidence, provenance, prior: prior.assessment, model: ASSESSMENT_MODEL, promptRevision: GRADUAL_ASSESSMENT_REVISION, indexStartedAt }
    const inserted = await metaDbQuery<{ run_id: string }>(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(user_id,request_id) DO NOTHING RETURNING run_id`, [runId,userId,requestId,conceptId,built.nodeVersion,built.inputHash,JSON.stringify(snapshot)])
    if (!inserted.rowCount) return this.prepare(userId, conceptId, requestId, vectors)
    await metaDbQuery('INSERT INTO learning_concept_assessment_active(user_id,concept_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [userId,conceptId])
    return { runId }
  }

  private async row(runId: string, query=metaDbQuery) {
    const row = (await query<RunRow>(`SELECT r.*,a.reserved_at,t.receipt FROM learning_concept_assessment_runs r
      LEFT JOIN learning_concept_assessment_attempts a USING(run_id) LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.run_id=$1`, [runId])).rows[0]
    if (!row) throw new Error('Assessment run not found')
    return row
  }

  async prepareProvided(userId: string, concept: AssessmentConcept, requestId: string, evidence: AssessmentSource[], prior: LearningConceptAssessment['assessment'], experimentId: string,live=false,
    incremental?: { built: ReturnType<typeof buildConceptAssessmentInput>; revision: string }) {
    const built = incremental?.built ?? buildConceptAssessmentInput(concept,evidence,prior)
    // Live refresh dedupes the actual selected evidence/config, not a new run ID.
    // Experiments deliberately remain independently callable for A/B comparison.
    const inputHash = providedAssessmentHash(built.inputHash,prior,experimentId,live)
    const snapshot: Snapshot = {...built,evidence,prior,experimentId,model:ASSESSMENT_MODEL,promptRevision:incremental?.revision ?? GRADUAL_ASSESSMENT_REVISION,indexStartedAt:new Date().toISOString()}
    const runId = randomUUID()
    const result = await metaDbQuery<{run_id:string}>(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(user_id,request_id) DO NOTHING RETURNING run_id`,
      [runId,userId,requestId,concept.conceptId,built.nodeVersion,inputHash,JSON.stringify(snapshot)])
    if (result.rows[0]) return result.rows[0].run_id
    const previous=(await metaDbQuery<{run_id:string;input_hash:string}>('SELECT run_id,input_hash FROM learning_concept_assessment_runs WHERE user_id=$1 AND request_id=$2',[userId,requestId])).rows[0]
    if (!previous || previous.input_hash!==inputHash) throw new Error('Assessment request ID conflicts with different evidence or configuration')
    return previous.run_id
  }

  async run(runId: string, userId?: string): Promise<LearningAssessmentRun> {
    const row = await this.row(runId)
    if (userId && row.user_id !== userId) throw new Error('Assessment run not found')
    const selected=row.snapshot.experimentId ? (await metaDbQuery<{turns:VectorTurn[];revision:string|null}>(`SELECT selection->'turns' AS turns,e.snapshot#>>'{metadata,selectionRevision}' AS revision
      FROM learning_vector_turn_experiments e,LATERAL jsonb_array_elements(e.snapshot->'selections') selection
      WHERE e.run_id::text=$1 AND e.user_id=$2 AND selection#>>'{concept,conceptId}'=$3`,[row.snapshot.experimentId,row.user_id,row.concept_id])).rows[0] : undefined
    const provenance=row.snapshot.provenance??assessmentEvidenceProvenance(row.snapshot.evidence,selected?{origin:'vector-selection',experimentId:row.snapshot.experimentId!,revision:selected.revision??undefined,turns:selected.turns}:undefined)
    return LearningAssessmentRunSchema.parse({ runId, userId: row.user_id, conceptId: row.concept_id, nodeVersion: row.node_version, inputHash: row.input_hash,
      status: row.receipt?.status ?? (row.reserved_at ? Date.now() - row.reserved_at.getTime() > 450_000 ? 'uncertain' : 'reserved' : 'queued'),
      createdAt: row.created_at.toISOString(), prompt: row.snapshot.prompt, model: row.snapshot.model, evidence: row.snapshot.evidence, provenance, promptRevision: row.snapshot.promptRevision, receipt: row.receipt ?? null })
  }

  async execute(runId: string, query=metaDbQuery) {
    const row = await this.row(runId,query)
    if (row.receipt) return { runId, status: row.receipt.status }
    if (row.reserved_at) return { runId, status: 'uncertain' }
    const unchanged = (await query('SELECT 1 FROM learning_concept_assessment_cache WHERE user_id=$1 AND concept_id=$2 AND input_hash=$3', [row.user_id,row.concept_id,row.input_hash])).rowCount > 0
    const noEvidence = !row.snapshot.evidence.some(item => item.role === 'user' && item.text.trim())
    if (unchanged || noEvidence) {
      await this.receipt(runId, { status: unchanged ? 'unchanged' : 'no_evidence', assessment: null, raw: '', error: null, durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 },query)
      return { runId, status: unchanged ? 'unchanged' : 'no_evidence' }
    }
    const scopeKey = assessmentHash([row.user_id,row.concept_id,row.input_hash])
    const reserved = await query('INSERT INTO learning_concept_assessment_attempts(run_id,scope_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING run_id', [runId, scopeKey])
    if (!reserved.rowCount) {
      // The guard exists so an attempt with an UNKNOWN outcome is never paid for twice. When the identical
      // input already completed, the outcome is known: reuse it, or a cold chain loses that part's estimate,
      // re-prices every later part under a different prior, and never settles.
      const holder = (await query<{ run_id: string; receipt: NonNullable<LearningAssessmentRun['receipt']> | null }>('SELECT a.run_id,t.receipt FROM learning_concept_assessment_attempts a LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.scope_key=$1', [scopeKey])).rows[0]
      if (holder?.receipt?.status === 'completed' && holder.receipt.assessment) {
        await this.receipt(runId, { status: 'unchanged', assessment: holder.receipt.assessment, raw: '', error: null, durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0, reusedRunId: holder.run_id },query)
        return { runId, status: 'unchanged' }
      }
      await this.receipt(runId, { status: 'uncertain', assessment: null, raw: '', error: 'Identical evidence already has a reserved model attempt. Review that receipt before requesting new evidence.', durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 },query)
      return { runId, status: 'uncertain' }
    }
    if (row.snapshot.model.backend === 'typesafe') {
      const receipt = await this.decide(row)
      await this.receipt(runId, receipt, query)
      return { runId, status: receipt.status }
    }
    const started = Date.now()
    let raw = ''
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    const add = (a: number | null, b: unknown) => typeof b === 'number' ? (a ?? 0) + b : a
    const attempt = async (prompt: string) => {
      const parsed = await this.llm.callLLMWithStructuredOutput({ label: `Learning concept assessment ${runId}`, prompt, outputSchema: row.snapshot.schema,
        parseFn: (value: unknown) => { raw = typeof value === 'string' ? value : JSON.stringify(value); return validateGradualAssessment(typeof value === 'string' ? JSON.parse(value) : value, row.snapshot.context) },
        // The immutable receipt must describe the model actually dispatched;
        // defaults belong at preparation, never over an experimental arm here.
        callOptions: { ...row.snapshot.model, onUsage: (usage: Record<string, unknown>) => { inputTokens = add(inputTokens, usage.inputTokens); outputTokens = add(outputTokens, usage.outputTokens) } }, maxParseRetries: row.snapshot.model.maxParseRetries })
      return validateGradualAssessment({ proposals: parsed }, row.snapshot.context)[0]!
    }
    // The grading experiment's B1a retry, measured as part of the shipped v2-cold arm: one retry, only for a
    // rejection the model can repair (a citation or a mis-copied nodeVersion), with the validator error fed back.
    // Tokens and seconds cover both calls.
    const result = await withValidatorRetry(row.snapshot.prompt, attempt, () => raw)
    const retry = result.retried ? { kind: result.retried, recovered: result.ok, firstError: (result.firstError ?? '').slice(0, 300) } : null
    const receipt: NonNullable<LearningAssessmentRun['receipt']> = result.ok
      ? { status: 'completed', assessment: result.value, raw, error: null, durationMs: Date.now()-started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0, validatorRetry: retry }
      : { status: 'failed', assessment: null, raw, error: `Provider call or source validation failed: ${result.error.slice(0, 300)}${result.retried ? ` (after one ${result.retried} retry)` : ''}. No further retry.`, durationMs: Date.now()-started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0, validatorRetry: retry }
    // If this write fails the reservation remains uncertain; never disguise that as a safe retry.
    await this.receipt(runId, receipt,query)
    return { runId, status: receipt.status }
  }

  /** Typed-decision arm: the frozen prompt IS the decision request. HTTP 429 is
   * refused before processing, so only it is retried; every other failure is final. */
  private async decide(row: RunRow): Promise<NonNullable<LearningAssessmentRun['receipt']>> {
    const started = Date.now()
    let raw = '', rateLimitRetries = 0
    const done = (fields: Partial<NonNullable<LearningAssessmentRun['receipt']>>) => ({ status: 'failed', assessment: null, raw, error: null, durationMs: Date.now() - started, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 as const, rateLimitRetries, decision: null, ...fields })
    if (!this.decisions) return done({ error: 'Typed-decision provider not configured' })
    for (;;) {
      try {
        const result = await this.decisions.evaluate({ provider: 'typesafe', model: row.snapshot.model.model }, JSON.parse(row.snapshot.prompt))
        raw = result.raw
        const usage = result.usage as { input_tokens?: unknown; output_tokens?: unknown } | null
        const tokens = (value: unknown) => typeof value === 'number' ? value : null
        return done({ status: 'completed', decision: decisionFromAnswer(result.answers.mastery, result.returnedModel, result.usage), inputTokens: tokens(usage?.input_tokens), outputTokens: tokens(usage?.output_tokens) })
      } catch (error) {
        if (error instanceof TagProviderFailure) raw = error.raw
        if (error instanceof TagProviderFailure && error.message === 'Provider HTTP 429' && rateLimitRetries < 6) { rateLimitRetries++; await Bun.sleep(2000 * rateLimitRetries); continue }
        // A body our validator rejected was still billed; keep its tokens so the spend is visible.
        const bill = jevBilledUsage({ decision: null, raw })
        return done({ error: `Typed-decision call or validation failed: ${error instanceof Error ? error.message : 'unknown'}. No automatic retry.`, ...(bill?.billed ? { inputTokens: bill.inputTokens, outputTokens: bill.outputTokens } : {}) })
      }
    }
  }

  private async receipt(runId: string, receipt: NonNullable<LearningAssessmentRun['receipt']>, query=metaDbQuery) {
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING', [runId, JSON.stringify(receipt)])
  }

  async publish(runId: string) {
    const row = await this.row(runId)
    // Experimental estimates stay scoped to their run, never replacing the live cache.
    if (row.snapshot.experimentId) return {runId,status:row.receipt?.status ?? 'uncertain'}
    if (row.receipt && ['completed','unchanged','no_evidence'].includes(row.receipt.status)) {
      await metaDbQuery('UPDATE learning_concept_assessment_active SET last_indexed_at=GREATEST(COALESCE(last_indexed_at,$3::timestamptz),$3::timestamptz) WHERE user_id=$1 AND concept_id=$2', [row.user_id,row.concept_id,row.snapshot.indexStartedAt])
    }
    if (!row.receipt?.assessment) return { runId, status: row.receipt?.status ?? 'uncertain' }
    if (!nodeVersionMatches(row.node_version, await this.concept(row.concept_id))) return { runId, status: 'stale' }
    const frozenConcept = row.snapshot.context.nodeStates[0]!
    const written = await persistAssessmentCache(metaDbQuery, { userId: row.user_id, concept: frozenConcept, nodeVersion: row.node_version, inputHash: row.input_hash, runId,
      assessment: row.receipt.assessment, completedAt: row.receipt.completedAt })
    return { runId, status: written.rowCount ? 'completed' : 'stale' }
  }

  async due(config: { countThreshold: number; maxAgeMs: number; concurrency: number } = { countThreshold: 20, maxAgeMs: 3_600_000, concurrency: 3 }) {
    if (!Number.isSafeInteger(config.countThreshold) || config.countThreshold < 1 || !Number.isSafeInteger(config.maxAgeMs) || config.maxAgeMs < 1
      || !Number.isSafeInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > 20) throw new Error('Invalid assessment trigger configuration')
    const inflight = (await metaDbQuery<{ count: string }>('SELECT count(*)::text count FROM learning_concept_assessment_runs r LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE t.run_id IS NULL')).rows[0]
    const slots = Math.max(0, config.concurrency - Number(inflight?.count ?? 0))
    if (!slots) return []
    const active = (await metaDbQuery<{ user_id: string; concept_id: string; new_count: string; oldest: Date | null }>(`SELECT a.user_id,a.concept_id,count(m.*)::text new_count,min(m.indexed_at) oldest
      FROM learning_concept_assessment_active a LEFT JOIN learning_semantic_index_messages m ON m.indexed_at > COALESCE(a.last_indexed_at,a.selected_at) AND m.current_canonical=true AND m.status='indexed'
      WHERE NOT EXISTS(SELECT 1 FROM learning_concept_assessment_runs r LEFT JOIN learning_concept_assessment_receipts t USING(run_id)
        WHERE r.user_id=a.user_id AND r.concept_id=a.concept_id AND t.run_id IS NULL)
      GROUP BY a.user_id,a.concept_id HAVING count(m.*)>0 ORDER BY min(m.indexed_at),a.user_id,a.concept_id`)).rows
    return active.filter(item => assessmentTriggerDue({ ...config, newIndexedMessages: Number(item.new_count), oldestPendingAt: item.oldest?.toISOString() ?? null })).slice(0,slots)
      .map(item => ({ userId: item.user_id, conceptId: item.concept_id, requestId: assessmentHash([item.user_id,item.concept_id,item.oldest?.toISOString(),item.new_count]) }))
  }
}
