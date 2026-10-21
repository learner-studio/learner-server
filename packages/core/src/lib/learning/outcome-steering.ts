import { createHash } from 'node:crypto'
import { z } from 'zod'

import { cliEffortSchema, llmBackendSchema } from '@learner/llm/lib/llm/model-catalog.js'

export const OUTCOME_STEERING_DIMENSIONS = [
  'outcome_framing',
  'constraint_precision_persistence',
  'decomposition_delegation',
  'context_correction',
  'feedback_efficiency_convergence',
  'verification_quality',
  'model_effort_tool_calibration',
  'recovery_after_failure',
  'cross_domain_transfer',
] as const

export const OutcomeSteeringDimensionSchema = z.enum(OUTCOME_STEERING_DIMENSIONS)
export const OutcomeEvaluatorConfigSchema = z.object({
  backend: llmBackendSchema,
  model: z.string().min(1).max(160),
  effort: cliEffortSchema,
})
export type OutcomeEvaluatorConfig = z.infer<typeof OutcomeEvaluatorConfigSchema>

export const DEFAULT_OUTCOME_EVALUATOR_CONFIG: OutcomeEvaluatorConfig = {
  backend: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
}

export const EpisodeTurnSchema = z.object({
  refId: z.string().min(1).max(300),
  provider: z.enum(['google', 'anthropic', 'openai', 'unknown']),
  threadId: z.string().min(1).max(300),
  turnId: z.string().min(1).max(300),
  role: z.enum(['user', 'assistant', 'tool']),
  text: z.string().max(24_000),
  occurredAt: z.string().datetime(),
  domain: z.string().min(1).max(160).nullable().default(null),
  agentRuntime: z.string().min(1).max(120).nullable().default(null),
  model: z.string().min(1).max(160).nullable().default(null),
})

export const EpisodeTaskSchema = z.object({
  refId: z.string().min(1).max(300),
  taskId: z.string().min(1).max(300),
  parentTaskId: z.string().min(1).max(300).nullable().default(null),
  title: z.string().min(1).max(1_000),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'refused', 'unknown']),
  outcome: z.string().max(8_000).nullable().default(null),
  agentRuntime: z.string().min(1).max(120).nullable().default(null),
})

export const EpisodeReceiptSchema = z.object({
  refId: z.string().min(1).max(300),
  receiptId: z.string().min(1).max(300),
  status: z.enum(['passed', 'failed', 'refused', 'unknown']),
  claim: z.string().min(1).max(1_000),
  detail: z.string().max(8_000),
  createdAt: z.string().datetime(),
})

export const CanonicalEpisodeInputSchema = z.object({
  sourceEpisodeKey: z.string().min(1).max(500),
  declaredOutcome: z.string().min(1).max(4_000),
  status: z.enum(['completed', 'failed', 'cancelled', 'indeterminate']),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable().default(null),
  domains: z.array(z.string().min(1).max(160)).max(24).default([]),
  turns: z.array(EpisodeTurnSchema).min(1).max(500),
  tasks: z.array(EpisodeTaskSchema).max(200).default([]),
  receipts: z.array(EpisodeReceiptSchema).max(200).default([]),
  sourceMetadata: z.record(z.string(), z.unknown()).default({}),
}).superRefine((value, context) => {
  if (value.status !== 'indeterminate' && value.endedAt === null) {
    context.addIssue({ code: 'custom', path: ['endedAt'], message: 'Terminal episodes require endedAt' })
  }
})
export type CanonicalEpisodeInput = z.infer<typeof CanonicalEpisodeInputSchema>

export const CanonicalEpisodeArtifactSchema = CanonicalEpisodeInputSchema.extend({
  artifactId: z.string().uuid(),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  groupingVersion: z.literal('canonical-episode-v1'),
  normalizedAt: z.string().datetime(),
  outcomeEvidenceSufficient: z.boolean(),
  evidenceRefIds: z.array(z.string()),
})
export type CanonicalEpisodeArtifact = z.infer<typeof CanonicalEpisodeArtifactSchema>

const stableValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

export const stableJson = (value: unknown): string => JSON.stringify(stableValue(value))
export const sha256 = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex')

const uuidFromHash = (hash: string): string => {
  const chars = hash.slice(0, 32).split('')
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16)
  const compact = chars.join('')
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

const hasActualOutcomeEvidence = (episode: CanonicalEpisodeInput): boolean => {
  if (episode.status === 'indeterminate') return false
  return episode.receipts.some((receipt) => receipt.status !== 'unknown')
    || episode.tasks.some((task) => task.status !== 'pending' && task.status !== 'running' && task.status !== 'unknown' && Boolean(task.outcome))
}

/**
 * Normalize an already-adapted source bundle into the one artifact shared by
 * every post-episode analysis branch. This does not read or regroup provider
 * transcripts; provider/harness adapters remain authoritative for their facts.
 */
export function canonicalizeEpisode(input: CanonicalEpisodeInput): CanonicalEpisodeArtifact {
  const parsed = CanonicalEpisodeInputSchema.parse(input)
  const turns = [...parsed.turns].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.refId.localeCompare(b.refId))
  const tasks = [...parsed.tasks].sort((a, b) => a.refId.localeCompare(b.refId))
  const receipts = [...parsed.receipts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.refId.localeCompare(b.refId))
  const domains = [...new Set(parsed.domains)].sort()
  const evidenceRefIds = [...turns, ...tasks, ...receipts].map((item) => item.refId)
  const duplicate = evidenceRefIds.find((refId, index) => evidenceRefIds.indexOf(refId) !== index)
  if (duplicate) throw new Error(`Duplicate episode evidence refId: ${duplicate}`)
  const normalized = { ...parsed, domains, turns, tasks, receipts }
  const sourceFingerprint = sha256(normalized)
  return CanonicalEpisodeArtifactSchema.parse({
    ...normalized,
    artifactId: uuidFromHash(sourceFingerprint),
    sourceFingerprint,
    groupingVersion: 'canonical-episode-v1',
    normalizedAt: new Date().toISOString(),
    outcomeEvidenceSufficient: hasActualOutcomeEvidence(normalized),
    evidenceRefIds,
  })
}

