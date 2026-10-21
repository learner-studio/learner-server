/**
 * Ships one projected LangfuseBatch to a Langfuse v4 instance.
 *
 * **The legacy `/api/public/ingestion` path is DEAD on v4 and this module no
 * longer speaks it.** A live replay against Langfuse 4.30 answered every
 * `trace-create`, `span-create` and `generation-create` event with
 * `400 Event type not accepted`; in v4 the worker's `otelIngestionQueue` is the
 * only thing that writes observations, and it writes straight to `events_full`.
 * So the transport here is OTLP/HTTP JSON, and the projector's event shapes are
 * MAPPED onto spans rather than posted as-is.
 *
 * 🚨 **That write is APPEND-ONLY: there is no upsert on span id.** Sending the
 * same span twice produces two rows, not one, so a replay silently doubles
 * every token and cost figure in the experiment view. Under the legacy API the
 * server's id upsert was a second line of defence; it is gone. **Exactly-once
 * now rests ENTIRELY on `claimLangfuseExport` in langfuse-ledger.ts** — never
 * call this function without holding a claim, and never "just retry" an export
 * whose outcome is unknown without consulting the ledger first.
 *
 * Scores cannot ride OTLP at all, and they are the ONE thing the legacy
 * endpoint still takes: under `LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only`
 * `/api/public/ingestion` refuses every observation type with
 * `Event type not accepted` while continuing to accept score and log events.
 * So `score-create` events go there unchanged, in their projected form, and
 * only trace/span/generation are mapped onto OTLP. That endpoint DOES key on
 * the score id, which is why a duplicate there is treated as success rather
 * than as a failure.
 *
 * Two rules are load-bearing:
 *  - Credentials never reach a message, a log line, or a thrown error. The
 *    target is read once, used to build the Authorization header, and never
 *    interpolated anywhere else.
 *  - Response bodies are never echoed either, except OTLP's structured
 *    `partialSuccess` and the scores API's status, which are the only places
 *    the server tells us WHICH work it refused.
 */
import {enqueueLangfuseWrite,type LangfuseOutbox} from '../lib/llm/learning-experiment-langfuse-transport.js'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { LANGFUSE_PROJECTOR_REVISION, type LangfuseBatch, type LangfuseEvent, type LangfuseGenerationEvent, type LangfuseScoreEvent, type LangfuseSpanEvent, type LangfuseTarget, type LangfuseTraceEvent } from './langfuse-types.js'

/** Langfuse rejects oversized payloads; stay well under the usual limit. */
const MAX_REQUEST_BYTES = 3_500_000
const DEFAULT_CHUNK_SIZE = 100
const MAX_ATTEMPTS = 4 // one try plus three retries
const BASE_BACKOFF_MS = 200
const MAX_RETRY_WINDOW_MS = 60_000
const SCOPE_NAME = 'maestro-langfuse'

/**
 * Span-attribute names, verified against the running image rather than the
 * docs: `LangfuseOtelSpanAttributes` in
 * `@langfuse/shared/dist/src/server/otel/attributes.js` inside
 * `biztools-langfuse-worker-1`. Two are easy to get wrong from memory — model
 * parameters are `model.parameters`, NOT `model_parameters`, and the primary
 * session key is the OTel-conventional `session.id` with `langfuse.session.id`
 * kept only as a documented compatibility alias.
 */
const ATTR = {
  traceName: 'langfuse.trace.name',
  traceTags: 'langfuse.trace.tags',
  traceInput: 'langfuse.trace.input',
  traceOutput: 'langfuse.trace.output',
  traceMetadata: 'langfuse.trace.metadata',
  sessionId: 'session.id',
  sessionIdCompat: 'langfuse.session.id',
  userId: 'user.id',
  release: 'langfuse.release',
  version: 'langfuse.version',
  environment: 'langfuse.environment',
  observationType: 'langfuse.observation.type',
  observationLevel: 'langfuse.observation.level',
  observationStatusMessage: 'langfuse.observation.status_message',
  observationMetadata: 'langfuse.observation.metadata',
  observationInput: 'langfuse.observation.input',
  observationOutput: 'langfuse.observation.output',
  observationModel: 'langfuse.observation.model.name',
  observationModelParameters: 'langfuse.observation.model.parameters',
  observationUsageDetails: 'langfuse.observation.usage_details',
} as const

