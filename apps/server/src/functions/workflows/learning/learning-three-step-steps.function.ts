import { defineSessionlessFunction } from '../../../runtime/define.js'
import { repoRoot } from '@learner/core/lib/repo-root.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'

import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { THREE_STEP_DEADLINE_MS, THREE_STEP_EFFORT, THREE_STEP_MODEL, THREE_STEP_STRATEGY,
  threeStepAssessmentPrompt, threeStepAssessmentSchema, validateThreeStepAssessment } from '@learner/core/lib/learning/learning-three-step-proof.js'

const Input = z.object({ runId: z.string().uuid(), maxBatchTokens: z.number().int().positive().max(400_000).default(400_000) })
const Output = z.record(z.string(), z.unknown())
export const PreflightLearningThreeStepProofInput = Input
export const PreflightLearningThreeStepProofOutput = Output
export const RunLearningThreeStepConsolidationInput = Input
export const RunLearningThreeStepConsolidationOutput = Output
export const RunLearningThreeStepAssessmentInput = Input
export const RunLearningThreeStepAssessmentOutput = Output
export const FinalizeLearningThreeStepProofInput = Input
export const FinalizeLearningThreeStepProofOutput = Output
const execFileAsync = promisify(execFile)

type ProofConfig = { contextStrategy?: string; privateInputPath?: string; inputSha256?: string; consolidationOutputPath?: string; assessmentOutputPath?: string;
  sourceExtractionRunId?: string; nodeStates?: unknown[]; conceptCount?: number; matchCount?: number; nodeStateBaseline?: string;
  nodeStateBaselineLimitation?: string; consolidationValidatedPath?: string; callAudit?: Array<{ step?: string; state?: string }>; maxBatchTokens?: number }
const load = async (runId: string, maxBatchTokens: number) => {
  const row = (await metaDbQuery<{ status: string; count: string; config: ProofConfig; summary: Record<string, unknown> | null }>(`SELECT r.status,count(c.*)::text count,r.config,r.summary
    FROM learning_extraction_benchmark_runs r LEFT JOIN learning_extraction_benchmark_cases c ON c.run_id=r.run_id
    WHERE r.run_id=$1 GROUP BY r.run_id`, [runId])).rows[0]
  if (!row || row.config.contextStrategy !== THREE_STEP_STRATEGY || row.config.maxBatchTokens !== maxBatchTokens || Number(row.count) !== 100 || row.config.matchCount !== 49 || row.config.conceptCount !== 34
    || !row.config.privateInputPath || !row.config.inputSha256 || !row.config.consolidationOutputPath || !row.config.assessmentOutputPath) throw new Error('Three-step proof is not the frozen 100-case/49-match input')
  return row
}
const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T
const appendAudit = (runId: string, value: unknown) => metaDbQuery(`UPDATE learning_extraction_benchmark_runs
  SET config=jsonb_set(config,'{callAudit}',COALESCE(config->'callAudit','[]'::jsonb) || $2::jsonb),status='running' WHERE run_id=$1`, [runId, JSON.stringify([value])])
const reserveAttempt = async (runId: string, step: string) => {
  const value = { step, state: 'started', attempt: 1, model: THREE_STEP_MODEL, effort: THREE_STEP_EFFORT, deadlineMs: THREE_STEP_DEADLINE_MS }
  const reserved = await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET
    config=jsonb_set(config,'{callAudit}',COALESCE(config->'callAudit','[]'::jsonb) || $3::jsonb),status='running'
    WHERE run_id=$1 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(config->'callAudit','[]'::jsonb)) a
      WHERE a->>'step'=$2 AND a->>'state'='started') RETURNING run_id`, [runId, step, JSON.stringify([value])])
  if (reserved.rows.length !== 1) throw new Error(`${step} attempt was already reserved; refusing a concurrent or hidden retry`)
}
const persistFailure = (runId: string, error: unknown) => metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='failed',completed_at=now(),
  summary=jsonb_build_object('proof','hindsight-native-consolidation-node-assessment','terminalState','failed','error',$2::text,'masteryWrites',0)
  WHERE run_id=$1`, [runId, error instanceof Error ? error.message : String(error)])

