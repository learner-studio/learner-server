import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'

import type { DB } from '../types/db.types.js'
import {
  HINDSIGHT_REALTIME_CONSOLIDATION_POLL_INTERVAL_MS,
  type HindsightRealtimeConsolidationConfig,
  pollNativeConsolidation,
  submitNativeConsolidation,
} from '../lib/learning/hindsight-realtime-consolidation.js'

export type CompletedFactProjection = {
  bankId: string
  scope: string[]
  sequence: number
  watermark: string
  pendingFacts: number
  oldestPendingAt: string | null
}

export type ConsolidationTriggerResult =
  | { state: 'disabled' | 'empty' | 'no_change' | 'below_threshold' | 'busy' | 'uncertain' }
  | { state: 'submitted' | 'polling' | 'completed' | 'failed' | 'timed_out'; operationId: string }

type Row = {
  bankId: string; scopeKey: string; availableSequence: number; availableWatermark: string | null; availablePendingFacts: number
  availableOldestAt: Date | string | null; reservedWatermark: string | null; completedWatermark: string | null
  reservationToken: string | null; reservationUntil: Date | string | null; nativeOperationId: string | null
  nativeDeadlineAt: Date | string | null; status: string; pollCount: number
}

// PostgreSQL text forbids NUL. Canonical JSON keeps distinct multi-tag scopes distinct.
const scopeKey = (scope: string[]): string => JSON.stringify([...new Set(scope)].sort())
const asDate = (value: Date | string | null): Date | null => value ? new Date(value) : null

/**
 * Owns only the app-side reservation and native operation checkpoint. It never
 * counts raw archive rows: callers must provide a completed derived-fact watermark.
 */
