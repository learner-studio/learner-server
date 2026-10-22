import { z } from 'zod'
import { LearningHookContextInput, LearningHookContextOutput } from './learning/learning-hook-context.js'
import { LearningFeedbackBeginPacket } from './learning/learning-live-hook.js'
import { LearningHookHealth, RecordLearningHookHealthInput, RecordLearningHookHealthOutput } from './learning/learning-hook-health.js'
import { LearningIndexStatus } from './learning/learning-index-status.js'
import { UploadTranscriptInput, UploadTranscriptOutput } from './learning/transcript-upload.js'

/**
 * The wire contract between the Learner server and its two clients (the CLI
 * hook and the web app). Each entry is one `POST /rpc/<name>` with body
 * `{ data: input }` returning `output` as JSON.
 *
 * Inputs here describe the wire shape. The server keeps stricter validation of
 * its own (concept IDs against the live catalog, evidence quotes against the
 * stored message), so a client that passes these schemas can still be refused.
 */
const CatalogEntry = z.object({ id: z.string(), title: z.string() })
const ConceptMatch = z.object({
  conceptId: z.string(), quote: z.string(),
  relationship: z.enum(['mention', 'task_context', 'learner_evidence', 'misconception']),
  outcome: z.enum(['demonstrated', 'partial', 'unclear', 'not_assessed']),
  reason: z.string(), remainingGap: z.string().optional(),
})
const PromptRevision = z.literal('task-teaching-v2')
const OutcomeVersion = z.enum(['v1', 'v1.2', 'v1.3', 'v1.4'])

export const BeginLearningFeedbackTurnWire = z.object({
  sessionId: z.string(), turnId: z.string().uuid(), message: z.string(), foundationFirst: z.boolean().optional(), catalogVersion: z.string().optional(),
})
export const SubmitLearningTurnFeedbackWire = z.object({
  sessionId: z.string(), turnId: z.string().uuid(), catalogVersion: z.string(), matches: z.array(ConceptMatch), taughtConceptIds: z.array(z.string()).optional(),
})
export const SubmitLearningTurnFeedbackResult = z.object({ status: z.literal('provisional'), replayed: z.boolean(), guidance: LearningHookContextOutput })
export const LearningFeedbackTraceWire = z.object({
  sessionId: z.string(), turnId: z.string().uuid(), phase: z.enum(['injection', 'submission']), promptRevision: PromptRevision,
  outcomeVersion: OutcomeVersion.optional(), catalogVersion: z.string(), promptHash: z.string(), injectedPrompt: z.string(), message: z.string(),
  feedback: z.unknown().optional(), guidance: z.unknown().optional(),
})
export const LearningFeedbackCatalog = z.object({ catalogVersion: z.string(), catalog: z.array(CatalogEntry) })

const rpc = <I extends z.ZodType, O extends z.ZodType>(input: I, output: O, client: 'hook' | 'web' | 'both' | 'remote') => ({ input, output, client })

export const RPC = {
  getLearningFeedbackCatalog: rpc(z.object({}), LearningFeedbackCatalog, 'both'),
  getLearningHookContext: rpc(LearningHookContextInput, LearningHookContextOutput, 'hook'),
  beginLearningFeedbackTurn: rpc(BeginLearningFeedbackTurnWire, LearningFeedbackBeginPacket, 'hook'),
  submitLearningTurnFeedback: rpc(SubmitLearningTurnFeedbackWire, SubmitLearningTurnFeedbackResult, 'hook'),
  recordLearningFeedbackTrace: rpc(LearningFeedbackTraceWire, z.object({ traceId: z.string().uuid(), state: z.string() }), 'hook'),
  recordLearningHookHealth: rpc(RecordLearningHookHealthInput, RecordLearningHookHealthOutput, 'hook'),
  notifyLearningTranscriptChanged: rpc(
    z.object({ sessionId: z.string().uuid(), invocationId: z.string().uuid() }),
    z.object({ runId: z.string().uuid().nullable(), coalesced: z.boolean().optional(), pending: z.boolean().optional() }), 'hook'),
  getLearningHookHealth: rpc(z.object({ windowMinutes: z.number().int().optional() }), LearningHookHealth, 'web'),
  getLearningIndexStatus: rpc(z.object({}), LearningIndexStatus, 'web'),
  startLearningIndex: rpc(z.object({}).passthrough(), z.object({ runId: z.string().uuid() }), 'web'),
  /** A desktop client with no access to this machine's disk sends its transcripts here. */
  uploadTranscript: rpc(UploadTranscriptInput, UploadTranscriptOutput, 'remote'),
} as const

export type RpcName = keyof typeof RPC
export type RpcInput<N extends RpcName> = z.input<(typeof RPC)[N]['input']>
export type RpcOutput<N extends RpcName> = z.output<(typeof RPC)[N]['output']>

/** A non-2xx RPC answer. `message` mirrors the server's `{ message }` body; the status stays in the text for log grepping. */
export class RpcError extends Error {
  constructor(readonly rpc: string, readonly status: number, message: string) {
    super(`Learning ${rpc} HTTP ${status}: ${message}`)
    this.name = 'RpcError'
  }
}

export interface ClientOptions {
  /** Origin of the Learner server, e.g. `http://127.0.0.1:3010`. Empty for same-origin (the web app). */
  baseUrl?: string
  /** Machine API key (hook). The web app authenticates with its session cookie instead. */
  apiKey?: string
  fetch?: typeof fetch
}

/** Typed `POST /rpc/<name>`; the response is validated against the contract. */
export function createLearnerClient({ baseUrl = '', apiKey, fetch: doFetch = fetch }: ClientOptions = {}) {
  return async function call<N extends RpcName>(name: N, data: RpcInput<N>, options: { timeoutMs?: number; validate?: boolean } = {}): Promise<RpcOutput<N>> {
    const response = await doFetch(`${baseUrl}/rpc/${name}`, {
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: { 'content-type': 'application/json', ...(apiKey ? { 'x-api-key': apiKey } : {}) },
      body: JSON.stringify({ data }),
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    })
    if (!response.ok) {
      const text = await response.text()
      let message = text.slice(0, 1500)
      try { message = (JSON.parse(text) as { message?: string }).message ?? message } catch { /* not JSON */ }
      throw new RpcError(name, response.status, message)
    }
    const body = await response.json()
    return (options.validate === false ? body : RPC[name].output.parse(body)) as RpcOutput<N>
  }
}
export type LearnerClient = ReturnType<typeof createLearnerClient>
