import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'

import { readConversationHistory, type ConversationTurn } from '../../functions/learning/get-conversation-history.js'
import { FROZEN_COMPUTER_SCIENCE_V1 as COMPUTER_SCIENCE } from '../../functions/learning/computer-science-2026-09-04.snapshot.js'
import { metaDbQuery, metaDbWithClient } from '../db-metadata/_shared.js'
import { batchClassifierV6CasesForConfig, CLASSIFIER_V6_CATALOG, CLASSIFIER_V6_CATALOG_HASH } from './learning-classifier-v6.js'
import { reviewClassifierInputs } from './learning-classifier-input-review.js'
import { loadLearningExtractorConfig } from './learning-extractor-config.js'
import {
  buildThreeTurnSequences,
  THREE_TURN_ACTIVE_CONTEXT_TOKENS,
  THREE_TURN_CONTEXT_STRATEGY,
  THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
  THREE_TURN_EXPERIMENT_LABEL,
  THREE_TURN_MAX_BATCH_TOKENS,
  THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
  ONE_PAIR_CONTEXT_STRATEGY,
  ONE_PAIR_EXPERIMENT_LABEL,
  SEED_V1_CONTEXT_STRATEGY,
  SEED_V1_EFFECTIVE_CONTEXT_TOKENS,
  SEED_V1_EXPERIMENT_LABEL,
  buildOnePairSequence,
  type OnePairSequence,
  type SeedV1PairSequence,
  type ThreeTurnSequence,
} from './learning-three-turn-context.js'
import { assertSelectableCombination, type CliEffort, type LlmBackend } from '@learner/llm/lib/llm/model-catalog.js'

const ActivitySchema = z.enum(['learning', 'implementation', 'debugging', 'design', 'research', 'review', 'decision', 'meta'])
const RelationshipSchema = z.enum(['mention', 'task_context', 'assistant_exposure', 'learner_evidence', 'misconception', 'prerequisite_signal'])
const EvidenceKindSchema = z.enum(['recognition', 'explanation', 'prediction', 'application', 'comparison', 'diagnosis', 'design', 'transfer', 'retrieval', 'misconception', 'insufficient'])
const AssessmentSchema = z.enum(['supports', 'partially_supports', 'contradicts', 'indeterminate'])
const AssistanceSchema = z.enum(['independent', 'scaffolded', 'answer_visible', 'execution_only', 'unclear'])
const MasterySchema = z.enum(['unknown', 'exposed', 'partial', 'operational', 'well_understood', 'uncertain'])
const SpanSourceSchema = z.enum(['current_learner', 'prior_learner', 'assistant'])
const DirectnessSchema = z.enum(['explicit', 'inferred'])
const ContextCompletenessValueSchema = z.enum(['complete', 'partial', 'missing', 'unavailable'])
const ContextCompletenessSchema = z.object({
  assistantTurns: ContextCompletenessValueSchema,
  toolOutput: ContextCompletenessValueSchema,
  taskOutcome: ContextCompletenessValueSchema,
  receiptContext: ContextCompletenessValueSchema,
})

export const LearningExtractionSchema = z.object({
  contextCompleteness: ContextCompletenessSchema,
  ontologyRetrieval: z.object({
    strategy: z.literal('bounded-lexical-v1'),
    candidateConceptIds: z.array(z.string().min(1)).max(48),
    totalOntologyConcepts: z.number().int().positive(),
  }),
  episode: z.object({
    boundary: z.enum(['continue', 'open']),
    objective: z.string().min(1).max(500),
    activity: ActivitySchema,
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).max(800),
  }),
  spans: z.array(z.object({
    conceptId: z.string().min(1),
    quote: z.string().min(1).max(1_000),
    source: SpanSourceSchema,
    directness: DirectnessSchema,
    relationship: RelationshipSchema,
    confidence: z.number().min(0).max(1),
  }).superRefine((span, context) => {
    if (span.directness === 'inferred' && span.confidence > 0.65) {
      context.addIssue({ code: 'custom', path: ['confidence'], message: 'Inferred concept spans cannot exceed 0.65 confidence' })
    }
    if ((span.relationship === 'learner_evidence' || span.relationship === 'misconception') && span.source !== 'current_learner') {
      context.addIssue({ code: 'custom', path: ['source'], message: 'Learner evidence and misconceptions must come from the current learner turn' })
    }
  })).max(16),
  evidence: z.array(z.object({
    disposition: z.enum(['candidate', 'accepted', 'rejected']),
    conceptId: z.string().min(1),
    quote: z.string().min(1).max(1_000),
    evidenceKind: EvidenceKindSchema,
    assessment: AssessmentSchema,
    assistanceLevel: AssistanceSchema,
    confidence: z.number().min(0).max(1),
    acceptance: z.object({
      decision: z.enum(['accept', 'reject', 'review']),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(800),
    }),
    mastery: z.object({
      estimate: MasterySchema,
      score: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
      reason: z.string().min(1).max(800),
    }),
  }).superRefine((evidence, context) => {
    const expectedDecision = evidence.disposition === 'accepted' ? 'accept' : evidence.disposition === 'rejected' ? 'reject' : 'review'
    if (evidence.acceptance.decision !== expectedDecision) {
      context.addIssue({ code: 'custom', path: ['acceptance', 'decision'], message: `${evidence.disposition} evidence must use the ${expectedDecision} decision` })
    }
    if (evidence.disposition !== 'accepted' && (!['unknown', 'uncertain'].includes(evidence.mastery.estimate) || evidence.mastery.score > 0.2)) {
      context.addIssue({ code: 'custom', path: ['mastery'], message: 'Candidate or rejected evidence cannot assert demonstrated mastery' })
    }
    if (evidence.disposition === 'accepted'
      && !['supports', 'partially_supports'].includes(evidence.assessment)
      && !(evidence.evidenceKind === 'misconception' && evidence.assessment === 'contradicts')) {
      context.addIssue({ code: 'custom', path: ['assessment'], message: 'Accepted evidence must support or partially support the concept' })
    }
  })).max(12),
  overallConfidence: z.number().min(0).max(1),
  notes: z.string().max(1_000),
})

const ComponentGradeSchema = z.object({ pass: z.boolean(), reason: z.string().min(1).max(1_000) })
const GradedOutputSchema = z.object({
  overallPass: z.boolean(),
  components: z.object({
    episodeGrouping: ComponentGradeSchema,
    conceptSelection: ComponentGradeSchema,
    conceptBoundaries: ComponentGradeSchema,
    evidenceClassification: ComponentGradeSchema,
    evidenceAcceptance: ComponentGradeSchema,
    masteryEstimate: ComponentGradeSchema,
    confidence: ComponentGradeSchema,
    authorshipAssistance: ComponentGradeSchema,
    abstention: ComponentGradeSchema,
  }),
  summary: z.string().min(1).max(1_500),
})

export const LearningExtractionJudgeSchema = z.object({
  A: GradedOutputSchema,
  B: GradedOutputSchema,
  winner: z.enum(['A', 'B', 'tie']),
  ambiguous: z.boolean(),
  ambiguityReason: z.string().max(1_000),
})

export type LearningExtraction = z.infer<typeof LearningExtractionSchema>
export type LearningExtractionJudge = z.infer<typeof LearningExtractionJudgeSchema>
export type BenchmarkCaseSnapshot = {
  current: Pick<ConversationTurn, 'id' | 'threadId' | 'exchangeId' | 'agent' | 'provider' | 'role' | 'authorship' | 'authorshipEvidence' | 'text' | 'timestamp' | 'model' | 'cwd'>
  context: Array<Pick<ConversationTurn, 'id' | 'role' | 'text' | 'timestamp'>>
  contextCompleteness: z.infer<typeof ContextCompletenessSchema>
  ontologyCandidateIds: string[]
  stratum?: string
  threeTurnSequence?: ThreeTurnSequence
  onePairSequence?: OnePairSequence
  seedV1PairSequence?: SeedV1PairSequence
}
export type BenchmarkCaseRow = {
  case_id: string
  ordinal: number
  provider: string
  agent: string
  thread_id: string
  turn_id: string
  occurred_at: string
  input_hash: string
  input_snapshot: BenchmarkCaseSnapshot
  status: string
  judge_output: unknown
  judge_duration_ms: number | null
  error: string | null
}
export type UsageTotals = { inputTokens: number | null; outputTokens: number | null }
export type BenchmarkCorpusInventory = {
  targetSize: number
  totalTurnsRead: number
  verifiedHumanTurns: number
  uniqueEligibleTurns: number
  duplicateHumanTurns: number
  excludedNonHumanTurns: number
  shortfall: number
  ready: boolean
  byProvider: Record<'google' | 'anthropic' | 'openai', number>
  byStratum: Record<string, number>
  sourceErrors: string[]
}

const allowedConceptIds = new Set(COMPUTER_SCIENCE.concepts.map((concept) => concept.id))
const modulesByConceptId = new Map(COMPUTER_SCIENCE.curriculum.modules.flatMap((item) => item.conceptIds.map((conceptId) => [conceptId, item] as const)))

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const redact = (value: string): string => value
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/g, '[email]')
  .replace(/\b(?:sk|pk|key|token)[-_][A-Za-z0-9_-]{16,}\b/gi, '[secret]')
  .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi, 'Bearer [secret]')
  .slice(0, 6_000)