export type LangfuseExportError = { id: string; status: number; message: string }
export type LangfuseExportResult = { ok: boolean; accepted: number; errors: LangfuseExportError[]; state?:'queued'|'delivered'; outboxIds?:string[] }

export type LangfuseExportDeps = {
  /** Append-only callers must use one attempt; ambiguous outcomes require ledger review. */
  maxAttempts?: number
  fetch?: typeof fetch
  chunkSize?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
}

type AttrValue = string | number | boolean
type OtlpSpan = {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: Array<{ key: string; value: Record<string, unknown> }>
  status?: { code: number; message?: string }
}
type PreparedSpan = { eventId: string; span: OtlpSpan; bytes: number }

/** Parents before children: the trace root first, then spans in the order given, then generations. */
const TYPE_ORDER: Record<LangfuseEvent['type'], number> = {
  'trace-create': 0,
  'span-create': 1,
  'generation-create': 2,
  'score-create': 3,
}

function orderEvents(events: LangfuseEvent[]): LangfuseEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => (TYPE_ORDER[a.event.type] - TYPE_ORDER[b.event.type]) || (a.index - b.index))
    .map((entry) => entry.event)
}

/**
 * OTel ids are fixed-width hex, and the projector's ids are uuid v5 — so the
 * conversion is a dash strip, never a re-derivation, and the same evidence
 * keeps producing the same span id. A non-uuid id is hashed rather than
 * padded, so a caller cannot collide two observations by truncation.
 */
function hexId(id: string, length: 16 | 32): string {
  const stripped = id.replace(/-/g, '').toLowerCase()
  const source = /^[0-9a-f]{32}$/.test(stripped) ? stripped : createHash('sha256').update(id).digest('hex')
  return source.slice(0, length)
}

function unixNanos(iso: string | undefined, fallback: string): string {
  const parsed = Date.parse(iso ?? '')
  const millis = Number.isNaN(parsed) ? Date.parse(fallback) : parsed
  return `${BigInt(Number.isNaN(millis) ? 0 : millis) * 1_000_000n}`
}

function attrValue(value: AttrValue): Record<string, unknown> {
  if (typeof value === 'boolean') return { boolValue: value }
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
  return { stringValue: value }
}

function attributes(entries: Array<[string, AttrValue | undefined]>): OtlpSpan['attributes'] {
  return entries
    .filter((entry): entry is [string, AttrValue] => entry[1] !== undefined && entry[1] !== '')
    .map(([key, value]) => ({ key, value: attrValue(value) }))
}

/** Metadata is FLATTENED onto `<prefix>.<key>`; the processor reads that form and a JSON blob alike, and the flat form survives a key the blob parser would drop. */
function metadataEntries(prefix: string, metadata: Record<string, unknown> | undefined): Array<[string, AttrValue | undefined]> {
  if (!metadata) return []
  return Object.entries(metadata).map(([key, value]) => [
    `${prefix}.${key}`,
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : value === undefined || value === null ? undefined : JSON.stringify(value),
  ])
}

function jsonOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function levelStatus(level: string | undefined, statusMessage: string | undefined): OtlpSpan['status'] {
  if (level !== 'ERROR') return undefined
  return statusMessage ? { code: 2, message: statusMessage } : { code: 2 }
}

