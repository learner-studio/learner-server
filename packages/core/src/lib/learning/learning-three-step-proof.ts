import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'

import { CLASSIFIER_V6_CATALOG } from './learning-classifier-v6.js'
import { metaDbQuery, metaDbWithClient } from '../db-metadata/_shared.js'
import { loadBenchmarkCases } from './learning-extraction-benchmark.js'

export const THREE_STEP_STRATEGY = 'seed-v1-hindsight-three-step-v1' as const
export const THREE_STEP_MODEL = 'gpt-5.6-luna' as const
export const THREE_STEP_EFFORT = 'high' as const
export const THREE_STEP_DEADLINE_MS = 420_000 as const

export const ThreeStepNodeStateSchema = z.object({
  conceptId: z.string().min(1), nodeId: z.string().min(1), nodeVersion: z.string().length(64),
  assessment: z.object({ level: z.literal('unknown'), score: z.literal(0), confidence: z.literal(0),
    evidenceCount: z.literal(0), strongEvidenceCount: z.literal(0) }).strict(),
  sourceIds: z.array(z.string()).default([]),
}).strict()

export const ThreeStepProposalSchema = z.object({
  conceptId: z.string().min(1), nodeVersion: z.string().length(64),
  decision: z.enum(['unchanged', 'improvement']), proposedScore: z.number().min(0).max(1).nullable(),
  needsReview: z.boolean(), reason: z.string().min(1).max(2_000),
  supportingSourceIds: z.array(z.string()).max(100), counterevidenceSourceIds: z.array(z.string()).max(100),
  limitations: z.array(z.string().max(1_000)).max(20),
}).strict()
export type ThreeStepProposal = z.infer<typeof ThreeStepProposalSchema>

export const ThreeStepAssessmentBatchSchema = z.object({ proposals: z.array(ThreeStepProposalSchema) }).strict()

export type ThreeStepAssessmentContext = {
  nodeStates: z.infer<typeof ThreeStepNodeStateSchema>[]
  evidenceByConcept: Record<string, Array<{ sourceId: string; relationship: string }>>
}

export function validateThreeStepAssessment(raw: unknown, context: ThreeStepAssessmentContext): ThreeStepProposal[] {
  const parsed = ThreeStepAssessmentBatchSchema.parse(raw)
  const states = new Map(context.nodeStates.map(state => [state.conceptId, state]))
  const expected = [...states.keys()].sort()
  if (parsed.proposals.length !== expected.length || new Set(parsed.proposals.map(item => item.conceptId)).size !== expected.length) {
    throw new Error(`Assessment must return exactly ${expected.length} unique concept proposals`)
  }
  for (const proposal of parsed.proposals) {
    const state = states.get(proposal.conceptId)
    if (!state || proposal.nodeVersion !== state.nodeVersion) throw new Error(`Stale or unknown node version: ${proposal.conceptId}`)
    const evidence = context.evidenceByConcept[proposal.conceptId] ?? []
    const allowed = new Set(evidence.map(item => item.sourceId))
    if ([...proposal.supportingSourceIds, ...proposal.counterevidenceSourceIds].some(id => !allowed.has(id))) {
      throw new Error(`Proposal references foreign source evidence: ${proposal.conceptId}`)
    }
    if (new Set(proposal.supportingSourceIds).size !== proposal.supportingSourceIds.length) throw new Error(`Duplicate supporting source: ${proposal.conceptId}`)
    if (new Set(proposal.counterevidenceSourceIds).size !== proposal.counterevidenceSourceIds.length) throw new Error(`Duplicate counterevidence source: ${proposal.conceptId}`)
    if (proposal.supportingSourceIds.some(id => proposal.counterevidenceSourceIds.includes(id))) throw new Error(`Supporting and counterevidence sources must be disjoint: ${proposal.conceptId}`)
    const learnerEvidence = new Set(evidence.filter(item => item.relationship === 'learner_evidence').map(item => item.sourceId))
    const misconceptionEvidence = new Set(evidence.filter(item => item.relationship === 'misconception').map(item => item.sourceId))
    if (proposal.supportingSourceIds.some(id => !learnerEvidence.has(id))) throw new Error(`Supporting sources must all be learner evidence: ${proposal.conceptId}`)
    if (proposal.counterevidenceSourceIds.some(id => !misconceptionEvidence.has(id))) throw new Error(`Counterevidence sources must all be misconceptions: ${proposal.conceptId}`)
    if (proposal.decision === 'unchanged' && proposal.proposedScore !== null) throw new Error(`Unchanged proposal must not set a score: ${proposal.conceptId}`)
    if (proposal.decision === 'improvement') {
      if (proposal.proposedScore == null || proposal.proposedScore <= state.assessment.score || proposal.supportingSourceIds.length === 0) {
        throw new Error(`Improvement requires a higher proposed score and supporting evidence: ${proposal.conceptId}`)
      }
      if (!proposal.supportingSourceIds.some(id => learnerEvidence.has(id))) throw new Error(`Improvement requires learner-authored evidence: ${proposal.conceptId}`)
    }
    if (proposal.counterevidenceSourceIds.length > 0 && !proposal.needsReview) throw new Error(`Counterevidence requires review: ${proposal.conceptId}`)
  }
  return parsed.proposals
}

