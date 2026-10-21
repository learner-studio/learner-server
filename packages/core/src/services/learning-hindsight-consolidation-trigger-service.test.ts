import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'

import type { DB } from '../types/db.types.js'
import { LearningHindsightConsolidationTriggerService, type CompletedFactProjection } from './learning-hindsight-consolidation-trigger-service.js'

const databaseUrl = process.env.LEARNING_CONSOLIDATION_TRIGGER_TEST_DATABASE_URL
const describePostgres = databaseUrl ? describe : describe.skip
const projection: CompletedFactProjection = {
  bankId: 'trigger-test-bank', scope: ['bt-experiment:trigger-test'], sequence: 1,
  watermark: 'frozen-receipt-1', pendingFacts: 50, oldestPendingAt: new Date(Date.now() - 31 * 60_000).toISOString(),
}

describe('LearningHindsightConsolidationTriggerService disabled boundary', () => {
  const disabled = new LearningHindsightConsolidationTriggerService(undefined as unknown as Kysely<DB>, {
    enabled: false, bankId: null, baseUrl: null, factCount: 50, maxAgeMs: 1, deadlineMs: 1,
  })
  test('returns unknown counts and never queries an unapplied table while disabled', async () => {
    await expect(disabled.status()).resolves.toEqual({ enabled: false, bankConfigured: false, countsKnown: false, triggerRows: null, activeRows: null })
    await expect(disabled.poll(projection)).resolves.toEqual({ state: 'disabled' })
  })
})

describePostgres('LearningHindsightConsolidationTriggerService durable reservation', () => {
  let kysely: Kysely<DB>
  let submissions = 0
  let service: LearningHindsightConsolidationTriggerService

  beforeAll(() => {
    kysely = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl!, max: 4 }) }), plugins: [new CamelCasePlugin()] })
    const fetchImpl = async () => { submissions += 1; return new Response(JSON.stringify({ operation_id: '5e2525a6-0a75-4c4c-8fde-130ea5ffc154' }), { status: 200 }) }
    service = new LearningHindsightConsolidationTriggerService(kysely, {
      enabled: true, bankId: projection.bankId, baseUrl: 'http://127.0.0.1:19001', factCount: 50, maxAgeMs: 30 * 60_000, deadlineMs: 15 * 60_000,
    }, fetchImpl as unknown as typeof fetch)
  })
  beforeEach(async () => { submissions = 0; await sql`TRUNCATE learning_hindsight_consolidation_triggers`.execute(kysely) })
  afterAll(async () => { await kysely?.destroy() })

  test('atomically admits only one submit for the same completed receipt watermark', async () => {
    const outcomes = await Promise.all([service.trigger(projection), service.trigger(projection)])
    expect(outcomes.filter((item) => item.state === 'submitted')).toHaveLength(1)
    expect(submissions).toBe(1)
  })

  test('a transport-uncertain POST is fail-closed and never re-submitted', async () => {
    const failing = new LearningHindsightConsolidationTriggerService(kysely, {
      enabled: true, bankId: projection.bankId, baseUrl: 'http://127.0.0.1:19001', factCount: 50, maxAgeMs: 1, deadlineMs: 1,
    }, (async () => { submissions += 1; throw new Error('disconnect after write') }) as unknown as typeof fetch)
    expect((await failing.trigger(projection)).state).toBe('uncertain')
    expect((await failing.trigger(projection)).state).toBe('uncertain')
    expect(submissions).toBe(1)
  })

  test('an older completed receipt cannot regress a newer available watermark', async () => {
    await service.observe({ ...projection, sequence: 2, watermark: 'frozen-receipt-2', pendingFacts: 51 })
    await service.observe(projection)
    const row = await sql<{ sequence: string; watermark: string }>`SELECT available_sequence AS sequence,available_watermark AS watermark FROM learning_hindsight_consolidation_triggers`.execute(kysely)
    expect(row.rows[0]).toEqual({ sequence: '2', watermark: 'frozen-receipt-2' })
  })

  test('an equal receipt replay cannot replace the first pending-count payload', async () => {
    await service.observe(projection)
    await service.observe({ ...projection, pendingFacts: 999, oldestPendingAt: null })
    const row = await sql<{ pending: number }>`SELECT available_pending_facts AS pending FROM learning_hindsight_consolidation_triggers`.execute(kysely)
    expect(row.rows[0]?.pending).toBe(50)
  })

  test('an expired pre-checkpoint reservation becomes uncertain without a second POST', async () => {
    await sql`INSERT INTO learning_hindsight_consolidation_triggers
      (bank_id,scope_key,available_sequence,available_watermark,available_pending_facts,reservation_token,reservation_until,status)
      VALUES (${projection.bankId},${JSON.stringify(projection.scope)},1,${projection.watermark},50,'5e2525a6-0a75-4c4c-8fde-130ea5ffc153'::uuid,NOW()-INTERVAL '1 second','reserved')`.execute(kysely)
    expect((await service.trigger(projection)).state).toBe('uncertain')
    expect(submissions).toBe(0)
  })

  test('arrival during a running operation remains pending after its captured watermark completes', async () => {
    await expect(service.trigger(projection)).resolves.toMatchObject({ state: 'submitted' })
    await service.observe({ ...projection, sequence: 2, watermark: 'frozen-receipt-2', pendingFacts: 1 })
    const completing = new LearningHindsightConsolidationTriggerService(kysely, {
      enabled: true, bankId: projection.bankId, baseUrl: 'http://127.0.0.1:19001', factCount: 50, maxAgeMs: 1, deadlineMs: 15 * 60_000,
    }, (async () => new Response(JSON.stringify({ status: 'completed', error_message: null }), { status: 200 })) as unknown as typeof fetch)
    expect((await completing.poll(projection)).state).toBe('completed')
    const row = await sql<{ available: string; completed: string }>`SELECT available_watermark AS available,completed_watermark AS completed FROM learning_hindsight_consolidation_triggers`.execute(kysely)
    expect(row.rows[0]).toEqual({ available: 'frozen-receipt-2', completed: 'frozen-receipt-1' })
  })
})