function traceSpan(event: LangfuseTraceEvent, traceId: string, environment: string | undefined, endsAt: string): PreparedSpan {
  const { body } = event
  const span: OtlpSpan = {
    traceId,
    spanId: hexId(body.id, 16),
    name: body.name,
    kind: 1,
    startTimeUnixNano: unixNanos(body.timestamp, event.timestamp),
    endTimeUnixNano: unixNanos(endsAt, body.timestamp),
    attributes: attributes([
      [ATTR.traceName, body.name],
      [ATTR.observationType, 'span'],
      [ATTR.sessionId, body.sessionId],
      [ATTR.sessionIdCompat, body.sessionId],
      [ATTR.userId, body.userId],
      [ATTR.traceTags, body.tags?.length ? JSON.stringify(body.tags) : undefined],
      [ATTR.environment, body.environment ?? environment],
      [ATTR.release, body.release],
      [ATTR.version, body.version],
      [ATTR.traceInput, jsonOrUndefined(body.input)],
      [ATTR.traceOutput, jsonOrUndefined(body.output)],
      // V4 events-only stores root spans as observations. Preserve the same
      // exact I/O there as well, not solely in legacy trace attributes.
      [ATTR.observationInput, jsonOrUndefined(body.input)],
      [ATTR.observationOutput, jsonOrUndefined(body.output)],
      ...metadataEntries(ATTR.traceMetadata, body.metadata),
    ]),
  }
  return { eventId: event.id, span, bytes: 0 }
}

function observationSpan(
  event: LangfuseSpanEvent | LangfuseGenerationEvent,
  traceId: string,
  rootSpanId: string,
  environment: string | undefined,
): PreparedSpan {
  const { body } = event
  const isGeneration = event.type === 'generation-create'
  const generation = isGeneration ? (event as LangfuseGenerationEvent).body : undefined
  const endedAt = body.endTime
  // An observation with no recorded end is given its own start rather than
  // "now": a fabricated duration would read as measured latency forever.
  const timingNote: Array<[string, AttrValue | undefined]> = endedAt
    ? []
    : [[`${ATTR.observationMetadata}.timingQuality`, (body.metadata?.timingQuality as AttrValue | undefined) ?? 'unknown']]
  const usageDetails = generation
    ? {
        ...(generation.usage?.input !== undefined ? { input: generation.usage.input } : {}),
        ...(generation.usage?.output !== undefined ? { output: generation.usage.output } : {}),
        ...(generation.usage?.total !== undefined ? { total: generation.usage.total } : {}),
        ...generation.usageDetails,
      }
    : undefined
  const span: OtlpSpan = {
    traceId,
    spanId: hexId(body.id, 16),
    parentSpanId: body.parentObservationId ? hexId(body.parentObservationId, 16) : rootSpanId,
    name: body.name,
    kind: 1,
    startTimeUnixNano: unixNanos(body.startTime, event.timestamp),
    endTimeUnixNano: unixNanos(endedAt, body.startTime),
    attributes: attributes([
      [ATTR.observationType, isGeneration ? 'generation' : 'span'],
      [ATTR.observationLevel, body.level],
      [ATTR.observationStatusMessage, 'statusMessage' in body ? body.statusMessage : undefined],
      [ATTR.environment, body.environment ?? environment],
      [ATTR.observationInput, jsonOrUndefined(body.input)],
      [ATTR.observationOutput, jsonOrUndefined(body.output)],
      [ATTR.observationModel, generation?.model],
      [ATTR.observationModelParameters, jsonOrUndefined(generation?.modelParameters)],
      [ATTR.observationUsageDetails, usageDetails && Object.keys(usageDetails).length ? JSON.stringify(usageDetails) : undefined],
      ...metadataEntries(ATTR.observationMetadata, body.metadata),
      ...timingNote,
    ]),
    ...(levelStatus(body.level, 'statusMessage' in body ? body.statusMessage : undefined) ? { status: levelStatus(body.level, 'statusMessage' in body ? body.statusMessage : undefined)! } : {}),
  }
  return { eventId: event.id, span, bytes: 0 }
}