const normalizedTurnText = (value: string): string => value.toLowerCase().replace(/\s+/g, ' ').trim()
const retrievalStopWords = new Set(['about', 'after', 'again', 'also', 'because', 'been', 'before', 'being', 'between', 'could', 'from', 'have', 'into', 'just', 'make', 'more', 'should', 'some', 'that', 'their', 'then', 'there', 'these', 'they', 'this', 'through', 'using', 'want', 'what', 'when', 'where', 'which', 'while', 'with', 'would', 'your'])
const retrievalTokens = (value: string): Set<string> => new Set(value.toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 2 && !retrievalStopWords.has(token)) ?? [])

export function retrieveOntologyCandidates(snapshot: Pick<BenchmarkCaseSnapshot, 'current' | 'context'>, limit = 40): string[] {
  const currentText = normalizedTurnText(snapshot.current.text)
  const currentTokens = retrievalTokens(currentText)
  const contextTokens = retrievalTokens(snapshot.context.map((turn) => turn.text).join(' '))
  return COMPUTER_SCIENCE.concepts
    .map((concept) => {
      const module = modulesByConceptId.get(concept.id)
      const title = normalizedTurnText(concept.title)
      const conceptTokens = retrievalTokens([concept.title, concept.summary, concept.explanation, module?.title ?? '', module?.summary ?? '', concept.domain].join(' '))
      let score = currentText.includes(title) ? 24 : 0
      for (const token of conceptTokens) {
        if (currentTokens.has(token)) score += token.length >= 8 ? 4 : 2
        else if (contextTokens.has(token)) score += 0.5
      }
      return { id: concept.id, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, Math.min(48, limit)))
    .map((item) => item.id)
}

const contextCompletenessFor = (threadTurns: ConversationTurn[], currentIndex: number, included: BenchmarkCaseSnapshot['context']): BenchmarkCaseSnapshot['contextCompleteness'] => {
  const precedingAssistants = threadTurns.slice(0, currentIndex).filter((turn) => turn.role === 'assistant')
  const includedAssistantIds = new Set(included.filter((turn) => turn.role === 'assistant').map((turn) => turn.id))
  const assistantTurns = precedingAssistants.length === 0
    ? 'missing'
    : precedingAssistants.every((turn) => includedAssistantIds.has(turn.id)) ? 'complete' : 'partial'
  return { assistantTurns, toolOutput: 'unavailable', taskOutcome: 'unavailable', receiptContext: 'unavailable' }
}

export function sanitizeBenchmarkContext(
  current: BenchmarkCaseSnapshot['current'],
  context: BenchmarkCaseSnapshot['context'],
): BenchmarkCaseSnapshot['context'] {
  const currentText = normalizedTurnText(current.text)
  const seen = new Set<string>()
  return context.filter((turn) => {
    const normalized = normalizedTurnText(turn.text)
    const key = `${turn.role}:${normalized}`
    if (turn.id === current.id || (turn.role === 'user' && normalized === currentText) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function buildBenchmarkCandidatePool(turns: ConversationTurn[]): BenchmarkCaseSnapshot[] {
  const byThread = new Map<string, ConversationTurn[]>()
  for (const turn of turns) {
    const key = [turn.provider, turn.threadId, turn.agent].join(':')
    const list = byThread.get(key) ?? []
    list.push(turn)
    byThread.set(key, list)
  }
  const candidates = turns.filter((turn) => turn.role === 'user' && turn.authorship === 'human').map((turn) => {
    const key = [turn.provider, turn.threadId, turn.agent].join(':')
    const threadTurns = [...(byThread.get(key) ?? [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    const currentIndex = threadTurns.findIndex((item) => item.id === turn.id)
    const rawContext = threadTurns.slice(0, currentIndex)
      .filter((item) => item.role === 'assistant' || item.authorship === 'human')
      .slice(-3)
      .map((item) => ({
        id: item.id,
        role: item.role,
        text: redact(item.text).slice(0, 2_500),
        timestamp: item.timestamp,
      }))
    const current = {
      id: turn.id,
      threadId: turn.threadId,
      exchangeId: turn.exchangeId,
      agent: turn.agent,
      provider: turn.provider,
      role: turn.role,
      authorship: turn.authorship,
      authorshipEvidence: turn.authorshipEvidence,
      text: redact(turn.text),
      timestamp: turn.timestamp,
      model: turn.model,
      cwd: turn.cwd,
    } satisfies BenchmarkCaseSnapshot['current']
    const context = sanitizeBenchmarkContext(current, rawContext)
    const base = {
      current,
      context,
      contextCompleteness: contextCompletenessFor(threadTurns, currentIndex, context),
      ontologyCandidateIds: [] as string[],
      stratum: benchmarkStratum(turn.text),
    }
    return { ...base, ontologyCandidateIds: retrieveOntologyCandidates(base) } satisfies BenchmarkCaseSnapshot
  })
  const seenText = new Set<string>()
  return candidates
    .sort((a, b) => sha(a.current).localeCompare(sha(b.current)))
    .filter((item) => {
      const key = item.current.text.toLowerCase().replace(/\s+/g, ' ').trim()
      if (seenText.has(key)) return false
      seenText.add(key)
      return true
    })
}

export function selectBenchmarkSample(uniqueCandidates: BenchmarkCaseSnapshot[], sampleSize: number, minimumPerProvider?: number): BenchmarkCaseSnapshot[] {
  const providers = ['google', 'anthropic', 'openai'] as const
  const byProvider = new Map(providers.map((provider) => [provider, diversifyByStratum(uniqueCandidates
      .filter((item) => item.current.provider === provider)
  )]))
  const selected: BenchmarkCaseSnapshot[] = []
  while (selected.length < sampleSize) {
    let added = false
    for (const provider of providers) {
      const next = byProvider.get(provider)?.shift()
      if (!next) continue
      selected.push(next)
      added = true
      if (selected.length === sampleSize) break
    }
    if (!added) break
  }
  if (selected.length !== sampleSize) throw new Error('Insufficient balanced messages: requested ' + sampleSize + ', found ' + selected.length)
  verifyBenchmarkSample(selected, sampleSize, minimumPerProvider)
  return selected
}

export const selectSeededBenchmarkSubset = (manifest: BenchmarkCaseSnapshot[], sampleSize: number, seed: string): BenchmarkCaseSnapshot[] => (
  [...manifest]
    .sort((left, right) => sha([seed, left.current.provider, left.current.threadId, left.current.id])
      .localeCompare(sha([seed, right.current.provider, right.current.threadId, right.current.id])))
    .slice(0, sampleSize)
)

export async function readBenchmarkCorpusInventory(targetSize = 500): Promise<BenchmarkCorpusInventory> {
  const history = await readConversationHistory(Math.max(1_000, targetSize * 4))
  const turns = history.threads.flatMap((thread) => thread.turns)
  const verifiedHumanTurns = turns.filter((turn) => turn.role === 'user' && turn.authorship === 'human')
  const eligible = buildBenchmarkCandidatePool(turns)
  const byProvider = { google: 0, anthropic: 0, openai: 0 }
  const byStratum: Record<string, number> = {}
  for (const item of eligible) {
    byProvider[item.current.provider] += 1
    const stratum = item.stratum ?? 'other'
    byStratum[stratum] = (byStratum[stratum] ?? 0) + 1
  }
  return {
    targetSize,
    totalTurnsRead: turns.length,
    verifiedHumanTurns: verifiedHumanTurns.length,
    uniqueEligibleTurns: eligible.length,
    duplicateHumanTurns: verifiedHumanTurns.length - eligible.length,
    excludedNonHumanTurns: turns.length - verifiedHumanTurns.length,
    shortfall: Math.max(0, targetSize - eligible.length),
    ready: eligible.length >= targetSize && Object.values(byProvider).every((count) => count >= 3),
    byProvider,
    byStratum,
    sourceErrors: history.sources.flatMap((source) => source.error ? [`${source.provider}/${source.location}: ${source.error}`] : []),
  }
}

export async function buildBenchmarkSample(
  sampleSize: number,
  options: { manifestSize?: number; sampleSeed?: string } = {},
): Promise<BenchmarkCaseSnapshot[]> {
  const manifestSize = options.manifestSize ?? sampleSize
  if (manifestSize < sampleSize) throw new Error(`Manifest size ${manifestSize} cannot be smaller than sample size ${sampleSize}`)
  const history = await readConversationHistory(Math.max(1_000, manifestSize * 4))
  const manifest = selectBenchmarkSample(buildBenchmarkCandidatePool(history.threads.flatMap((thread) => thread.turns)), manifestSize)
  if (manifestSize === sampleSize) return manifest
  if (!options.sampleSeed) throw new Error('A sample seed is required when selecting a subset from a larger manifest')
  const selected = selectSeededBenchmarkSubset(manifest, sampleSize, options.sampleSeed)
  verifyBenchmarkSample(selected, sampleSize, 0)
  return selected
}

export function buildThreeTurnBenchmarkCandidates(turns: ConversationTurn[]): BenchmarkCaseSnapshot[] {
  const candidates = buildThreeTurnSequences(turns).map((sequence) => {
    const messages = sequence.messages.map((message) => ({ ...message, text: redact(message.text) }))
    const target = messages[2]!
    const current = {
      id: target.id,
      threadId: target.threadId,
      exchangeId: target.exchangeId,
      agent: target.agent,
      provider: target.provider,
      role: target.role,
      authorship: target.authorship,
      authorshipEvidence: target.authorshipEvidence,
      text: target.text,
      timestamp: target.timestamp,
      model: target.model,
      cwd: target.cwd,
    } satisfies BenchmarkCaseSnapshot['current']
    const context = messages.slice(0, 2).map(({ id, role, text, timestamp }) => ({ id, role, text, timestamp }))
    const base = {
      current,
      context,
      contextCompleteness: {
        assistantTurns: 'partial' as const,
        toolOutput: 'unavailable' as const,
        taskOutcome: 'unavailable' as const,
        receiptContext: 'unavailable' as const,
      },
      ontologyCandidateIds: CLASSIFIER_V6_CATALOG.map((concept) => concept.id),
      stratum: benchmarkStratum(current.text),
      threeTurnSequence: { ...sequence, messages },
    }
    return base satisfies BenchmarkCaseSnapshot
  })
  // Distinct native turn IDs remain distinct observations even when their
  // normalized text repeats. The experiment report discloses overlap and does
  // not claim these conversation windows are independent observations.
  return candidates
}

export async function readThreeTurnExperimentPreflight(
  sampleSize = 50,
  sampleSeed: string = THREE_TURN_EXPERIMENT_LABEL,
): Promise<{
  snapshots: BenchmarkCaseSnapshot[]
  manifestHash: string
  cases: Array<{ caseId: string; inputHash: string; sequenceHash: string }>
  batchPlan: {
    batches: number
    caseIdsByBatch: string[][]
    maxBatchTokens: number
    activeContextTokens: number
    nativeSchemaReserveTokens: number
    effectiveBatchByteCeiling: number
  }
  inventory: {
    completeWindows: number
    duplicateNormalizedCenters: number
    byProvider: Record<string, number>
    byThread: Record<string, number>
    sourceErrors: string[]
  }
}> {
  const history = await readConversationHistory(10_000, undefined, {
    transcriptTailBytes: 64 * 1024 * 1024,
    includeIncomplete: true,
  })
  const candidates = buildThreeTurnBenchmarkCandidates(history.threads.flatMap((thread) => thread.turns))
  const shuffled = selectSeededBenchmarkSubset(candidates, candidates.length, sampleSeed)
  const snapshots = shuffled.slice(0, sampleSize)
  if (snapshots.length !== sampleSize) throw new Error(`Need ${sampleSize} complete three-turn windows; found ${snapshots.length}`)
  if (new Set(snapshots.map(({ current }) => [current.provider, current.threadId, current.id].join(':'))).size !== snapshots.length) {
    throw new Error('Three-turn sample contains duplicate native target IDs')
  }
  const cases = snapshots.map((snapshot) => ({
    caseId: sha([snapshot.current.provider, snapshot.current.threadId, snapshot.current.id]).slice(0, 24),
    snapshot,
  }))
  const promptConfig = {
    contextStrategy: THREE_TURN_CONTEXT_STRATEGY,
    effectiveBatchByteCeiling: THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
    nativeSchemaReserveTokens: THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
  }
  const batches = batchClassifierV6CasesForConfig(cases, promptConfig)
  const normalizedCenters = candidates.map(({ current }) => normalizedTurnText(current.text))
  const byProvider: Record<string, number> = {}
  const byThread: Record<string, number> = {}
  for (const { current } of candidates) {
    byProvider[current.provider] = (byProvider[current.provider] ?? 0) + 1
    const key = [current.provider, current.threadId, current.agent].join(':')
    byThread[key] = (byThread[key] ?? 0) + 1
  }
  return {
    snapshots,
    manifestHash: sha(snapshots),
    cases: cases.map(({ caseId, snapshot }) => ({
      caseId,
      inputHash: sha(snapshot),
      sequenceHash: sha(snapshot.threeTurnSequence),
    })),
    batchPlan: {
      batches: batches.length,
      caseIdsByBatch: batches.map((batch) => batch.map(({ caseId }) => caseId)),
      maxBatchTokens: THREE_TURN_MAX_BATCH_TOKENS,
      activeContextTokens: THREE_TURN_ACTIVE_CONTEXT_TOKENS,
      nativeSchemaReserveTokens: THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
      effectiveBatchByteCeiling: THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
    },
    inventory: {
      completeWindows: candidates.length,
      duplicateNormalizedCenters: candidates.length - new Set(normalizedCenters).size,
      byProvider,
      byThread,
      sourceErrors: history.sources.flatMap((source) => source.error ? [`${source.provider}/${source.location}: ${source.error}`] : []),
    },
  }
}

export function verifyBenchmarkSample(sample: BenchmarkCaseSnapshot[], expectedSize: number, minimumPerProvider = 3): void {
  if (sample.length !== expectedSize) throw new Error(`Expected ${expectedSize} benchmark cases; received ${sample.length}`)
  for (const provider of ['google', 'anthropic', 'openai'] as const) {
    const cases = sample.filter((item) => item.current.provider === provider)
    const minimum = Math.min(minimumPerProvider, Math.floor(expectedSize / 3))
    if (cases.length < minimum) throw new Error(`Benchmark must include at least ${minimum} ${provider} cases; received ${cases.length}`)
  }
  const normalizedTexts = sample.map((item) => item.current.text.toLowerCase().replace(/\s+/g, ' ').trim())
  if (new Set(normalizedTexts).size !== normalizedTexts.length) throw new Error('Benchmark sample contains duplicate normalized learner text')
  for (const item of sample) {
    if (item.current.role !== 'user' || item.current.authorship !== 'human' || !item.current.authorshipEvidence) {
      throw new Error(`Benchmark case ${item.current.id} lacks verified human authorship`)
    }
    if (sanitizeBenchmarkContext(item.current, item.context).length !== item.context.length) {
      throw new Error(`Benchmark case ${item.current.id} contains duplicate source context`)
    }
  }
}

export function benchmarkStratum(text: string): string {
  const value = text.toLowerCase()
  if (/\b(explain|why|how does|what is|mental model|understand)\b/.test(value)) return 'explanation'
  if (/\b(predict|what happens|diagnos|error|issue|broke|failure|debug)\b/.test(value)) return 'prediction-diagnosis'
  if (/\b(design|architecture|tradeoff|trade-off|should we|do you think|recommend)\b/.test(value)) return 'design-tradeoff'
  if (/\b(agent|handoff|merge|push|review|spec|todo|documentation|docs)\b/.test(value)) return 'coordination-meta'
  if (/\b(build|implement|fix|run|add|remove|move|install|deploy)\b/.test(value)) return 'execution-request'
  return 'other'
}

const diversifyByStratum = (items: BenchmarkCaseSnapshot[]): BenchmarkCaseSnapshot[] => {
  const strata = new Map<string, BenchmarkCaseSnapshot[]>()
  for (const item of items) {
    const values = strata.get(item.stratum ?? 'other') ?? []
    values.push(item)
    strata.set(item.stratum ?? 'other', values)
  }
  const result: BenchmarkCaseSnapshot[] = []
  while (result.length < items.length) {
    for (const values of strata.values()) {
      const next = values.shift()
      if (next) result.push(next)
    }
  }
  return result
}

const ontologyFor = (snapshot: BenchmarkCaseSnapshot): string => {
  const ids = new Set(snapshot.ontologyCandidateIds)
  return COMPUTER_SCIENCE.concepts
    .filter((concept) => ids.has(concept.id))
    .map((concept) => [concept.id, concept.title, modulesByConceptId.get(concept.id)?.title, concept.capability].join(' | '))
    .join('\n')
}

const contextText = (snapshot: BenchmarkCaseSnapshot): string => [
  ...snapshot.context.map((turn) => turn.role.toUpperCase() + ': ' + turn.text),
  'CURRENT LEARNER TURN: ' + snapshot.current.text,
].join('\n\n')

export function extractionPrompt(snapshot: BenchmarkCaseSnapshot): string {
  const completeness = JSON.stringify(snapshot.contextCompleteness)
  const retrieval = JSON.stringify({ strategy: 'bounded-lexical-v1', candidateConceptIds: snapshot.ontologyCandidateIds, totalOntologyConcepts: COMPUTER_SCIENCE.concepts.length })
  return [
    'You are the Learning system evidence extractor. Analyze the CURRENT LEARNER TURN using preceding messages only as context.',
    'Return one JSON object matching this contract:',
    '{"episode":{"boundary":"continue|open","objective":"string","activity":"learning|implementation|debugging|design|research|review|decision|meta","confidence":0.0,"reason":"string"},"spans":[{"conceptId":"exact candidate id","quote":"exact contiguous quote","source":"current_learner|prior_learner|assistant","directness":"explicit|inferred","relationship":"mention|task_context|assistant_exposure|learner_evidence|misconception|prerequisite_signal","confidence":0.0}],"evidence":[{"disposition":"candidate|accepted|rejected","conceptId":"exact candidate id","quote":"exact contiguous current-learner quote","evidenceKind":"recognition|explanation|prediction|application|comparison|diagnosis|design|transfer|retrieval|misconception|insufficient","assessment":"supports|partially_supports|contradicts|indeterminate","assistanceLevel":"independent|scaffolded|answer_visible|execution_only|unclear","confidence":0.0,"acceptance":{"decision":"accept|reject|review","confidence":0.0,"reason":"string"},"mastery":{"estimate":"unknown|exposed|partial|operational|well_understood|uncertain","score":0.0,"confidence":0.0,"reason":"string"}}],"overallConfidence":0.0,"notes":"string"}',
    `The system, not the model, attaches this authoritative contextCompleteness metadata: ${completeness}.`,
    `The system also attaches this ontologyRetrieval metadata: ${retrieval}.`,
    'All judgments, including evidence acceptance, mastery, and confidence, are model judgments.',
    'Only learner-authored text can demonstrate mastery. Assistant or tool text can be exposure or context.',
    'A request to perform work is task context, never evidence that the learner understands the underlying concepts.',
    'A task-context span may preserve an explicit material concept even when evidence is empty. Do not add weak keyword-only or inferred concepts just to avoid an empty span list.',
    'Default the episode boundary to continue. Open only when the CURRENT turn introduces a materially different sustained objective; a refinement, enabling question, requested next step, or added constraint continues.',
    'Prefer evidence abstention for instructions, questions requesting an answer, plans not yet executed, and assertions copied or strongly primed by visible assistant text.',
    'Positive applied evidence includes the learner independently diagnosing a mechanism, correcting a specific misconception, explaining why an implementation works, predicting a failure, or verifying an outcome against an explicit criterion. Mere imperatives to implement, diagnose, correct, or verify remain task context.',
    'Contrast: "fix the cache" is task context; "the stale cache survives because invalidation never runs after this write" is candidate diagnosis evidence. "run the test" is task context; "the test proves retries are idempotent because the second insert changes no state" is candidate verification evidence.',
    'Evidence entries are auditable attempts. Use disposition candidate with decision review, rejected with decision reject, and accepted with decision accept. Candidate or rejected evidence must use unknown/uncertain mastery with score at most 0.2.',
    `Context completeness is authoritative: ${completeness}. Unless assistantTurns is complete, assistanceLevel must be unclear; do not infer independence or scaffolding from absent context.`,
    'Spans can overlap. Every quote must be an exact, unchanged, contiguous substring of the declared source turn. Use only allowed concept IDs.',
    'Prefer the shortest sufficient quote within one physical source line. Never collapse, insert, or remove whitespace inside a quote.',
    'Every evidence item must have a span with the same conceptId, source current_learner, relationship learner_evidence or misconception, and an overlapping quote. If you cannot supply that span, omit the evidence item.',
    'Use directness inferred only for a necessary semantic mapping that is not named directly, and never assign it confidence above 0.65.',
    'Treat assistant-visible terminology or reasoning as scaffolded or answer_visible, not independent.',
    'Mastery is supported by this turn and context, not lifetime certainty. Avoid well_understood without transfer or delayed retrieval.',
    'Return JSON only.',
    'CONVERSATION:',
    contextText(snapshot),
    'ALLOWED CONCEPT ONTOLOGY:',
    ontologyFor(snapshot) || '(no sufficiently related candidates; abstain from concept spans and evidence)',
  ].join('\n\n')
}

const glossaryFor = (...outputs: LearningExtraction[]): string => {
  const ids = new Set(outputs.flatMap((output) => [
    ...output.spans.map((span) => span.conceptId),
    ...output.evidence.map((evidence) => evidence.conceptId),
  ]))
  return COMPUTER_SCIENCE.concepts.filter((concept) => ids.has(concept.id))
    .map((concept) => [concept.id, concept.title, concept.capability].join(' | '))
    .join('\n')
}

export function judgePrompt(snapshot: BenchmarkCaseSnapshot, outputA: LearningExtraction, outputB: LearningExtraction): string {
  return [
    'You are grading two anonymized outputs from a learning-evidence extractor. Judge each independently, then select a winner.',
    'Return JSON with A and B. Each has overallPass, summary, and components named episodeGrouping, conceptSelection, conceptBoundaries, evidenceClassification, evidenceAcceptance, masteryEstimate, confidence, authorshipAssistance, abstention. Every component is {"pass":boolean,"reason":"string"}. Also return winner as A, B, or tie; ambiguous boolean; ambiguityReason string.',
    'Episode grouping identifies the sustained objective and opens only for a real objective change.',
    'Concept selection is precise and covers material concepts supported by the text.',
    'Concept boundaries use faithful and specific quotes; overlapping annotations are allowed.',
    'Evidence classification distinguishes mention or task execution from learner demonstration.',
    'Evidence acceptance must reject or flag weak, copied, or indeterminate evidence.',
    'Mastery must be proportional to this evidence and cannot infer lifetime mastery from one turn.',
    'Confidence must reflect ambiguity, assistance, and evidence strength.',
    'Authorship and assistance distinguish learner, assistant, and answer-visible material.',
    'Abstention passes when empty output is appropriate or non-empty evidence is genuinely justified.',
    'overallPass is true only when every material component passes. Return JSON only.',
    'TRANSCRIPT:',
    contextText(snapshot),
    'CONCEPT GLOSSARY:',
    glossaryFor(outputA, outputB) || '(no concepts selected)',
    'OUTPUT A:',
    JSON.stringify(outputA),
    'OUTPUT B:',
    JSON.stringify(outputB),
  ].join('\n\n')
}

const parseJsonObject = (raw: unknown): unknown => {
  const text = typeof raw === 'string'
    ? raw
    : raw && typeof raw === 'object' && typeof (raw as { content?: unknown }).content === 'string'
      ? String((raw as { content: string }).content)
      : ''
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Model returned no JSON object')
  return JSON.parse(text.slice(start, end + 1))
}

const regexEscape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const canonicalizeWhitespaceOnlyQuote = (quote: string, sources: Array<string | undefined>): string => {
  if (sources.some((source) => source?.includes(quote))) return quote
  const parts = quote.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return quote
  const pattern = new RegExp(parts.map(regexEscape).join('\\s+'), 'g')
  const matches = sources.flatMap((source) => source ? [...source.matchAll(pattern)].map((match) => match[0]) : [])
  return matches.length === 1 && matches[0] ? matches[0] : quote
}

export const parseExtraction = (raw: unknown, snapshot?: BenchmarkCaseSnapshot): LearningExtraction => {
  const parsed = parseJsonObject(raw)
  const enriched = snapshot && parsed && typeof parsed === 'object'
    ? {
        ...(parsed as Record<string, unknown>),
        contextCompleteness: snapshot.contextCompleteness,
        ontologyRetrieval: { strategy: 'bounded-lexical-v1', candidateConceptIds: snapshot.ontologyCandidateIds, totalOntologyConcepts: COMPUTER_SCIENCE.concepts.length },
      }
    : parsed
  const parsedExtraction = LearningExtractionSchema.parse(enriched)
  const extraction = snapshot ? LearningExtractionSchema.parse({
    ...parsedExtraction,
    spans: parsedExtraction.spans.map((span) => ({
      ...span,
      quote: canonicalizeWhitespaceOnlyQuote(span.quote, span.source === 'current_learner'
        ? [snapshot.current.text]
        : snapshot.context
          .filter((turn) => span.source === 'assistant' ? turn.role === 'assistant' : turn.role === 'user')
          .map((turn) => turn.text)),
    })),
    evidence: parsedExtraction.evidence.map((evidence) => ({
      ...evidence,
      quote: canonicalizeWhitespaceOnlyQuote(evidence.quote, [snapshot.current.text]),
    })),
  }) : parsedExtraction
  const candidateIds = new Set(snapshot?.ontologyCandidateIds ?? allowedConceptIds)
  for (const span of extraction.spans) {
    if (!allowedConceptIds.has(span.conceptId)) throw new Error(`Unknown concept ID: ${span.conceptId}`)
    if (!candidateIds.has(span.conceptId)) throw new Error(`Concept ID was not retrieved for this turn: ${span.conceptId}`)
    const sources = span.source === 'current_learner'
      ? [snapshot?.current.text]
      : snapshot?.context.filter((turn) => span.source === 'assistant' ? turn.role === 'assistant' : turn.role === 'user').map((turn) => turn.text)
    if (snapshot && !sources?.some((text) => text?.includes(span.quote))) {
      throw new Error(`Span quote is not an exact contiguous substring of ${span.source}: ${span.quote}`)
    }
  }
  for (const evidence of extraction.evidence) {
    if (!allowedConceptIds.has(evidence.conceptId)) throw new Error(`Unknown concept ID: ${evidence.conceptId}`)
    if (!candidateIds.has(evidence.conceptId)) throw new Error(`Evidence concept ID was not retrieved for this turn: ${evidence.conceptId}`)
    if (snapshot && !snapshot.current.text.includes(evidence.quote)) {
      throw new Error(`Evidence quote is not an exact contiguous substring of the current learner turn: ${evidence.quote}`)
    }
    if (snapshot?.contextCompleteness.assistantTurns !== 'complete' && evidence.assistanceLevel !== 'unclear') {
      throw new Error('Assistance must be unclear unless assistant-turn context is complete')
    }
    const matchingSpan = extraction.spans.some((span) => span.conceptId === evidence.conceptId
      && span.source === 'current_learner'
      && (span.quote.includes(evidence.quote) || evidence.quote.includes(span.quote))
      && ['learner_evidence', 'misconception'].includes(span.relationship))
    if (!matchingSpan) throw new Error('Every evidence attempt requires a matching current-learner evidence or misconception span')
  }
  return extraction
}
const JUDGE_COMPONENTS = [
  'episodeGrouping',
  'conceptSelection',
  'conceptBoundaries',
  'evidenceClassification',
  'evidenceAcceptance',
  'masteryEstimate',
  'confidence',
  'authorshipAssistance',
  'abstention',
] as const

export const parseJudge = (raw: unknown): LearningExtractionJudge => {
  const parsed = parseJsonObject(raw) as Record<string, unknown>
  // Sol occasionally emits the exact requested component keys directly under
  // A/B. Treat that as an equivalent serialization, not a semantic failure.
  for (const label of ['A', 'B'] as const) {
    const grade = parsed[label]
    if (!grade || typeof grade !== 'object') continue
    const record = grade as Record<string, unknown>
    if (record.components && typeof record.components === 'object') continue
    const components = Object.fromEntries(JUDGE_COMPONENTS
      .filter((component) => record[component] !== undefined)
      .map((component) => [component, record[component]]))
    if (Object.keys(components).length) record.components = components
  }
  return LearningExtractionJudgeSchema.parse(parsed)
}

export type BenchmarkRunMode = 'prototype-extraction' | 'model-comparison'

export async function createBenchmarkRun(
  sampleSize: number,
  mode: BenchmarkRunMode = 'model-comparison',
  sampling: {
    manifestSize?: number
    sampleSeed?: string
    replayRunId?: string
    backend?: LlmBackend
    model?: string
    effort?: CliEffort
    maxAttempts?: number
    maxBatchTokens?: number
    experimentLabel?: typeof THREE_TURN_EXPERIMENT_LABEL | typeof ONE_PAIR_EXPERIMENT_LABEL | typeof SEED_V1_EXPERIMENT_LABEL
    contextStrategy?: typeof THREE_TURN_CONTEXT_STRATEGY | typeof ONE_PAIR_CONTEXT_STRATEGY | typeof SEED_V1_CONTEXT_STRATEGY
    prepareOnly?: boolean
  } = {},
): Promise<string> {
  const runId = randomUUID()
  const classifier = await loadLearningExtractorConfig()
  const isThreeTurn = sampling.contextStrategy === THREE_TURN_CONTEXT_STRATEGY
  const isOnePair = sampling.contextStrategy === ONE_PAIR_CONTEXT_STRATEGY
  const isSeedV1 = sampling.contextStrategy === SEED_V1_CONTEXT_STRATEGY
  const isContextExperiment = isThreeTurn || isOnePair || isSeedV1
  const backend = sampling.backend ?? (sampling.model ? 'codex' : classifier.backend)
  const model = sampling.model ?? classifier.model
  const effort = sampling.effort ?? (sampling.model ? 'medium' : classifier.effort)
  assertSelectableCombination(backend, model, effort)
  if (isContextExperiment && (sampling.experimentLabel !== (isSeedV1 ? SEED_V1_EXPERIMENT_LABEL : isThreeTurn ? THREE_TURN_EXPERIMENT_LABEL : ONE_PAIR_EXPERIMENT_LABEL)
    || (!isSeedV1 && sampling.model !== 'gpt-5.6-luna')
    || !sampling.effort
    || sampling.maxAttempts !== 1
    || sampling.maxBatchTokens !== THREE_TURN_MAX_BATCH_TOKENS
    || (isSeedV1 ? sampleSize !== 100 || !sampling.replayRunId : sampleSize !== 1 && sampleSize !== 50))) {
    throw new Error('Matched context experiment protocol is not fully frozen')
  }
  const replaySource = sampling.replayRunId ? (await metaDbQuery<{ source_counts: unknown; config: Record<string, unknown> }>(
    'SELECT source_counts,config FROM learning_extraction_benchmark_runs WHERE run_id=$1', [sampling.replayRunId],
  )).rows[0] : undefined
  if (sampling.replayRunId && !replaySource) throw new Error(`Replay run ${sampling.replayRunId} does not exist`)
  const peers = sampling.replayRunId ? await metaDbQuery<{ count: string }>(
    `SELECT count(*)::text count FROM learning_extraction_benchmark_runs WHERE status='completed' AND config->>'replayRunId'=$1`, [sampling.replayRunId],
  ) : undefined
  const comparisonArm = peers ? String.fromCharCode(66 + Math.min(24, Number(peers.rows[0]?.count ?? 0))) : undefined
  const config = {
    benchmarkVersion: 6,
    mode,
    validity: 'valid',
    provenancePolicyVersion: 1,
    extractorPromptVersion: 6,
    classifierPromptRevision: isSeedV1 ? 7 : isContextExperiment ? 5 : 4,
    outputFormat: 'native-json-schema',
    outputSchemaRevision: 1,
    attemptHardDeadlineMs: isSeedV1 ? 420_000 : 600_000,
    samplingStrategy: sampling.replayRunId
      ? 'frozen-run-replay-v1'
      : (sampling.manifestSize ?? sampleSize) > sampleSize
        ? 'provider-stratified-500-manifest-then-seeded-uniform-subset-v1'
        : 'provider-round-robin-stratified-v2',
    ontologyRetrieval: { strategy: 'full-flat-catalog-v6', totalConcepts: CLASSIFIER_V6_CATALOG.length },
    catalog: CLASSIFIER_V6_CATALOG,
    catalogHash: CLASSIFIER_V6_CATALOG_HASH,
    model,
    backend,
    effort,
    maxBatchTokens: sampling.maxBatchTokens ?? 200_000,
    maxAttempts: sampling.maxAttempts ?? 4,
    ...(isContextExperiment ? {
      experimentLabel: isSeedV1 ? SEED_V1_EXPERIMENT_LABEL : isThreeTurn ? THREE_TURN_EXPERIMENT_LABEL : ONE_PAIR_EXPERIMENT_LABEL,
      protocolVersion: 1,
      contextStrategy: sampling.contextStrategy,
      activeContextTokens: isSeedV1 ? (sampling.maxBatchTokens ?? THREE_TURN_MAX_BATCH_TOKENS) : THREE_TURN_ACTIVE_CONTEXT_TOKENS,
      nativeSchemaReserveTokens: THREE_TURN_NATIVE_SCHEMA_RESERVE_TOKENS,
      effectiveBatchByteCeiling: isSeedV1 ? (sampling.maxBatchTokens ?? THREE_TURN_MAX_BATCH_TOKENS) : THREE_TURN_EFFECTIVE_BATCH_BYTE_CEILING,
      classifiedMessage: isSeedV1 ? 'human/operator target only' : isThreeTurn ? 'central learner message only' : 'target learner message only',
      messagesPerSequence: isThreeTurn ? 6 : 2,
      exchangesPerSequence: isThreeTurn ? 3 : 1,
      ...(isThreeTurn
        ? { futureContextPolicy: 'messages-5-and-6-retrospective-not-prior-assistance' }
        : { sourceManifestStrategy: THREE_TURN_CONTEXT_STRATEGY, ablation: 'remove-before-and-after-exchanges-retain-target-user-and-response' }),
      prepareOnly: sampling.prepareOnly === true,
    } : {}),
    ...(sampling.replayRunId ? { comparisonSourceRunId: sampling.replayRunId, comparisonGroupId: sampling.replayRunId, comparisonArm } : {}),
    ...(replaySource?.config.dataset ? { dataset: replaySource.config.dataset } : {}),
    defaultTagCount: [2, 5],
    contextCompletenessVersion: 1,
    evidenceInvariantVersion: 1,
    corpusTarget: sampleSize,
    manifestSize: sampling.manifestSize ?? sampleSize,
    sampleSeed: sampling.sampleSeed ?? null,
    replayRunId: sampling.replayRunId ?? null,
    corpusAdmission: isThreeTurn
      ? 'three-adjacent-complete-native-human-user-boundaries-with-final-assistant-before-next-user-v1'
      : isOnePair
        ? 'exact-target-pair-derived-from-frozen-three-turn-manifest-v1'
        : isSeedV1
          ? 'verified-human-user-plus-final-assistant-before-next-user-boundary'
      : 'provider-native-human-authorship-plus-global-normalized-text-deduplication',
    conceptCoverageCheckpoints: [5, 10, 50],
    ontologyId: COMPUTER_SCIENCE.curriculum.id,
    models: [{ backend, model, effort }],
    judge: null,
  }
  await metaDbQuery(
    'INSERT INTO learning_extraction_benchmark_runs (run_id, status, sample_size, source_counts, config) VALUES ($1, \'queued\', $2, $3::jsonb, $4::jsonb)',
    [runId, sampleSize, JSON.stringify(replaySource?.source_counts ?? {}), JSON.stringify(config)],
  )
  return runId
}

export async function completePrototypeExtractionCase(runId: string, caseId: string): Promise<void> {
  await metaDbQuery(
    'UPDATE learning_extraction_benchmark_cases SET status=\'completed\', judge_output=$3::jsonb, judge_duration_ms=NULL, error=NULL WHERE run_id=$1 AND case_id=$2',
    [runId, caseId, JSON.stringify({ mode: 'prototype-extraction', judged: false })],
  )
}

export async function finalizePreparedBenchmarkManifest(runId: string): Promise<Record<string, unknown>> {
  const cases = await loadBenchmarkCases(runId, 0, 500)
  const summary = {
    classifierVersion: 6,
    preparedManifest: true,
    cases: cases.length,
    paidCalls: 0,
    semanticReview: 'pending',
  }
  await metaDbQuery(
    `UPDATE learning_extraction_benchmark_runs SET status='completed',summary=$2::jsonb,completed_at=now() WHERE run_id=$1 AND status <> 'cancelled'`,
    [runId, JSON.stringify(summary)],
  )
  return summary
}

export async function prepareBenchmarkRun(runId: string, sampleSize: number, manifestSize?: number, sampleSeed?: string, replayRunId?: string): Promise<{ cases: number }> {
  const existing = await loadBenchmarkCases(runId, 0, 500)
  if (existing.length === sampleSize) return { cases: existing.length }
  const run = (await metaDbQuery<{ config: { contextStrategy?: string } }>(
    'SELECT config FROM learning_extraction_benchmark_runs WHERE run_id=$1',
    [runId],
  )).rows[0]
  if (!run) throw new Error(`Benchmark run ${runId} does not exist`)
  const isThreeTurn = run.config.contextStrategy === THREE_TURN_CONTEXT_STRATEGY
  const isOnePair = run.config.contextStrategy === ONE_PAIR_CONTEXT_STRATEGY
  const isSeedV1 = run.config.contextStrategy === SEED_V1_CONTEXT_STRATEGY
  const sampling = {
    ...(manifestSize === undefined ? {} : { manifestSize }),
    ...(sampleSeed === undefined ? {} : { sampleSeed }),
  }
  const replayHashes = new Map<string, string>()
  const replayCaseIds = new Map<BenchmarkCaseSnapshot, string>()
  const snapshots = replayRunId
    ? await (async () => {
        const replay = await metaDbQuery<{ case_id: string; input_hash: string; input_snapshot: Partial<BenchmarkCaseSnapshot> & Pick<BenchmarkCaseSnapshot, 'current' | 'context'> }>(
          'SELECT case_id,input_hash,input_snapshot FROM learning_extraction_benchmark_cases WHERE run_id=$1 ORDER BY ordinal',
          [replayRunId],
        )
        if (isThreeTurn ? replay.rows.length < sampleSize : replay.rows.length !== sampleSize) {
          throw new Error(`Replay run ${replayRunId} has ${replay.rows.length} cases; expected ${sampleSize}`)
        }
        return replay.rows.slice(0, sampleSize).map(({ case_id, input_hash, input_snapshot: frozen }) => {
          if ((isThreeTurn || isOnePair) && !frozen.threeTurnSequence) throw new Error(`Replay case ${case_id} is not a frozen three-turn source sequence`)
          if (isSeedV1 && !frozen.seedV1PairSequence) throw new Error(`Replay case ${case_id} is not a frozen Seed V1 pair`)
          if (isSeedV1) {
            replayHashes.set(case_id, input_hash)
            const snapshot = frozen as BenchmarkCaseSnapshot
            replayCaseIds.set(snapshot, case_id)
            return snapshot
          }
          if (isThreeTurn) {
            replayHashes.set(case_id, input_hash)
            return frozen as BenchmarkCaseSnapshot
          }
          if (isOnePair) {
            const source = frozen as BenchmarkCaseSnapshot
            const onePairSequence = buildOnePairSequence(source.threeTurnSequence!)
            const target = onePairSequence.messages[0]
            if (target.id !== source.current.id || target.text !== source.current.text) {
              throw new Error(`Replay case ${case_id} target differs from frozen source current turn`)
            }
            return {
              current: source.current,
              context: [],
              contextCompleteness: {
                assistantTurns: 'missing',
                toolOutput: source.contextCompleteness.toolOutput,
                taskOutcome: source.contextCompleteness.taskOutcome,
                receiptContext: source.contextCompleteness.receiptContext,
              },
              ontologyCandidateIds: source.ontologyCandidateIds,
              ...(source.stratum ? { stratum: source.stratum } : {}),
              onePairSequence,
            }
          }
          if (frozen.contextCompleteness && JSON.stringify(frozen.ontologyCandidateIds) === JSON.stringify(CLASSIFIER_V6_CATALOG.map((concept) => concept.id))) {
            // Preserve the original hash and payload on exact v6 replay. JSONB
            // changes object key order, so re-hashing JSON.stringify would
            // incorrectly report different inputs for an identical pair.
            replayHashes.set(case_id, input_hash)
            return frozen as BenchmarkCaseSnapshot
          }
          const base = {
            current: frozen.current,
            context: frozen.context,
            contextCompleteness: frozen.contextCompleteness ?? {
              assistantTurns: frozen.context.some((turn) => turn.role === 'assistant') ? 'partial' as const : 'missing' as const,
              toolOutput: 'unavailable' as const,
              taskOutcome: 'unavailable' as const,
              receiptContext: 'unavailable' as const,
            },
            ...(frozen.stratum ? { stratum: frozen.stratum } : {}),
          }
          return { ...base, ontologyCandidateIds: CLASSIFIER_V6_CATALOG.map((concept) => concept.id) } satisfies BenchmarkCaseSnapshot
        })
      })()
    : isThreeTurn
      ? (await readThreeTurnExperimentPreflight(sampleSize, sampling.sampleSeed ?? THREE_TURN_EXPERIMENT_LABEL)).snapshots
      : isOnePair
        ? (() => { throw new Error('One-pair experiment requires replayRunId from the frozen three-turn manifest') })()
      : await (async () => {
        // The UI's small tail omits older human/assistant pairs in long agent
        // sessions. Expand only the offline benchmark reader, not the UI path.
        const history = await readConversationHistory(4_000, undefined, { transcriptTailBytes: 8 * 1024 * 1024 })
        const prior = await metaDbQuery<{ text: string }>(`SELECT input_snapshot->'current'->>'text' AS text FROM learning_extraction_benchmark_cases`)
        const used = new Set(prior.rows.map((row) => normalizedTurnText(row.text)))
        const paired = buildBenchmarkCandidatePool(history.threads.flatMap((thread) => thread.turns)).filter((item) =>
          item.context.some((turn) => turn.role === 'assistant') && !used.has(normalizedTurnText(item.current.text)))
        const shuffled = selectSeededBenchmarkSubset(paired, paired.length, sampling.sampleSeed ?? runId)
        const selected = selectBenchmarkSample(shuffled, sampleSize, 0)
        if (selected.length !== sampleSize) throw new Error(`Need ${sampleSize} unused human messages with preceding assistant context; found ${selected.length}`)
        return selected.map((item) => ({ ...item,
          context: item.context.filter((turn) => turn.role === 'assistant').slice(-1),
          contextCompleteness: { ...item.contextCompleteness, assistantTurns: 'partial' as const },
          ontologyCandidateIds: CLASSIFIER_V6_CATALOG.map((concept) => concept.id),
        }))
        })()
  const counts: Record<string, number> = {}
  await metaDbWithClient(async (client) => {
  await client.query('BEGIN')
  try {
  for (const [ordinal, snapshot] of snapshots.entries()) {
    counts[snapshot.current.provider] = (counts[snapshot.current.provider] ?? 0) + 1
    const caseId = replayCaseIds.get(snapshot as BenchmarkCaseSnapshot) ?? sha([snapshot.current.provider, snapshot.current.threadId, snapshot.current.id]).slice(0, 24)
    await client.query(
      'INSERT INTO learning_extraction_benchmark_cases (run_id, case_id, ordinal, provider, agent, thread_id, turn_id, occurred_at, input_hash, input_snapshot) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT (run_id, case_id) DO NOTHING',
      [runId, caseId, ordinal, snapshot.current.provider, snapshot.current.agent, snapshot.current.threadId, snapshot.current.id, snapshot.current.timestamp, replayHashes.get(caseId) ?? sha(snapshot), JSON.stringify(snapshot)],
    )
  }
  await client.query(
    'UPDATE learning_extraction_benchmark_runs SET status = \'running\', source_counts = $2::jsonb WHERE run_id = $1',
    [runId, JSON.stringify(counts)],
  )
  await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error }
  })
  return { cases: snapshots.length }
}

export async function loadBenchmarkCases(runId: string, offset: number, limit: number): Promise<BenchmarkCaseRow[]> {
  const result = await metaDbQuery<BenchmarkCaseRow>(
    'SELECT case_id, ordinal, provider, agent, thread_id, turn_id, occurred_at::text, input_hash, input_snapshot, status, judge_output, judge_duration_ms, error FROM learning_extraction_benchmark_cases WHERE run_id = $1 AND ordinal >= $2 AND ordinal < $3 ORDER BY ordinal',
    [runId, offset, offset + limit],
  )
  return result.rows
}

export async function saveModelResult(input: {
  runId: string
  caseId: string
  model: string
  effort: string
  status: 'completed' | 'failed'
  extraction?: LearningExtraction
  durationMs: number
  usage?: UsageTotals
  error?: string
}): Promise<void> {
  await metaDbQuery(
    'INSERT INTO learning_extraction_benchmark_results (run_id, case_id, model, effort, status, extraction, duration_ms, input_tokens, output_tokens, error) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10) ON CONFLICT (run_id, case_id, model, effort) DO UPDATE SET status=EXCLUDED.status, extraction=EXCLUDED.extraction, duration_ms=EXCLUDED.duration_ms, input_tokens=EXCLUDED.input_tokens, output_tokens=EXCLUDED.output_tokens, error=EXCLUDED.error',
    [input.runId, input.caseId, input.model, input.effort, input.status, input.extraction ? JSON.stringify(input.extraction) : null, input.durationMs, input.usage?.inputTokens ?? null, input.usage?.outputTokens ?? null, input.error ?? null],
  )
}

export async function loadCompletedModelResult(input: {
  runId: string
  caseId: string
  model: string
  effort: string
}): Promise<LearningExtraction | null> {
  const result = await metaDbQuery<{ extraction: unknown }>(
    'SELECT extraction FROM learning_extraction_benchmark_results WHERE run_id=$1 AND case_id=$2 AND model=$3 AND effort=$4 AND status=\'completed\'',
    [input.runId, input.caseId, input.model, input.effort],
  )
  const extraction = result.rows[0]?.extraction
  return extraction ? LearningExtractionSchema.parse(extraction) : null
}

export async function saveJudgeResult(input: {
  runId: string
  caseId: string
  labels: Record<'A' | 'B', { model: string; effort: string }>
  verdict?: LearningExtractionJudge
  durationMs: number
  error?: string
}): Promise<void> {
  await metaDbQuery(
    'UPDATE learning_extraction_benchmark_cases SET status=$3, judge_output=$4::jsonb, judge_duration_ms=$5, error=$6 WHERE run_id=$1 AND case_id=$2',
    [input.runId, input.caseId, input.verdict ? 'completed' : 'failed', input.verdict ? JSON.stringify({ labels: input.labels, verdict: input.verdict }) : null, input.durationMs, input.error ?? null],
  )
}

type ResultRow = { model: string; effort: string; status: string; duration_ms: number; ordinal: number; extraction: unknown }

export async function finalizeBenchmarkRun(runId: string): Promise<Record<string, unknown>> {
  const cases = await metaDbQuery<{ status: string; judge_output: unknown }>(
    'SELECT status, judge_output FROM learning_extraction_benchmark_cases WHERE run_id=$1',
    [runId],
  )
  const results = await metaDbQuery<ResultRow>(
    'SELECT r.model, r.effort, r.status, r.duration_ms, c.ordinal, r.extraction FROM learning_extraction_benchmark_results r JOIN learning_extraction_benchmark_cases c ON c.run_id=r.run_id AND c.case_id=r.case_id WHERE r.run_id=$1',
    [runId],
  )
  const models = new Map<string, {
    model: string
    effort: string
    completed: number
    failed: number
    strictPasses: number
    durations: number[]
    componentPasses: Record<string, number>
    conceptsByOrdinal: Array<{ ordinal: number; conceptIds: string[] }>
  }>()
  for (const result of results.rows) {
    const key = [result.model, result.effort].join(':')
    const item = models.get(key) ?? {
      model: result.model,
      effort: result.effort,
      completed: 0,
      failed: 0,
      strictPasses: 0,
      durations: [],
      componentPasses: {},
      conceptsByOrdinal: [],
    }
    if (result.status === 'completed') {
      item.completed += 1
      const extraction = result.extraction as Partial<LearningExtraction> | null
      const conceptIds = [...new Set([
        ...(extraction?.spans ?? []).map((span) => span.conceptId),
        ...(extraction?.evidence ?? []).map((evidence) => evidence.conceptId),
      ])]
      item.conceptsByOrdinal.push({ ordinal: result.ordinal, conceptIds })
    }
    else item.failed += 1
    item.durations.push(result.duration_ms)
    models.set(key, item)
  }
  for (const row of cases.rows) {
    const judged = row.judge_output as {
      labels?: Record<'A' | 'B', { model: string; effort: string }>
      verdict?: LearningExtractionJudge
    } | null
    if (!judged?.labels || !judged.verdict) continue
    for (const label of ['A', 'B'] as const) {
      const identity = judged.labels[label]
      const model = models.get([identity.model, identity.effort].join(':'))
      if (!model) continue
      const grade = judged.verdict[label]
      if (grade.overallPass) model.strictPasses += 1
      for (const [component, gradeResult] of Object.entries(grade.components)) {
        if (gradeResult.pass) model.componentPasses[component] = (model.componentPasses[component] ?? 0) + 1
      }
    }
  }
  const percentile = (values: number[], fraction: number): number | null => {
    if (!values.length) return null
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? null
  }
  const summary = {
    totalCases: cases.rows.length,
    completedCases: cases.rows.filter((row) => row.status === 'completed').length,
    failedCases: cases.rows.filter((row) => row.status === 'failed').length,
    models: [...models.values()].map((item) => ({
      model: item.model,
      effort: item.effort,
      completed: item.completed,
      failed: item.failed,
      strictPasses: item.strictPasses,
      strictPassRate: item.completed ? item.strictPasses / item.completed : 0,
      componentPassRates: Object.fromEntries(Object.entries(item.componentPasses).map(([key, value]) => [key, item.completed ? value / item.completed : 0])),
      conceptCoverage: (() => {
        const seen = new Set<string>()
        let previousCount = 0
        const checkpoints = [30, 100, 250, 500]
          .filter((checkpoint) => checkpoint <= cases.rows.length || checkpoint === 30)
          .map((checkpoint) => {
            for (const row of item.conceptsByOrdinal.filter((entry) => entry.ordinal < checkpoint)) {
              for (const conceptId of row.conceptIds) seen.add(conceptId)
            }
            const cumulative = seen.size
            const value = { messages: Math.min(checkpoint, cases.rows.length), cumulative, newSincePrior: cumulative - previousCount }
            previousCount = cumulative
            return value
          })
        return { uniqueConcepts: new Set(item.conceptsByOrdinal.flatMap((entry) => entry.conceptIds)).size, checkpoints }
      })(),
      latencyMs: {
        p50: percentile(item.durations, 0.5),
        p90: percentile(item.durations, 0.9),
        p95: percentile(item.durations, 0.95),
      },
    })),
  }
  const finalStatus = summary.failedCases === 0 && summary.completedCases === summary.totalCases ? 'completed' : 'partial'
  await metaDbQuery(
    'UPDATE learning_extraction_benchmark_runs SET status=$2, summary=$3::jsonb, completed_at=NOW() WHERE run_id=$1',
    [runId, finalStatus, JSON.stringify(summary)],
  )
  return summary
}

export type BenchmarkRead = {
  runs: Array<{
    runId: string
    status: string
    sampleSize: number
    outputTokens: number | null
    config: unknown
    sourceCounts: unknown
    summary: unknown
    error: string | null
    startedAt: string
    completedAt: string | null
  }>
  cases: Array<BenchmarkCaseRow & {
    run_id: string
    humanReview: {
      status: string
      preferredWinner: string | null
      componentReviews: Record<string, unknown>
      notes: string
      reviewerId: string
      updatedAt: string
    } | null
    results: Array<{
      model: string
      effort: string
      status: string
      extraction: unknown
      durationMs: number
      inputTokens: number | null
      outputTokens: number | null
      error: string | null
    }>
  }>
}

export async function readBenchmarks(runId?: string): Promise<BenchmarkRead> {
  const runs = await metaDbQuery<{
    run_id: string
    status: string
    sample_size: number
    output_tokens: string | null
    config: unknown
    source_counts: unknown
    summary: unknown
    error: string | null
    started_at: string
    completed_at: string | null
  }>(
    'SELECT run_id, status, sample_size, output_tokens::text, config, source_counts, summary, error, started_at::text, completed_at::text FROM learning_extraction_benchmark_runs ORDER BY started_at DESC',
    [],
  )
  const selectedRunId = runId ?? runs.rows[0]?.run_id
  const cases = selectedRunId
    ? await metaDbQuery<BenchmarkCaseRow & { run_id: string }>(
      'SELECT run_id, case_id, ordinal, provider, agent, thread_id, turn_id, occurred_at::text, input_hash, input_snapshot, status, judge_output, judge_duration_ms, error FROM learning_extraction_benchmark_cases WHERE run_id=$1 ORDER BY ordinal',
      [selectedRunId],
    )
    : { rows: [] }
  const results = selectedRunId
    ? await metaDbQuery<{
      case_id: string
      model: string
      effort: string
      status: string
      extraction: unknown
      duration_ms: number
      input_tokens: number | null
      output_tokens: number | null
      error: string | null
    }>(
      'SELECT case_id, model, effort, status, extraction, duration_ms, input_tokens, output_tokens, error FROM learning_extraction_benchmark_results WHERE run_id=$1 ORDER BY case_id, model',
      [selectedRunId],
    )
    : { rows: [] }
  const humanReviews = selectedRunId
    ? await metaDbQuery<{
      case_id: string
      status: string
      preferred_winner: string | null
      component_reviews: Record<string, unknown>
      notes: string
      reviewer_id: string
      updated_at: string
    }>(
      'SELECT case_id, status, preferred_winner, component_reviews, notes, reviewer_id, updated_at::text FROM learning_extraction_human_reviews WHERE run_id=$1',
      [selectedRunId],
    )
    : { rows: [] }
  const reviewsByCase = new Map(humanReviews.rows.map((review) => [review.case_id, review]))
  const resultsByCase = new Map<string, typeof results.rows>()
  for (const result of results.rows) {
    const list = resultsByCase.get(result.case_id) ?? []
    list.push(result)
    resultsByCase.set(result.case_id, list)
  }
  return {
    runs: runs.rows.map((run) => ({
      runId: run.run_id,
      status: run.status,
      sampleSize: run.sample_size,
      outputTokens: run.output_tokens === null ? null : Number(run.output_tokens),
      config: run.run_id === selectedRunId && run.config && typeof run.config === 'object'
        ? { ...run.config, inputReview: reviewClassifierInputs(run.config, cases.rows.map(c=>({caseId:c.case_id,snapshot:c.input_snapshot}))) }
        : run.config,
      sourceCounts: run.source_counts,
      summary: run.summary,
      error: run.error,
      startedAt: run.started_at,
      completedAt: run.completed_at,
    })),
    cases: cases.rows.map((item) => ({
      ...item,
      humanReview: reviewsByCase.has(item.case_id) ? (() => {
        const review = reviewsByCase.get(item.case_id)!
        return {
          status: review.status,
          preferredWinner: review.preferred_winner,
          componentReviews: review.component_reviews,
          notes: review.notes,
          reviewerId: review.reviewer_id,
          updatedAt: review.updated_at,
        }
      })() : null,
      results: (resultsByCase.get(item.case_id) ?? []).map((result) => ({
        model: result.model,
        effort: result.effort,
        status: result.status,
        extraction: result.extraction,
        durationMs: result.duration_ms,
        inputTokens: result.input_tokens,
        outputTokens: result.output_tokens,
        error: result.error,
      })),
    })),
  }
}

/**
 * Read the persisted, message-level extractor artifacts without invoking any
 * model.  This is deliberately separate from readBenchmarks: the benchmark
 * review page is case-oriented and reads one selected run, while the
 * operator-facing extraction ledger needs every stored result across runs.
 */
export type LearningExtractionRecord = {
  id: string
  processType: 'benchmark' | 'shadow'
  runId: string | null
  runStatus: string | null
  runValidity: string | null
  invalidReason: string | null
  caseId: string | null
  eventId: string | null
  decisionId: string | null
  ordinal: number | null
  provider: string
  agent: string
  stratum: string | null
  threadId: string
  turnId: string
  occurredAt: string
  status: string
  model: string | null
  backend: string | null
  effort: string | null
  benchmarkVersion: number | null
  promptVersion: string | number | null
  policyVersion: string | null
  extraction: unknown
  inputSnapshot: unknown
  runConfig: unknown
  packet: unknown
  judgeOutput: unknown
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  error: string | null
}

export async function readLearningExtractions(limit = 500): Promise<{ records: LearningExtractionRecord[] }> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const benchmark = await metaDbQuery<{
    run_id: string
    case_id: string
    ordinal: number
    provider: string
    agent: string
    thread_id: string
    turn_id: string
    occurred_at: string
    input_snapshot: unknown
    case_status: string
    judge_output: unknown
    case_error: string | null
    model: string
    effort: string
    result_status: string
    extraction: unknown
    duration_ms: number
    input_tokens: number | null
    output_tokens: number | null
    result_error: string | null
    run_config: unknown
    run_status: string
    run_started_at: string
  }>(
    `SELECT r.run_id, r.case_id, c.ordinal, c.provider, c.agent, c.thread_id,
            c.turn_id, c.occurred_at::text, c.input_snapshot, c.status AS case_status,
            c.judge_output, c.error AS case_error, r.model, r.effort,
            r.status AS result_status, r.extraction, r.duration_ms,
            r.input_tokens, r.output_tokens, r.error AS result_error,
            b.config AS run_config, b.status AS run_status, b.started_at::text AS run_started_at
       FROM learning_extraction_benchmark_results r
       JOIN learning_extraction_benchmark_cases c
         ON c.run_id = r.run_id AND c.case_id = r.case_id
       JOIN learning_extraction_benchmark_runs b ON b.run_id = r.run_id
      ORDER BY b.started_at DESC, c.ordinal ASC, r.model ASC
      LIMIT $1`,
    [boundedLimit],
  )

  const records: LearningExtractionRecord[] = benchmark.rows.map((row) => {
    const config = row.run_config && typeof row.run_config === 'object' ? row.run_config as Record<string, unknown> : {}
    const snapshot = row.input_snapshot && typeof row.input_snapshot === 'object' ? row.input_snapshot as Record<string, unknown> : {}
    return {
      id: `benchmark:${row.run_id}:${row.case_id}:${row.model}:${row.effort}`,
      processType: 'benchmark', runId: row.run_id, runStatus: row.run_status,
      runValidity: typeof config.validity === 'string' ? config.validity : null,
      invalidReason: typeof config.invalidReason === 'string' ? config.invalidReason : null,
      caseId: row.case_id, eventId: null, decisionId: null,
      ordinal: row.ordinal, provider: row.provider, agent: row.agent,
      stratum: typeof snapshot.stratum === 'string' ? snapshot.stratum : null,
      threadId: row.thread_id, turnId: row.turn_id, occurredAt: row.occurred_at,
      status: row.result_status === 'completed' ? row.case_status : row.result_status,
      model: row.model, backend: typeof config.backend === 'string' ? config.backend : null,
      effort: row.effort,
      benchmarkVersion: typeof config.benchmarkVersion === 'number' ? config.benchmarkVersion : null,
      promptVersion: typeof config.promptVersion === 'string' || typeof config.promptVersion === 'number' ? config.promptVersion : null,
      policyVersion: typeof config.policyVersion === 'string' ? config.policyVersion : null,
      extraction: row.extraction, inputSnapshot: row.input_snapshot, runConfig: row.run_config,
      packet: null, judgeOutput: row.judge_output, durationMs: row.duration_ms,
      inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      error: row.result_error ?? row.case_error,
    }
  })

  // Shadow decisions are also persisted extractions. Include them only when
  // there is room after benchmark results, keeping the endpoint hard-capped.
  const remaining = boundedLimit - records.length
  if (remaining > 0) {
    const shadow = await metaDbQuery<{
      decision_id: string
      event_id: string
      provider: string
      agent: string
      thread_id: string
      turn_id: string
      input_snapshot: unknown
      extraction: unknown
      packet: unknown
      extractor_config: unknown
      status: string
      latency_ms: number
      error: string | null
      created_at: string
    }>(
      `SELECT decision_id, event_id, provider, agent, thread_id, turn_id,
              input_snapshot, extraction, packet, extractor_config, status,
              latency_ms, error, created_at::text
         FROM learning_turn_context_decisions
        ORDER BY created_at DESC
        LIMIT $1`,
      [remaining],
    )
    records.push(...shadow.rows.map((row) => {
      const config = row.extractor_config && typeof row.extractor_config === 'object' ? row.extractor_config as Record<string, unknown> : {}
      const packet = row.packet && typeof row.packet === 'object' ? row.packet as Record<string, unknown> : {}
      const snapshot = row.input_snapshot && typeof row.input_snapshot === 'object' ? row.input_snapshot as Record<string, unknown> : {}
      return {
        id: `shadow:${row.decision_id}`, processType: 'shadow', runId: null, runStatus: null, runValidity: null, invalidReason: null, caseId: null,
        eventId: row.event_id, decisionId: row.decision_id, ordinal: null,
        provider: row.provider, agent: row.agent, stratum: null, threadId: row.thread_id,
        turnId: row.turn_id, occurredAt: row.created_at, status: row.status,
        model: typeof config.model === 'string' ? config.model : null,
        backend: typeof config.backend === 'string' ? config.backend : null,
        effort: typeof config.effort === 'string' ? config.effort : null,
        benchmarkVersion: null, promptVersion: null,
        policyVersion: typeof packet.policyVersion === 'string' ? packet.policyVersion : null,
        extraction: row.extraction, inputSnapshot: row.input_snapshot,
        runConfig: row.extractor_config, packet: row.packet, judgeOutput: null,
        durationMs: row.latency_ms, inputTokens: null, outputTokens: null, error: row.error,
      } satisfies LearningExtractionRecord
    }))
  }
  return { records }
}

export async function saveBenchmarkHumanReview(input: {
  runId: string
  caseId: string
  reviewerId: string
  preferredWinner: 'A' | 'B' | 'tie' | 'unsure'
  componentReviews: Record<string, unknown>
  notes: string
}): Promise<{ status: 'completed'; updatedAt: string }> {
  const result = await metaDbQuery<{ updated_at: string }>(
    `INSERT INTO learning_extraction_human_reviews
       (run_id, case_id, reviewer_id, status, preferred_winner, component_reviews, notes)
     VALUES ($1, $2, $3, 'completed', $4, $5::jsonb, $6)
     ON CONFLICT (run_id, case_id) DO UPDATE SET
       reviewer_id = EXCLUDED.reviewer_id,
       status = 'completed',
       preferred_winner = EXCLUDED.preferred_winner,
       component_reviews = EXCLUDED.component_reviews,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING updated_at::text`,
    [input.runId, input.caseId, input.reviewerId, input.preferredWinner, JSON.stringify(input.componentReviews), input.notes],
  )
  return { status: 'completed', updatedAt: result.rows[0]?.updated_at ?? new Date().toISOString() }
}
