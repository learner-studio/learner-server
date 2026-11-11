import { randomUUID } from 'node:crypto'
import { metaDbQuery } from '../lib/db-metadata/_shared.js'
import type { LearningCurriculumStore } from './learning-curriculum-store.js'
import type { LearningGraph } from '../functions/learning/learning-seed.js'
import type { LLMService } from '@learner/llm/services/llm-service.js'
import { TagProviderFailure, type TypeSafeDecisionService } from '@learner/llm/services/typesafe-decision-service.js'
import { decisionFromAnswer, jevBilledUsage } from '../lib/learning/learning-mastery-model-comparison.js'
import { GRADUAL_ASSESSMENT_REVISION, validateGradualAssessment } from '../lib/learning/learning-gradual-assessment.js'
import { withValidatorRetry } from '../lib/learning/learning-incremental-grading-experiment.js'
import { priorBlindPrompt, promptCarriesPrior } from '../lib/learning/learning-incremental-assessment.js'
import { isCurrentAssessmentRevision } from '../lib/learning/learning-live-incremental-variant.js'
import { persistAssessmentCache } from '../lib/learning/learning-assessment-persistence.js'
import { ASSESSMENT_MODEL, assessmentHash, assessmentTriggerDue, buildConceptAssessmentInput, nodeVersionMatches, LearningAssessmentRunSchema, type AssessmentConcept, type AssessmentSource, type LearningAssessmentRun, type LearningConceptAssessment } from '../lib/learning/learning-concept-assessment.js'
import { providedAssessmentHash } from '../lib/learning/learning-concept-assessment.js'
import { assessmentEvidenceProvenance, type AssessmentEvidenceProvenance } from '../lib/learning/learning-assessment-evidence.js'
import { VectorTurnConfig, VECTOR_SELECTION_REVISION, assertVectorPromptBudget, type VectorTurn } from '../lib/learning/learning-vector-turns.js'
import type { LearningVectorTurnService } from './learning-vector-turn-service.js'
import { loadLearningPolicy } from '../lib/learning/learning-policy-settings.js'
import { combineReplicates, type Confidence } from '../lib/learning/mastery-change-statistics.js'
import { assessmentAttemptKey, driveAttempt, pgLeaseStore, replicateAttemptKey, type LeaseStore } from '../lib/learning/llm-attempt-lease.js'
import type { DurableCallPlan } from '@learner/llm/lib/cli/durable-cli-call.js'

type Receipt = NonNullable<LearningAssessmentRun['receipt']>
/** A replicate step's outcome: 'skipped' when the run's own grading produced no number to replicate. */
export type ReplicateStatus = 'completed' | 'failed' | 'uncertain' | 'skipped'

type Snapshot = { experimentId?: string; provenance?:AssessmentEvidenceProvenance; prompt: string; schema: ReturnType<typeof buildConceptAssessmentInput>['schema']; context: ReturnType<typeof buildConceptAssessmentInput>['context']; evidence: AssessmentSource[]; prior: LearningConceptAssessment['assessment']; model: LearningAssessmentRun['model']; promptRevision: string; indexStartedAt: string }
type RunRow = { run_id: string; user_id: string; request_id: string; concept_id: string; node_version: string; input_hash: string; snapshot: Snapshot; created_at: Date; reserved_at: Date | null; receipt: LearningAssessmentRun['receipt'] }
export function conceptFromGraphs(graphs: LearningGraph[], conceptId: string): AssessmentConcept {
  const concept = graphs.flatMap(graph => graph.concepts).find(item => item.id === conceptId)
  if (!concept) throw new Error('Unknown Learning concept')
  return { conceptId, title: concept.title, description: concept.summary + '\n' + concept.explanation,
    objectives: [...new Set(graphs.flatMap(graph => graph.curriculum.modules.filter(module => module.conceptIds.includes(conceptId)).flatMap(module => module.masteryGoals)))].sort() }
}

