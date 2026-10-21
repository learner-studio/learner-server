import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { COMPUTER_SCIENCE } from '../../functions/learning/computer-science-seed.js'
import { metaDbQuery } from '../db-metadata/_shared.js'
import {
  extractionPrompt,
  LearningExtractionSchema,
  parseExtraction,
  retrieveOntologyCandidates,
  type BenchmarkCaseSnapshot,
  type LearningExtraction,
} from './learning-extraction-benchmark.js'
import { loadLearningExtractorConfig } from './learning-extractor-config.js'

export const LearningTurnContextInput = z.object({
  eventId: z.string().min(1).max(300),
  provider: z.enum(['google', 'anthropic', 'openai']),
  agent: z.string().min(1).max(120),
  threadId: z.string().min(1).max(300),
  turnId: z.string().min(1).max(300),
  text: z.string().min(1).max(12_000),
  timestamp: z.string().datetime(),
  context: z.array(z.object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    text: z.string().max(12_000),
    timestamp: z.string().datetime(),
  })).max(3).default([]),
  contextCompleteness: z.object({
    assistantTurns: z.enum(['complete', 'partial', 'missing', 'unavailable']),
    toolOutput: z.enum(['complete', 'partial', 'missing', 'unavailable']),
    taskOutcome: z.enum(['complete', 'partial', 'missing', 'unavailable']),
    receiptContext: z.enum(['complete', 'partial', 'missing', 'unavailable']),
  }).optional(),
})

const ShadowAction = z.enum(['none', 'retrieval', 'prerequisite_reminder', 'misconception_correction', 'scaffold'])
export const LearningTurnContextPacket = z.object({
  mode: z.literal('shadow'),
  action: z.literal('none'),
  wouldInject: ShadowAction,
  policyVersion: z.literal('shadow-v1'),
  reason: z.string(),
  episode: z.object({ boundary: z.enum(['continue', 'open']), objective: z.string(), activity: z.string(), confidence: z.number() }),
  matchedConcepts: z.array(z.object({ id: z.string(), title: z.string(), relationship: z.string(), confidence: z.number() })).max(3),
  learnerEvidence: z.array(z.object({ conceptId: z.string(), assessment: z.string(), masteryScore: z.number(), confidence: z.number() })).max(3),
  contextBudget: z.object({ maxConcepts: z.literal(3), maxPriorTurns: z.literal(3) }),
  activationGate: z.object({ eligible: z.literal(false), reason: z.string() }),
})
export type LearningTurnContextPacket = z.infer<typeof LearningTurnContextPacket>

const conceptById = new Map(COMPUTER_SCIENCE.concepts.map((concept) => [concept.id, concept]))

export function buildShadowPacket(extraction: LearningExtraction): LearningTurnContextPacket {
  const accepted = extraction.evidence.filter((item) => item.acceptance.decision === 'accept')
  const misconception = accepted.find((item) => item.evidenceKind === 'misconception' || item.assessment === 'contradicts')
  const weak = accepted.find((item) => item.mastery.score < 0.45)
  const prerequisite = extraction.spans.find((item) => item.relationship === 'prerequisite_signal')
  const wouldInject = misconception
    ? 'misconception_correction'
    : prerequisite
      ? 'prerequisite_reminder'
      : weak
        ? 'scaffold'
        : 'none'
  const reason = wouldInject === 'none'
    ? 'No sufficiently grounded intervention trigger was found.'
    : `Shadow policy identified ${wouldInject}; active injection remains disabled.`
  return LearningTurnContextPacket.parse({
    mode: 'shadow',
    action: 'none',
    wouldInject,
    policyVersion: 'shadow-v1',
    reason,
    episode: extraction.episode,
    matchedConcepts: extraction.spans.slice(0, 3).map((span) => ({
      id: span.conceptId,
      title: conceptById.get(span.conceptId)?.title ?? span.conceptId,
      relationship: span.relationship,
      confidence: span.confidence,
    })),
    learnerEvidence: accepted.slice(0, 3).map((item) => ({
      conceptId: item.conceptId,
      assessment: item.assessment,
      masteryScore: item.mastery.score,
      confidence: item.mastery.confidence,
    })),
    contextBudget: { maxConcepts: 3, maxPriorTurns: 3 },
    activationGate: {
      eligible: false,
      reason: 'Calibration is small and skewed; Mini concept selection and boundary scores remain below the activation threshold.',
    },
  })
}