export const OutcomeSteeringDimensionJudgmentSchema = z.object({
  dimension: OutcomeSteeringDimensionSchema,
  status: z.enum(['judged', 'abstained']),
  estimate: z.number().min(0).max(1).nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(4_000),
  evidenceRefs: z.array(z.string().min(1)).max(50),
  observedDomains: z.array(z.string().min(1)).max(24),
}).superRefine((value, context) => {
  if (value.status === 'judged' && value.estimate === null) {
    context.addIssue({ code: 'custom', path: ['estimate'], message: 'Judged dimensions require an estimate' })
  }
  if (value.status === 'judged' && value.evidenceRefs.length === 0) {
    context.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'Judged dimensions require evidence references' })
  }
  if (value.status === 'abstained' && value.estimate !== null) {
    context.addIssue({ code: 'custom', path: ['estimate'], message: 'Abstained dimensions cannot carry an estimate' })
  }
})

export const OutcomeSteeringJudgmentSchema = z.object({
  evaluatorVersion: z.literal('outcome-steering-v1'),
  overallStatus: z.enum(['judged', 'abstained']),
  summary: z.string().min(1).max(8_000),
  limitations: z.array(z.string().min(1).max(2_000)).max(30),
  dimensions: z.array(OutcomeSteeringDimensionJudgmentSchema).length(OUTCOME_STEERING_DIMENSIONS.length),
})
export type OutcomeSteeringJudgment = z.infer<typeof OutcomeSteeringJudgmentSchema>

const parseJsonObject = (raw: unknown): unknown => {
  if (raw && typeof raw === 'object' && !('content' in raw)) return raw
  const embeddedContent = raw && typeof raw === 'object' && 'content' in raw
    ? raw.content
    : undefined
  const text = typeof raw === 'string'
    ? raw
    : typeof embeddedContent === 'string'
      ? embeddedContent
      : ''
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('Outcome evaluator returned no JSON object')
  return JSON.parse(text.slice(start, end + 1))
}

export function parseOutcomeSteeringJudgment(raw: unknown, artifact: CanonicalEpisodeArtifact): OutcomeSteeringJudgment {
  const judgment = OutcomeSteeringJudgmentSchema.parse(parseJsonObject(raw))
  const dimensions = new Set(judgment.dimensions.map((item) => item.dimension))
  if (dimensions.size !== OUTCOME_STEERING_DIMENSIONS.length) {
    throw new Error('Outcome evaluator must return every steering dimension exactly once')
  }
  if (!artifact.outcomeEvidenceSufficient && (
    judgment.overallStatus !== 'abstained'
    || judgment.dimensions.some((item) => item.status !== 'abstained')
  )) {
    throw new Error('Outcome evaluator must abstain when actual outcome evidence is insufficient')
  }
  const knownRefs = new Set(artifact.evidenceRefIds)
  const knownDomains = new Set(artifact.domains)
  for (const item of judgment.dimensions) {
    for (const refId of item.evidenceRefs) {
      if (!knownRefs.has(refId)) throw new Error(`${item.dimension} cites unknown evidence reference: ${refId}`)
    }
    for (const domain of item.observedDomains) {
      if (!knownDomains.has(domain)) throw new Error(`${item.dimension} cites unknown episode domain: ${domain}`)
    }
  }
  const transfer = judgment.dimensions.find((item) => item.dimension === 'cross_domain_transfer')!
  if (transfer.status === 'judged' && new Set(transfer.observedDomains).size < 2) {
    throw new Error('A cross-domain transfer judgment requires evidence from at least two episode domains')
  }
  return judgment
}

export function outcomeSteeringPrompt(artifact: CanonicalEpisodeArtifact): string {
  return [
    'You are evaluating the user\'s curriculum-independent ability to steer an AI system toward an outcome after a work episode has ended.',
    'Return JSON only. Preserve a profile; never return or infer one global score.',
    `Return evaluatorVersion "outcome-steering-v1", overallStatus (judged or abstained), summary, limitations, and exactly these dimensions: ${OUTCOME_STEERING_DIMENSIONS.join(', ')}.`,
    'Each dimension is {dimension,status,estimate,confidence,rationale,evidenceRefs,observedDomains}. estimate is 0..1 for judged and null for abstained.',
    'Every judged dimension must cite exact refId values from the artifact. Abstain wherever evidence is insufficient.',
    'Judge instructions together with actual outcomes, corrections, delegation, tool/model choices, and verification. Wording alone is insufficient.',
    'Do not equate task success with steering mastery. Do not blame the user for a model or tool failure without user-controllable evidence.',
    'Cross-domain transfer may be judged only when the artifact contains comparable observations in at least two domains; otherwise abstain for that dimension.',
    `The deterministic provenance check says outcome evidence sufficient: ${artifact.outcomeEvidenceSufficient}. If false, overallStatus must be abstained and every unsupported dimension must abstain.`,
    'CANONICAL EPISODE ARTIFACT:',
    stableJson(artifact),
  ].join('\n\n')
}