/** Retrieval is replaceable; the assessment contract and immutable evidence are not. */
/** Receipt error prefix: the identical evidence already failed a paid grading, so this part settles with no estimate. */
export const IDENTICAL_EVIDENCE_FAILED = 'Identical evidence already failed a paid grading'
/** Receipt error prefix: the identical evidence has a reserved paid attempt with no receipt (outcome unknown). */
export const IDENTICAL_EVIDENCE_UNKNOWN = 'Identical evidence already has a reserved model attempt'
/**
 * A failed paid attempt that says nothing about the evidence: the provider or the CLI failed (a crash, a timeout,
 * HTTP 429/5xx, unparseable output, the generic telemetry error). Identical evidence gets ONE fresh paid attempt
 * after it (round-7 R7-S2): its outcome is known and nothing usable was bought, so this is not paying twice for an
 * unknown outcome. A validator rejecting what the model wrote is about the evidence and stays a known failure.
 * On dev 2026-11-11 the first kind held 1,792 of 2,012 failed holders (1,566 "codex CLI exited" from 10-22..10-27).
 * The marker must OPEN the failure text (round-8 R8-S1): a validator message that cites a concept or source id
 * containing a marker word ("...--timeout-...") is about the evidence, and an unanchored match bought it a paid retry.
 */
export const isProviderFailure = (receipt: { status: string; error: string | null } | null | undefined) =>
  receipt?.status === 'failed' && /failed(: (LLM_ERROR|LLM_PARSE_ERROR|Provider HTTP (429|5\d\d)\b|The operation timed out|ECONNRESET)|; consult shared LLM telemetry)/.test(receipt.error ?? '')

export class LearningConceptAssessmentService {
  readonly reactiveRevision='reactive-v1'
  /** `leases`: where attempt leases live (llm-attempt-lease.ts); Postgres through the call's query function unless a test fakes it. */
  constructor(private readonly curricula: LearningCurriculumStore, private readonly llm: LLMService, private readonly decisions?: Pick<TypeSafeDecisionService,'evaluate'>,
    private readonly leases: (query: typeof metaDbQuery) => LeaseStore = pgLeaseStore) {}

