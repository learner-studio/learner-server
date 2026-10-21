import { envFlag, learningLocalMvpEnabled } from '../runtime-flags.js'

export const HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_FACT_COUNT = 50
export const HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_MAX_AGE_MS = 30 * 60 * 1_000
export const HINDSIGHT_REALTIME_CONSOLIDATION_POLL_INTERVAL_MS = 60 * 1_000
export const HINDSIGHT_REALTIME_CONSOLIDATION_DEADLINE_MS = 15 * 60 * 1_000

export type HindsightRealtimeConsolidationConfig = {
  enabled: boolean
  factCount: number
  maxAgeMs: number
  deadlineMs: number
  baseUrl: string | null
  bankId: string | null
}

const positive = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/** Disabled by default; raw archival never opts this paid path in. */
export const hindsightRealtimeConsolidationConfig = (): HindsightRealtimeConsolidationConfig => ({
  enabled: learningLocalMvpEnabled() && envFlag('LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_ENABLED')
    && validLoopbackUrl(process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_BASE_URL)
    && Boolean(process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_BANK),
  factCount: positive(process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_FACT_COUNT, HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_FACT_COUNT),
  maxAgeMs: positive(process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_MAX_AGE_MS, HINDSIGHT_REALTIME_CONSOLIDATION_DEFAULT_MAX_AGE_MS),
  deadlineMs: positive(process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_DEADLINE_MS, HINDSIGHT_REALTIME_CONSOLIDATION_DEADLINE_MS),
  baseUrl: validLoopbackUrl(process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_BASE_URL) ? process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_BASE_URL! : null,
  bankId: process.env.LEARNING_HINDSIGHT_REALTIME_CONSOLIDATION_BANK || null,
})

function validLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false
  try { const url = new URL(value); return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) } catch { return false }
}

export type NativeConsolidationOperation = { operationId: string; status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'; error: string | null }

const nativeError = async (response: Response): Promise<Error> => new Error(`Hindsight native request failed (${response.status}): ${(await response.text()).slice(0, 500)}`)

export const submitNativeConsolidation = async (
  config: HindsightRealtimeConsolidationConfig & { baseUrl: string }, bankId: string, observationScope: string[], fetchImpl: typeof fetch = fetch,
): Promise<string> => {
  const response = await fetchImpl(`${config.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/consolidate`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ observation_scopes: [observationScope] }), signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw await nativeError(response)
  const body = await response.json() as { operation_id?: unknown }
  if (typeof body.operation_id !== 'string' || body.operation_id.length === 0) throw new Error('Hindsight consolidation response omitted operation_id')
  return body.operation_id
}

export const pollNativeConsolidation = async (
  config: HindsightRealtimeConsolidationConfig & { baseUrl: string }, bankId: string, operationId: string, fetchImpl: typeof fetch = fetch,
): Promise<NativeConsolidationOperation> => {
  const response = await fetchImpl(`${config.baseUrl}/v1/default/banks/${encodeURIComponent(bankId)}/operations/${encodeURIComponent(operationId)}`, {
    headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw await nativeError(response)
  const body = await response.json() as { status?: unknown; error_message?: unknown }
  if (!['pending', 'processing', 'completed', 'failed', 'cancelled'].includes(String(body.status))) throw new Error('Hindsight operation returned an invalid status')
  return { operationId, status: body.status as NativeConsolidationOperation['status'], error: typeof body.error_message === 'string' ? body.error_message : null }
}