/** Maps the projected events onto OTLP spans, oldest ancestor first. Scores are returned separately because OTLP has nowhere to put them. */
function prepare(batch: LangfuseBatch, environment: string | undefined): { spans: PreparedSpan[]; scores: LangfuseScoreEvent[] } {
  const ordered = orderEvents(batch.events)
  const traceEvent = ordered.find((event): event is LangfuseTraceEvent => event.type === 'trace-create')
  const traceId = hexId(batch.traceId, 32)
  const rootSpanId = hexId(traceEvent?.body.id ?? batch.traceId, 16)
  const observations = ordered.filter((event): event is LangfuseSpanEvent | LangfuseGenerationEvent => event.type === 'span-create' || event.type === 'generation-create')
  const latestEnd = observations
    .map((event) => event.body.endTime ?? event.body.startTime)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1)

  const spans: PreparedSpan[] = []
  if (traceEvent) spans.push(traceSpan(traceEvent, traceId, environment, latestEnd ?? traceEvent.body.timestamp))
  for (const event of observations) spans.push(observationSpan(event, traceId, rootSpanId, environment))
  for (const entry of spans) entry.bytes = Buffer.byteLength(JSON.stringify(entry.span), 'utf8') + 1

  return { spans, scores: ordered.filter((event): event is LangfuseScoreEvent => event.type === 'score-create') }
}

function chunkSpans(spans: PreparedSpan[], chunkSize: number): PreparedSpan[][] {
  const chunks: PreparedSpan[][] = []
  let current: PreparedSpan[] = []
  let bytes = 0
  for (const entry of spans) {
    if (current.length >= chunkSize || (current.length > 0 && bytes + entry.bytes > MAX_REQUEST_BYTES)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(entry)
    bytes += entry.bytes
  }
  if (current.length) chunks.push(current)
  return chunks
}

/** The same count-and-byte budget as the span chunker, for the score events that still ride the legacy endpoint. */
function chunkEvents<T>(events: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let bytes = 0
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
    if (current.length >= chunkSize || (current.length > 0 && bytes + size > MAX_REQUEST_BYTES)) {
      chunks.push(current)
      current = []
      bytes = 0
    }
    current.push(event)
    bytes += size
  }
  if (current.length) chunks.push(current)
  return chunks
}

/**
 * Reads the legacy endpoint's per-object outcome:
 * `{ successes: [{id,status}], errors: [{id,status,message,error}] }`.
 * A duplicate is the retry succeeding, not a failure — the endpoint keys on
 * the score id, which is the whole reason the projector makes it deterministic.
 */
function readIngestionBody(body: unknown, sent: LangfuseScoreEvent[]): { accepted: number; errors: LangfuseExportError[] } {
  const shape = (body ?? {}) as { successes?: Array<{ id?: unknown }>; errors?: Array<{ id?: unknown; status?: unknown; message?: unknown; error?: unknown }> }
  const raw = Array.isArray(shape.errors) ? shape.errors : []
  const isDuplicate = (entry: { status?: unknown; message?: unknown; error?: unknown }) =>
    entry.status === 409 || /duplicate|already exists/i.test(`${entry.message ?? ''} ${entry.error ?? ''}`)
  const errors: LangfuseExportError[] = raw.filter((entry) => !isDuplicate(entry)).map((entry) => ({
    id: typeof entry?.id === 'string' ? entry.id : 'unknown',
    status: typeof entry?.status === 'number' ? entry.status : 400,
    message: typeof entry?.message === 'string' && entry.message
      ? entry.message
      : typeof entry?.error === 'string' && entry.error
        ? entry.error
        : 'langfuse rejected the score',
  }))
  const succeeded = Array.isArray(shape.successes) ? shape.successes.length : sent.length - raw.length
  return { accepted: Math.max(succeeded + (raw.length - errors.length), 0), errors }
}

