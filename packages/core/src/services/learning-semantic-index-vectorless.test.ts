import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { DB } from '../types/db.types.js'
import { LearningSemanticIndexService, VECTORLESS_ACCEPTED_REASON, VECTORLESS_REASON, VECTORLESS_WITH_CONTENT_REASON, isContentFree, vectorlessOperationChunks } from './learning-semantic-index-service.js'

/**
 * A chunk Hindsight retained with zero vectors (a run of hyphens, `.”`, `{}`) must
 * leave the coverage guards as `empty`. From 2026-10-22 to 11-11 the classifier
 * read `row.chunk_id` from a Kysely instance with CamelCasePlugin, got undefined
 * for every row, and never marked one: four 477-hyphen chunks then stalled routing
 * and every assessment. The service's real plugin configuration is used here.
 *
 * Shadow tables are TEMP on one connection (max 1), so no shared row is touched.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('vectorless chunks are classified under the service Kysely configuration', () => {
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 })
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] })
  const operation = randomUUID()
  const message = `vectorless-${randomUUID()}`
  const chunk = (n: number) => `${message}-chunk-${n}`
  // Chunk n is SOURCE[n*10, n*10+5): words, a run of hyphens, then `{}` and a quote mark.
  const SOURCE = 'hello-----\n----------\n{} .”     '
  const withText = 0
  beforeAll(async () => {
    await sql`CREATE TEMP TABLE learning_semantic_index_messages (LIKE public.learning_semantic_index_messages INCLUDING DEFAULTS)`.execute(db)
    await sql`CREATE TEMP TABLE learning_semantic_index_chunks (LIKE public.learning_semantic_index_chunks INCLUDING DEFAULTS)`.execute(db)
    await sql`CREATE TEMP TABLE learning_reactive_route_holds (LIKE public.learning_reactive_route_holds INCLUDING DEFAULTS)`.execute(db)
  })
  beforeEach(async () => {
    await sql`DELETE FROM pg_temp.learning_semantic_index_chunks`.execute(db)
    await sql`DELETE FROM pg_temp.learning_semantic_index_messages`.execute(db)
    await sql`DELETE FROM pg_temp.learning_reactive_route_holds`.execute(db)
    await sql`INSERT INTO pg_temp.learning_semantic_index_messages(message_id,observation_id,logical_message_key,raw_version_id,conversation_id,role,observed_at,payload,source_text,source_sha256,parts,status)
      VALUES(${message},gen_random_uuid(),'k',gen_random_uuid(),'c','assistant',now(),'{}',${SOURCE},'x','[]','indexed')`.execute(db)
    for (const n of [0, 1, 2]) {
      await sql`INSERT INTO pg_temp.learning_semantic_index_chunks(chunk_id,message_id,ordinal,start_offset,end_offset,token_count,tokenizer_sha256,content_sha256,operation_id,status)
        VALUES(${chunk(n)},${message},${n},${n * 10},${n * 10 + 5},5,'t','c',${operation}::uuid,'indexed')`.execute(db)
    }
  })
  afterAll(async () => { await db.destroy() })

  test('the one chunk the bank holds no vector for is named, not undefined', async () => {
    const present = async () => new Set([chunk(0), chunk(2)])
    expect(await vectorlessOperationChunks(db, operation, present)).toEqual({ empty: [chunk(1)], withContent: [] })
  })

  test('"empty" is decided by content: a vectorless chunk WITH text is never emptied, it is flagged and returned (review S1)', async () => {
    expect([SOURCE.slice(0, 5), SOURCE.slice(10, 15), SOURCE.slice(20, 25)].map(isContentFree)).toEqual([false, true, true])
    expect(isContentFree('–— … ¿?')).toBe(true)
    expect(isContentFree('ок')).toBe(false)
    expect(isContentFree('42')).toBe(false)
    expect(await vectorlessOperationChunks(db, operation, async () => new Set())).toEqual({ empty: [chunk(1), chunk(2)], withContent: [chunk(withText)] })
    const service = new LearningSemanticIndexService(db, { enabled: true })
    const result = await service.reconcileVectorlessChunks({ apply: true, present: async () => new Set([chunk(2)]) })
    expect(result).toEqual({ checked: 3, vectorless: [chunk(0), chunk(1)], marked: 1, withContent: [chunk(0)] })
    const rows = (await sql<{ chunkId: string; status: string; error: string | null }>`SELECT chunk_id AS "chunkId",status,error FROM pg_temp.learning_semantic_index_chunks ORDER BY chunk_id`.execute(db)).rows
    expect(rows).toEqual([
      { chunkId: chunk(0), status: 'indexed', error: VECTORLESS_WITH_CONTENT_REASON },
      { chunkId: chunk(1), status: 'empty', error: VECTORLESS_REASON },
      { chunkId: chunk(2), status: 'indexed', error: null },
    ])
  })

  test('reconciliation marks it empty with its reason, and a second pass finds nothing (idempotent)', async () => {
    const service = new LearningSemanticIndexService(db, { enabled: true })
    const present = async () => new Set([chunk(0), chunk(2)])
    expect(await service.reconcileVectorlessChunks({ apply: false, present })).toEqual({ checked: 3, vectorless: [chunk(1)], marked: 0, withContent: [] })
    expect((await service.reconcileVectorlessChunks({ apply: true, present })).marked).toBe(1)
    const row = (await sql<{ status: string; error: string }>`SELECT status,error FROM pg_temp.learning_semantic_index_chunks WHERE chunk_id=${chunk(1)}`.execute(db)).rows[0]
    expect(row).toEqual({ status: 'empty', error: VECTORLESS_REASON })
    expect(await service.reconcileVectorlessChunks({ apply: true, present })).toEqual({ checked: 2, vectorless: [], marked: 0, withContent: [] })
  })

  test('a bank missing more than the limit is refused, not silently emptied', async () => {
    const service = new LearningSemanticIndexService(db, { enabled: true })
    await expect(service.reconcileVectorlessChunks({ apply: true, limit: 1, present: async () => new Set() })).rejects.toThrow('bank looks incomplete')
    const statuses = (await sql<{ status: string }>`SELECT DISTINCT status FROM pg_temp.learning_semantic_index_chunks`.execute(db)).rows.map(r => r.status)
    expect(statuses).toEqual(['indexed'])
  })

  // Round-2 N-S2: flagged chunks with text must not accumulate into the limit, and must have a way out.
  test('chunks already flagged with text do not count against the limit; new vectorless ones still do', async () => {
    const service = new LearningSemanticIndexService(db, { enabled: true })
    await sql`UPDATE pg_temp.learning_semantic_index_chunks SET error=${VECTORLESS_WITH_CONTENT_REASON} WHERE chunk_id IN (${chunk(0)},${chunk(1)})`.execute(db)
    const present = async () => new Set([chunk(2)])
    expect(await service.reconcileVectorlessChunks({ apply: false, limit: 0, present })).toEqual({ checked: 3, vectorless: [chunk(0), chunk(1)], marked: 0, withContent: [chunk(0)] })
    await expect(service.reconcileVectorlessChunks({ apply: false, limit: 0, present: async () => new Set() })).rejects.toThrow('1 indexed chunks have no vector (limit 0)')
  })
  test('accepting a flagged chunk empties it with its reason and releases only the holds it alone kept; anything else is reported back', async () => {
    const service = new LearningSemanticIndexService(db, { enabled: true })
    await service.reconcileVectorlessChunks({ apply: true, present: async () => new Set([chunk(1), chunk(2)]) })
    // A second flagged chunk the operator has not accepted yet.
    await sql`UPDATE pg_temp.learning_semantic_index_chunks SET error=${VECTORLESS_WITH_CONTENT_REASON} WHERE chunk_id=${chunk(2)}`.execute(db)
    const hold = (user: string, missing: string[]) => sql`INSERT INTO pg_temp.learning_reactive_route_holds(user_id,event_id,revision,message_id,reason,attempts,next_attempt_at,missing_chunk_ids)
      VALUES(${user},gen_random_uuid(),'rev','m','r',6,NULL,${missing}::text[])`.execute(db)
    await hold('u1', [chunk(0)])
    await hold('u2', [chunk(0)])
    await hold('u1', [chunk(0), chunk(2)])
    await hold('u1', [chunk(0), chunk(1)])
    expect(await service.acceptVectorlessChunks([chunk(0), chunk(1), 'nope'])).toEqual({ accepted: [chunk(0)], notFlagged: ['nope', chunk(1)].sort(), releasedHolds: 3 })
    const row = (await sql<{ status: string; error: string }>`SELECT status,error FROM pg_temp.learning_semantic_index_chunks WHERE chunk_id=${chunk(0)}`.execute(db)).rows[0]
    expect(row).toEqual({ status: 'empty', error: VECTORLESS_ACCEPTED_REASON })
    const left = (await sql<{ missing: string[] }>`SELECT missing_chunk_ids AS missing FROM pg_temp.learning_reactive_route_holds`.execute(db)).rows
    expect(left).toEqual([{ missing: [chunk(0), chunk(2)] }])
    expect(await service.acceptVectorlessChunks([chunk(0)])).toEqual({ accepted: [], notFlagged: [chunk(0)], releasedHolds: 0 })
  })
})