export function threeStepAssessmentSchema(conceptIds: string[]) {
  return z.toJSONSchema(z.object({ proposals: z.array(ThreeStepProposalSchema.safeExtend({ conceptId: z.enum(conceptIds) })).length(conceptIds.length) }).strict())
}

export function threeStepNodeState(conceptId: string) {
  const concept = CLASSIFIER_V6_CATALOG.find(item => item.id === conceptId)
  if (!concept) throw new Error(`Unknown concept ${conceptId}`)
  const assessment = { level: 'unknown' as const, score: 0 as const, confidence: 0 as const, evidenceCount: 0 as const, strongEvidenceCount: 0 as const }
  const nodeVersion = createHash('sha256').update(JSON.stringify({ conceptId, title: concept.title, assessment })).digest('hex')
  return ThreeStepNodeStateSchema.parse({ conceptId, nodeId: conceptId, nodeVersion, assessment, sourceIds: [] })
}

export function threeStepAssessmentPrompt(input: { consolidation: unknown; nodeStates: unknown; nativeLinkedEvidenceByConcept?: unknown; evidence: unknown }): string {
  return [
    'Propose review-only Learning node assessments from a native Hindsight consolidation and authoritative original human evidence.',
    'Return exactly one proposal per supplied concept. Never apply mastery or claim that assistant text demonstrates learner ability.',
    'Use improvement only when at least one linked learner_evidence source demonstrates understanding; task_context and mention are not mastery evidence.',
    'A quote copied from a prior assistant report, transcript, or other pasted material inside a user envelope is not independent learner evidence. Inspect the complete current/response pair and mark ambiguity for review.',
    'Use unchanged for insufficient evidence. Set needsReview for contradictions, corrections, ambiguity, weak support, or limitations.',
    'Copy only supplied canonical concept IDs, frozen node versions, and source IDs. Do not invent sources.',
    'Use supportingSourceIds and counterevidenceSourceIds only from nativeLinkedEvidenceByConcept. The complete evidence pairs remain supplied for authoritative reread and limitation review.',
    `INPUT:\n${JSON.stringify(input)}`,
  ].join('\n\n')
}

