/**
 * One Langfuse generation per model call, whichever path made it (CLI, HTTP
 * API, SDK). Langfuse is the only price list: this module sends usage and
 * never a cost, and Langfuse prices the usage from its model definitions.
 *
 * Usage goes out under Langfuse's own key names so those definitions match:
 * `input` never includes cached tokens (callers subtract them), cache reads are
 * `input_cache_read`, and cache writes are `input_cache_creation_1h` when the
 * caller is Claude Code (it writes one-hour cache entries, which is the rate its
 * own costUSD uses) and `input_cache_creation` otherwise.
 */
import { createHash } from 'node:crypto'
import { enqueueLangfuseWrite, registeredTelemetryOutbox } from './learning-experiment-langfuse-transport.js'

export type GenerationUsage = {
  readonly input?: number | null | undefined
  readonly output?: number | null | undefined
  readonly cacheRead?: number | null | undefined
  readonly cacheWrite?: number | null | undefined
  readonly cacheWriteTtl?: '5m' | '1h'
}

export type GenerationRecord = {
  /** Stable per call: seeds the trace and span ids, so it must never be reused. */
  readonly callId: string
  /** The client that made the call: 'claude', 'codex', 'agy', 'openrouter', 'claude-code-sdk', 'typesafe'. */
  readonly system: string
  /** The model the provider says it ran; the one Langfuse prices. */
  readonly model: string
  readonly startedAt: number
  readonly endedAt: number
  readonly usage?: GenerationUsage | null
  readonly failed?: boolean
  readonly statusMessage?: string | null
  readonly label: string
  readonly tags?: readonly string[]
  readonly userId?: string
  readonly sessionId?: string
  readonly metadata?: Record<string, unknown>
}

const count = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined)

export function langfuseUsageDetails(usage: GenerationUsage | null | undefined): Record<string, number> {
  if (!usage) return {}
  const details: Record<string, number | undefined> = {
    input: count(usage.input),
    output: count(usage.output),
    input_cache_read: count(usage.cacheRead),
    [usage.cacheWriteTtl === '1h' ? 'input_cache_creation_1h' : 'input_cache_creation']: count(usage.cacheWrite),
  }
  return Object.fromEntries(Object.entries(details).filter((e): e is [string, number] => e[1] !== undefined))
}

const attr = (key: string, value: unknown) => ({
  key,
  value: typeof value === 'number'
    ? { doubleValue: value }
    : typeof value === 'boolean'
      ? { boolValue: value }
      : { stringValue: typeof value === 'string' ? value : JSON.stringify(value) },
})

const digest = (seed: string, chars: number) => createHash('sha256').update(seed).digest('hex').slice(0, chars)

/** Pure: the OTLP payload for one generation. Exported so its shape is testable without I/O. */
export function generationSpan(record: GenerationRecord) {
  const usage = langfuseUsageDetails(record.usage)
  const attributes = [
    attr('langfuse.observation.type', 'generation'),
    attr('langfuse.trace.name', record.label),
    attr('langfuse.trace.tags', [record.system, record.label, ...(record.tags ?? [])]),
    attr('gen_ai.system', record.system),
    attr('gen_ai.request.model', record.model),
    attr('langfuse.observation.model.name', record.model),
    attr('langfuse.observation.metadata', record.metadata ?? {}),
  ]
  if (Object.keys(usage).length) attributes.push(attr('langfuse.observation.usage_details', usage))
  if (record.sessionId) attributes.push(attr('langfuse.session.id', record.sessionId), attr('session.id', record.sessionId))
  if (record.userId) attributes.push(attr('langfuse.user.id', record.userId))
  if (record.failed) attributes.push(attr('langfuse.observation.level', 'ERROR'))
  if (record.statusMessage) attributes.push(attr('langfuse.observation.status_message', record.statusMessage))
  return {
    resourceSpans: [{
      resource: { attributes: [attr('service.name', 'biztools-llm')] },
      scopeSpans: [{
        scope: { name: 'biztools-llm', version: '1' },
        spans: [{
          traceId: digest(`cli-trace:${record.callId}`, 32),
          spanId: digest(`cli-span:${record.callId}`, 16),
          name: `${record.system} ${record.model}`.trim(),
          kind: 3,
          startTimeUnixNano: String(BigInt(Math.round(record.startedAt)) * 1_000_000n),
          endTimeUnixNano: String(BigInt(Math.round(record.endedAt)) * 1_000_000n),
          attributes,
          status: { code: record.failed ? 2 : 1 },
        }],
      }],
    }],
  }
}

/** True inside a server/worker process; a bare script or unit test has no outbox and records nothing. */
export function telemetryOutboxConfigured(): boolean {
  try {
    return Boolean(registeredTelemetryOutbox())
  } catch {
    return false
  }
}

let failureWarnedAt = Number.NEGATIVE_INFINITY

/**
 * Admits the generation to the durable telemetry outbox. The returned promise
 * never rejects: a model call that succeeded must not fail because its trace
 * could not be queued. A failure warns at most every ten minutes.
 */
export function recordGeneration(
  record: GenerationRecord,
  enqueue: typeof enqueueLangfuseWrite = enqueueLangfuseWrite,
): Promise<void> | undefined {
  if (enqueue === enqueueLangfuseWrite && !telemetryOutboxConfigured()) return undefined
  return enqueue('/api/public/otel/v1/traces', generationSpan(record)).then(() => undefined, () => {
    const at = Date.now()
    if (at - failureWarnedAt >= 10 * 60_000) {
      failureWarnedAt = at
      console.warn(`[langfuse-generation] durable telemetry admission failed for ${record.system}; export not acknowledged`)
    }
  })
}