export const preflightLearningThreeStepProof = defineSessionlessFunction({
  title: 'Preflight frozen Hindsight three-step proof', description: 'Verify the accepted adapter-v2 source, frozen node states, native one-call preflight, and zero-call boundary.',
  input: PreflightLearningThreeStepProofInput, output: PreflightLearningThreeStepProofOutput,
  func: async (_services, { runId, maxBatchTokens }) => {
    const { config } = await load(runId, maxBatchTokens)
    const bytes = await readFile(config.privateInputPath!)
    if (createHash('sha256').update(bytes).digest('hex') !== config.inputSha256) throw new Error('Frozen three-step input hash drift')
    const source = (await metaDbQuery<{ config: { hindsightAudit?: unknown[] } }>('SELECT config FROM learning_extraction_benchmark_runs WHERE run_id=$1 AND status=\'completed\'', [config.sourceExtractionRunId])).rows[0]
    const reconciled = [...(source?.config.hindsightAudit ?? [])].reverse().find((item: any) => item?.state === 'reconciled') as any
    if (reconciled?.adapterRevision !== 'hindsight-native-list-v2' || reconciled?.validRows !== 100 || reconciled?.mappedMatches !== 49
      || reconciled?.unmappableFacts !== 0 || reconciled?.newModelCalls !== 0) throw new Error('Source is not the accepted zero-call adapter-v2 reconciliation')
    const preflightPath = config.consolidationOutputPath!.replace('consolidation-raw-', 'consolidation-preflight-')
    const preflight = await json<{ terminalState?: string; zeroModelCalls?: boolean; inputDigest?: string; feed?: { itemCount?: number }; scopes?: unknown[];
      expectedConsolidationBatchUpperBound?: number; budget?: { estimatedInputTokens?: number; effectiveInputCeilingTokens?: number; plannedNativeCalls?: number; adaptiveBisectionPossible?: boolean };
      lineage?: { assessmentMustRereadFrozenEvidence?: boolean; nativeGranularity?: string } }>(preflightPath)
    if (preflight.terminalState !== 'ready' || preflight.zeroModelCalls !== true || preflight.feed?.itemCount !== 1 || preflight.scopes?.length !== 1
      || preflight.expectedConsolidationBatchUpperBound !== 1 || preflight.budget?.plannedNativeCalls !== 1 || preflight.budget.adaptiveBisectionPossible !== false
      || !preflight.budget.estimatedInputTokens || !preflight.budget.effectiveInputCeilingTokens || preflight.budget.estimatedInputTokens > preflight.budget.effectiveInputCeilingTokens
      || preflight.lineage?.assessmentMustRereadFrozenEvidence !== true || preflight.lineage.nativeGranularity !== 'bundled-feed-source-memory') {
      throw new Error('Native consolidation preflight does not prove a single bounded call and frozen-evidence reread')
    }
    return { ready: true, zeroModelCalls: true, inputSha256: config.inputSha256, preflightPath }
  },
})