export async function createThreeStepProofRun(sourceRunId: string, requestedRunId: string = randomUUID(), maxBatchTokens = 400_000): Promise<{ runId: string; inputPath: string; inputSha256: string; concepts: number; matches: number }> {
  if (!Number.isInteger(maxBatchTokens) || maxBatchTokens < 1 || maxBatchTokens > 400_000) throw new Error('Consolidation maxBatchTokens must be between 1 and 400000')
  const source = (await metaDbQuery<{ source_counts: unknown; config: Record<string, unknown> }>(
    'SELECT source_counts,config FROM learning_extraction_benchmark_runs WHERE run_id=$1 AND status=$2', [sourceRunId, 'completed'],
  )).rows[0]
  const reconciliation = Array.isArray(source?.config.hindsightAudit)
    ? [...source.config.hindsightAudit].reverse().find((item: any) => item?.state === 'reconciled') as Record<string, unknown> | undefined
    : undefined
  if (!source || source.config.hindsightOnly !== true || source.config.dataset == null
    || reconciliation?.adapterRevision !== 'hindsight-native-list-v2' || reconciliation?.validRows !== 100
    || reconciliation?.mappedMatches !== 49 || reconciliation?.unmappableFacts !== 0 || reconciliation?.newModelCalls !== 0) {
    throw new Error('Three-step proof requires the completed, reconciled Hindsight adapter-v2 Seed V1 rerun')
  }
  const cases = await loadBenchmarkCases(sourceRunId, 0, 500)
  if (cases.length !== 100) throw new Error('Three-step proof requires exactly 100 source cases')
  const results = (await metaDbQuery<{ case_id: string; extraction: { matches?: Array<{ conceptId: string; quote: string; relationship: string; evidenceKind: string; assessment: string; reason: string }> } }>(
    `SELECT case_id,extraction FROM learning_extraction_benchmark_results WHERE run_id=$1 AND model='hindsight:gpt-5.6-luna' AND effort='high' AND status='completed' ORDER BY case_id`, [sourceRunId],
  )).rows
  if (results.length !== 100) throw new Error('Three-step proof requires 100 completed adapter-v2 outcomes')
  const byCase = new Map(results.map(row => [row.case_id, row.extraction]))
  const conceptIds = [...new Set(results.flatMap(row => row.extraction.matches?.map(match => match.conceptId) ?? []))].sort()
  const nodeStates = conceptIds.map(threeStepNodeState)
  const normalizedCases = cases.sort((a, b) => a.ordinal - b.ordinal).map(row => {
    const messages = row.input_snapshot.seedV1PairSequence?.messages
    if (!messages || messages.length !== 2) throw new Error(`Missing frozen pair ${row.case_id}`)
    return { caseId: row.case_id, current: { id: messages[0]!.id, role: 'user', text: messages[0]!.text },
      response: { id: messages[1]!.id, role: 'assistant', text: messages[1]!.text }, classification: byCase.get(row.case_id) }
  })
  const input = { runId: requestedRunId, sourceExtractionRunId: sourceRunId, classificationRevision: 'hindsight-native-list-v2',
    sourceDatasetDigest: (source.config.dataset as { membershipDigest?: string }).membershipDigest, nodeStates, cases: normalizedCases }
  const inputText = `${JSON.stringify(input, null, 2)}\n`
  const inputSha256 = createHash('sha256').update(inputText).digest('hex')
  const directory = `/var/lib/biztools/learning-experiments/seed-v1-three-step-${requestedRunId}`
  const inputPath = `${directory}/input-PRIVATE.json`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const existing = await readFile(inputPath, 'utf8')
    if (existing !== inputText) throw new Error('Frozen three-step input already exists with different bytes')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(inputPath, inputText, { flag: 'wx', mode: 0o600 })
  }
  await chmod(inputPath, 0o600)
  const config = { benchmarkVersion: 6, validity: 'valid', mode: 'prototype-extraction', contextStrategy: THREE_STEP_STRATEGY,
    experimentLabel: 'Seed V1 Hindsight native consolidation plus node assessment', model: THREE_STEP_MODEL, backend: 'codex', effort: THREE_STEP_EFFORT,
    maxAttempts: 1, maxBatchTokens, attemptHardDeadlineMs: THREE_STEP_DEADLINE_MS, sourceExtractionRunId: sourceRunId,
    sourceClassificationRevision: 'hindsight-native-list-v2', dataset: source.config.dataset, catalog: CLASSIFIER_V6_CATALOG,
    privateInputPath: inputPath, inputSha256, consolidationOutputPath: `${directory}/consolidation-raw-PRIVATE.json`,
    assessmentOutputPath: `${directory}/assessment-raw-PRIVATE.json`, nodeStates, conceptCount: conceptIds.length,
    matchCount: results.reduce((sum, row) => sum + (row.extraction.matches?.length ?? 0), 0), masteryWrites: 0, callAudit: [],
    nodeStateBaseline: 'synthetic-empty-v1', nodeStateBaselineLimitation: 'No persisted learner-assessment store exists; catalog concepts exist but have no mastery fields. This proof starts every frozen node at unknown/zero and does not test reconciliation with nonempty live learner state.' }
  await metaDbWithClient(async client => {
    await client.query('BEGIN')
    try {
      await client.query(`INSERT INTO learning_extraction_benchmark_runs (run_id,status,sample_size,source_counts,config)
        VALUES ($1,'queued',100,$2::jsonb,$3::jsonb)`, [requestedRunId, JSON.stringify(source.source_counts), JSON.stringify(config)])
      await client.query(`INSERT INTO learning_extraction_benchmark_cases
        (run_id,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,status)
        SELECT $1,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,'pending'
        FROM learning_extraction_benchmark_cases WHERE run_id=$2 ORDER BY ordinal`, [requestedRunId, sourceRunId])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
  })
  return { runId: requestedRunId, inputPath, inputSha256, concepts: conceptIds.length, matches: config.matchCount }
}
