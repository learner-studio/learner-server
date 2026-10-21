import { createHash } from 'node:crypto'
import { lstat, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { Database } from 'bun:sqlite'
import type { DB } from '../types/db.types.js'
import { captureOpaqueFile } from '../lib/learning/lossless-archive-files.js'
import { LearningExposureObservation } from '../lib/learning/learning-exposure-schemas.js'
import { LearningLosslessArchiveService } from './learning-lossless-archive-service.js'
import { LearningExposureService } from './learning-exposure-service.js'
import { isCliProjectionRevisionUpgrade, projectCliExposureRecord } from '../lib/learning/learning-exposure-cli.js'
import { LearningExposureWorkService } from './learning-exposure-work-service.js'
import { drainOpenClawTranscriptHistory } from '../openclaw/learning-archive/history.js'
import { LearningArchiveSpool } from '../openclaw/learning-archive/spool.js'

/** Spool captures are leased outside any Pikku workflow run, so the terminal-run
 * reclaim path (which matches lease_owner against workflow_run_id) can never
 * attribute them. A random per-call owner made every lease anonymous even to the
 * process holding it; one deterministic owner per host+process keeps every lease
 * this process takes identifiable, so a stale one is reclaimable as a set. */
const processLeaseOwnerId = (): string => {
  const bytes = createHash('sha256').update(`learning-exposure-ingest|${hostname()}|${process.pid}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Observe the existing gateway handoff. This service never invokes a model,
 * sends a Discord message, downloads an arbitrary URL, or deletes spool data. */
export class LearningExposureIngestService {
  readonly implementationVersion = 4
  readonly leaseOwnerId = processLeaseOwnerId()
  constructor(
    private readonly kysely: Kysely<DB>,
    private readonly archive: LearningLosslessArchiveService,
    private readonly exposure: LearningExposureService,
    private readonly config: { enabled: boolean; spoolRoot: string; drainEnabled?: boolean; historyDatabasePath?: string; confirmedHumanSenderIds?: string[] },
  ) {}

  private async archiveFile(relativePath: string, limit: number) {
    if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error('Exposure spool path escaped its root')
    const root = resolve(this.config.spoolRoot)
    const path = resolve(root, relativePath)
    if (!relative(root, path) || relative(root, path).startsWith('..')) throw new Error('Exposure spool path escaped its root')
    const details = await lstat(path)
    if (!details.isFile() || details.isSymbolicLink() || details.size > limit) throw new Error('Exposure spool file is missing, unsafe or over the explicit capture limit')
    // captureOpaqueFile checks each path component/no-follow and verifies the
    // full stable bytes. The size bound above is a refusal, never truncation.
    const captured = await captureOpaqueFile(path, { approvedRoot: root, chunkBytes: 4 * 1024 * 1024 })
    const source = await this.archive.registerSource({
      host: hostname(), provider: 'openclaw', rootPath: root, relativePath, fileKind: 'attachment',
      observedAt: new Date().toISOString(), sourceSize: captured.rawLength,
      deviceId: captured.source.deviceId, inodeId: captured.source.inodeId,
      sourceMtimeNs: captured.source.mtimeNs, sourceCtimeNs: captured.source.ctimeNs,
      metadata: { captureAdapter: 'openclaw-exposure-v1' },
    })
    const checkpoint = await this.archive.getCheckpoint(source.sourceId, source.generation)
    if (checkpoint?.lastVerifiedVersionId) {
      const existing = await this.archive.verifyVersion(checkpoint.lastVerifiedVersionId)
      if (existing.sha256 !== captured.rawSha256 || existing.rawLength !== captured.rawLength) {
        throw new Error('Immutable exposure spool file changed after archival')
      }
      return { versionId: existing.versionId, sha256: existing.sha256, byteLength: existing.rawLength }
    }
    const claim = await this.archive.claimSource({ sourceId: source.sourceId, generation: source.generation, ownerId: this.leaseOwnerId, leaseMs: 120_000 })
    if (!claim) throw new Error('Exposure spool capture is leased by another worker')
    try {
      const result = await this.archive.commitCapture({ claim, expectedCursor: 0, checkpointCursorAfter: captured.rawLength, capture: captured })
      await this.archive.verifyVersion(result.versionId)
      return { versionId: result.versionId, sha256: captured.rawSha256, byteLength: captured.rawLength }
    } finally { await this.archive.releaseClaim(claim) }
  }

  get drainEnabled() { return this.config.enabled && this.config.drainEnabled === true }

  async drain(slot: number) {
    const empty = { processed: 0, pending: 0, gaps: 0, batches: 0 }
    if (!this.drainEnabled) return empty
    if (slot !== 0 && slot !== 1) throw new Error('Exposure drain slot must be 0 or 1')
    const work = new LearningExposureWorkService(this.kysely)
    const claim = await work.claim(`drain-slot:${slot}`)
    if (!claim) return empty
    try {
      const result = { ...empty }
      const startedAt = Date.now()
      do {
        const batch = await this.ingestSpool(true)
        result.processed += batch.processed; result.pending = batch.pending
        result.gaps += batch.gaps; result.batches += 1
        await work.renew(claim)
      } while (result.pending > 0 && result.batches < 20 && Date.now() - startedAt < 15_000)
      await work.finish(claim, { completedAt: new Date().toISOString() }, result)
      return result
    } catch (error) {
      await work.fail(claim, error)
      throw error
    } finally { await work.release(claim) }
  }

  async parity() {
    const capturedAt = new Date().toISOString()
    const raw = await sql<{ pending: string; bytes: string }>`SELECT
      count(*) FILTER(WHERE COALESCE(c.cursor_offset,0)<COALESCE(s.source_size,0)) pending,
      COALESCE(sum(GREATEST(0,COALESCE(s.source_size,0)-COALESCE(c.cursor_offset,0))),0) bytes
      FROM learning_archive_sources s LEFT JOIN learning_archive_checkpoints c
        ON c.source_id=s.source_id AND c.generation=s.generation WHERE s.metadata ? 'rootId'`.execute(this.kysely)
    const projection = await sql<{ total: string; pending: string; gaps: string }>`WITH latest AS (
      SELECT DISTINCT ON(s.source_id) v.version_id FROM learning_archive_sources s
      JOIN learning_archive_versions v USING(source_id)
      WHERE v.manifest_status='sealed' AND v.generation=s.generation AND s.metadata ? 'rootId'
        AND ((s.file_kind='jsonl' AND s.provider IN('codex','claude'))
          OR (s.file_kind='sqlite' AND s.provider='antigravity' AND s.metadata->>'rootId'='antigravity-conversations'))
      ORDER BY s.source_id,v.version_number DESC
    ) SELECT count(*) total,count(*) FILTER(WHERE i.import_key IS NULL) pending,
      count(*) FILTER(WHERE i.status='gap') gaps FROM latest
      LEFT JOIN learning_exposure_imports i ON i.import_key='cli-v2:'||latest.version_id::text`.execute(this.kysely)
    const work = await sql<{ key: string; cursor: Record<string, unknown>; counters: Record<string, unknown>; error: string | null; updatedAt: Date }>`
      SELECT work_key AS key,cursor,counters,last_error AS error,updated_at AS "updatedAt"
      FROM learning_exposure_work WHERE work_key='openclaw-history' OR last_error IS NOT NULL`.execute(this.kysely)
    const events = await readdir(join(this.config.spoolRoot, 'events')).catch(() => [])
    const receipts = await sql<{ key: string }>`SELECT import_key AS key FROM learning_exposure_imports
      WHERE import_key LIKE 'openclaw-spool:%' AND status='completed'`.execute(this.kysely)
    const imported = new Set(receipts.rows.map((row) => row.key))
    const pendingSpool = events.filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name) && !imported.has(`openclaw-spool:${name}`)).length
    let historyPending = 0
    const history = work.rows.find((row) => row.key === 'openclaw-history')
    if (this.config.historyDatabasePath) {
      const database = new Database(this.config.historyDatabasePath, { readonly: true })
      try {
        const cursor = history?.cursor
        const after = typeof cursor?.createdAt === 'number' ? cursor.createdAt : -1
        const sessionId = typeof cursor?.sessionId === 'string' ? cursor.sessionId : ''
        const seq = typeof cursor?.seq === 'number' ? cursor.seq : -1
        const count = database.query<{ count: number }, [number, number, string, string, number]>(
          'SELECT count(*) count FROM transcript_events WHERE created_at>? OR (created_at=? AND (session_id>? OR (session_id=? AND seq>?)))',
        ).get(after, after, sessionId, sessionId, seq)
        historyPending = count?.count ?? 0
      } finally { database.close() }
    }
    const media = await sql<{ pending: string }>`WITH current AS (
      SELECT DISTINCT ON(COALESCE(logical_message_key,observation_id::text),direction) payload
      FROM learning_exposure_observations
      ORDER BY COALESCE(logical_message_key,observation_id::text),direction,visible DESC,observed_at DESC,inserted_at DESC
    ) SELECT count(*) pending FROM current o,
      jsonb_array_elements(o.payload->'parts') p WHERE p->>'type'='media'
      AND p->>'captureStatus' IN('missing','refused','remote-pending')
      AND COALESCE(o.payload->'correlation'->>'proofFixture','false')<>'true'`.execute(this.kysely)
    return { capturedAt, rawPendingSources: Number(raw.rows[0]?.pending ?? 0), rawBacklogBytes: Number(raw.rows[0]?.bytes ?? 0),
      projectionEligibleVersions: Number(projection.rows[0]?.total ?? 0), projectionPendingVersions: Number(projection.rows[0]?.pending ?? 0),
      projectionGapVersions: Number(projection.rows[0]?.gaps ?? 0), pendingSpool, historyPending,
      mediaGapObservations: Number(media.rows[0]?.pending ?? 0), history: history ? { cursor: history.cursor, counters: history.counters } : null,
      errors: work.rows.filter((row) => row.error).map((row) => ({ key: row.key, error: row.error })),
      limitations: ['Measured against the latest discovered source sizes and sealed versions; live source growth after this measurement belongs to the next sweep.',
        'Drained queues do not prove rendered/read exposure or unexposed upstream data fidelity. Media gaps remain separate.',
        'JSONL partial tails and explicitly unsupported versions are gaps, not silently successful projections.'],
    }
  }

  async ingestSpool(projectCli = !this.drainEnabled) {
    const work = new LearningExposureWorkService(this.kysely)
    if (!this.config.enabled) return { processed: 0, pending: 0, gaps: 0 }
    const history = await this.ingestHistory()
    const claim = await work.claim('openclaw-spool')
    let spool = { processed: 0, pending: 0, gaps: 0 }
    if (claim) {
      try { spool = await this.ingestSpoolFiles() }
      finally { await work.release(claim) }
    }
    const cli = projectCli ? await this.projectCliVersions() : { processed: 0, pending: 0, gaps: 0 }
    return { processed: history.processed + spool.processed + cli.processed,
      pending: history.pending + spool.pending + cli.pending, gaps: history.gaps + spool.gaps + cli.gaps }
  }

  private async ingestHistory() {
    if (!this.config.historyDatabasePath) return { processed: 0, pending: 0, gaps: 0 }
    const work = new LearningExposureWorkService(this.kysely)
    const claim = await work.claim('openclaw-history')
    if (!claim) return { processed: 0, pending: 0, gaps: 0 }
    try {
      const cursor = claim.cursor
      const spool = new LearningArchiveSpool({ spoolRoot: this.config.spoolRoot,
        approvedLocalRoots: ['/root/.openclaw/media/inbound', '/root/media/inbound'] })
      await spool.initialize()
      const result = await drainOpenClawTranscriptHistory({
        databasePath: this.config.historyDatabasePath,
        spool,
        maxRows: 100, confirmedHumanSenderIds: new Set(this.config.confirmedHumanSenderIds ?? []),
        originalMediaRoots: ['/root/.openclaw/media/inbound'],
        cursor: cursor.importerRevision === 3 && typeof cursor.createdAt === 'number' && typeof cursor.sessionId === 'string' && typeof cursor.seq === 'number'
          ? { createdAt: cursor.createdAt, sessionId: cursor.sessionId, seq: cursor.seq } : null,
      })
      const prior = (key: string) => cursor.importerRevision === 3 && typeof claim.counters[key] === 'number' ? Number(claim.counters[key]) : 0
      await work.finish(claim, { ...result.cursor, importerRevision: 3, exhausted: result.exhausted }, {
        rowsRead: prior('rowsRead') + result.rowsRead, observationsWritten: prior('observationsWritten') + result.observationsWritten,
        usersImported: prior('usersImported') + result.usersImported, assistantsImported: prior('assistantsImported') + result.assistantsImported,
        mediaCaptured: prior('mediaCaptured') + result.mediaCaptured, mediaParityVerified: prior('mediaParityVerified') + result.mediaParityVerified,
        gaps: prior('gaps') + result.gaps,
      })
      return { processed: result.rowsRead, pending: result.exhausted ? 0 : 1, gaps: result.gaps }
    } finally { await work.release(claim) }
  }

  private async ingestSpoolFiles() {
    if (!this.config.enabled) return { processed: 0, pending: 0, gaps: 0 }
    const eventsDirectory = join(this.config.spoolRoot, 'events')
    const entries = await readdir(eventsDirectory, { withFileTypes: true }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return []
      throw error
    })
    let processed = 0; let pending = 0; let gaps = 0
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-zA-Z0-9_-]+\.json$/.test(entry.name)) continue
      const importKey = `openclaw-spool:${entry.name}`
      if (await this.exposure.imported(importKey)) continue
      if (processed >= 25) { pending += 1; continue }
      const relativePath = `events/${entry.name}`
      const raw = await this.archiveFile(relativePath, 16 * 1024 * 1024)
      // Parse verified DB bytes, not a second mutable read of the source file.
      const bytes = await this.archive.restoreVersion(raw.versionId, 16 * 1024 * 1024)
      const decoded: unknown = JSON.parse(Buffer.from(bytes).toString('utf8'))
      const parsed = LearningExposureObservation.safeParse(decoded)
      if (!parsed.success) {
        await this.exposure.markImported(importKey, raw.versionId, 'unsupported-observation-schema')
        processed += 1; gaps += 1; continue
      }
      const observation = parsed.data
      let mediaFailed = false
      for (const part of observation.parts) {
        if (part.type !== 'media' || !part.spoolRelativePath) continue
        try {
          const captured = await this.archiveFile(part.spoolRelativePath, 64 * 1024 * 1024)
          if (part.sha256 !== captured.sha256 || part.byteLength !== captured.byteLength) throw new Error('Exposure media digest mismatch')
          part.archiveVersionId = captured.versionId
          part.captureStatus = 'captured'
        } catch {
          mediaFailed = true
          part.captureStatus = 'refused'; part.gapCode = 'media-archive-verification-failed'
          observation.gaps.push({ code: part.gapCode, detail: 'Media was not declared captured because its archive/path/size/digest verification failed; raw observation is retained.' })
        }
      }
      // A projection can gain verified media after a transient archive failure.
      // Keep each derived revision immutable while preserving the original
      // gateway observation ID and the same canonical message identity.
      observation.correlation.gatewayObservationId = observation.observationId
      const revision = createHash('sha256').update(JSON.stringify(observation)).digest('hex')
      observation.observationId = `${revision.slice(0, 8)}-${revision.slice(8, 12)}-5${revision.slice(13, 16)}-a${revision.slice(17, 20)}-${revision.slice(20, 32)}`
      observation.dedupeKey = `gateway-projection-v1:${revision}`
      await this.exposure.ingestObservation(observation, raw.versionId)
      await this.exposure.markImported(importKey, raw.versionId, mediaFailed ? 'media-archive-verification-failed' : null)
      processed += 1; gaps += observation.gaps.length
    }
    return { processed, pending, gaps }
  }

  async projectActiveSource(sourceId: string) {
    if(!this.config.enabled) throw new Error('Learning exposure disabled')
    const result=await this.projectCliVersions(sourceId)
    const latest=(await sql<{pending:boolean;gap:boolean}>`SELECT NOT EXISTS(SELECT 1 FROM learning_exposure_imports i
      WHERE i.import_key='cli-v2:'||v.version_id::text) AS pending,
      EXISTS(SELECT 1 FROM learning_exposure_imports i WHERE i.import_key='cli-v2:'||v.version_id::text AND i.status='gap') AS gap
      FROM learning_archive_versions v JOIN learning_archive_sources s USING(source_id)
      WHERE s.source_id=${sourceId}::uuid AND v.generation=s.generation AND v.manifest_status='sealed'
      ORDER BY v.version_number DESC LIMIT 1`.execute(this.kysely)).rows[0]
    if(!latest || latest.pending) throw new Error('Active transcript projection pending; retry from durable cursor')
    return {...result,pending:0,gaps:Math.max(result.gaps,latest.gap?1:0)}
  }

  private async projectCliVersions(sourceId?: string) {
    const versions = await sql<{ sourceId: string; versionId: string; generation: number; provider: string; fileKind: string; relativePath: string; byteLength: string }>`
      WITH latest AS (
        SELECT DISTINCT ON (s.source_id) s.source_id,v.version_id,v.generation,s.provider,s.file_kind,
          s.relative_path,v.captured_byte_length
        FROM learning_archive_sources s JOIN learning_archive_versions v USING(source_id)
        WHERE v.manifest_status='sealed' AND v.generation=s.generation AND s.metadata ? 'rootId'
          AND (${sourceId ?? null}::uuid IS NULL OR s.source_id=${sourceId ?? null}::uuid)
          AND ((s.file_kind='jsonl' AND s.provider IN ('codex','claude'))
            OR (s.file_kind='sqlite' AND s.provider='antigravity' AND s.metadata->>'rootId'='antigravity-conversations'))
        ORDER BY s.source_id,v.version_number DESC
      ) SELECT latest.source_id AS "sourceId",version_id AS "versionId",latest.generation,provider,
        file_kind AS "fileKind",relative_path AS "relativePath",captured_byte_length AS "byteLength"
      FROM latest LEFT JOIN learning_exposure_projection_cursors p USING(source_id,generation)
      WHERE NOT EXISTS(SELECT 1 FROM learning_exposure_imports i WHERE i.import_key='cli-v2:'||latest.version_id::text)
        AND NOT EXISTS(SELECT 1 FROM learning_exposure_work w WHERE w.work_key='cli-source:'||latest.source_id::text
          AND w.lease_until>NOW())
      ORDER BY p.updated_at ASC NULLS FIRST,latest.source_id LIMIT 8`.execute(this.kysely)
    let processed = 0; let gaps = 0
    const work = new LearningExposureWorkService(this.kysely)
    for (const version of versions.rows) {
      const claim = await work.claim(`cli-source:${version.sourceId}`)
      if (!claim) continue
      try {
      if (version.fileKind === 'sqlite' && Number(version.byteLength) > 64 * 1024 * 1024) {
        await work.fenced(claim, async (trx) => new LearningExposureService(trx).markImported(`cli-v2:${version.versionId}`, version.versionId, 'projection-version-over-64MiB-limit'))
        gaps += 1; continue
      }
      const previous = await sql<{ cursorOffset: string; sourceOrder: string; parserState: { sessionId?: string; originator?: string; codexTurnId?: string; cliProjectionRevision?: number; sqliteVersionId?: string } }>`
        SELECT cursor_offset AS "cursorOffset",source_order AS "sourceOrder",parser_state AS "parserState"
        FROM learning_exposure_projection_cursors WHERE source_id=${version.sourceId}::uuid AND generation=${version.generation}`.execute(this.kysely)
      let offset = Number(previous.rows[0]?.cursorOffset ?? 0)
      let order = Number(previous.rows[0]?.sourceOrder ?? 0)
      let state = previous.rows[0]?.parserState ?? {}
      const previousProjectionRevision = state.cliProjectionRevision === undefined ? null : String(state.cliProjectionRevision)
      const projectionRevisionUpgrade = version.fileKind === 'jsonl' && isCliProjectionRevisionUpgrade(state.cliProjectionRevision)
      // Revision 2 carries the exact enclosing native Codex turn_context into
      // assistant records. Replay the immutable archived version from byte 0;
      // old projection rows remain as provenance and query ranking prefers v2.
      if (version.fileKind === 'jsonl' && state.cliProjectionRevision !== 2) {
        if (!projectionRevisionUpgrade) throw new Error('Unsupported CLI projection revision; refusing a cursor downgrade')
        offset = 0; order = 0; state = { cliProjectionRevision: 2 }
      }
      // Verify the whole immutable version once, then decode bounded windows.
      // Large transcript files need not be loaded into memory or refused.
      if (claim.cursor.versionId !== version.versionId) await this.archive.verifyVersion(version.versionId)
      const windowStart = version.fileKind === 'jsonl' ? offset : 0
      const bytes = version.fileKind === 'jsonl'
        ? await this.archive.restoreVersionWindow(version.versionId, offset, 16 * 1024 * 1024)
        : await this.archive.restoreVersion(version.versionId, 64 * 1024 * 1024)
      let lines = 0
      let completed = false
      let projected = 0
      let excluded = 0
      let invalid = 0
      if (version.fileKind === 'sqlite') {
        // SQLite snapshots can update existing rows. An append-only row cursor
        // is valid only within one immutable archived snapshot.
        if (state.sqliteVersionId !== version.versionId) { offset = 0; order = 0 }
        state = { ...state, sqliteVersionId: version.versionId }
        const directory = await mkdtemp('/var/tmp/learning-exposure-sqlite-')
        try {
          const path = join(directory, 'snapshot.db')
          await writeFile(path, bytes, { mode: 0o600, flag: 'wx' })
          const database = new Database(path, { readonly: true, strict: true })
          try {
            // A WAL-mode database captured before its first checkpoint is a valid
            // header page with no schema. This immutable version has nothing to
            // project; refusing it once keeps the sources behind it draining, and
            // the checkpointed table arrives as a later version of the source.
            const stepsTable = database.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='steps'").get()
            if (!stepsTable) {
              await work.fenced(claim, async (trx) => new LearningExposureService(trx).markImported(`cli-v2:${version.versionId}`, version.versionId, 'sqlite-snapshot-without-steps-table'))
              gaps += 1; continue
            }
            const rows = database.query<Record<string, unknown>, [number]>('SELECT * FROM steps WHERE idx >= ? ORDER BY idx LIMIT 1000').all(offset)
            for (const row of rows) {
              const index = Number(row.idx)
              const observation = projectCliExposureRecord('antigravity', row, {
                sourceId: version.sourceId, versionId: version.versionId, sourceOrder: index,
                generation: version.generation, sessionId: version.relativePath.replace(/\.db$/, ''),
              })
              if (observation) { await this.exposure.ingestObservation(observation, version.versionId); projected += 1 }
              else excluded += 1
              offset = index + 1; order += 1
            }
            completed = rows.length < 1000
          } finally { database.close() }
        } finally { await rm(directory, { recursive: true, force: true }) }
      }
      while (version.fileKind === 'jsonl' && offset - windowStart < bytes.length && lines < 1000) {
        const newline = bytes.indexOf(10, offset - windowStart)
        if (newline < 0) break // partial record stays in the byte archive, unparsed
        let record: unknown
        try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset - windowStart, newline))) }
        catch {
          await this.exposure.markImported(`cli-record:${version.versionId}:${offset}`, version.versionId, 'invalid-jsonl-record')
          gaps += 1; invalid += 1; offset = windowStart + newline + 1; order += 1; lines += 1; continue
        }
        if (record && typeof record === 'object' && 'type' in record && record.type === 'session_meta' && 'payload' in record) {
          const payload = record.payload
          if (payload && typeof payload === 'object') {
            state = { ...state,
              ...('id' in payload && typeof payload.id === 'string' ? { sessionId: payload.id } : {}),
              ...('originator' in payload && typeof payload.originator === 'string' ? { originator: payload.originator } : {}),
            }
          }
        }
        if (record && typeof record === 'object' && 'type' in record && record.type === 'turn_context' && 'payload' in record) {
          const payload = record.payload
          if (payload && typeof payload === 'object' && 'turn_id' in payload && typeof payload.turn_id === 'string') {
            state = { ...state, codexTurnId: payload.turn_id, cliProjectionRevision: 2 }
          }
        }
        const observation = projectCliExposureRecord(version.provider === 'codex' ? 'codex' : 'claude', record, {
          sourceId: version.sourceId, versionId: version.versionId, sourceOrder: order,
          generation: version.generation, ...state, isSubagent: version.relativePath.split('/').includes('subagents'),
        })
        if (observation) { await this.exposure.ingestObservation(observation, version.versionId); projected += 1 }
        else excluded += 1
        offset = windowStart + newline + 1; order += 1; lines += 1
      }
      const oversizedRecord = version.fileKind === 'jsonl' && lines === 0
        && windowStart + bytes.length < Number(version.byteLength) && bytes.indexOf(10) < 0
      if (version.fileKind === 'jsonl') completed = oversizedRecord || offset >= Number(version.byteLength)
        || (windowStart + bytes.length === Number(version.byteLength) && bytes.indexOf(10, offset - windowStart) < 0)
      await work.fenced(claim, async (trx) => {
      await sql`INSERT INTO learning_exposure_projection_cursors(source_id,generation,cursor_offset,source_order,parser_state)
        VALUES(${version.sourceId}::uuid,${version.generation},${offset},${order},${JSON.stringify(state)}::jsonb)
        ON CONFLICT(source_id,generation) DO UPDATE SET cursor_offset=EXCLUDED.cursor_offset,source_order=EXCLUDED.source_order,
          parser_state=EXCLUDED.parser_state,updated_at=NOW()
        WHERE learning_exposure_projection_cursors.cursor_offset<=EXCLUDED.cursor_offset
          OR (${projectionRevisionUpgrade} AND EXCLUDED.parser_state->>'cliProjectionRevision'='2'
            AND learning_exposure_projection_cursors.parser_state->>'cliProjectionRevision' IS NOT DISTINCT FROM ${previousProjectionRevision})
          OR (${version.fileKind}='sqlite' AND learning_exposure_projection_cursors.parser_state->>'sqliteVersionId'
            IS DISTINCT FROM EXCLUDED.parser_state->>'sqliteVersionId')`.execute(trx)
      if (completed) await new LearningExposureService(trx).markImported(`cli-v2:${version.versionId}`, version.versionId,
        oversizedRecord ? 'jsonl-record-over-16MiB-window' : version.fileKind === 'jsonl' && offset < Number(version.byteLength) ? 'partial-jsonl-tail' : null)
      const sameVersion = claim.cursor.versionId === version.versionId
      const prior = (key: string) => sameVersion && typeof claim.counters[key] === 'number' ? Number(claim.counters[key]) : 0
      await sql`UPDATE learning_exposure_work SET cursor=${JSON.stringify({ versionId: version.versionId, offset, completed })}::jsonb,
        counters=${JSON.stringify({ projected: prior('projected') + projected, excluded: prior('excluded') + excluded,
          invalid: prior('invalid') + invalid, scanned: prior('scanned') + projected + excluded + invalid,
          partialTailBytes: version.fileKind === 'jsonl' && completed ? Number(version.byteLength) - offset : 0 })}::jsonb,
        last_error=NULL,updated_at=NOW() WHERE work_key=${claim.key} AND token=${claim.token}::uuid`.execute(trx)
      })
      processed += 1
      } finally { await work.release(claim) }
    }
    return { processed, pending: versions.rows.length > 0 ? 1 : 0, gaps }
  }
}