  async list(userId: string): Promise<Array<LearningConceptAssessment & { sourceIds: string[] }>> {
    const rows = (await metaDbQuery<{ concept_id: string; node_version: string; assessment: LearningConceptAssessment['assessment']; run_id: string; assessed_at: Date; pending: boolean; source_ids: string[]; prompt_revision:string|null }>(
      `SELECT c.concept_id,c.node_version,c.assessment,c.run_id,c.assessed_at,
        d.prompt_revision,COALESCE(d.evidence_ids,'{}') source_ids,
        (EXISTS(SELECT 1 FROM learning_reactive_targets target JOIN learning_reactive_admission admission USING(user_id,session_id)
          WHERE target.user_id=c.user_id AND target.concept_id=c.concept_id AND admission.requested_generation>admission.captured_generation)
        OR (NOT EXISTS(SELECT 1 FROM learning_reactive_settings WHERE user_id=c.user_id AND enabled) AND EXISTS(SELECT 1 FROM learning_concept_assessment_active a
        JOIN learning_semantic_index_messages m ON m.current_canonical AND m.status='indexed' AND m.indexed_at>COALESCE(a.last_indexed_at,a.selected_at)
        WHERE a.user_id=c.user_id AND a.concept_id=c.concept_id))) pending FROM learning_concept_assessment_cache c LEFT JOIN learning_concept_assessment_run_digests d USING(run_id) WHERE c.user_id=$1`, [userId])).rows
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
      `SELECT c.assessment,c.run_id,c.node_version,c.assessed_at,d.prompt_revision FROM learning_concept_assessment_cache c
       JOIN learning_concept_assessment_run_digests d USING(run_id) WHERE c.user_id=$1 AND c.concept_id=$2`, [userId, conceptId])).rows[0]
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
    // Reserved earlier with no receipt: a restart killed the process during the call, or another delivery of this
    // step is running it. The lease decides: wait for a live owner, finish it for a dead one (repeat-free backend),
    // or refuse as before (metered).
    if (row.reserved_at) return this.driveReserved(row, query)
    // The cache holds the MERGED published estimate; a chain continues from the producing run's raw one.
    const cached = (await query<{ run_id: string; receipt: NonNullable<LearningAssessmentRun['receipt']> | null }>('SELECT c.run_id,t.receipt FROM learning_concept_assessment_cache c LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE c.user_id=$1 AND c.concept_id=$2 AND c.input_hash=$3', [row.user_id,row.concept_id,row.input_hash])).rows[0]
    const unchanged = !!cached
    const noEvidence = !row.snapshot.evidence.some(item => item.role === 'user' && item.text.trim())
    if (unchanged || noEvidence) {
      const reused = unchanged && cached.receipt?.assessment ? { assessment: cached.receipt.assessment, reusedRunId: cached.run_id } : { assessment: null }
      await this.receipt(runId, { status: unchanged ? 'unchanged' : 'no_evidence', ...reused, raw: '', error: null, durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 },query)
      return { runId, status: unchanged ? 'unchanged' : 'no_evidence' }
    }
    const scopeKey = assessmentHash([row.user_id,row.concept_id,row.input_hash])
    const reserve = (key: string) => query('INSERT INTO learning_concept_assessment_attempts(run_id,scope_key) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING run_id', [runId, key])
    const holderOf = async (key: string) => (await query<{ run_id: string; receipt: NonNullable<LearningAssessmentRun['receipt']> | null }>('SELECT a.run_id,t.receipt FROM learning_concept_assessment_attempts a LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.scope_key=$1', [key])).rows[0]
    // The holder of a scope, with its outcome REPAIRED first where it can be: an unreceipted holder's call is waited
    // for (live owner) or finished for its dead owner on a repeat-free backend (restart-safety.md); its receipt then
    // decides below like any other. Only a metered holder, or one whose takeover budget is spent, stays unknown.
    const settledHolder = async (key: string) => {
      const holder = await holderOf(key)
      if (!holder || holder.receipt) return holder
      await this.driveReserved(await this.row(holder.run_id, query), query)
      return holderOf(key)
    }
    let reserved = await reserve(scopeKey)
    if (!reserved.rowCount) {
      // The guard exists so an attempt with an UNKNOWN outcome is never paid for twice. When the identical
      // input already completed, the outcome is known: reuse it, or a cold chain loses that part's estimate,
      // re-prices every later part under a different prior, and never settles.
      let holder = await settledHolder(scopeKey)
      // A provider-side failure bought nothing and says nothing about the evidence: one fresh attempt (R7-S2).
      if (isProviderFailure(holder?.receipt)) {
        reserved = await reserve(`${scopeKey}:retry`)
        if (!reserved.rowCount) holder = await settledHolder(`${scopeKey}:retry`)
      }
      if (!reserved.rowCount) {
        if (holder?.receipt?.status === 'completed' && holder.receipt.assessment) {
          await this.receipt(runId, { status: 'unchanged', assessment: holder.receipt.assessment, raw: '', error: null, durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0, reusedRunId: holder.run_id },query)
          return { runId, status: 'unchanged' }
        }
        // A FAILED holder (a validator rejection, or the fresh attempt failing too) is a known outcome: the pass
        // settles with no reading for this part instead of retrying for ever (round 7); new evidence grades it again.
        if (holder?.receipt?.status === 'failed') {
          await this.receipt(runId, { status: 'failed', assessment: null, raw: '', error: `${IDENTICAL_EVIDENCE_FAILED} (run ${holder.run_id}); not paid again, graded again when new evidence arrives.`, durationMs: 0, inputTokens: 0, outputTokens: 0, completedAt: new Date().toISOString(), masteryWrites: 0, reusedRunId: holder.run_id },query)
          return { runId, status: 'failed' }
        }
        // Still no receipt (metered, or takeovers spent), or one with no reusable estimate that is not a failure
        // (uncertain, a typed decision): the outcome for THIS evidence is unknown. Never pay twice; the breaker reviews it.
        await this.receipt(runId, { status: 'uncertain', assessment: null, raw: '', error: `${IDENTICAL_EVIDENCE_UNKNOWN} (run ${holder?.run_id ?? 'unknown'}, ${holder?.receipt?.status ?? 'no receipt'}). Review that run before requesting new evidence.`, durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 },query)
        return { runId, status: 'uncertain' }
      }
    }
    return this.driveReserved(row, query, true)
  }

  /**
   * Execute a reserved attempt under its lease (llm-attempt-lease.ts) and record its receipt insert-once. `fresh`:
   * this call wrote the reservation a moment ago. A refused claim (metered backend with an unknown outcome, or the
   * takeover budget spent) writes nothing and answers 'uncertain', the rule this replaced for every backend.
   */
  private async driveReserved(row: RunRow, query = metaDbQuery, fresh = false): Promise<{ runId: string; status: string }> {
    const runId = row.run_id
    const outcome = await driveAttempt(this.leases(query), {
      key: assessmentAttemptKey(runId), backend: row.snapshot.model.backend, fresh, reservedAt: row.reserved_at,
      settled: async () => !!(await this.row(runId, query)).receipt,
      work: (durable) => row.snapshot.model.backend === 'typesafe' ? this.decide(row) : this.grade(row, `Learning concept assessment ${runId}`, undefined, durable),
      // If this write fails the lease lapses and the attempt is finished again (free) or stays unknown (metered).
      record: (receipt) => this.receipt(runId, receipt, query),
    })
    if (outcome.kind === 'refused') return { runId, status: 'uncertain' }
    // The stored receipt is the truth (an insert-once write may have lost to a concurrent one); a recorded value
    // whose row is not visible yet still answers with what was written.
    const stored = (await this.row(runId, query)).receipt?.status
    return { runId, status: stored ?? (outcome.kind === 'recorded' ? outcome.value.status : 'uncertain') }
  }

  /**
   * One paid grading of a prompt prepared outside any run (the weekly drift panel, grader-drift-panel.ts): the
   * same model call, validator and one repair retry as a run's grading, and no run, receipt or reading is written.
   * The caller holds the reservation that keeps it from being paid twice.
   */
  async gradePrepared(input: Pick<Snapshot, 'prompt' | 'schema' | 'context' | 'model'>, label: string, durable?: DurableCallPlan): Promise<Receipt> {
    return this.grade({ snapshot: input }, label, undefined, durable)
  }

  /** One paid model grading of a run's frozen prompt (or `prompt`, a variant of it). The caller holds the reservation that keeps it from being paid twice. */
  private async grade(row: { snapshot: Pick<Snapshot, 'prompt' | 'schema' | 'context' | 'model'> }, label: string, prompt = row.snapshot.prompt, durable?: DurableCallPlan): Promise<NonNullable<LearningAssessmentRun['receipt']>> {
    const started = Date.now()
    let raw = ''
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    const add = (a: number | null, b: unknown) => typeof b === 'number' ? (a ?? 0) + b : a
    const attempt = async (prompt: string) => {
      const parsed = await this.llm.callLLMWithStructuredOutput({ label, prompt, outputSchema: row.snapshot.schema,
        parseFn: (value: unknown) => { raw = typeof value === 'string' ? value : JSON.stringify(value); return validateGradualAssessment(typeof value === 'string' ? JSON.parse(value) : value, row.snapshot.context) },
        // The immutable receipt must describe the model actually dispatched;
        // defaults belong at preparation, never over an experimental arm here.
        callOptions: { ...row.snapshot.model, ...(durable ? { durable } : {}), onUsage: (usage: Record<string, unknown>) => { inputTokens = add(inputTokens, usage.inputTokens); outputTokens = add(outputTokens, usage.outputTokens) } }, maxParseRetries: row.snapshot.model.maxParseRetries })
      return validateGradualAssessment({ proposals: parsed }, row.snapshot.context)[0]!
    }
    // The grading experiment's B1a retry, measured as part of the shipped v2-cold arm: one retry, only for a
    // rejection the model can repair (a citation or a mis-copied nodeVersion), with the validator error fed back.
    // Tokens and seconds cover both calls.
    const result = await withValidatorRetry(prompt, attempt, () => raw)
    const retry = result.retried ? { kind: result.retried, recovered: result.ok, firstError: (result.firstError ?? '').slice(0, 300) } : null
    return result.ok
      ? { status: 'completed', assessment: result.value, raw, error: null, durationMs: Date.now()-started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0, validatorRetry: retry }
      : { status: 'failed', assessment: null, raw, error: `Provider call or source validation failed: ${result.error.slice(0, 300)}${result.retried ? ` (after one ${result.retried} retry)` : ''}. No further retry.`, durationMs: Date.now()-started, inputTokens, outputTokens, completedAt: new Date().toISOString(), masteryWrites: 0, validatorRetry: retry }
  }

  // --- Replicate grading (docs/specs/mastery-change-statistics.md, policy gradingReplicates) ---------

  /**
   * Before a live reading's grading: when the policy asks for k > 1 gradings, record the plan, which
   * keeps the reading out of learning_mastery_readings until its summary exists (so it is published
   * once, already averaged). k is read once and stored: a replayed step returns the stored plan.
   * Experiment runs and typed-decision arms are never replicated. Returns the extra gradings 2..k.
   */
  async planReplicates(runId: string, query = metaDbQuery): Promise<{ runId: string; replicates: number[] }> {
    const stored = (await query<{ replicates: number }>('SELECT replicates FROM learning_concept_assessment_replicate_plans WHERE run_id=$1', [runId])).rows[0]
    const range = (k: number) => Array.from({ length: k - 1 }, (_, i) => i + 2)
    if (stored) return { runId, replicates: range(stored.replicates) }
    const k = (await loadLearningPolicy(query)).gradingReplicates
    if (k <= 1) return { runId, replicates: [] }
    const row = await this.row(runId, query)
    if (row.snapshot.model.backend === 'typesafe') return { runId, replicates: [] }
    // A plan made after the reading was published would hide it again. A manual run publishes with its
    // receipt, so it is planned before grading; a pass part publishes when its pass completes, so it
    // can be planned after grading, until then.
    if (row.snapshot.experimentId) {
      const pass = (await query<{ live: boolean; status: string }>(`SELECT config->>'purpose'='live' AS live, status FROM learning_vector_turn_experiments WHERE run_id::text=$1`, [row.snapshot.experimentId])).rows[0]
      if (!pass?.live || pass.status === 'completed') return { runId, replicates: [] }
    } else if (row.receipt) return { runId, replicates: [] }
    await query('INSERT INTO learning_concept_assessment_replicate_plans(run_id,replicates) VALUES($1,$2) ON CONFLICT DO NOTHING', [runId, k])
    const planned = (await query<{ replicates: number }>('SELECT replicates FROM learning_concept_assessment_replicate_plans WHERE run_id=$1', [runId])).rows[0]!
    return { runId, replicates: range(planned.replicates) }
  }

  /**
   * One extra PRIOR-BLIND grading of the run's evidence (grading `replicate` of k): the frozen prompt
   * with its current estimate withheld (`priorBlindPrompt`), so the grading is truth plus independent
   * noise and not a copy of the prior (review B1). Reserved before the model call: a replay finds the
   * receipt and returns it; a reservation with no receipt is driven through its lease (a live owner is
   * waited for, a dead one's call finished when the backend is repeat-free) and recorded as uncertain
   * only when that is refused. A late receipt still replaces an 'uncertain' stamp (review S5).
   */
  async executeReplicate(runId: string, replicate: number, query = metaDbQuery): Promise<{ runId: string; replicate: number; status: ReplicateStatus }> {
    const existing = (await query<{ receipt: Receipt | null; reserved_at: Date }>('SELECT receipt,reserved_at FROM learning_concept_assessment_replicates WHERE run_id=$1 AND replicate=$2', [runId, replicate])).rows[0]
    const uncertain = async () => {
      const receipt: Receipt = { status: 'uncertain', assessment: null, raw: '', error: 'A replicate grading was reserved and never recorded (the process stopped during the call) on a backend that is never repeated without a receipt, or after its takeover budget; it is not repeated.', durationMs: 0, inputTokens: null, outputTokens: null, completedAt: new Date().toISOString(), masteryWrites: 0 }
      await query('UPDATE learning_concept_assessment_replicates SET receipt=$3::jsonb WHERE run_id=$1 AND replicate=$2 AND receipt IS NULL', [runId, replicate, JSON.stringify(receipt)])
      return { runId, replicate, status: 'uncertain' as const }
    }
    // An 'uncertain' stamp is not final while the call it gave up on may still record (S5): it goes through the
    // lease like a bare reservation, and a refusal keeps it.
    if (existing?.receipt && existing.receipt.status !== 'uncertain') return { runId, replicate, status: existing.receipt.status as ReplicateStatus }
    const row = await this.row(runId, query)
    let fresh = false
    if (!existing) {
      if (row.receipt?.status !== 'completed' || typeof row.receipt.assessment?.understandingPercent !== 'number') return { runId, replicate, status: 'skipped' }
      fresh = ((await query('INSERT INTO learning_concept_assessment_replicates(run_id,replicate) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING run_id', [runId, replicate])).rowCount ?? 0) > 0
    }
    // A reservation with no receipt (a restart, or a concurrent delivery) goes through the lease: waited for while
    // its owner lives, finished for a dead owner on a repeat-free backend, 'uncertain' only when that is refused.
    const outcome = await driveAttempt(this.leases(query), {
      key: replicateAttemptKey(runId, replicate), backend: row.snapshot.model.backend, fresh, reservedAt: existing?.reserved_at ?? new Date(),
      settled: async () => (await query(`SELECT 1 FROM learning_concept_assessment_replicates WHERE run_id=$1 AND replicate=$2 AND receipt IS NOT NULL AND receipt->>'status' <> 'uncertain'`, [runId, replicate])).rowCount > 0,
      work: (durable) => this.grade(row, `Learning concept assessment ${runId} replicate ${replicate}`, priorBlindPrompt(row.snapshot.prompt), durable),
      record: async (receipt) => { await query(`UPDATE learning_concept_assessment_replicates SET receipt=$3::jsonb WHERE run_id=$1 AND replicate=$2 AND (receipt IS NULL OR receipt->>'status' = 'uncertain')`, [runId, replicate, JSON.stringify(receipt)]) },
    })
    if (outcome.kind === 'refused') return uncertain()
    const recorded = (await query<{ receipt: Receipt | null }>('SELECT receipt FROM learning_concept_assessment_replicates WHERE run_id=$1 AND replicate=$2', [runId, replicate])).rows[0]?.receipt
    return { runId, replicate, status: (recorded?.status ?? 'uncertain') as ReplicateStatus }
  }

  /**
   * Publish a planned reading: the reading itself is the run's own (live) grading; the summary is its
   * PRIOR-BLIND measurement, combined from the blind replicates plus the run's own grading when its
   * prompt carried no numeric prior: the raw mean (grid value for display), the spread, the median
   * confidence, and what all the run's gradings cost. An unchanged copy takes the summary of the run
   * it copied. Idempotent: the first summary stays.
   */
  async combineReplicates(runId: string, query = metaDbQuery): Promise<{ runId: string; replicates: number; meanPercent: number | null }> {
    const done = async () => {
      const s = (await query<{ replicates: number; mean_percent: string | null }>('SELECT replicates, mean_percent FROM learning_concept_assessment_replicate_summaries WHERE run_id=$1', [runId])).rows[0]
      return { runId, replicates: s?.replicates ?? 0, meanPercent: s?.mean_percent == null ? null : Number(s.mean_percent) }
    }
    const planned = (await query('SELECT 1 FROM learning_concept_assessment_replicate_plans WHERE run_id=$1', [runId])).rowCount
    if (!planned || (await done()).replicates) return done()
    const row = await this.row(runId, query)
    const reused = row.receipt?.status === 'unchanged' ? row.receipt.reusedRunId : undefined
    if (reused) {
      const copied = await query(`INSERT INTO learning_concept_assessment_replicate_summaries(run_id,replicates,mean_percent,display_percent,sd,min_percent,max_percent,confidence,input_tokens,output_tokens,duration_ms)
        SELECT $1,replicates,mean_percent,display_percent,sd,min_percent,max_percent,confidence,0,0,0 FROM learning_concept_assessment_replicate_summaries WHERE run_id=$2
        ON CONFLICT DO NOTHING`, [runId, reused])
      if (copied.rowCount) return done()
    }
    const replicas = (await query<{ receipt: Receipt | null }>('SELECT receipt FROM learning_concept_assessment_replicates WHERE run_id=$1 ORDER BY replicate', [runId])).rows.map((r) => r.receipt).filter((r): r is Receipt => !!r)
    const receipts = [row.receipt, ...replicas].filter((r): r is Receipt => !!r)
    const blind = [...(promptCarriesPrior(row.snapshot) || row.receipt?.status !== 'completed' ? [] : [row.receipt]), ...replicas]
    const graded = blind.filter((r) => (r.status === 'completed' || r.status === 'unchanged') && r.assessment)
      .map((r) => ({ percent: r.assessment!.understandingPercent ?? null, confidence: r.assessment!.confidence as Confidence }))
    const combined = combineReplicates(graded)
    const sum = (pick: (r: Receipt) => number | null) => receipts.reduce((a, r) => a + (pick(r) ?? 0), 0)
    // The cost covers the gradings this run paid for: a copy paid nothing.
    const paid = receipts.filter((r) => r.status !== 'unchanged')
    await query(`INSERT INTO learning_concept_assessment_replicate_summaries(run_id,replicates,mean_percent,display_percent,sd,min_percent,max_percent,confidence,input_tokens,output_tokens,duration_ms)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [runId, combined?.replicates ?? 0, combined?.meanPercent ?? null, combined?.displayPercent ?? null, combined?.sd ?? null, combined?.min ?? null, combined?.max ?? null,
        combined?.confidence ?? null,
        paid.length ? sum((r) => paid.includes(r) ? r.inputTokens : 0) : 0, paid.length ? sum((r) => paid.includes(r) ? r.outputTokens : 0) : 0, sum((r) => paid.includes(r) ? r.durationMs : 0)])
    return done()
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
