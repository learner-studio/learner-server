import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'

import { metaDbQuery, metaDbWithClient } from '../db-metadata/_shared.js'

export const GRADUAL_ASSESSMENT_COMPARISON_STRATEGY = 'seed-v1-gradual-assessment-ab-v1' as const
export const GRADUAL_ASSESSMENT_SOURCE_RUN_ID = '7754b037-05db-4a5b-b8b7-910411a5094a' as const
export const GRADUAL_ASSESSMENT_DEADLINE_MS = 420_000 as const
export const GRADUAL_ASSESSMENT_MAX_INPUT_TOKENS = 194_400 as const

export const GRADUAL_ASSESSMENT_ARMS = [
  { armId: 'luna-high', label: 'GPT-5.6 Luna High', backend: 'codex', requestedModel: 'gpt-5.6-luna', requestedEffort: 'high' },
  { armId: 'agy-3.7-flash-high', label: 'AGY Gemini 3.7 Flash High', backend: 'agy', requestedModel: 'gemini-3.7-flash', requestedEffort: 'high' },
] as const

type ProviderUsageReceipt = { usage?: { outputTokens?: unknown } }

/** Sum one actual provider output-token receipt per arm; unknown stays NULL. */
export function sumGradualAssessmentOutputTokens(receipts: ProviderUsageReceipt[]): number | null {
  if (receipts.length === 0) return null
  const values = receipts.map(receipt => receipt.usage?.outputTokens)
  if (values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) return null
  const total = (values as number[]).reduce((sum, value) => sum + value, 0)
  return Number.isSafeInteger(total) ? total : null
}

