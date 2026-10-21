import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { DB } from '../types/db.types.js'
import { LearningSemanticIndexService } from './learning-semantic-index-service.js'
import { LearningExposureService } from './learning-exposure-service.js'
import { LearningLosslessArchiveService } from './learning-lossless-archive-service.js'
import { archivePlaygroundTurn } from '../lib/learning/learning-playground-archive.js'
import { LearningExposureObservation } from '../lib/learning/learning-exposure-schemas.js'

const databaseUrl = process.env.LEARNING_SEMANTIC_INDEX_TEST_DATABASE_URL
const integration = databaseUrl ? describe : describe.skip
integration('isolated PostgreSQL semantic index transport recovery', () => {
  let db: Kysely<DB>
  const originalFetch = globalThis.fetch
  const documents = new Map<string, string>()
  const operations = new Set<string>()
  let posts = 0
  beforeAll(async () => {
    if (!new URL(databaseUrl!).pathname.startsWith('/learning_semantic_probe_')) throw new Error('Refusing a non-isolated semantic index test database')
    db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl!, max: 3 }) }), plugins: [new CamelCasePlugin()] })
    for (const migration of ['0154-lossless-cli-archive.sql','0155-learning-exposure.sql','0161-learning-semantic-index.sql']) {
      await sql.raw(await readFile(new URL(`../../test/fixtures/source-migrations/${migration}`, import.meta.url), 'utf8')).execute(db)
    }
    await sql`CREATE TABLE IF NOT EXISTS public.learner_workflow_runs(workflow_run_id text PRIMARY KEY,status text)`.execute(db)
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (!url.startsWith('http://127.0.0.1:18925/')) throw new Error('Unexpected HTTP target in isolated test')
      if (url.endsWith('/version')) return Response.json({ api_version: '0.9.2', features: { observations: false, bank_config_api: false, store_document_text: true } })
      if (url.endsWith('/config')) return Response.json({ config: { retain_extraction_mode: 'chunks', store_document_text: true, enable_observations: false, enable_auto_consolidation: false, retain_chunk_size: 3000 } })
      if (url.includes('/operations/')) {
        const operationId = url.split('/').at(-1)!
        return Response.json({ operation_id: operationId, status: operations.has(operationId) ? 'completed' : 'not_found' })
      }
      if (url.endsWith('/memories') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { operation_id: string; items: Array<{ document_id: string; content: string }> }
        posts++
        operations.add(body.operation_id)
        for (const item of body.items) documents.set(item.document_id, item.content)
        // The provider committed the request but its acknowledgement was lost.
        throw new Error('Simulated lost retain acknowledgement')
      }
      if (url.includes('/documents/')) {
        const text = documents.get(url.split('/').at(-1)!)
        return text === undefined ? new Response('', { status: 404 }) : Response.json({ original_text: text })
      }
      throw new Error(`Unrecognized isolated HTTP contract: ${url}`)
    }) as typeof fetch
  })
  afterAll(async () => { globalThis.fetch = originalFetch; await db?.destroy() })

  test('hydrates long canonical payload and reconciles a lost acknowledgement without a duplicate POST', async () => {
    const original = 'Original learner evidence beyond the query preview limit. '.repeat(300) + 'Tail witness.'
    const archive = new LearningLosslessArchiveService(db)
    const exposure = new LearningExposureService(db)
    await archivePlaygroundTurn(archive, exposure, { requestId: randomUUID(), userId: `probe-${randomUUID()}`, provider: 'codex',
      message: original, response: 'Original assistant context.', receivedAt: '2026-09-06T12:00:00.000Z' })
    const page = await exposure.query({ limit: 100 })
    expect((await exposure.canonicalIndexManifest()).map(row=>row.id)).toEqual(page.items.map(row=>row.id))
    expect(page.items.find(item => item.observation.direction === 'user_to_model')!.observation.parts[0]!.textOmitted).toBe(true)
    const index = new LearningSemanticIndexService(db, { enabled: true })
    const frozen = await index.freeze(randomUUID())
    const plan = await index.prepareOperations(frozen.runId)
    expect(plan.operationIds.length).toBe(1)
    await expect(index.retainBatch(frozen.runId, plan.firstOperationId)).rejects.toThrow('lost retain acknowledgement')
    expect(posts).toBe(1)
    const adopted = await index.retainBatch(frozen.runId, plan.firstOperationId)
    expect(adopted.operationPending).toBe(false)
    expect(adopted.pending).toBe(0)
    expect(posts).toBe(1)
    await index.retainBatch(frozen.runId, plan.firstOperationId)
    expect(posts).toBe(1)
    const receipt = await index.finish(frozen.runId)
    expect(receipt.indexedMessages).toBe(2)
    expect(receipt.indexedChunks).toBeGreaterThan(2)
    const restored = await sql<{ text: string }>`SELECT source_text AS text FROM learning_semantic_index_messages WHERE role='user'`.execute(db)
    expect(restored.rows[0]!.text).toBe(original)
    expect(await index.hasPendingChanges()).toBe(false)
    expect((await index.freeze(randomUUID())).runId).toBe(frozen.runId)
    const source = await sql<{ payload: unknown; rawVersionId: string }>`SELECT payload,raw_version_id AS "rawVersionId"
      FROM learning_exposure_observations WHERE direction='user_to_model' LIMIT 1`.execute(db)
    const observation = LearningExposureObservation.parse(source.rows[0]!.payload)
    await exposure.ingestObservation({ ...observation, observationId: randomUUID(), dedupeKey: randomUUID(),
      logicalMessageKey: null, direction: 'internal' }, source.rows[0]!.rawVersionId)
    // Hidden/tool arrivals change raw count, but neither a new instance nor a
    // repeated scheduler check may request a full freeze of identical evidence.
    expect(await index.hasPendingChanges()).toBe(false)
    expect(await new LearningSemanticIndexService(db, { enabled: true }).hasPendingChanges()).toBe(false)
    const before = await sql<{ count: string }>`SELECT count(*) AS count FROM learning_semantic_index_runs`.execute(db)
    expect(Number(before.rows[0]!.count)).toBe(1)
    // A higher-priority revision that removes visibility must invalidate the
    // old indexed identity, even though its logical message key is unchanged.
    await exposure.ingestObservation({ ...observation, observationId: randomUUID(), dedupeKey: randomUUID(),
      stage: 'failed', correlation: { ...observation.correlation, historyProjectionRevision: '3' } }, source.rows[0]!.rawVersionId)
    expect(await index.hasPendingChanges()).toBe(true)
    const removed = await index.freeze(randomUUID())
    await index.finish(removed.runId)
    expect(await index.hasPendingChanges()).toBe(false)
    // New canonical input is actionable after the negative identity delta.
    await exposure.ingestObservation({ ...observation, observationId: randomUUID(), dedupeKey: randomUUID(),
      logicalMessageKey: `new-${randomUUID()}` }, source.rows[0]!.rawVersionId)
    expect(await index.hasPendingChanges()).toBe(true)
  }, 30000)
  test('operator recovery refuses terminal native failures without resetting identity',async()=>{
    const index=new LearningSemanticIndexService(db,{enabled:true})
    const selected=await sql<{id:string}>`SELECT operation_id AS id FROM learning_semantic_index_operations LIMIT 1`.execute(db)
    const id=selected.rows[0]!.id
    await sql`UPDATE learning_semantic_index_messages SET status='error' WHERE current_canonical AND message_id IN
      (SELECT message_id FROM learning_semantic_index_chunks WHERE operation_id=${id}::uuid)`.execute(db)
    await sql`UPDATE learning_semantic_index_operations SET status='error',error='Hindsight operation failed' WHERE operation_id=${id}::uuid`.execute(db)
    await expect(index.retryFailedOperations()).rejects.toThrow('Repair terminal Hindsight operations first')
    const after=await sql<{status:string}>`SELECT status FROM learning_semantic_index_operations WHERE operation_id=${id}::uuid`.execute(db)
    expect(after.rows[0]!.status).toBe('error')
  })
})
