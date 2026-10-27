import { sql, type Kysely } from 'kysely'
import type { DB } from '../types/db.types.js'
import { LearningExposureService, canonicalIndexManifestQuery } from './learning-exposure-service.js'
import { LearningExposureObservation } from '../lib/learning/learning-exposure-schemas.js'
import { verifyHindsightArchiveOnlyConfig } from '../lib/learning/transcript-archive.js'
import {
  canonicalSemanticMessage, LEARNING_SEMANTIC_BANK, LearningIndexStatus,
  LearningSemanticHit, LearningSemanticHydration, LearningSemanticSource,
  semanticHash, semanticOperationId, tokenizeSemanticTexts, readHindsightIndexOperationStatus,
} from '../lib/learning/learning-semantic-index.js'
import { z } from 'zod'
import { Pool } from 'pg'
import { hindsightDatabaseUrl } from '../lib/learning/hindsight-database.js'

type IndexConfig = { enabled: boolean; scheduleEnabled?: boolean; baseUrl?: string; python?: string; tokenizerPath?: string }
type SourceRow = z.infer<typeof LearningSemanticSource>
type ChunkRow = SourceRow & { chunkId: string; startOffset: number; endOffset: number; contentSha256: string }
type OperationRow = { operationId: string; chunkIds: string[]; status: string; attempts: number }
const iso = (date: Date | string | null) => date ? new Date(date).toISOString() : null

/** PostgreSQL canonical observations are authoritative. Hindsight is a derived
 * zero-LLM search index; it receives source slices, never an envelope embedding.
 * SQL below uses new migration tables before generated DB types exist and
 * PostgreSQL advisory locks / snapshot isolation for atomic index manifests. */
