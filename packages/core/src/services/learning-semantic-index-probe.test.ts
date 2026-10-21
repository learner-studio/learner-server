import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'
import type { DB } from '../types/db.types.js'
import { LearningExposureObservation } from '../lib/learning/learning-exposure-schemas.js'
import { canonicalSemanticMessage, LEARNING_SEMANTIC_BANK, semanticHash, tokenizeSemanticTexts } from '../lib/learning/learning-semantic-index.js'
import { LearningLosslessArchiveService } from './learning-lossless-archive-service.js'

// Explicit opt-in read-only probe. No fixtures, migrations, indexing or cleanup
// writes. This remains runnable against any retained completed pilot/run.
const databaseUrl = process.env.LEARNING_SEMANTIC_INDEX_PROBE_DATABASE_URL
const runId = process.env.LEARNING_SEMANTIC_INDEX_PROBE_RUN_ID
const probeTimeout = Number(process.env.LEARNING_SEMANTIC_INDEX_PROBE_TIMEOUT_MS ?? 120000)
if (!Number.isFinite(probeTimeout) || probeTimeout < 1000 || probeTimeout > 1800000) throw new Error('Probe timeout must be between 1000 and 1800000 ms')
const probe = databaseUrl && runId ? describe : describe.skip
probe('canonical semantic index retained PostgreSQL and Hindsight proof', () => {
  let db: Kysely<DB>
  beforeAll(() => { db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: databaseUrl!, max: 2 }) }), plugins: [new CamelCasePlugin()] }) })
  afterAll(async () => { await db?.destroy() })

  test('frozen text matches canonical full payload, exact chunks, actual tokenizer and retained Hindsight bytes', async () => {
    const run = await sql<{ status: string; count: number }>`SELECT status,canonical_messages AS count FROM learning_semantic_index_runs WHERE run_id=${runId!}::uuid`.execute(db)
    expect(run.rows[0]?.status).toBe('completed')
    const messages = await sql<{ messageId: string; rawVersionId: string; text: string; sourceSha256: string; payload: unknown; status: string }>`
      SELECT m.message_id AS "messageId",m.raw_version_id AS "rawVersionId",m.source_text AS text,m.source_sha256 AS "sourceSha256",o.payload,m.status
      FROM learning_semantic_index_members member JOIN learning_semantic_index_messages m USING(message_id)
      JOIN learning_exposure_observations o ON o.observation_id=m.observation_id WHERE member.run_id=${runId!}::uuid ORDER BY m.message_id`.execute(db)
    expect(messages.rows.length).toBe(run.rows[0]!.count)
    expect(messages.rows.length).toBeGreaterThan(0)
    const archive = new LearningLosslessArchiveService(db)
    const verifiedRaw = new Set<string>()
    type SourceChunk = { messageId: string; chunkId: string; startOffset: number; endOffset: number; tokenCount: number; status: string; contentSha256: string }
    const allChunks = await sql<SourceChunk>`SELECT c.message_id AS "messageId",c.chunk_id AS "chunkId",c.start_offset AS "startOffset",
      c.end_offset AS "endOffset",c.token_count AS "tokenCount",c.status,c.content_sha256 AS "contentSha256"
      FROM learning_semantic_index_chunks c JOIN learning_semantic_index_members member USING(message_id)
      WHERE member.run_id=${runId!}::uuid ORDER BY c.message_id,c.ordinal`.execute(db)
    const chunksByMessage = new Map<string, SourceChunk[]>()
    for (const chunk of allChunks.rows) {
      const group = chunksByMessage.get(chunk.messageId) ?? []
      group.push(chunk)
      chunksByMessage.set(chunk.messageId, group)
    }
    const textByMessage = new Map(messages.rows.map(message => [message.messageId, message.text]))
    // Certify every exact slice with the actual tokenizer, amortizing process
    // startup only. No sampled chunks, approximate counts, or truncation.
    for (let offset = 0; offset < allChunks.rows.length; offset += 128) {
      const batch = allChunks.rows.slice(offset, offset + 128)
      const certified = await tokenizeSemanticTexts(batch.map(chunk => textByMessage.get(chunk.messageId)!.slice(chunk.startOffset, chunk.endOffset)))
      for (const [index, chunk] of batch.entries()) {
        expect(certified[index]!.chunks.length).toBe(1)
        expect(certified[index]!.chunks[0]!.tokenCount).toBe(chunk.tokenCount)
        expect(chunk.tokenCount).toBeLessThanOrEqual(480)
      }
    }
    let certifiedChunks = 0
    for (const message of messages.rows) {
      const canonical = canonicalSemanticMessage(LearningExposureObservation.parse(message.payload), message.rawVersionId)
      expect(message.text).toBe(canonical.text)
      expect(message.messageId).toBe(canonical.messageId)
      expect(message.sourceSha256).toBe(semanticHash(canonical.text))
      if (!verifiedRaw.has(message.rawVersionId)) {
        const verified = await archive.verifyVersion(message.rawVersionId)
        expect(verified.rawLength).toBeGreaterThan(0)
        verifiedRaw.add(message.rawVersionId)
      }
      const chunks = chunksByMessage.get(message.messageId) ?? []
      if (message.status !== 'indexed') {
        expect(['empty','media_only','unsupported']).toContain(message.status)
        expect(chunks.length).toBe(0)
        continue
      }
      expect(chunks.length).toBeGreaterThan(0)
      const slices = chunks.map(chunk => message.text.slice(chunk.startOffset, chunk.endOffset))
      expect(slices.join('')).toBe(message.text)
      for (const [index, chunk] of chunks.entries()) {
        expect(chunk.status).toBe('indexed')
        expect(semanticHash(slices[index]!)).toBe(chunk.contentSha256)
        const response = await fetch(`http://127.0.0.1:18925/v1/default/banks/${LEARNING_SEMANTIC_BANK}/documents/${chunk.chunkId}`, { signal: AbortSignal.timeout(10000) })
        expect(response.ok).toBe(true)
        expect((await response.json() as { original_text: string }).original_text).toBe(slices[index]!)
        certifiedChunks++
      }
    }
    expect(certifiedChunks).toBeGreaterThan(0)
  }, probeTimeout)
})