export const runLearningThreeStepConsolidation = defineSessionlessFunction({
  title: 'Run native Hindsight consolidation', description: 'Feed the frozen derived evidence and node state to one isolated native Hindsight consolidation call.',
  input: RunLearningThreeStepConsolidationInput, output: RunLearningThreeStepConsolidationOutput,
  func: async (_services, { runId, maxBatchTokens }) => {
    const { config } = await load(runId, maxBatchTokens)
    const prior = config.callAudit ?? []
    const validatedPath = config.consolidationValidatedPath ?? config.consolidationOutputPath!
    let pendingResume = false
    try {
      const existing = await json<{ terminalState?: string; operationId?: string; metrics?: unknown; timing?: unknown; adapted?: { validationFailures?: unknown[] } }>(validatedPath)
      const nativePreflight = await json<{ inputDigest?: string }>(config.consolidationOutputPath!.replace('consolidation-raw-', 'consolidation-preflight-'))
      if (existing.terminalState === 'success' && (existing.adapted?.validationFailures?.length ?? 0) === 0
        && (existing as any).preflight?.inputDigest === nativePreflight.inputDigest) {
        if (!prior.some(item => item.step === 'consolidation' && item.state === 'completed')) {
          if (!prior.some(item => item.step === 'consolidation' && item.state === 'started')) throw new Error('Successful consolidation artifact has no reserved attempt')
          await appendAudit(runId, { step: 'consolidation', state: 'completed', attempt: 1, recoveredFromArtifact: true, metrics: existing.metrics, timing: existing.timing })
        }
        return { replayed: true, newModelCalls: 0, recoveredFromArtifact: true }
      }
      pendingResume = existing.terminalState === 'pending' && typeof existing.operationId === 'string' && existing.operationId.length > 0
    } catch { /* no terminal artifact */ }
    const alreadyReserved = prior.some(item => item.step === 'consolidation' && item.state === 'started')
    if (alreadyReserved && !pendingResume) throw new Error('Consolidation attempt reserved without an acknowledged operation checkpoint; refusing hidden retry')
    if (!alreadyReserved) await reserveAttempt(runId, 'consolidation')
    try { await execFileAsync('/opt/biztools-hindsight/venv/bin/python', ['scripts/hindsight/learning-seed-v1-hindsight-consolidation.py', '--input', config.privateInputPath!,
      '--output', config.consolidationOutputPath!, '--base-url', 'http://127.0.0.1:18923', '--poll-seconds', '900', '--max-batch-tokens', String(maxBatchTokens)], { cwd: repoRoot, timeout: 900_000, maxBuffer: 64 * 1024 }) } catch { /* terminal artifact is authoritative */ }
    const result = await json<{ terminalState?: string; error?: string; metrics?: unknown; timing?: unknown; adapted?: { validationFailures?: unknown[] } }>(config.consolidationOutputPath!)
    const success = result.terminalState === 'success' && (result.adapted?.validationFailures?.length ?? 0) === 0
    await appendAudit(runId, { step: 'consolidation', state: success ? 'completed' : 'failed', attempt: 1, error: result.error ?? null, metrics: result.metrics, timing: result.timing })
    if (!success) { const error = new Error(result.error ?? 'Native consolidation failed deterministic validation'); await persistFailure(runId, error); throw error }
    return { completed: true, metrics: result.metrics, timing: result.timing }
  },
})