function otlpPayload(chunk: PreparedSpan[], environment: string | undefined): string {
  return JSON.stringify({
    resourceSpans: [{
      resource: { attributes: attributes([['service.name', SCOPE_NAME], [ATTR.environment, environment]]) },
      scopeSpans: [{
        scope: { name: SCOPE_NAME, version: String(LANGFUSE_PROJECTOR_REVISION) },
        spans: chunk.map((entry) => entry.span),
      }],
    }],
  })
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

async function sleepDefault(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

type Resolved = Required<Pick<LangfuseExportDeps, 'fetch' | 'sleep' | 'now' | 'maxAttempts'>>
type Attempted = { status: number; body: unknown; reason?: string }

/** One request with the retry policy applied. `status: 0` means the request never got an answer. */
async function request(url: string, authorization: string, payload: string, deps: Resolved, startedAt: number): Promise<Attempted> {
  let lastStatus = 0
  let lastReason = 'no attempt was made'
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
    try {
      const response = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization },
        body: payload,
      })
      if (response.status < 300 || !isRetryableStatus(response.status)) {
        let body: unknown
        try { body = await response.json() } catch { body = undefined }
        return { status: response.status, body }
      }
      lastStatus = response.status
      lastReason = `langfuse returned HTTP ${response.status}`
    } catch (error) {
      // Never surface the cause verbatim beyond its message: the request options hold the credentials.
      lastStatus = 0
      lastReason = `langfuse request failed: ${error instanceof Error ? error.message : 'network error'}`
    }
    const elapsed = deps.now().getTime() - startedAt
    if (attempt === deps.maxAttempts || elapsed > MAX_RETRY_WINDOW_MS) break
    await deps.sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1))
  }
  return { status: lastStatus, body: undefined, reason: `${lastReason} (gave up after ${deps.maxAttempts} attempts)` }
}

/** OTLP answers 200 with `{}` on full acceptance and `{partialSuccess:{rejectedSpans,errorMessage}}` otherwise. */
function readPartialSuccess(body: unknown): { rejected: number; message?: string } {
  const partial = (body as { partialSuccess?: { rejectedSpans?: unknown; errorMessage?: unknown } } | undefined)?.partialSuccess
  if (!partial) return { rejected: 0 }
  const rejected = Number(partial.rejectedSpans ?? 0)
  return {
    rejected: Number.isFinite(rejected) ? rejected : 0,
    ...(typeof partial.errorMessage === 'string' && partial.errorMessage ? { message: partial.errorMessage } : {}),
  }
}

/**
 * Sends a projected batch. Resolves with the aggregate outcome instead of
 * throwing, because the caller's next move is always to write a ledger row.
 */