export class LearningSemanticIndexService {
  readonly implementationVersion = 1
  readonly bank = LEARNING_SEMANTIC_BANK
  constructor(private readonly kysely: Kysely<DB>, private readonly config: IndexConfig) {}
  get scheduleEnabled() { return this.config.enabled && this.config.scheduleEnabled === true }
  assertEnabled() { if (!this.config.enabled) throw new Error('Learning semantic index is disabled') }
  async withStartLock<T>(start: () => Promise<T>): Promise<T> {
    return this.kysely.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('learning-semantic-index-start-v1'))`.execute(trx)
      return start()
    })
  }
  async hasPendingChanges() {
    const current = await sql<{ rawCount: string; frozenCount: number | null; scope: string | null; pending: boolean }>`SELECT
      (SELECT count(*) FROM learning_exposure_observations) AS "rawCount",
      (SELECT raw_observations FROM learning_semantic_index_runs ORDER BY frozen_at DESC LIMIT 1) AS "frozenCount",
      (SELECT scope FROM learning_semantic_index_runs ORDER BY frozen_at DESC LIMIT 1) AS scope,
      EXISTS(SELECT 1 FROM learning_semantic_index_messages WHERE current_canonical AND status IN ('pending','chunked')) AS pending`.execute(this.kysely)
    const value = current.rows[0]!
    if (value.pending || value.scope !== 'all-queryable') return true
    if (Number(value.rawCount) === value.frozenCount) return false
    // Observation count includes tools, retries, hidden records and forked
    // copies. Compare canonical identities against the same manifest a freeze
    // writes before scheduling expensive payload hydration or a frozen
    // manifest; no frozen receipt is mutated as a cursor.
    const changed = await sql<{ changed: boolean }>`WITH canonical AS (
      SELECT id AS observation_id FROM (${canonicalIndexManifestQuery}) manifest
    ), indexed AS (
      SELECT observation_id FROM learning_semantic_index_messages WHERE current_canonical
    ) SELECT EXISTS(SELECT observation_id FROM canonical EXCEPT SELECT observation_id FROM indexed)
      OR EXISTS(SELECT observation_id FROM indexed EXCEPT SELECT observation_id FROM canonical) AS changed`.execute(this.kysely)
    return changed.rows[0]!.changed
  }
  private get baseUrl() { return this.config.baseUrl ?? 'http://127.0.0.1:18925' }
  private get root() { return `${this.baseUrl}/v1/default/banks/${this.bank}` }

  private async safeBackend() {
    if (this.baseUrl !== 'http://127.0.0.1:18925') throw new Error('Semantic archive requires the canonical local Hindsight service')
    await verifyHindsightArchiveOnlyConfig({ baseUrl: this.baseUrl, bank: this.bank })
    const response = await fetch(`${this.root}/config`, { signal: AbortSignal.timeout(5000) })
    const value = await response.json() as { config?: { retain_chunk_size?: number; retain_structured_chunk_size?: number | null } }
    if ((value.config?.retain_chunk_size ?? 0) < 2500 || (value.config?.retain_structured_chunk_size != null && value.config.retain_structured_chunk_size < 2500)) {
      throw new Error('Hindsight chunk size would split tokenizer-certified source slices')
    }
  }

  async freeze(runId: string, maxMessages?: number) {
    this.assertEnabled()
    await this.safeBackend()
    return this.kysely.transaction().setIsolationLevel('repeatable read').execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('learning-semantic-index-freeze-v1'))`.execute(trx)
      const existing = await sql`SELECT run_id FROM learning_semantic_index_runs WHERE run_id=${runId}::uuid`.execute(trx)
      if (existing.rows.length) return { runId }
      const exposure = new LearningExposureService(trx)
      const ids: string[] = []
      // Observations are immutable. Reuse certified source rows rather than
      // rehydrating every historical transcript on each realtime notification.
      const knownRows=await sql<{observationId:string;messageId:string;rawVersionId:string}>`SELECT observation_id AS "observationId",message_id AS "messageId",raw_version_id AS "rawVersionId" FROM learning_semantic_index_messages`.execute(trx)
      const known=new Map(knownRows.rows.map(row=>[row.observationId,row]))
      const manifest=await exposure.canonicalIndexManifest()
        for (const item of manifest.slice(0,maxMessages)) {
          const cached=known.get(item.id)
          if(cached?.rawVersionId===item.rawVersionId) {ids.push(cached.messageId);continue}
          const raw = await sql<{ payload: unknown }>`SELECT payload FROM learning_exposure_observations
            WHERE observation_id=${item.id}::uuid`.execute(trx)
          const observation = LearningExposureObservation.parse(raw.rows[0]?.payload)
          const message = canonicalSemanticMessage(observation, item.rawVersionId)
          const status = message.unsupported ? 'unsupported' : message.text.trim() ? 'pending' : message.mediaCount ? 'media_only' : 'empty'
          await sql`INSERT INTO learning_semantic_index_messages
            (message_id,observation_id,logical_message_key,raw_version_id,conversation_id,role,observed_at,
              payload,source_text,source_sha256,parts,media_count,status)
            VALUES(${message.messageId},${message.observationId}::uuid,${message.logicalMessageKey},${message.rawVersionId}::uuid,
              ${message.conversationId},${message.role},${message.observedAt}::timestamptz,${JSON.stringify(observation)}::jsonb,
              ${message.text},${message.sourceSha256},${JSON.stringify(message.parts)}::jsonb,${message.mediaCount},${status})
            ON CONFLICT(message_id) DO NOTHING`.execute(trx)
          ids.push(message.messageId)
        }
      const raw = await exposure.status()
      const watermark = semanticHash(ids.slice().sort().join('\n'))
      const previous = await sql<{ runId: string }>`SELECT run_id AS "runId" FROM learning_semantic_index_runs
        WHERE watermark=${watermark} AND status='completed' AND scope=${maxMessages ? 'bounded-pilot' : 'all-queryable'}
        ORDER BY frozen_at DESC LIMIT 1`.execute(trx)
      if (previous.rows[0]) return { runId: previous.rows[0].runId }
      await sql`INSERT INTO learning_semantic_index_runs(run_id,watermark,scope,canonical_messages,raw_observations)
        VALUES(${runId}::uuid,${watermark},${maxMessages ? 'bounded-pilot' : 'all-queryable'},${ids.length},${raw.observations})`.execute(trx)
      for (let offset = 0; offset < ids.length; offset += 500) {
        await sql`INSERT INTO learning_semantic_index_members(run_id,message_id)
          SELECT ${runId}::uuid,value FROM jsonb_array_elements_text(${JSON.stringify(ids.slice(offset, offset + 500))}::jsonb)` .execute(trx)
      }
      if (!maxMessages) await sql`UPDATE learning_semantic_index_messages m SET current_canonical=EXISTS(
        SELECT 1 FROM learning_semantic_index_members member WHERE member.run_id=${runId}::uuid AND member.message_id=m.message_id)`.execute(trx)
      return { runId }
    })
  }

  async chunkBatch(runId: string) {
    this.assertEnabled()
    const selected = await sql<{ messageId: string; text: string; sourceSha256: string }>`
      SELECT m.message_id AS "messageId",m.source_text AS text,m.source_sha256 AS "sourceSha256"
      FROM learning_semantic_index_messages m JOIN learning_semantic_index_members member USING(message_id)
      WHERE member.run_id=${runId}::uuid AND m.status='pending' ORDER BY message_id LIMIT 16`.execute(this.kysely)
    const tokenizations = await tokenizeSemanticTexts(selected.rows.map(message => message.text), this.config)
    for (const [index, message] of selected.rows.entries()) {
      try {
        if (semanticHash(message.text) !== message.sourceSha256) throw new Error('Canonical archive source hash mismatch')
        const tokenized = tokenizations[index]!
        await this.kysely.transaction().execute(async trx => {
          for (const [ordinal, chunk] of tokenized.chunks.entries()) {
            const contentSha256 = semanticHash(message.text.slice(chunk.startOffset, chunk.endOffset))
            const chunkId = semanticHash(`${message.messageId}:${ordinal}:${contentSha256}:${tokenized.tokenizerSha256}`)
            await sql`INSERT INTO learning_semantic_index_chunks
              (chunk_id,message_id,ordinal,start_offset,end_offset,token_count,tokenizer_sha256,content_sha256)
              VALUES(${chunkId},${message.messageId},${ordinal},${chunk.startOffset},${chunk.endOffset},
                ${chunk.tokenCount},${tokenized.tokenizerSha256},${contentSha256}) ON CONFLICT DO NOTHING`.execute(trx)
          }
          await sql`UPDATE learning_semantic_index_messages SET status='chunked',error=NULL
            WHERE message_id=${message.messageId} AND status='pending'`.execute(trx)
        })
      } catch (error) {
        await sql`UPDATE learning_semantic_index_messages SET status='error',error=${String(error).slice(0, 1000)}
          WHERE message_id=${message.messageId} AND status='pending'`.execute(this.kysely)
      }
    }
    return this.batchStatus(runId, selected.rows.length)
  }

  private async sourceChunks(chunkIds: string[]): Promise<ChunkRow[]> {
    const result = await sql<ChunkRow>`SELECT c.chunk_id AS "chunkId", c.start_offset AS "startOffset",c.end_offset AS "endOffset",
      c.content_sha256 AS "contentSha256", m.message_id AS "messageId",m.observation_id AS "observationId",
      m.logical_message_key AS "logicalMessageKey",m.raw_version_id AS "rawVersionId",m.conversation_id AS "conversationId",
      m.role,m.observed_at AS "observedAt",m.source_text AS text
      FROM learning_semantic_index_chunks c JOIN learning_semantic_index_messages m USING(message_id)
      WHERE c.chunk_id IN(SELECT value FROM jsonb_array_elements_text(${JSON.stringify(chunkIds)}::jsonb)) ORDER BY c.chunk_id`.execute(this.kysely)
    return result.rows.map(row => ({ ...row, observedAt: iso(row.observedAt)! }))
  }

  async prepareOperations(runId: string) {
    const pending = await sql<{ count: string }>`SELECT count(*) AS count FROM learning_semantic_index_messages m
      JOIN learning_semantic_index_members member USING(message_id) WHERE member.run_id=${runId}::uuid AND m.status='pending'`.execute(this.kysely)
    // Each chunk batch commits its own idempotent receipt. A replay after a
    // process failure resumes from the remaining pending message versions.
    for (let batch = 0; batch < Math.ceil(Number(pending.rows[0]?.count ?? 0) / 16); batch++) await this.chunkBatch(runId)
    return this.kysely.transaction().execute(async trx => {
      await sql`SELECT pg_advisory_xact_lock(hashtext('learning-semantic-index-retain-v1'))`.execute(trx)
      const selected = await sql<{ chunkId: string }>`SELECT c.chunk_id AS "chunkId" FROM learning_semantic_index_chunks c
        JOIN learning_semantic_index_members member USING(message_id)
        WHERE member.run_id=${runId}::uuid AND c.status='pending' AND c.operation_id IS NULL ORDER BY c.chunk_id`.execute(trx)
      for (let offset = 0; offset < selected.rows.length; offset += 32) {
        const chunkIds = selected.rows.slice(offset, offset + 32).map(row => row.chunkId)
        const operationId = semanticOperationId(chunkIds.join('\n'))
        await sql`INSERT INTO learning_semantic_index_operations(operation_id,chunk_ids)
          VALUES(${operationId}::uuid,${JSON.stringify(chunkIds)}::jsonb) ON CONFLICT DO NOTHING`.execute(trx)
        await sql`UPDATE learning_semantic_index_chunks SET operation_id=${operationId}::uuid
          WHERE chunk_id IN(SELECT value FROM jsonb_array_elements_text(${JSON.stringify(chunkIds)}::jsonb))`.execute(trx)
      }
      const operations = await sql<{ operationId: string }>`SELECT DISTINCT c.operation_id AS "operationId"
        FROM learning_semantic_index_chunks c JOIN learning_semantic_index_members member USING(message_id)
        WHERE member.run_id=${runId}::uuid AND c.status IN ('pending','submitted') AND c.operation_id IS NOT NULL ORDER BY c.operation_id`.execute(trx)
      return { runId, firstOperationId: operations.rows[0]?.operationId ?? null,
        operationIds: operations.rows.map(row => row.operationId), pollPasses: Array.from({ length: 60 }, (_, i) => i) }
    })
  }

  private async getOperation(operationId: string): Promise<OperationRow | null> {
    const existing = await sql<OperationRow>`SELECT operation_id AS "operationId",chunk_ids AS "chunkIds",status,attempts
      FROM learning_semantic_index_operations WHERE operation_id=${operationId}::uuid`.execute(this.kysely)
    return existing.rows[0] ?? null
  }

  async retainBatch(runId: string, operationId: string | null) {
    this.assertEnabled()
    if (!operationId) return { ...await this.batchStatus(runId, 0), operationPending: false }
    await this.safeBackend()
    const operation = await this.getOperation(operationId)
    if (!operation) throw new Error('Index operation not found')
    if (['indexed', 'error'].includes(operation.status)) return { ...await this.batchStatus(runId, 0), operationPending: false }
    try {
      const statusResponse = await fetch(`${this.root}/operations/${operation.operationId}`, { signal: AbortSignal.timeout(15000) })
      const status = await readHindsightIndexOperationStatus(statusResponse)
      if (status !== 'not_found') {
        if (status === 'completed') {
          // Verify stored original document bytes before acknowledging a chunk.
          const chunks = await this.sourceChunks(operation.chunkIds)
          for (const chunk of chunks) {
            const response = await fetch(`${this.root}/documents/${chunk.chunkId}`, { signal: AbortSignal.timeout(15000) })
            if (!response.ok) throw new Error(`Hindsight verification HTTP ${response.status}`)
            const document = await response.json() as { original_text?: string }
            if (document.original_text !== chunk.text.slice(chunk.startOffset, chunk.endOffset)
              || semanticHash(document.original_text) !== chunk.contentSha256) throw new Error('Hindsight stored source differs from canonical slice')
          }
          await this.settleOperation(operation.operationId, 'indexed', null)
        } else if (['failed', 'cancelled'].includes(status)) {
          await this.settleOperation(operation.operationId, 'error', `Hindsight operation ${status}`)
        } else {
          await sql`UPDATE learning_semantic_index_operations SET status='submitted',updated_at=NOW()
            WHERE operation_id=${operation.operationId}::uuid`.execute(this.kysely)
        }
      } else {
        if (operation.attempts >= 3) {
          await this.settleOperation(operation.operationId, 'error', 'Retain acknowledgement remained unavailable after three attempts')
        } else {
          const chunks = await this.sourceChunks(operation.chunkIds)
          const items = chunks.map(chunk => ({ content: chunk.text.slice(chunk.startOffset, chunk.endOffset),
            document_id: chunk.chunkId, timestamp: chunk.observedAt, update_mode: 'replace',
            metadata: { chunkId: chunk.chunkId, messageId: chunk.messageId, observationId: chunk.observationId,
              rawVersionId: chunk.rawVersionId, conversationId: chunk.conversationId, role: chunk.role,
              startOffset: String(chunk.startOffset), endOffset: String(chunk.endOffset), sourceSha256: chunk.contentSha256 },
            tags: ['learning-canonical-v1', `role:${chunk.role}`, `conversation:${semanticHash(chunk.conversationId)}`] }))
          await sql`UPDATE learning_semantic_index_operations SET attempts=attempts+1,updated_at=NOW()
            WHERE operation_id=${operation.operationId}::uuid`.execute(this.kysely)
          const response = await fetch(`${this.root}/memories`, { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items, async: true, operation_id: operation.operationId }), signal: AbortSignal.timeout(30000) })
          if (!response.ok) throw new Error(`Hindsight retain HTTP ${response.status}`)
          const acknowledgement = await response.json() as { operation_id?: string }
          if (acknowledgement.operation_id !== operation.operationId) throw new Error('Hindsight operation identity mismatch')
          await sql`UPDATE learning_semantic_index_operations SET status='submitted',error=NULL,updated_at=NOW()
            WHERE operation_id=${operation.operationId}::uuid`.execute(this.kysely)
        }
      }
    } catch (error) {
      // A timed-out POST is uncertain, not permission to allocate a new ID.
      // The next durable iteration reconciles the same operation first.
      await sql`UPDATE learning_semantic_index_operations SET error=${String(error).slice(0, 1000)},updated_at=NOW()
        WHERE operation_id=${operation.operationId}::uuid`.execute(this.kysely)
      throw error
    }
    return { ...await this.batchStatus(runId, operation.chunkIds.length), operationPending: ['pending', 'submitted'].includes((await this.getOperation(operationId))!.status) }
  }

  /** Chunks of a settled operation that Hindsight retained but found nothing to embed in. */
  private async unembeddedChunks(operationId: string): Promise<string[]> {
    if (process.env.LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED !== 'true') return []
    const ids = (await sql<{ chunk_id: string }>`SELECT chunk_id FROM learning_semantic_index_chunks
      WHERE operation_id=${operationId}::uuid`.execute(this.kysely)).rows.map(row => row.chunk_id)
    if (!ids.length) return []
    const pool = new Pool({ connectionString: hindsightDatabaseUrl(), max: 1, options: '-c default_transaction_read_only=on' })
    try {
      const present = new Set((await pool.query<{ document_id: string }>('SELECT DISTINCT document_id FROM public.learner_learning_vectors WHERE document_id=ANY($1::text[])', [ids])).rows.map(row => row.document_id))
      return ids.filter(id => !present.has(id))
    } finally { await pool.end() }
  }

  private async settleOperation(operationId: string, state: 'indexed' | 'error', error: string | null) {
    // A `.”` or `{}` tail of a split message yields no vector; marked `empty`, it
    // is terminal and outside every coverage guard instead of blocking them all.
    const empty = state === 'indexed' ? await this.unembeddedChunks(operationId) : []
    await this.kysely.transaction().execute(async trx => {
      await sql`UPDATE learning_semantic_index_operations SET status=${state},error=${error},updated_at=NOW()
        WHERE operation_id=${operationId}::uuid`.execute(trx)
      await sql`UPDATE learning_semantic_index_chunks SET status=${state},error=${error},indexed_at=${state === 'indexed' ? sql`NOW()` : null}
        WHERE operation_id=${operationId}::uuid`.execute(trx)
      if (empty.length) await sql`UPDATE learning_semantic_index_chunks SET status='empty' WHERE chunk_id=ANY(${empty}::text[])`.execute(trx)
      await sql`UPDATE learning_semantic_index_messages m SET
        status=CASE WHEN EXISTS(SELECT 1 FROM learning_semantic_index_chunks c WHERE c.message_id=m.message_id AND c.status='error') THEN 'error' ELSE 'indexed' END,
        indexed_at=CASE WHEN ${state}='indexed' THEN NOW() ELSE NULL END,error=${error}
        WHERE m.status IN ('chunked','error') AND EXISTS(SELECT 1 FROM learning_semantic_index_chunks c WHERE c.message_id=m.message_id AND c.operation_id=${operationId}::uuid)
        AND NOT EXISTS(SELECT 1 FROM learning_semantic_index_chunks c WHERE c.message_id=m.message_id AND c.status IN ('pending','submitted'))`.execute(trx)
    })
  }

  private async batchStatus(runId: string, processed: number) {
    const result = await sql<{ pending: string; errors: string }>`SELECT
      count(*) FILTER(WHERE m.status IN ('pending','chunked')) AS pending,count(*) FILTER(WHERE m.status='error') AS errors
      FROM learning_semantic_index_messages m JOIN learning_semantic_index_members member USING(message_id) WHERE member.run_id=${runId}::uuid`.execute(this.kysely)
    return { runId, processed, pending: Number(result.rows[0]?.pending ?? 0), errors: Number(result.rows[0]?.errors ?? 0) }
  }

  async finish(runId: string) {
    const result = await this.batchStatus(runId, 0)
    if (result.pending || result.errors) throw new Error('Index run still has unfinished or failed canonical messages; dirty generation remains unacknowledged')
    await sql`UPDATE learning_semantic_index_runs SET status=${result.errors ? 'errors' : 'completed'},finished_at=NOW()
      WHERE run_id=${runId}::uuid AND status='running'`.execute(this.kysely)
    return this.status()
  }

  async retryFailedOperations() {
    this.assertEnabled()
    // Explicit operator recovery only, under the shared start lock. Source
    // bytes and successful embeddings remain untouched; operation IDs are reused.
    await this.kysely.transaction().execute(async trx=>{
      const terminal=await sql`SELECT 1 FROM learning_semantic_index_operations WHERE status='error'
        AND error IN ('Hindsight operation failed','Hindsight operation cancelled')
        AND operation_id IN (SELECT c.operation_id FROM learning_semantic_index_chunks c
          JOIN learning_semantic_index_messages m USING(message_id) WHERE m.current_canonical AND m.status='error') LIMIT 1`.execute(trx)
      if(terminal.rows.length) throw new Error('Repair terminal Hindsight operations first; local retry cannot restart a failed native operation')
      await sql`UPDATE learning_semantic_index_operations SET status='pending',attempts=0,error=NULL,updated_at=NOW()
        WHERE status='error' AND operation_id IN (SELECT c.operation_id FROM learning_semantic_index_chunks c
          JOIN learning_semantic_index_messages m USING(message_id) WHERE m.current_canonical AND m.status='error')`.execute(trx)
      await sql`UPDATE learning_semantic_index_chunks SET status='pending',error=NULL,indexed_at=NULL
        WHERE status='error' AND operation_id IN (SELECT operation_id FROM learning_semantic_index_operations WHERE status='pending')`.execute(trx)
      await sql`UPDATE learning_semantic_index_messages SET status='chunked',error=NULL,indexed_at=NULL
        WHERE current_canonical AND status='error' AND EXISTS(SELECT 1 FROM learning_semantic_index_chunks c
          WHERE c.message_id=learning_semantic_index_messages.message_id AND c.status='pending')`.execute(trx)
      const unrepaired=await sql`SELECT 1 FROM learning_semantic_index_messages WHERE current_canonical AND status='error' LIMIT 1`.execute(trx)
      if(unrepaired.rows.length) throw new Error('Canonical source errors require source repair before resetting the index retry budget')
    })
  }
  async status() {
    const latest = await sql<{ runId: string; status: string; scope: string; watermark: string; canonicalMessages: number; rawObservations: number }>`
      SELECT r.run_id AS "runId",CASE WHEN r.status='running' AND w.status IN ('failed','cancelled') THEN w.status ELSE r.status END AS status,
      r.scope,r.watermark,r.canonical_messages AS "canonicalMessages",r.raw_observations AS "rawObservations"
      FROM learning_semantic_index_runs r LEFT JOIN public.learner_workflow_runs w ON w.workflow_run_id::text=r.run_id::text
      ORDER BY r.frozen_at DESC LIMIT 1`.execute(this.kysely)
    const counts = await sql<{ status: string; count: string }>`SELECT status,count(*) AS count FROM learning_semantic_index_messages
      WHERE current_canonical GROUP BY status`.execute(this.kysely)
    const chunks = await sql<{ count: string; latest: Date | null }>`SELECT count(*) AS count,max(c.indexed_at) AS latest
      FROM learning_semantic_index_chunks c JOIN learning_semantic_index_messages m USING(message_id)
      WHERE m.current_canonical AND m.status='indexed' AND c.status='indexed'`.execute(this.kysely)
    const count = (state: string) => Number(counts.rows.find(row => row.status === state)?.count ?? 0)
    const run = latest.rows[0]
    const latestIndexedAt = iso(chunks.rows[0]?.latest ?? null)
    return LearningIndexStatus.parse({ bank: this.bank, model: 'BAAI/bge-small-en-v1.5', enabled: this.config.enabled,
      scheduleEnabled: this.scheduleEnabled, watermark: semanticHash(`${run?.watermark ?? ''}:${count('indexed')}:${latestIndexedAt ?? ''}`),
      scope: run?.scope ?? 'all-queryable', canonicalMessages: counts.rows.reduce((sum, row) => sum + Number(row.count), 0), rawObservations: run?.rawObservations ?? 0,
      indexedMessages: count('indexed'), indexedChunks: Number(chunks.rows[0]?.count ?? 0),
      pendingMessages: count('pending') + count('chunked'), emptyMessages: count('empty'), mediaOnlyMessages: count('media_only'),
      unsupportedMessages: count('unsupported'), errorMessages: count('error'), latestIndexedAt,
      activeRunId: run?.status === 'running' ? run.runId : null, runStatus: run?.status ?? null,
      limitations: ['Coverage is the frozen canonical queryable message projection, not every raw archive record.',
        'Media bytes remain in the lossless archive; this index embeds text only.',
        'Exposure and semantic similarity are not evidence of learner understanding.',
        'Offsets use UTF-16 code units in the full source text; text parts are joined with a newline and preserve original per-part offsets.'],
    })
  }

  async search({ query, limit = 12, conversationId, timeoutMs = 30000 }: { query: string; limit?: number | undefined; conversationId?: string | undefined; timeoutMs?: number }) {
    this.assertEnabled()
    await this.safeBackend()
    const response = await fetch(`${this.root}/memories/recall`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, budget: 'high', max_tokens: 16000, types: ['world'],
        tags: ['learning-canonical-v1', ...(conversationId ? [`conversation:${semanticHash(conversationId)}`] : [])], tags_match: 'all_strict' }),
      signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`Hindsight recall HTTP ${response.status}`)
    const body = await response.json() as { results?: Array<{ document_id?: string; metadata?: { chunkId?: string }; score?: number }> }
    const results = body.results ?? []
    const ranked = [...new Map(results.map(hit => ({ chunkId: hit.document_id ?? hit.metadata?.chunkId, score: hit.score ?? null }))
      .filter(hit => hit.chunkId).map(hit => [hit.chunkId, hit])).values()]
    if (!ranked.length) return []
    const sources = await this.sourceChunks(ranked.map(hit => hit.chunkId!))
    const current = await sql<{ chunkId: string }>`SELECT c.chunk_id AS "chunkId" FROM learning_semantic_index_chunks c
      JOIN learning_semantic_index_messages m USING(message_id) WHERE m.current_canonical AND m.status='indexed' AND c.status='indexed'
      AND c.chunk_id IN(SELECT value FROM jsonb_array_elements_text(${JSON.stringify(ranked.map(hit => hit.chunkId))}::jsonb))`.execute(this.kysely)
    const allowed = new Set(current.rows.map(row => row.chunkId))
    return ranked.flatMap(hit => {
      const source = sources.find(row => row.chunkId === hit.chunkId)
      return source && allowed.has(source.chunkId) && (!conversationId || source.conversationId === conversationId)
        ? [LearningSemanticHit.parse({ ...source, snippet: source.text.slice(source.startOffset, source.endOffset), score: hit.score })] : []
    }).slice(0, Math.min(50, Math.max(1, limit)))
  }

  async hydrate({ chunkId }: { chunkId: string }) {
    const source = (await this.sourceChunks([chunkId]))[0]
    if (!source) throw new Error('Canonical source chunk not found')
    const neighbors = await sql<SourceRow>`SELECT message_id AS "messageId",observation_id AS "observationId",
      logical_message_key AS "logicalMessageKey",raw_version_id AS "rawVersionId",conversation_id AS "conversationId",role,observed_at AS "observedAt",source_text AS text
      FROM (
        (SELECT * FROM learning_semantic_index_messages WHERE current_canonical AND conversation_id=${source.conversationId}
          AND (observed_at,message_id)<(${source.observedAt}::timestamptz,${source.messageId}) ORDER BY observed_at DESC,message_id DESC LIMIT 2)
        UNION ALL
        (SELECT * FROM learning_semantic_index_messages WHERE current_canonical AND conversation_id=${source.conversationId}
          AND (observed_at,message_id)>(${source.observedAt}::timestamptz,${source.messageId}) ORDER BY observed_at,message_id LIMIT 2)
      ) neighbors ORDER BY observed_at,message_id`.execute(this.kysely)
    return LearningSemanticHydration.parse({ ...source, chunkText: source.text.slice(source.startOffset, source.endOffset),
      neighbors: neighbors.rows.map(row => ({ ...row, observedAt: iso(row.observedAt)! })).sort((a, b) => a.observedAt.localeCompare(b.observedAt)) })
  }
}
