import type { Stats } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { sql, type Kysely } from 'kysely'

import type { DB } from '../types/db.types.js'
import {
  parseAnthropicRecord,
  parseGoogleNativeRow,
  parseOpenAIRecord,
  retainVerifiedTranscriptEnvelope,
  sourceCursorMustReset,
  verifyHindsightArchiveOnlyConfig,
  type ArchivedTurn,
  type GoogleNativeRow,
  type ParserState,
  type SourceIdentity,
  type TranscriptProvider,
} from '../lib/learning/transcript-archive.js'

export type TranscriptArchiveSource = {
  provider: TranscriptProvider
  path: string
  kind: 'jsonl' | 'sqlite'
}

type Checkpoint = TranscriptArchiveSource & {
  device: number
  inode: number
  generation: number
  cursor: number
  recordOrder: number
  parserState: ParserState
  lastScannedAt: string | null
}

export type TranscriptArchiveScanResult = {
  archiveOnlyConfigVerified: true
  sourcesDiscovered: number
  sourcesScanned: number
  recordsRead: number
  messagesStored: number
  replaysVerified: number
  bytesRead: number
  newestSourceMtime: string | null
  errors: string[]
}

type ArchiveConfig = {
  baseUrl: string
  bank: string
  openaiRoot: string
  anthropicRoot: string
  googleRoot: string
  maxSourcesPerRun?: number
  maxMessagesPerRun?: number
  maxBytesPerSource?: number
}

const MAX_SINGLE_RECORD_BYTES = 64 * 1024 * 1024

const recurseJsonl = async (root: string, depth = 0): Promise<string[]> => {
  if (depth > 7) return []
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path)
    else if (entry.isDirectory()) files.push(...await recurseJsonl(path, depth + 1))
  }
  return files
}

export class LearningTranscriptArchiveService {
  constructor(
    private readonly kysely: Kysely<DB>,
    private readonly config: ArchiveConfig,
  ) {}

  static local(kysely: Kysely<DB>, values: Partial<ArchiveConfig> = {}): LearningTranscriptArchiveService {
    const home = homedir()
    return new LearningTranscriptArchiveService(kysely, {
      baseUrl: 'http://127.0.0.1:18925',
      bank: 'learning-transcript-archive-v1',
      openaiRoot: join(home, '.codex', 'sessions'),
      anthropicRoot: join(home, '.claude', 'projects'),
      googleRoot: join(home, '.gemini', 'antigravity-cli', 'conversations'),
      maxSourcesPerRun: 24,
      maxMessagesPerRun: 100,
      maxBytesPerSource: 4 * 1024 * 1024,
      ...values,
    })
  }

