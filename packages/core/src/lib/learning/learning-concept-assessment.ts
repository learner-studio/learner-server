import { createHash } from 'node:crypto'
import { z } from 'zod'
import { GradualAssessmentProposalSchema, GRADUAL_ASSESSMENT_REVISION, gradualAssessmentPrompt, gradualAssessmentSchema } from './learning-gradual-assessment.js'
import { LearningConceptAssessmentSchema } from './learning-concept-assessment-schemas.js'
import { AssessmentEvidenceProvenanceSchema } from './learning-assessment-evidence.js'
export { LearningConceptAssessmentSchema } from './learning-concept-assessment-schemas.js'

export const ASSESSMENT_MODEL = { backend: 'codex', model: 'gpt-5.6-luna', effort: 'xhigh', timeout: 420, killMs: 420_000, maxParseRetries: 0, maxAttempts: 1 } as const
export const assessmentHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const providedAssessmentHash=(inputHash:string,prior:unknown,experimentId:string,live=false)=>live?inputHash:assessmentHash({input:inputHash,prior,experimentId})
export const AssessmentSourceSchema = z.object({ id: z.string(), conversationId: z.string(), role: z.string(), text: z.string(), occurredAt: z.string().nullable() })
export const LearningAssessmentRunSchema = z.object({
  runId: z.string(), conceptId: z.string(), userId: z.string(), nodeVersion: z.string(), inputHash: z.string(),
  status: z.enum(['queued', 'reserved', 'completed', 'no_evidence', 'unchanged', 'failed', 'uncertain', 'stale']),
  createdAt: z.string(), prompt: z.string(), model: z.object({ backend: z.string(), model: z.string(), effort: z.string(), timeout: z.number(), killMs: z.number(), maxParseRetries: z.number(), maxAttempts: z.number() }),
  evidence: z.array(AssessmentSourceSchema), promptRevision: z.string(),
  provenance: AssessmentEvidenceProvenanceSchema.optional(),
  receipt: z.object({ status: z.string(), assessment: GradualAssessmentProposalSchema.nullable(), raw: z.string(), error: z.string().nullable(), durationMs: z.number(), inputTokens: z.number().nullable(), outputTokens: z.number().nullable(), completedAt: z.string(), masteryWrites: z.literal(0),
    // Typed-decision arms (Jev) answer a score question, not a structured proposal.
    decision: z.object({ level: z.number().int(), expectedScore: z.number().optional(), probabilities: z.record(z.string(), z.number()), confidence: z.number(), legend: z.record(z.string(), z.unknown()), returnedModel: z.string(), usage: z.unknown() }).nullable().optional(), rateLimitRetries: z.number().int().optional(),
    validatorRetry: z.object({ kind: z.enum(['quote', 'nodeVersion']), recovered: z.boolean(), firstError: z.string() }).nullable().optional() }).nullable(),
})
export type AssessmentSource = z.infer<typeof AssessmentSourceSchema>
export type LearningConceptAssessment = z.infer<typeof LearningConceptAssessmentSchema>
export type LearningAssessmentRun = z.infer<typeof LearningAssessmentRunSchema>
export type AssessmentConcept = { conceptId: string; title: string; description: string; objectives: string[] }

/** The server's concept version: the four defining fields, keys sorted, so a concept read back from JSONB
 * (which orders keys by length) hashes like the one built from the curriculum. */
export function conceptVersion(concept: AssessmentConcept): string {
  const { conceptId, description, objectives, title } = concept
  return assessmentHash({ conceptId, description, objectives, title })
}
/** Rows written before the canonical version carry a serialized-order hash: builder order (conceptFromGraphs) or
 * JSONB order (a concept read back from a run snapshot). Both stay current until rewritten; no mass invalidation. */
export function nodeVersionMatches(stored: string, concept: AssessmentConcept): boolean {
  const { conceptId, title, description, objectives } = concept
  return stored === conceptVersion(concept) || stored === assessmentHash({ conceptId, title, description, objectives })
    || stored === assessmentHash({ title, conceptId, objectives, description })
}

/** JSONB reorders object keys; compare semantic fields, not serialized key order. */
export function sameAssessmentConcept(a: AssessmentConcept, b: AssessmentConcept): boolean {
  return a.conceptId===b.conceptId && a.title===b.title && a.description===b.description
    && JSON.stringify(a.objectives)===JSON.stringify(b.objectives)
}

export function buildConceptAssessmentInput(concept: AssessmentConcept, evidence: AssessmentSource[], _prior: LearningConceptAssessment['assessment']) {
  const nodeVersion = conceptVersion(concept)
  const nodeStates = [{ ...concept, nodeVersion, understandingPercent: null }]
  const input = { nodeStates, nativeObservations: [], evidence }
  return {
    nodeVersion, inputHash: assessmentHash({ revision: GRADUAL_ASSESSMENT_REVISION, model: ASSESSMENT_MODEL, concept, evidence }),
    prompt: gradualAssessmentPrompt(input), schema: gradualAssessmentSchema([concept.conceptId]),
    context: { nodeStates, humanTextBySourceId: Object.fromEntries(evidence.filter(item => item.role === 'user').map(item => [item.id, item.text])) },
  }
}

export function assessmentTriggerDue(input: { newIndexedMessages: number; oldestPendingAt: string | null; now?: number; countThreshold?: number; maxAgeMs?: number }) {
  if (input.newIndexedMessages <= 0 || !input.oldestPendingAt) return false
  return input.newIndexedMessages >= (input.countThreshold ?? 20)
    || (input.now ?? Date.now()) - Date.parse(input.oldestPendingAt) >= (input.maxAgeMs ?? 3_600_000)
}
/** Variables backends may decode JSON booleans; only explicit true opts in. */
export function assessmentAutomationEnabled(value: unknown): boolean {
  return value === true || value === 'true'
}