export class LearningHindsightConsolidationTriggerService {
  constructor(private readonly kysely: Kysely<DB>, private readonly config: HindsightRealtimeConsolidationConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  async observe(projection: CompletedFactProjection): Promise<void> {
    if (!projection.bankId || !projection.watermark || !Number.isSafeInteger(projection.sequence) || projection.sequence < 0 || projection.pendingFacts < 0) throw new Error('Invalid completed fact projection')
    await sql`
      INSERT INTO learning_hindsight_consolidation_triggers
        (bank_id,scope_key,available_sequence,available_watermark,available_pending_facts,available_oldest_at,updated_at)
      VALUES (${projection.bankId},${scopeKey(projection.scope)},${projection.sequence},${projection.watermark},${projection.pendingFacts},${projection.oldestPendingAt},NOW())
      ON CONFLICT(bank_id,scope_key) DO UPDATE SET
        available_sequence=EXCLUDED.available_sequence,available_watermark=EXCLUDED.available_watermark,available_pending_facts=EXCLUDED.available_pending_facts,
        available_oldest_at=EXCLUDED.available_oldest_at,updated_at=NOW()
      WHERE EXCLUDED.available_sequence > learning_hindsight_consolidation_triggers.available_sequence
    `.execute(this.kysely)
  }

  async status(): Promise<{ enabled: boolean; bankConfigured: boolean; countsKnown: boolean; triggerRows: number | null; activeRows: number | null }> {
    // 0160 intentionally is not applied while the feature is disabled. Status
    // must remain a safe real-dev configuration read during that interval.
    if (!this.config.enabled) return { enabled: false, bankConfigured: Boolean(this.config.bankId && this.config.baseUrl), countsKnown: false, triggerRows: null, activeRows: null }
    const count = await sql<{ triggerRows: string; activeRows: string }>`SELECT count(*) AS "triggerRows",
      count(*) FILTER (WHERE status IN ('reserved','polling','uncertain')) AS "activeRows"
      FROM learning_hindsight_consolidation_triggers`.execute(this.kysely)
    return {
      enabled: this.config.enabled, bankConfigured: Boolean(this.config.bankId && this.config.baseUrl), countsKnown: true,
      triggerRows: Number(count.rows[0]?.triggerRows ?? 0), activeRows: Number(count.rows[0]?.activeRows ?? 0),
    }
  }

  private async row(projection: CompletedFactProjection): Promise<Row | null> {
    const result = await sql<Row>`SELECT bank_id AS "bankId",scope_key AS "scopeKey",available_sequence AS "availableSequence",available_watermark AS "availableWatermark",
      available_pending_facts AS "availablePendingFacts",available_oldest_at AS "availableOldestAt",reserved_watermark AS "reservedWatermark",
      completed_watermark AS "completedWatermark",reservation_token AS "reservationToken",reservation_until AS "reservationUntil",
      native_operation_id AS "nativeOperationId",native_deadline_at AS "nativeDeadlineAt",status,poll_count AS "pollCount"
      FROM learning_hindsight_consolidation_triggers WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)}`.execute(this.kysely)
    return result.rows[0] ?? null
  }

  private eligible(row: Row): ConsolidationTriggerResult | null {
    if (row.status === 'failed' && row.nativeOperationId) return { state: 'failed', operationId: row.nativeOperationId }
    if (row.nativeOperationId) return { state: 'polling', operationId: row.nativeOperationId }
    if (row.status === 'uncertain') return { state: 'uncertain' }
    if (!row.availableWatermark || row.availableWatermark === row.completedWatermark) return { state: 'no_change' }
    if (row.availablePendingFacts === 0) return { state: 'empty' }
    const oldest = asDate(row.availableOldestAt)
    if (row.availablePendingFacts < this.config.factCount && (!oldest || Date.now() - oldest.getTime() < this.config.maxAgeMs)) return { state: 'below_threshold' }
    return null
  }

  private async reserve(projection: CompletedFactProjection): Promise<string | null> {
    const token = randomUUID()
    const result = await sql<{ reservationToken: string }>`UPDATE learning_hindsight_consolidation_triggers
      SET reservation_token=${token}::uuid,reservation_until=NOW()+INTERVAL '5 minutes',reserved_watermark=available_watermark,reserved_sequence=available_sequence,status='reserved',last_error=NULL,updated_at=NOW()
      WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)}
        AND native_operation_id IS NULL AND status IN ('idle','completed') AND available_watermark IS DISTINCT FROM completed_watermark
        AND available_pending_facts > 0
        AND (available_pending_facts >= ${this.config.factCount} OR available_oldest_at <= NOW() - (${this.config.maxAgeMs} * INTERVAL '1 millisecond'))
        AND (reservation_until IS NULL OR reservation_until <= NOW())
      RETURNING reservation_token AS "reservationToken"`.execute(this.kysely)
    return result.rows[0]?.reservationToken ?? null
  }

  private async resolveExpiredReservation(projection: CompletedFactProjection, row: Row): Promise<ConsolidationTriggerResult | null> {
    if (row.status !== 'reserved') return null
    const until = asDate(row.reservationUntil)
    if (until && until > new Date()) return { state: 'busy' }
    await sql`UPDATE learning_hindsight_consolidation_triggers SET status='uncertain',reservation_token=NULL,reservation_until=NULL,
      last_error='reservation expired before native operation ID checkpoint; refusing blind re-submit',updated_at=NOW()
      WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)} AND status='reserved' AND reservation_until <= NOW()`.execute(this.kysely)
    return { state: 'uncertain' }
  }

  private async checkpointSubmit(projection: CompletedFactProjection, token: string, operationId: string): Promise<boolean> {
    const result = await sql`UPDATE learning_hindsight_consolidation_triggers SET native_operation_id=${operationId}::uuid,
      native_submitted_at=NOW(),native_deadline_at=NOW()+(${this.config.deadlineMs} * INTERVAL '1 millisecond'),
      reservation_token=NULL,reservation_until=NULL,status='polling',next_poll_at=NOW(),updated_at=NOW()
      WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)} AND reservation_token=${token}::uuid AND status='reserved'`.execute(this.kysely)
    return Number(result.numAffectedRows ?? 0) === 1
  }

  private async markUncertain(projection: CompletedFactProjection, token: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    await sql`UPDATE learning_hindsight_consolidation_triggers SET status='uncertain',reservation_token=NULL,reservation_until=NULL,
      last_error=${message.slice(0, 4000)},updated_at=NOW() WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)}
      AND reservation_token=${token}::uuid AND status='reserved'`.execute(this.kysely)
  }

  async trigger(projection: CompletedFactProjection): Promise<ConsolidationTriggerResult> {
    if (!this.config.enabled || !this.config.baseUrl || !this.config.bankId || this.config.bankId !== projection.bankId) return { state: 'disabled' }
    await this.observe(projection)
    let current = await this.row(projection)
    if (!current) throw new Error('Consolidation trigger observation was not persisted')
    const reservation = await this.resolveExpiredReservation(projection, current)
    if (reservation) return reservation
    let outcome = this.eligible(current)
    if (outcome) return outcome
    const token = await this.reserve(projection)
    if (!token) { current = await this.row(projection); return current ? (this.eligible(current) ?? { state: 'busy' }) : { state: 'busy' } }
    let operationId: string
    try { operationId = await submitNativeConsolidation(this.config as HindsightRealtimeConsolidationConfig & { baseUrl: string }, projection.bankId, projection.scope, this.fetchImpl) }
    catch (error) { await this.markUncertain(projection, token, error); return { state: 'uncertain' } }
    if (!(await this.checkpointSubmit(projection, token, operationId))) throw new Error('Native consolidation was accepted but its checkpoint lost the reservation')
    return { state: 'submitted', operationId }
  }

  async poll(projection: Pick<CompletedFactProjection, 'bankId' | 'scope'>): Promise<ConsolidationTriggerResult> {
    if (!this.config.enabled || !this.config.baseUrl || !this.config.bankId || this.config.bankId !== projection.bankId) return { state: 'disabled' }
    const complete = { ...projection, sequence: 0, watermark: 'unused', pendingFacts: 0, oldestPendingAt: null }
    const current = await this.row(complete)
    if (!current?.nativeOperationId) return current?.status === 'uncertain' ? { state: 'uncertain' } : { state: 'no_change' }
    if (current.status === 'failed') return { state: 'failed', operationId: current.nativeOperationId }
    const nextPoll = await sql<{ ready: boolean }>`SELECT next_poll_at IS NULL OR next_poll_at <= NOW() AS ready FROM learning_hindsight_consolidation_triggers WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)} AND native_operation_id=${current.nativeOperationId}::uuid`.execute(this.kysely)
    if (nextPoll.rows[0]?.ready !== true) return { state: 'polling', operationId: current.nativeOperationId }
    const deadline = asDate(current.nativeDeadlineAt)
    if (deadline && deadline <= new Date()) {
      await sql`UPDATE learning_hindsight_consolidation_triggers SET status='failed',last_error='native operation exceeded durable deadline',next_poll_at=NULL,updated_at=NOW()
        WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)} AND native_operation_id=${current.nativeOperationId}::uuid`.execute(this.kysely)
      return { state: 'timed_out', operationId: current.nativeOperationId }
    }
    if (!this.config.baseUrl) return { state: 'uncertain' }
    const native = await pollNativeConsolidation(this.config as HindsightRealtimeConsolidationConfig & { baseUrl: string }, projection.bankId, current.nativeOperationId, this.fetchImpl)
    if (native.status === 'completed') {
      await sql`UPDATE learning_hindsight_consolidation_triggers SET completed_watermark=reserved_watermark,native_operation_id=NULL,status='completed',poll_count=poll_count+1,next_poll_at=NULL,last_error=NULL,updated_at=NOW()
        WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)} AND native_operation_id=${native.operationId}::uuid`.execute(this.kysely)
      return { state: 'completed', operationId: native.operationId }
    }
    if (native.status === 'failed' || native.status === 'cancelled') {
      await sql`UPDATE learning_hindsight_consolidation_triggers SET status='failed',poll_count=poll_count+1,next_poll_at=NULL,last_error=${native.error ?? native.status},updated_at=NOW()
        WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)} AND native_operation_id=${native.operationId}::uuid`.execute(this.kysely)
      return { state: 'failed', operationId: native.operationId }
    }
    await sql`UPDATE learning_hindsight_consolidation_triggers SET status='polling',poll_count=poll_count+1,next_poll_at=NOW()+(${HINDSIGHT_REALTIME_CONSOLIDATION_POLL_INTERVAL_MS} * INTERVAL '1 millisecond'),updated_at=NOW()
      WHERE bank_id=${projection.bankId} AND scope_key=${scopeKey(projection.scope)} AND native_operation_id=${native.operationId}::uuid`.execute(this.kysely)
    return { state: 'polling', operationId: native.operationId }
  }
}