export const runLearningThreeStepAssessment = defineSessionlessFunction({
  title: 'Run review-only Learning node assessment', description: 'Propose unchanged or improvement from native consolidation, frozen node state, and authoritative sources without mastery writes.',
  input: RunLearningThreeStepAssessmentInput, output: RunLearningThreeStepAssessmentOutput,
  func: async ({ llmService }, { runId, maxBatchTokens }) => {
    const { config } = await load(runId, maxBatchTokens)
    const prior = config.callAudit ?? []
    try {
      const existing = await json<{ terminalState?: string; proposals?: unknown[]; durationMs?: number; inputTokens?: number | null; outputTokens?: number | null;
        inputSha256?: string; model?: string; effort?: string }>(config.assessmentOutputPath!)
      if (existing.terminalState === 'success' && existing.inputSha256 === config.inputSha256 && existing.model === THREE_STEP_MODEL && existing.effort === THREE_STEP_EFFORT) {
        if (!prior.some(item => item.step === 'assessment' && item.state === 'completed')) {
          if (!prior.some(item => item.step === 'assessment' && item.state === 'started')) throw new Error('Successful assessment artifact has no reserved attempt')
          await appendAudit(runId, { step: 'assessment', state: 'completed', attempt: 1, recoveredFromArtifact: true, durationMs: existing.durationMs,
            inputTokens: existing.inputTokens, outputTokens: existing.outputTokens, proposalCount: existing.proposals?.length ?? 0, masteryWrites: 0 })
        }
        return { replayed: true, newModelCalls: 0, recoveredFromArtifact: true }
      }
    } catch { /* no terminal artifact */ }
    if (prior.some(item => item.step === 'assessment' && item.state === 'started')) throw new Error('Assessment attempt reserved without terminal receipt; refusing hidden retry')
    const [input, consolidation] = await Promise.all([json<any>(config.privateInputPath!), json<any>(config.consolidationValidatedPath ?? config.consolidationOutputPath!)])
    const matchedCases = input.cases.filter((item: any) => item.classification?.matches?.length)
    const frozenEvidenceByConcept: Record<string, Array<{ sourceId: string; relationship: string }>> = {}
    for (const item of matchedCases) for (const match of item.classification.matches) (frozenEvidenceByConcept[match.conceptId] ??= []).push({ sourceId: item.current.id, relationship: match.relationship })
    const conceptIds = input.nodeStates.map((state: any) => state.conceptId).sort()
    const nativeObservations = consolidation.native?.observations?.body?.items
    if (!Array.isArray(nativeObservations) || nativeObservations.length === 0 || (consolidation.adapted?.validationFailures?.length ?? 0) !== 0) {
      const error = new Error('Assessment requires deterministically validated native observation text'); await persistFailure(runId, error); throw error
    }
    const evidenceByConcept = Object.fromEntries(Object.entries(frozenEvidenceByConcept).map(([conceptId, evidence]) => [conceptId,
      evidence.filter(item => nativeObservations.some((observation: unknown) => {
        const text = JSON.stringify(observation)
        return text.includes(conceptId) && text.includes(item.sourceId)
      }))]))
    const prompt = threeStepAssessmentPrompt({ consolidation: { adapter: consolidation.adapted, nativeObservations }, nodeStates: input.nodeStates,
      nativeLinkedEvidenceByConcept: evidenceByConcept,
      evidence: matchedCases.map((item: any) => ({ caseId: item.caseId, current: item.current, response: item.response, matches: item.classification.matches })) })
    const outputSchema = threeStepAssessmentSchema(conceptIds)
    const promptBytes = Buffer.byteLength(prompt), schemaBytes = Buffer.byteLength(JSON.stringify(outputSchema))
    const conservativeInputTokenUpperBound = promptBytes + schemaBytes + 1_024
    const requestedInputCeilingTokens = maxBatchTokens
    const effectiveInputCeilingTokens = Math.min(requestedInputCeilingTokens, 194_400)
    if (conservativeInputTokenUpperBound > effectiveInputCeilingTokens) throw new Error('Assessment prompt exceeds the configured effective input-token ceiling')
    await reserveAttempt(runId, 'assessment')
    await appendAudit(runId, { step: 'assessment-preflight', state: 'completed', attempt: 0,
      promptSha256: createHash('sha256').update(prompt).digest('hex'), promptBytes, schemaBytes, conservativeInputTokenUpperBound,
      effectiveInputCeilingTokens, requestedInputCeilingTokens, reservedOutputReasoningTokens: 64_000, nativeObservationCount: nativeObservations.length })
    const started = Date.now(); let raw = ''; let inputTokens: number | null = null; let outputTokens: number | null = null
    try {
      const proposals = await llmService.callLLMWithStructuredOutput({ label: `Learning three-step assessment ${runId}`, prompt, outputSchema,
        parseFn: (value: unknown) => { raw = typeof value === 'string' ? value : JSON.stringify(value); return validateThreeStepAssessment(typeof value === 'string' ? JSON.parse(value) : value, { nodeStates: input.nodeStates, evidenceByConcept }) },
        callOptions: { backend: 'codex', model: THREE_STEP_MODEL, effort: THREE_STEP_EFFORT, timeout: 420, killMs: THREE_STEP_DEADLINE_MS,
          onUsage: (usage: { inputTokens?: number; outputTokens?: number }) => { inputTokens = usage.inputTokens ?? null; outputTokens = usage.outputTokens ?? null } }, maxParseRetries: 0 })
      const receipt = { terminalState: 'success', proposals, raw, inputSha256: config.inputSha256, model: THREE_STEP_MODEL, effort: THREE_STEP_EFFORT, durationMs: Date.now() - started,
        inputTokens, outputTokens, masteryWrites: 0, validation: { concepts: conceptIds.length, sourceGrounded: true } }
      await writeFile(config.assessmentOutputPath!, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); await chmod(config.assessmentOutputPath!, 0o600)
      await appendAudit(runId, { step: 'assessment', state: 'completed', attempt: 1, durationMs: receipt.durationMs, inputTokens, outputTokens, proposalCount: proposals.length, masteryWrites: 0 })
      return { completed: true, proposalCount: proposals.length, durationMs: receipt.durationMs, inputTokens, outputTokens, masteryWrites: 0 }
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error)
      try {
        await writeFile(config.assessmentOutputPath!, `${JSON.stringify({ terminalState: 'failed', error: errorText, raw, inputSha256: config.inputSha256,
          model: THREE_STEP_MODEL, effort: THREE_STEP_EFFORT, durationMs: Date.now() - started, inputTokens, outputTokens, masteryWrites: 0 }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        await chmod(config.assessmentOutputPath!, 0o600)
      } catch (writeError) { if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError }
      await appendAudit(runId, { step: 'assessment', state: 'failed', attempt: 1, durationMs: Date.now() - started, error: errorText, inputTokens, outputTokens, rawCaptured: raw.length > 0, masteryWrites: 0 })
      await persistFailure(runId, error)
      throw error
    }
  },
})

export const finalizeLearningThreeStepProof = defineSessionlessFunction({
  title: 'Finalize Hindsight three-step proof', description: 'Persist a dated authenticated report projection while leaving learner mastery unchanged.',
  input: FinalizeLearningThreeStepProofInput, output: FinalizeLearningThreeStepProofOutput,
  func: async (_services, { runId, maxBatchTokens }) => {
    const { config, summary: priorSummary } = await load(runId, maxBatchTokens)
    const [consolidation, assessment] = await Promise.all([json<any>(config.consolidationValidatedPath ?? config.consolidationOutputPath!), json<any>(config.assessmentOutputPath!)])
    const summary = { reportDate: new Date().toISOString().slice(0, 10), proof: 'hindsight-native-consolidation-node-assessment', sourceExtractionRunId: config.sourceExtractionRunId,
      pairCount: 100, messageCount: 200, matchCount: 49, conceptCount: 34, consolidation: { terminalState: consolidation.terminalState, timing: consolidation.timing, metrics: consolidation.metrics,
        observations: consolidation.native?.observations?.body?.items?.length ?? 0, priorNodeStatePromptProof: consolidation.adapted?.priorNodeStatePromptProof },
      assessment: { terminalState: assessment.terminalState, proposalCount: assessment.proposals?.length ?? 0, durationMs: assessment.durationMs,
        inputTokens: assessment.inputTokens, outputTokens: assessment.outputTokens, needsReview: assessment.proposals?.filter((item: any) => item.needsReview).length ?? 0,
        improvements: assessment.proposals?.filter((item: any) => item.decision === 'improvement').length ?? 0 }, masteryWrites: 0,
      nodeStateBaseline: config.nodeStateBaseline ?? 'synthetic-empty-v1', nodeStateBaselineLimitation: config.nodeStateBaselineLimitation ?? 'No persisted nonempty learner-assessment state was available.',
      nativeLineageLimitation: 'The single native source fact proves bundled-feed lineage only; individual concept/case/human source IDs are revalidated against frozen originals by step 3.',
      semanticReview: priorSummary?.semanticReview ?? 'pending', rawTranscriptPublication: 'private-only' }
    await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET status='completed',summary=$2::jsonb,completed_at=now(),
      config=jsonb_set(jsonb_set(config,'{assessmentProposals}',$3::jsonb),'{nativeObservations}',$4::jsonb) WHERE run_id=$1`,
    [runId, JSON.stringify(summary), JSON.stringify(assessment.proposals), JSON.stringify(consolidation.native?.observations?.body?.items ?? [])])
    await metaDbQuery(`UPDATE learning_extraction_benchmark_cases SET status='completed',error=NULL WHERE run_id=$1`, [runId])
    return summary
  },
})