type SourceConfig = {
  privateInputPath?: string
  inputSha256?: string
  assessmentOutputPath?: string
  dataset?: unknown
  catalog?: unknown
  nativeObservations?: unknown[]
  assessmentProposals?: unknown[]
  sourceExtractionRunId?: string
  sourceClassificationRevision?: string
  nodeStateBaseline?: string
  nodeStateBaselineLimitation?: string
  matchCount?: number
  conceptCount?: number
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

type GradualProposalLike = {
  conceptId: string
  understandingPercent: number | null
  confidence: 'insufficient' | 'low' | 'medium' | 'high'
  demonstrated: unknown[]
  gaps: Array<{ kind: 'untested' | 'observed_difficulty' }>
  needsReview: boolean
}

export function summarizeGradualAssessment(proposals: GradualProposalLike[]) {
  const estimated = proposals.filter(item => item.understandingPercent !== null)
  const meanUnderstandingPercent = estimated.length === 0 ? null
    : estimated.reduce((sum, item) => sum + item.understandingPercent!, 0) / estimated.length
  return {
    proposalCount: proposals.length,
    estimatedConcepts: estimated.length,
    unknownConcepts: proposals.length - estimated.length,
    meanUnderstandingPercent,
    needsReview: proposals.filter(item => item.needsReview).length,
    demonstratedItems: proposals.reduce((sum, item) => sum + item.demonstrated.length, 0),
    untestedGaps: proposals.reduce((sum, item) => sum + item.gaps.filter(gap => gap.kind === 'untested').length, 0),
    observedDifficultyGaps: proposals.reduce((sum, item) => sum + item.gaps.filter(gap => gap.kind === 'observed_difficulty').length, 0),
    confidence: Object.fromEntries(['insufficient', 'low', 'medium', 'high'].map(value => [value, proposals.filter(item => item.confidence === value).length])),
  }
}

export function compareGradualAssessments(left: GradualProposalLike[], right: GradualProposalLike[]) {
  const rightByConcept = new Map(right.map(item => [item.conceptId, item]))
  const paired = left.map(item => [item, rightByConcept.get(item.conceptId)] as const)
  if (left.length !== right.length || paired.some(([, item]) => !item) || new Set(left.map(item => item.conceptId)).size !== left.length) {
    throw new Error('Gradual assessment arms must contain the same unique concept IDs')
  }
  const jointlyEstimated = paired.filter(([a, b]) => a.understandingPercent !== null && b!.understandingPercent !== null)
  const meanAbsoluteDifference = jointlyEstimated.length === 0 ? null : jointlyEstimated.reduce(
    (sum, [a, b]) => sum + Math.abs(a.understandingPercent! - b!.understandingPercent!), 0,
  ) / jointlyEstimated.length
  return {
    conceptCount: paired.length,
    exactUnderstandingAgreement: paired.filter(([a, b]) => a.understandingPercent === b!.understandingPercent).length,
    confidenceAgreement: paired.filter(([a, b]) => a.confidence === b!.confidence).length,
    jointlyEstimatedConcepts: jointlyEstimated.length,
    meanAbsoluteUnderstandingDifference: meanAbsoluteDifference,
    lunaEstimatedConcepts: left.filter(item => item.understandingPercent !== null).length,
    agyEstimatedConcepts: right.filter(item => item.understandingPercent !== null).length,
  }
}

export async function createGradualAssessmentComparisonRun(
  requestedRunId: string = randomUUID(),
): Promise<{ runId: string; inputPath: string; inputSha256: string; concepts: number; matches: number; observations: number }> {
  const source = (await metaDbQuery<{ status: string; sample_size: number; source_counts: unknown; config: SourceConfig }>(
    'SELECT status,sample_size,source_counts,config FROM learning_extraction_benchmark_runs WHERE run_id=$1',
    [GRADUAL_ASSESSMENT_SOURCE_RUN_ID],
  )).rows[0]
  if (!source || source.status !== 'completed' || source.sample_size !== 100 || source.config.matchCount !== 49 || source.config.conceptCount !== 34
    || !source.config.privateInputPath || !source.config.inputSha256 || !source.config.assessmentOutputPath
    || source.config.sourceClassificationRevision !== 'hindsight-native-list-v2'
    || !Array.isArray(source.config.nativeObservations) || source.config.nativeObservations.length !== 5
    || !Array.isArray(source.config.assessmentProposals) || source.config.assessmentProposals.length !== 34) {
    throw new Error('Gradual assessment comparison requires the completed frozen 7754 proof with 100 cases, 49 matches, 34 concepts, and five native observations')
  }

  const [sourceInputBytes, originalAssessmentBytes] = await Promise.all([
    readFile(source.config.privateInputPath),
    readFile(source.config.assessmentOutputPath),
  ])
  if (sha256(sourceInputBytes) !== source.config.inputSha256) throw new Error('Frozen 7754 source input hash drift')
  const sourceInput = JSON.parse(sourceInputBytes.toString('utf8')) as { cases?: Array<{ current?: unknown; response?: unknown; classification?: { matches?: unknown[] } }>; nodeStates?: unknown[] }
  const cases = sourceInput.cases ?? []
  const nodeStates = sourceInput.nodeStates ?? []
  const matchCount = cases.reduce((sum, item) => sum + (item.classification?.matches?.length ?? 0), 0)
  if (cases.length !== 100 || cases.some(item => !item.current || !item.response) || matchCount !== 49 || nodeStates.length !== 34) {
    throw new Error('Frozen 7754 private input no longer has exactly 100 pairs, 49 matches, and 34 node states')
  }

  const directory = `/var/lib/biztools/learning-experiments/seed-v1-gradual-assessment-${requestedRunId}`
  const inputPath = `${directory}/input-PRIVATE.json`
  const manifest = {
    runId: requestedRunId,
    sourceProofRunId: GRADUAL_ASSESSMENT_SOURCE_RUN_ID,
    sourceExtractionRunId: source.config.sourceExtractionRunId,
    sourceClassificationRevision: source.config.sourceClassificationRevision,
    sourceInputSha256: source.config.inputSha256,
    originalAssessmentReceipt: { path: source.config.assessmentOutputPath, sha256: sha256(originalAssessmentBytes) },
    nodeStateBaseline: source.config.nodeStateBaseline,
    nodeStateBaselineLimitation: source.config.nodeStateBaselineLimitation,
    cases,
    nodeStates,
    nativeObservations: source.config.nativeObservations,
  }
  const inputText = `${JSON.stringify(manifest, null, 2)}\n`
  const inputSha256 = sha256(inputText)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const existing = await readFile(inputPath, 'utf8')
    if (existing !== inputText) throw new Error('Gradual assessment comparison input already exists with different bytes')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(inputPath, inputText, { flag: 'wx', mode: 0o600 })
  }
  await chmod(inputPath, 0o600)

  const arms = GRADUAL_ASSESSMENT_ARMS.map(arm => ({
    ...arm,
    outputPath: `${directory}/${arm.armId}-raw-PRIVATE.json`,
    maxAttempts: 1,
    modelRetries: 0,
    deadlineMs: GRADUAL_ASSESSMENT_DEADLINE_MS,
  }))
  const config = {
    benchmarkVersion: 7,
    validity: 'valid',
    mode: 'prototype-assessment-comparison',
    contextStrategy: GRADUAL_ASSESSMENT_COMPARISON_STRATEGY,
    experimentLabel: 'Seed V1 gradual-understanding assessment: Luna High vs AGY Gemini 3.7 Flash High',
    sourceProofRunId: GRADUAL_ASSESSMENT_SOURCE_RUN_ID,
    sourceExtractionRunId: source.config.sourceExtractionRunId,
    sourceClassificationRevision: source.config.sourceClassificationRevision,
    dataset: source.config.dataset,
    catalog: source.config.catalog,
    privateInputPath: inputPath,
    inputSha256,
    sourceInputSha256: source.config.inputSha256,
    originalAssessmentOutputPath: source.config.assessmentOutputPath,
    originalAssessmentSha256: manifest.originalAssessmentReceipt.sha256,
    promptContractPath: `${directory}/common-prompt-schema-PRIVATE.json`,
    pairCount: 100,
    messageCount: 200,
    matchCount,
    conceptCount: nodeStates.length,
    nativeObservationCount: source.config.nativeObservations.length,
    nodeStateBaseline: source.config.nodeStateBaseline ?? 'synthetic-empty-v1',
    nodeStateBaselineLimitation: source.config.nodeStateBaselineLimitation,
    requestedInputCeilingTokens: 400_000,
    effectiveInputCeilingTokens: GRADUAL_ASSESSMENT_MAX_INPUT_TOKENS,
    reservedOutputReasoningTokens: 64_000,
    arms,
    callAudit: [],
    masteryWrites: 0,
    rawTranscriptPublication: 'private-only',
  }

  await metaDbWithClient(async client => {
    await client.query('BEGIN')
    try {
      await client.query(`INSERT INTO learning_extraction_benchmark_runs (run_id,status,sample_size,source_counts,config)
        VALUES ($1,'queued',100,$2::jsonb,$3::jsonb)`, [requestedRunId, JSON.stringify(source.source_counts), JSON.stringify(config)])
      await client.query(`INSERT INTO learning_extraction_benchmark_cases
        (run_id,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,status)
        SELECT $1,case_id,ordinal,provider,agent,thread_id,turn_id,occurred_at,input_hash,input_snapshot,'pending'
        FROM learning_extraction_benchmark_cases WHERE run_id=$2 ORDER BY ordinal`, [requestedRunId, GRADUAL_ASSESSMENT_SOURCE_RUN_ID])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  })
  return { runId: requestedRunId, inputPath, inputSha256, concepts: nodeStates.length, matches: matchCount, observations: source.config.nativeObservations.length }
}