export async function deliverLangfuseBatch(
  batch: LangfuseBatch,
  target: LangfuseTarget,
  deps: LangfuseExportDeps = {},
): Promise<LangfuseExportResult> {
  const resolved: Resolved = {
    fetch: deps.fetch ?? globalThis.fetch,
    sleep: deps.sleep ?? sleepDefault,
    now: deps.now ?? (() => new Date()),
    maxAttempts: Math.max(1, Math.min(MAX_ATTEMPTS, Math.floor(deps.maxAttempts ?? MAX_ATTEMPTS))),
  }
  const chunkSize = Math.max(1, deps.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const base = target.baseUrl.replace(/\/+$/, '')
  const tracesUrl = `${base}/api/public/otel/v1/traces`
  // Scores are the one event type the legacy endpoint still accepts under events_only mode.
  const ingestionUrl = `${base}/api/public/ingestion`
  const authorization = `Basic ${Buffer.from(`${target.publicKey}:${target.secretKey}`, 'utf8').toString('base64')}`
  const startedAt = resolved.now().getTime()

  const { spans, scores } = prepare(batch, target.environment)
  const chunks = chunkSpans(spans, chunkSize)
  let accepted = 0
  const errors: LangfuseExportError[] = []

  for (const [index, chunk] of chunks.entries()) {
    const outcome = await request(tracesUrl, authorization, otlpPayload(chunk, target.environment), resolved, startedAt)
    if (outcome.reason) {
      errors.push(...chunk.map((entry) => ({ id: entry.eventId, status: outcome.status, message: outcome.reason! })))
      // The server is unreachable; report the untried remainder rather than hammering it.
      for (const remaining of chunks.slice(index + 1)) {
        errors.push(...remaining.map((entry) => ({ id: entry.eventId, status: 0, message: 'not sent: langfuse OTLP ingestion was unreachable' })))
      }
      return { ok: false, accepted, errors }
    }
    if (outcome.status >= 300) {
      errors.push(...chunk.map((entry) => ({ id: entry.eventId, status: outcome.status, message: `langfuse OTLP ingestion returned HTTP ${outcome.status}` })))
      continue
    }
    const partial = readPartialSuccess(outcome.body)
    accepted += Math.max(chunk.length - partial.rejected, 0)
    if (partial.rejected > 0) {
      // OTLP reports a COUNT, never which spans, so attributing the rejection
      // to individual ids would be a guess. Report it against the trace.
      errors.push({ id: batch.traceId, status: outcome.status, message: `langfuse rejected ${partial.rejected} of ${chunk.length} spans${partial.message ? `: ${partial.message}` : ''}` })
    }
  }

  if (scores.length) {
    // 🚨 The score must name the OTel ids, not the projector's uuids. OTLP
    // stored the trace under the dash-stripped hex and each observation under
    // its 16-hex span id, so posting the uuid attaches the score to a trace
    // that does not exist — accepted with a 201, invisible forever.
    const rebased = scores.map((score) => ({
      ...score,
      body: {
        ...score.body,
        traceId: hexId(score.body.traceId, 32),
        ...(score.body.observationId ? { observationId: hexId(score.body.observationId, 16) } : {}),
        ...(score.body.environment ?? target.environment ? { environment: score.body.environment ?? target.environment! } : {}),
      },
    }))
    for (const chunk of chunkEvents(rebased, chunkSize)) {
      const payload = JSON.stringify({
        batch: chunk,
        metadata: { sdk_name: SCOPE_NAME, sdk_version: String(LANGFUSE_PROJECTOR_REVISION) },
      })
      const outcome = await request(ingestionUrl, authorization, payload, resolved, startedAt)
      if (outcome.reason) {
        errors.push(...chunk.map((score) => ({ id: score.id, status: outcome.status, message: outcome.reason! })))
        continue
      }
      if (outcome.status >= 300 && outcome.status !== 207) {
        errors.push(...chunk.map((score) => ({ id: score.id, status: outcome.status, message: `langfuse ingestion returned HTTP ${outcome.status}` })))
        continue
      }
      const result = readIngestionBody(outcome.body, chunk)
      accepted += result.accepted
      errors.push(...result.errors)
    }
  }

  return { ok: errors.length === 0, accepted, errors }
}

/**
 * Builds a target from the environment. Returns undefined when either key is
 * missing so a caller can degrade to "projection only" instead of guessing.
 */
export async function exportLangfuseBatch(batch:LangfuseBatch,target:Pick<LangfuseTarget,'environment'>,deps:{outbox?:LangfuseOutbox;chunkSize?:number}={}):Promise<LangfuseExportResult & {state:'queued'|'delivered';outboxIds:string[]}> {
  const {spans,scores}=prepare(batch,target.environment),outboxIds:string[]=[]
  let delivered=true
  for(const chunk of chunkSpans(spans,deps.chunkSize??DEFAULT_CHUNK_SIZE)) {
    const admitted=await enqueueLangfuseWrite('/api/public/otel/v1/traces',JSON.parse(otlpPayload(chunk,target.environment)),deps.outbox)
    outboxIds.push(admitted.id);delivered=delivered&&admitted.state==='delivered'
  }
  for(const score of scores) {
    const body={...score.body,traceId:hexId(score.body.traceId,32),...(score.body.observationId?{observationId:hexId(score.body.observationId,16)}:{}),...(score.body.environment??target.environment?{environment:score.body.environment??target.environment}:{}),id:score.body.id}
    const admitted=await enqueueLangfuseWrite('/api/public/scores',body,deps.outbox)
    outboxIds.push(admitted.id);delivered=delivered&&admitted.state==='delivered'
  }
  return {ok:true,accepted:0,errors:[],state:delivered?'delivered':'queued',outboxIds}
}

export function langfuseTargetFromEnv(env: NodeJS.ProcessEnv = process.env): LangfuseTarget | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim()
  const secretKey = env.LANGFUSE_SECRET_KEY?.trim()
  if (!publicKey || !secretKey) return undefined
  return {
    baseUrl: env.LANGFUSE_BASE_URL?.trim() || 'http://127.0.0.1:3100/experiments',
    publicKey,
    secretKey,
    environment: env.LANGFUSE_ENVIRONMENT?.trim() || 'maestro-harness',
  }
}
