import { createHash, timingSafeEqual } from 'node:crypto'
import { ReadAiCallPayload, ReadAiWebhookDelivery, ReadAiWebhookToken, type ReadAiWebhookStatus } from '@learner/contract'
import { metaDbQuery } from '../db-metadata/_shared.js'
import { callRecord, readAiSpeech } from './call-ingest.js'
import { ingestCalls, type CallPipelineDeps } from './call-pipeline.js'

/**
 * The Read AI webhook (Settings > Integrations). Read.ai signs nothing, so the
 * URL token is the delivery's only credential: only its sha256 is stored, and
 * a delivery is compared by hash in constant time.
 */
type Query = typeof metaDbQuery

/** The pipeline client every webhook delivery is filed under (spool dir desktop/readai-webhook/). */
export const READAI_WEBHOOK_CLIENT_ID = 'readai-webhook'

export class ReadAiWebhookRejected extends Error {}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

export async function loadReadAiWebhook(query: Query = metaDbQuery): Promise<ReadAiWebhookStatus> {
  const row = (await query<{ token_hint: string; updated_at: Date; last_delivery: unknown }>(
    `SELECT token_hint, updated_at, last_delivery FROM learning_readai_webhook WHERE config_key = 'default'`)).rows[0]
  if (!row) return { configured: false, tokenHint: null, updatedAt: null, lastDelivery: null }
  const last = ReadAiWebhookDelivery.safeParse(row.last_delivery)
  return { configured: true, tokenHint: row.token_hint, updatedAt: row.updated_at.toISOString(), lastDelivery: last.success ? last.data : null }
}

/** Replace the token. The previous token stops working at once, and the delivery history restarts with it. */
export async function saveReadAiWebhook(token: string, updatedBy: string, query: Query = metaDbQuery): Promise<ReadAiWebhookStatus> {
  const parsed = ReadAiWebhookToken.parse(token)
  await query(`INSERT INTO learning_readai_webhook (config_key, token_sha256, token_hint, updated_by, updated_at) VALUES ('default', $1, $2, $3, now())
    ON CONFLICT (config_key) DO UPDATE SET token_sha256 = EXCLUDED.token_sha256, token_hint = EXCLUDED.token_hint, updated_by = EXCLUDED.updated_by,
      updated_at = now(), last_delivery_at = NULL, last_delivery = NULL`, [sha256(parsed), parsed.slice(-4), updatedBy])
  return loadReadAiWebhook(query)
}

export async function clearReadAiWebhook(query: Query = metaDbQuery): Promise<ReadAiWebhookStatus> {
  await query(`DELETE FROM learning_readai_webhook WHERE config_key = 'default'`)
  return loadReadAiWebhook(query)
}

/** True only for the saved token. No token configured rejects every delivery. */
export async function verifyReadAiWebhookToken(token: string, query: Query = metaDbQuery): Promise<boolean> {
  const row = (await query<{ token_sha256: string }>(`SELECT token_sha256 FROM learning_readai_webhook WHERE config_key = 'default'`)).rows[0]
  if (!row) return false
  return timingSafeEqual(Buffer.from(sha256(token), 'hex'), Buffer.from(row.token_sha256, 'hex'))
}

/**
 * One delivery, end to end: the token, the payload, then (unless a test) the
 * call pipeline that stores and grades it. A test runs the same parse and
 * speech conversion and stores nothing, so it can run against live settings.
 */
export async function receiveReadAiDelivery(deps: CallPipelineDeps, token: string, body: unknown, test: boolean, query: Query = deps.query ?? metaDbQuery): Promise<ReadAiWebhookDelivery> {
  if (!await verifyReadAiWebhookToken(token, query)) throw new ReadAiWebhookRejected('Unknown webhook token')
  const payload = ReadAiCallPayload.parse(body)
  const speech = readAiSpeech(payload)
  const base = { at: new Date().toISOString(), test, sessionId: payload.session_id, title: payload.title ?? null, lines: speech.lines.length }
  let delivery: ReadAiWebhookDelivery
  if (test) delivery = { ...base, outcome: 'test-ok', graded: false }
  else {
    const result = await ingestCalls(deps, READAI_WEBHOOK_CLIENT_ID, [callRecord('readai', speech)])
    const outcome = result.duplicates ? 'duplicate' : result.accepted ? 'stored' : result.updated ? 'updated' : result.unchanged ? 'unchanged' : 'not-stored'
    delivery = { ...base, outcome, graded: outcome !== 'duplicate' && outcome !== 'not-stored' && !result.notGraded }
  }
  await query(`UPDATE learning_readai_webhook SET last_delivery_at = now(), last_delivery = $1::jsonb WHERE config_key = 'default'`, [JSON.stringify(delivery)])
  return delivery
}
