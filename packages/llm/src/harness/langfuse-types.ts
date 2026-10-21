/**
 * Shared contract for the Maestro → Langfuse projection.
 *
 * Langfuse is the FRONT END for harness experiments: every terminal Maestro
 * run becomes exactly one trace, grouped by experiment so runs of the same
 * task under different harness settings sit side by side. The projection is
 * deterministic: the same evidence always yields the same object ids, so a
 * replay after a crash, a retry, or a projector revision bump never creates a
 * second trace or double-counts usage. Ids are uuid v5 over the stable native
 * identifiers below, never over arrival order or export time.
 *
 * Three modules implement this contract and nothing else shares files:
 *  - langfuse-evidence.ts   gathers MaestroTraceEvidence for a run (store + journals + native rollouts)
 *  - langfuse-projector.ts  pure: MaestroTraceEvidence → LangfuseBatch
 *  - langfuse-export.ts     LangfuseBatch → /api/public/ingestion, plus the exactly-once ledger
 */
/** Run shape owned by the orchestration harness; Learning never builds one. */
type MaestroRun = Record<string, unknown>

/** Bump when the projection shape changes; the ledger keys on (taskId, fence, revision). */
export const LANGFUSE_PROJECTOR_REVISION = 1

/** uuid v5 namespace for every projected id. Fixed forever; changing it re-keys history. */
export const LANGFUSE_ID_NAMESPACE = '6f1c0c3e-9b3a-4c7e-8d0a-2f3b7c1a9e55'

export type TimingQuality = 'native' | 'adapter' | 'inferred' | 'unknown'

/** One native model call, as recorded by the provider's own store (Codex rollout, Claude project log, AGY db). */
export type NativeGeneration = {
  /** Provider-native id of the call (Codex response id, Claude message uuid, AGY row id). */
  nativeId: string
  /** Native session/thread the call belongs to; a child agent has its own. */
  sessionId: string
  /** Parent native session when this call ran inside a child agent, else undefined. */
  parentSessionId?: string
  model: string
  startedAt?: string
  endedAt?: string
  timingQuality: TimingQuality
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number; total?: number }
  /** Where the usage numbers came from, verbatim path or store name. */
  usageSource: string
  /** Optional short input/output previews; the projector must NOT embed raw transcripts. */
  inputPreview?: string
  outputPreview?: string
  toolCalls?: Array<{ nativeId: string; name: string; startedAt?: string; endedAt?: string; status?: string }>
}

/** A lane journal record after parsing (see packages/completion-receipt/src/lane-journal.ts). */
export type JournalTurn = {
  turnId: string
  sessionId?: string
  startedAt?: string
  endedAt?: string
  status?: string
  timingQuality: TimingQuality
}

export type StageAttempt = { stage: string; status: string; startedAt: string; finishedAt?: string; durationMs?: number; error?: string }

export type MaestroTraceEvidence = {
  run: MaestroRun
  /** Absolute paths of the journal files that were read, oldest first. */
  journalFiles: string[]
  turns: JournalTurn[]
  stages: StageAttempt[]
  actions: Array<{ at: string; role: string; kind: string; body: string }>
  generations: NativeGeneration[]
  /** Receipt outcome as the completion-receipt CLI reports it. */
  receipt?: { finalized: boolean; status?: string; events: number }
  /** Evidence that was looked for and not found; becomes a trace-level gap score, never a fabricated value. */
  gaps: Array<{ kind: string; detail: string }>
}

/** Langfuse legacy ingestion event shapes we emit (deterministic ids, upsert semantics on the server). */
export type LangfuseTraceEvent = {
  id: string; type: 'trace-create'; timestamp: string
  body: { id: string; name: string; timestamp: string; sessionId?: string; userId?: string; tags?: string[]; metadata?: Record<string, unknown>; input?: unknown; output?: unknown; release?: string; version?: string; environment?: string }
}
export type LangfuseSpanEvent = {
  id: string; type: 'span-create'; timestamp: string
  body: { id: string; traceId: string; parentObservationId?: string; name: string; startTime: string; endTime?: string; level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'; statusMessage?: string; metadata?: Record<string, unknown>; input?: unknown; output?: unknown; environment?: string }
}
export type LangfuseGenerationEvent = {
  id: string; type: 'generation-create'; timestamp: string
  body: { id: string; traceId: string; parentObservationId?: string; name: string; startTime: string; endTime?: string; model?: string; modelParameters?: Record<string, string | number>; usage?: { input?: number; output?: number; total?: number; unit?: 'TOKENS' }; usageDetails?: Record<string, number>; level?: 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR'; metadata?: Record<string, unknown>; input?: unknown; output?: unknown; environment?: string }
}
export type LangfuseScoreEvent = {
  id: string; type: 'score-create'; timestamp: string
  body: { id: string; traceId: string; observationId?: string; name: string; value: number | string; dataType?: 'NUMERIC' | 'BOOLEAN' | 'CATEGORICAL'; comment?: string; environment?: string }
}
export type LangfuseEvent = LangfuseTraceEvent | LangfuseSpanEvent | LangfuseGenerationEvent | LangfuseScoreEvent

export type LangfuseBatch = {
  taskId: string
  fence: number
  revision: number
  traceId: string
  events: LangfuseEvent[]
  /** Totals the ledger records so a replay can prove nothing was double-counted. */
  totals: { generations: number; inputTokens: number; outputTokens: number }
}

export type LangfuseTarget = {
  /** e.g. http://127.0.0.1:3100/experiments — the API lives under <baseUrl>/api/public. */
  baseUrl: string
  publicKey: string
  secretKey: string
  /** Langfuse environment label on every object; 'maestro-harness' by default. */
  environment?: string
}

export type LangfuseLedgerRow = {
  taskId: string
  fence: number
  revision: number
  traceId: string
  status: 'queued' | 'exported' | 'failed'
  attempts: number
  objectCount: number
  totals: LangfuseBatch['totals']
  error?: string
  exportedAt?: string
  updatedAt: string
}
