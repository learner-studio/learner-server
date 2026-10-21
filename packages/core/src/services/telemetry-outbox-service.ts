import { randomUUID } from 'node:crypto'
import type { MetaPgQueryFn } from '../lib/db-metadata/_shared.js'

export interface TelemetryDestination {
  validate(payload: unknown): void
  deliver(payload: unknown, context: { id: string; dedupeKey: string; signal: AbortSignal }): Promise<void>
}
export const TELEMETRY_MAX_ENVELOPE_BYTES = 3_600_000
export type TelemetryOutboxState = 'pending' | 'delivering' | 'delivered' | 'dead'
export interface TelemetryOutboxStatus {
  id: string
  state: TelemetryOutboxState
  attempts: number
  last_error: string | null
}
export class TelemetryFlushIncompleteError extends Error {
  constructor(readonly rows: TelemetryOutboxStatus[], readonly incompleteIds: string[]) {
    super('Telemetry flush incomplete')
    this.name = 'TelemetryFlushIncompleteError'
  }
}

export interface TelemetryEnqueueInput { destination: string; dedupeKey: string; payload: unknown }

function assertTelemetryPayload(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 32) throw new Error('Telemetry payload nesting too deep')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (typeof value !== 'object' || ancestors.has(value)) throw new Error('Telemetry payload must be JSON')
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Telemetry payload must be plain JSON')
  ancestors.add(value)
  for (const [key, child] of Object.entries(value)) {
    if (/^(authorization|headers?|cookies?|credentials?|password|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|endpoint|base[-_]?url|url)$/i.test(key)) {
      throw new Error('Telemetry payload contains transport configuration or credentials')
    }
    assertTelemetryPayload(child, ancestors, depth + 1)
  }
  ancestors.delete(value)
}