export async function extractShadowTurnContext(
  llmService: { callLLMWithStructuredOutput: (input: Record<string, unknown>) => Promise<unknown> },
  input: z.infer<typeof LearningTurnContextInput>,
): Promise<{ decisionId: string; packet: LearningTurnContextPacket; extraction: LearningExtraction | null; status: 'completed' | 'failed'; error: string | null }> {
  const parsed = LearningTurnContextInput.parse(input)
  const existing = await metaDbQuery<{
    decision_id: string
    packet: unknown
    extraction: unknown
    status: 'completed' | 'failed'
    error: string | null
  }>(
    'SELECT decision_id, packet, extraction, status, error FROM learning_turn_context_decisions WHERE event_id=$1',
    [parsed.eventId],
  )
  const prior = existing.rows[0]
  if (prior) {
    return {
      decisionId: prior.decision_id,
      packet: LearningTurnContextPacket.parse(prior.packet),
      extraction: prior.extraction ? LearningExtractionSchema.parse(prior.extraction) : null,
      status: prior.status,
      error: prior.error,
    }
  }
  const decisionId = randomUUID()
  const config = await loadLearningExtractorConfig()
  const contextCompleteness: BenchmarkCaseSnapshot['contextCompleteness'] = parsed.contextCompleteness ?? {
    assistantTurns: parsed.context.some((turn) => turn.role === 'assistant') ? 'partial' : 'missing',
    toolOutput: 'unavailable',
    taskOutcome: 'unavailable',
    receiptContext: 'unavailable',
  }
  const snapshotBase: Omit<BenchmarkCaseSnapshot, 'ontologyCandidateIds' | 'stratum'> = {
    current: {
      id: parsed.turnId, threadId: parsed.threadId, exchangeId: parsed.eventId, agent: parsed.agent,
      provider: parsed.provider, role: 'user', authorship: 'human',
      authorshipEvidence: 'Authenticated agent turn-context request', text: parsed.text,
      timestamp: parsed.timestamp, model: null, cwd: null,
    },
    context: parsed.context,
    contextCompleteness,
  }
  const snapshot: BenchmarkCaseSnapshot = { ...snapshotBase, ontologyCandidateIds: retrieveOntologyCandidates(snapshotBase) }
  const started = Date.now()
  let extraction: LearningExtraction | null = null
  let error: string | null = null
  try {
    extraction = await llmService.callLLMWithStructuredOutput({
      label: 'Learning real-time shadow extractor',
      prompt: extractionPrompt(snapshot),
      parseFn: (raw: unknown) => parseExtraction(raw, snapshot),
      callOptions: { backend: config.backend, model: config.model, effort: config.effort, timeout: 90 },
      maxParseRetries: 1,
      includeParseFailureFeedback: true,
    }) as LearningExtraction
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught)
  }
  const packet = extraction ? buildShadowPacket(extraction) : LearningTurnContextPacket.parse({
    mode: 'shadow', action: 'none', wouldInject: 'none', policyVersion: 'shadow-v1',
    reason: 'Extractor failed; shadow policy failed closed.',
    episode: { boundary: 'continue', objective: 'Unknown', activity: 'meta', confidence: 0 },
    matchedConcepts: [], learnerEvidence: [], contextBudget: { maxConcepts: 3, maxPriorTurns: 3 },
    activationGate: { eligible: false, reason: 'Extractor failure; active injection is disabled.' },
  })
  const status = extraction ? 'completed' : 'failed'
  await metaDbQuery(
    `INSERT INTO learning_turn_context_decisions
       (decision_id, event_id, provider, agent, thread_id, turn_id, input_snapshot, extraction, packet, extractor_config, status, latency_ms, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)
     ON CONFLICT (event_id) DO UPDATE SET
       input_snapshot=EXCLUDED.input_snapshot, extraction=EXCLUDED.extraction, packet=EXCLUDED.packet,
       extractor_config=EXCLUDED.extractor_config, status=EXCLUDED.status, latency_ms=EXCLUDED.latency_ms, error=EXCLUDED.error
     RETURNING decision_id`,
    [decisionId, parsed.eventId, parsed.provider, parsed.agent, parsed.threadId, parsed.turnId,
      JSON.stringify(snapshot), extraction ? JSON.stringify(extraction) : null, JSON.stringify(packet), JSON.stringify(config),
      status, Date.now() - started, error],
  )
  return { decisionId, packet, extraction, status, error }
}