  async discoverSources(): Promise<TranscriptArchiveSource[]> {
    const [openai, anthropic, googleEntries] = await Promise.all([
      recurseJsonl(this.config.openaiRoot),
      recurseJsonl(this.config.anthropicRoot),
      readdir(this.config.googleRoot, { withFileTypes: true }).catch(() => []),
    ])
    return [
      ...openai.map((path) => ({ provider: 'openai' as const, path, kind: 'jsonl' as const })),
      ...anthropic.map((path) => ({ provider: 'anthropic' as const, path, kind: 'jsonl' as const })),
      ...googleEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.db')).map((entry) => ({
        provider: 'google' as const,
        path: join(this.config.googleRoot, entry.name),
        kind: 'sqlite' as const,
      })),
    ]
  }

  private async checkpoints(): Promise<Map<string, Checkpoint>> {
    const result = await sql<{
      provider: TranscriptProvider
      sourcePath: string
      sourceKind: 'jsonl' | 'sqlite'
      deviceId: string
      inodeId: string
      generation: number
      sourceCursor: string
      recordOrder: string
      parserState: ParserState
      lastScannedAt: Date | string | null
    }>`SELECT provider, source_path AS "sourcePath", source_kind AS "sourceKind",
              device_id AS "deviceId", inode_id AS "inodeId", generation,
              source_cursor AS "sourceCursor", record_order AS "recordOrder",
              parser_state AS "parserState", last_scanned_at AS "lastScannedAt"
         FROM learning_transcript_archive_checkpoints`.execute(this.kysely)
    return new Map(result.rows.map((row) => [row.sourcePath, {
      provider: row.provider,
      path: row.sourcePath,
      kind: row.sourceKind,
      device: Number(row.deviceId),
      inode: Number(row.inodeId),
      generation: row.generation,
      cursor: Number(row.sourceCursor),
      recordOrder: Number(row.recordOrder),
      parserState: row.parserState ?? {},
      lastScannedAt: row.lastScannedAt ? new Date(row.lastScannedAt).toISOString() : null,
    }]))
  }

  private async saveCheckpoint(checkpoint: Checkpoint, delivered?: { documentId: string; contentHash: string }): Promise<void> {
    await sql`
      INSERT INTO learning_transcript_archive_checkpoints (
        provider, source_path, source_kind, device_id, inode_id, generation,
        source_cursor, record_order, parser_state, last_scanned_at,
        last_archived_at, last_document_id, last_content_hash, last_error, last_error_at
      ) VALUES (
        ${checkpoint.provider}, ${checkpoint.path}, ${checkpoint.kind}, ${checkpoint.device}, ${checkpoint.inode},
        ${checkpoint.generation}, ${checkpoint.cursor}, ${checkpoint.recordOrder},
        ${JSON.stringify(checkpoint.parserState)}::jsonb, NOW(),
        ${delivered ? sql`NOW()` : null}, ${delivered?.documentId ?? null}, ${delivered?.contentHash ?? null}, NULL, NULL
      )
      ON CONFLICT (source_path) DO UPDATE SET
        provider = EXCLUDED.provider, source_kind = EXCLUDED.source_kind,
        device_id = EXCLUDED.device_id, inode_id = EXCLUDED.inode_id,
        generation = EXCLUDED.generation, source_cursor = EXCLUDED.source_cursor,
        record_order = EXCLUDED.record_order, parser_state = EXCLUDED.parser_state,
        last_scanned_at = NOW(),
        last_archived_at = COALESCE(EXCLUDED.last_archived_at, learning_transcript_archive_checkpoints.last_archived_at),
        last_document_id = COALESCE(EXCLUDED.last_document_id, learning_transcript_archive_checkpoints.last_document_id),
        last_content_hash = COALESCE(EXCLUDED.last_content_hash, learning_transcript_archive_checkpoints.last_content_hash),
        last_error = NULL, last_error_at = NULL, updated_at = NOW()
      WHERE learning_transcript_archive_checkpoints.generation < EXCLUDED.generation
         OR (learning_transcript_archive_checkpoints.generation = EXCLUDED.generation
             AND learning_transcript_archive_checkpoints.source_cursor <= EXCLUDED.source_cursor)
    `.execute(this.kysely)
  }

  private async recordError(sourcePath: string, message: string): Promise<void> {
    await sql`UPDATE learning_transcript_archive_checkpoints
                 SET last_error = ${message.slice(0, 2_000)}, last_error_at = NOW(), last_scanned_at = NOW()
               WHERE source_path = ${sourcePath}`.execute(this.kysely)
  }

  private async archive(turn: ArchivedTurn): Promise<{ documentId: string; contentHash: string }> {
    return retainVerifiedTranscriptEnvelope(turn, this.config)
  }

  private async verifyArchiveOnlyConfig(): Promise<void> {
    await verifyHindsightArchiveOnlyConfig(this.config)
  }

  private freshCheckpoint(source: TranscriptArchiveSource, details: Stats, prior?: Checkpoint): Checkpoint {
    const rotated = Boolean(prior) && sourceCursorMustReset(prior!, {
      device: Number(details.dev), inode: Number(details.ino), size: Number(details.size),
    })
    if (prior && !rotated) return prior
    return {
      ...source,
      device: Number(details.dev),
      inode: Number(details.ino),
      generation: (prior?.generation ?? -1) + 1,
      cursor: 0,
      recordOrder: 0,
      parserState: {},
      lastScannedAt: prior?.lastScannedAt ?? null,
    }
  }

  private async scanJsonl(source: TranscriptArchiveSource, prior: Checkpoint | undefined, messageBudget: number) {
    const details = await stat(source.path)
    const checkpoint = this.freshCheckpoint(source, details, prior)
    // Materialize the cursor before parsing so a malformed first complete line
    // can record its error without advancing past unarchived source bytes.
    await this.saveCheckpoint(checkpoint)
    const remaining = Number(details.size) - checkpoint.cursor
    if (remaining <= 0) {
      await this.saveCheckpoint(checkpoint)
      return { records: 0, messages: 0, replays: 0, bytes: 0 }
    }
    const preferred = Math.min(remaining, this.config.maxBytesPerSource ?? 4 * 1024 * 1024)
    const handle = await open(source.path, 'r')
    let buffer: Buffer
    try {
      buffer = Buffer.alloc(preferred)
      const first = await handle.read(buffer, 0, preferred, checkpoint.cursor)
      buffer = buffer.subarray(0, first.bytesRead)
      if (!buffer.includes(10) && checkpoint.cursor + buffer.length < Number(details.size)) {
        const extendedSize = Math.min(remaining, MAX_SINGLE_RECORD_BYTES)
        if (extendedSize <= buffer.length) throw new Error(`JSONL record exceeds ${MAX_SINGLE_RECORD_BYTES} bytes`)
        const extended = Buffer.alloc(extendedSize)
        const read = await handle.read(extended, 0, extendedSize, checkpoint.cursor)
        buffer = extended.subarray(0, read.bytesRead)
        if (!buffer.includes(10) && checkpoint.cursor + buffer.length < Number(details.size)) {
          throw new Error(`JSONL record exceeds ${MAX_SINGLE_RECORD_BYTES} bytes`)
        }
      }
    } finally {
      await handle.close()
    }
    const startCursor = checkpoint.cursor
    const readEnd = startCursor + buffer.length
    let local = 0
    let records = 0
    let messages = 0
    let replays = 0
    while (local < buffer.length && messages < messageBudget) {
      const newline = buffer.indexOf(10, local)
      const atEof = readEnd >= Number(details.size)
      const end = newline === -1 ? buffer.length : newline
      if (newline === -1 && !atEof) break
      const bytes = buffer.subarray(local, end)
      if (bytes.length === 0) {
        const consumed = end - local + (newline === -1 ? 0 : 1)
        checkpoint.cursor += consumed; checkpoint.recordOrder += 1; local += consumed; records += 1
        await this.saveCheckpoint(checkpoint)
        continue
      }
      let parsed: { state: ParserState; turn: ArchivedTurn | null }
      try {
        const identity: SourceIdentity = {
          path: source.path, kind: 'jsonl', device: checkpoint.device, inode: checkpoint.inode,
          generation: checkpoint.generation, offset: checkpoint.cursor,
        }
        parsed = source.provider === 'openai'
          ? parseOpenAIRecord(bytes.toString('utf8'), identity, checkpoint.recordOrder, checkpoint.parserState)
          : parseAnthropicRecord(bytes.toString('utf8'), identity, checkpoint.recordOrder, checkpoint.parserState)
      } catch (error) {
        // A non-newline-terminated invalid record may still be in flight. Its
        // cursor stays put so the next scan retries after the writer finishes.
        if (newline === -1) break
        throw new Error(
          `Malformed complete JSONL record at byte ${checkpoint.cursor}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const consumed = end - local + (newline === -1 ? 0 : 1)
      const delivered = parsed.turn ? await this.archive(parsed.turn) : undefined
      if (parsed.turn && delivered && messages === 0) {
        const replay = await this.archive(parsed.turn)
        if (replay.documentId !== delivered.documentId || replay.contentHash !== delivered.contentHash) {
          throw new Error(`Hindsight replay identity mismatch for ${delivered.documentId}`)
        }
        replays += 1
      }
      checkpoint.parserState = parsed.state
      checkpoint.cursor += consumed
      checkpoint.recordOrder += 1
      local += consumed
      records += 1
      if (delivered) messages += 1
      await this.saveCheckpoint(checkpoint, delivered)
    }
    return { records, messages, replays, bytes: local }
  }

  private async scanGoogle(source: TranscriptArchiveSource, prior: Checkpoint | undefined, messageBudget: number) {
    const details = await stat(source.path)
    const checkpoint = this.freshCheckpoint(source, details, prior)
    const { Database } = await import('bun:sqlite')
    const database = new Database(source.path, { readonly: true })
    let rows: GoogleNativeRow[]
    try {
      rows = database.query<GoogleNativeRow, [number, number]>(
        'SELECT idx, step_type, metadata, step_payload FROM steps WHERE idx >= ? ORDER BY idx LIMIT ?',
      ).all(checkpoint.cursor, Math.max(messageBudget * 4, 100))
    } finally {
      database.close()
    }
    let messages = 0
    let replays = 0
    let records = 0
    for (const row of rows) {
      if (messages >= messageBudget) break
      const identity: SourceIdentity = {
        path: source.path, kind: 'sqlite', device: checkpoint.device, inode: checkpoint.inode,
        generation: checkpoint.generation, offset: row.idx,
      }
      const parsed = parseGoogleNativeRow(row, basename(source.path, '.db'), identity, checkpoint.parserState)
      const delivered = parsed.turn ? await this.archive(parsed.turn) : undefined
      if (parsed.turn && delivered && messages === 0) {
        const replay = await this.archive(parsed.turn)
        if (replay.documentId !== delivered.documentId || replay.contentHash !== delivered.contentHash) {
          throw new Error(`Hindsight replay identity mismatch for ${delivered.documentId}`)
        }
        replays += 1
      }
      checkpoint.parserState = parsed.state
      // SQLite cursors are the next row index, so an initial cursor of zero
      // includes idx=0 and a committed row is never replayed unnecessarily.
      checkpoint.cursor = row.idx + 1
      checkpoint.recordOrder += 1
      records += 1
      if (delivered) messages += 1
      await this.saveCheckpoint(checkpoint, delivered)
    }
    if (rows.length === 0) await this.saveCheckpoint(checkpoint)
    return { records, messages, replays, bytes: 0 }
  }

  async scan(): Promise<TranscriptArchiveScanResult> {
    await this.verifyArchiveOnlyConfig()
    const sources = await this.discoverSources()
    const checkpoints = await this.checkpoints()
    const selected = [...sources].sort((left, right) => {
      const a = checkpoints.get(left.path)?.lastScannedAt ?? ''
      const b = checkpoints.get(right.path)?.lastScannedAt ?? ''
      return a.localeCompare(b) || left.path.localeCompare(right.path)
    }).slice(0, this.config.maxSourcesPerRun ?? 24)
    const result: TranscriptArchiveScanResult = {
      archiveOnlyConfigVerified: true,
      sourcesDiscovered: sources.length,
      sourcesScanned: 0,
      recordsRead: 0,
      messagesStored: 0,
      replaysVerified: 0,
      bytesRead: 0,
      newestSourceMtime: null,
      errors: [],
    }
    let remainingMessages = this.config.maxMessagesPerRun ?? 100
    for (const source of selected) {
      if (remainingMessages <= 0) break
      try {
        const details = await stat(source.path)
        const mtime = details.mtime.toISOString()
        if (!result.newestSourceMtime || mtime > result.newestSourceMtime) result.newestSourceMtime = mtime
        const scanned = source.kind === 'jsonl'
          ? await this.scanJsonl(source, checkpoints.get(source.path), remainingMessages)
          : await this.scanGoogle(source, checkpoints.get(source.path), remainingMessages)
        result.sourcesScanned += 1
        result.recordsRead += scanned.records
        result.messagesStored += scanned.messages
        result.replaysVerified += scanned.replays
        result.bytesRead += scanned.bytes
        remainingMessages -= scanned.messages
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        result.errors.push(`${source.provider}:${source.path}: ${message}`)
        await this.recordError(source.path, message).catch(() => {})
      }
    }
    return result
  }
}