/** Injected SQL uses snake_case (metaDbQuery), never the camel-case plugin. */
export class TelemetryOutboxService {
  constructor(
    private readonly query: MetaPgQueryFn,
    private readonly destinations: Readonly<Record<string, TelemetryDestination>>,
    private readonly dispatch?: () => Promise<unknown>,
    private readonly options: { deliveryTimeoutMs?: number } = {},
  ) {
    const timeout = options.deliveryTimeoutMs ?? 15_000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 15_000) throw new Error('Invalid telemetry timeout')
  }

  async wake(): Promise<boolean> {
    if (!this.dispatch) return false
    try { await this.dispatch(); return true } catch { return false }
  }

  async enqueue(input: TelemetryEnqueueInput) {
    if (!Object.hasOwn(this.destinations, input.destination)) throw new Error('Unknown telemetry destination')
    if (!/^[a-z][a-z0-9_.-]{0,79}$/.test(input.destination)) throw new Error('Invalid telemetry destination')
    if (!input.dedupeKey || input.dedupeKey.length > 512) throw new Error('Invalid telemetry dedupe key')
    assertTelemetryPayload(input.payload)
    this.destinations[input.destination]!.validate(input.payload)
    const payload = JSON.stringify(input.payload)
    if (Buffer.byteLength(payload) > TELEMETRY_MAX_ENVELOPE_BYTES) throw new Error('Telemetry payload too large')
    const result = await this.query<{ id: string; state: TelemetryOutboxState }>(`
      INSERT INTO telemetry_outbox (id, destination, dedupe_key, payload, payload_fingerprint)
      VALUES ($1,$2,$3,$4::jsonb,encode(sha256(convert_to(($4::jsonb)::text,'UTF8')),'hex'))
      ON CONFLICT (destination, dedupe_key) DO UPDATE SET dedupe_key = EXCLUDED.dedupe_key
      WHERE telemetry_outbox.payload_fingerprint = EXCLUDED.payload_fingerprint
      RETURNING id, state`, [randomUUID(), input.destination, input.dedupeKey, payload])
    if (!result.rows.length) throw new Error('Telemetry dedupe payload conflict')
    // A replay of terminal or leased work needs no new delivery job. Pending
    // replays still wake, so a previously failed queue admission can recover.
    return { ...result.rows[0]!, wakeQueued: result.rows[0]!.state === 'pending' ? await this.wake() : false }
  }

  /** Keep terminal tombstones forever; only their large payload is retired. */
  async compact(options: { limit?: number } = {}): Promise<number> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)))
    if (!Number.isFinite(limit)) throw new Error('Invalid telemetry compaction limit')
    const result = await this.query(`WITH candidate AS (
      SELECT id FROM telemetry_outbox WHERE compacted_at IS NULL AND (
        (state='delivered' AND delivered_at <= now()-interval '7 days') OR
        (state='dead' AND updated_at <= now()-interval '30 days'))
      ORDER BY updated_at, id FOR UPDATE SKIP LOCKED LIMIT $1
    ) UPDATE telemetry_outbox AS o SET payload=NULL, compacted_at=now()
      FROM candidate WHERE o.id=candidate.id RETURNING o.id`, [limit])
    return result.rows.length
  }

  async drain(options: { limit?: number; ids?: string[] } = {}) {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 20)))
    if (!Number.isFinite(limit)) throw new Error('Invalid telemetry drain limit')
    await this.query(`UPDATE telemetry_outbox SET state=CASE WHEN attempts >= 8 THEN 'dead' ELSE 'pending' END,
      lease_token=NULL, lease_until=NULL, available_at=now(), updated_at=now(), last_error='lease-expired'
      WHERE state='delivering' AND lease_until <= now() AND ($1::uuid[] IS NULL OR id=ANY($1::uuid[]))`, [options.ids ?? null])
    let processed = 0
    for (; processed < limit; processed++) {
      const token = randomUUID()
      const claimed = await this.query<TelemetryOutboxStatus & { payload: unknown; destination: string; dedupe_key: string }>(`
        WITH candidate AS (
          SELECT id FROM telemetry_outbox
          WHERE state = 'pending' AND available_at <= now() AND attempts < 8
            AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
          ORDER BY available_at, created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE telemetry_outbox AS o SET state='delivering', attempts=attempts+1,
          lease_token=$2, lease_until=now()+interval '60 seconds', updated_at=now()
        FROM candidate WHERE o.id=candidate.id RETURNING o.*`, [options.ids ?? null, token])
      const row = claimed.rows[0]
      if (!row) break
      try {
        if (!Object.hasOwn(this.destinations, row.destination)) throw new Error('Unknown destination')
        const destination = this.destinations[row.destination]!
        assertTelemetryPayload(row.payload)
        if (Buffer.byteLength(JSON.stringify(row.payload)) > TELEMETRY_MAX_ENVELOPE_BYTES) throw new Error('Telemetry payload too large')
        destination.validate(row.payload)
        const signal = AbortSignal.timeout(this.options.deliveryTimeoutMs ?? 15_000)
        let onAbort!: () => void
        const deadline = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error('Telemetry delivery deadline'))
          signal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          await Promise.race([destination.deliver(row.payload, { id: row.id, dedupeKey: row.dedupe_key, signal }), deadline])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      } catch {
        // Never persist transport errors: they may embed credentials/request bodies.
        await this.query(`UPDATE telemetry_outbox SET state=CASE WHEN attempts >= 8 THEN 'dead' ELSE 'pending' END,
          available_at=now()+($3 * interval '1 millisecond'), updated_at=now(), last_error='delivery-failed',
          lease_token=NULL, lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='delivering'`,
        [row.id, token, Math.min(60_000, 1000 * 2 ** (row.attempts - 1))])
        continue
      }
      // A DB failure after provider acceptance leaves the lease to recovery. Do not
      // pretend the export failed or redispatch any upstream computation.
      await this.query(`UPDATE telemetry_outbox SET state='delivered', delivered_at=now(), updated_at=now(),
        lease_token=NULL, lease_until=NULL, last_error=NULL WHERE id=$1 AND lease_token=$2 AND state='delivering'`, [row.id, token])
    }
    const hasMore = (await this.query<{ ready: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM telemetry_outbox WHERE state='pending' AND available_at <= now() AND attempts < 8
      AND ($1::uuid[] IS NULL OR id=ANY($1::uuid[]))) AS ready`, [options.ids ?? null])).rows[0]!.ready
    if (hasMore) await this.wake()
    await this.compact()
    return { processed, hasMore }
  }

  /** One bounded pass, not an in-process polling loop; retries honor durable backoff. */
  async flush(ids: string[]): Promise<TelemetryOutboxStatus[]> {
    const unique = [...new Set(ids)]
    if (!unique.length) return []
    if (unique.length > 100) throw new Error('Telemetry flush accepts at most 100 ids')
    await this.drain({ ids: unique, limit: unique.length })
    const rows = await this.status(unique)
    const delivered = new Set(rows.filter((row) => row.state === 'delivered').map((row) => row.id))
    const missing = unique.filter((id) => !delivered.has(id))
    if (missing.length) throw new TelemetryFlushIncompleteError(rows, missing)
    return rows
  }

  async status(ids: string[]): Promise<TelemetryOutboxStatus[]> {
    if (!ids.length) return []
    return (await this.query<TelemetryOutboxStatus>(
      'SELECT id, state, attempts, last_error FROM telemetry_outbox WHERE id = ANY($1::uuid[])', [ids],
    )).rows
  }
}
