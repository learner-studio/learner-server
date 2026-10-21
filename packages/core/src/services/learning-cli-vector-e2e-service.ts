import { createHash, randomUUID } from 'node:crypto'
import { mkdir, lstat, readFile, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { sql, type Kysely, type RawBuilder } from 'kysely'
import type { DB } from '../types/db.types.js'
import { AGENTS, runCliAgent } from '@learner/llm/lib/cli/cli-agents.js'
import { canonicalSemanticMessage, semanticHash } from '../lib/learning/learning-semantic-index.js'
import { LearningExposureObservation } from '../lib/learning/learning-exposure-schemas.js'
import { defaultLosslessArchiveInventory } from '../lib/learning/lossless-archive-files.js'
import type { LearningLosslessArchiveSyncService } from './learning-lossless-archive-sync-service.js'
import type { LearningExposureIngestService } from './learning-exposure-ingest-service.js'
import type { LearningSemanticIndexService } from './learning-semantic-index-service.js'

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const bytes = (value: string) => Buffer.byteLength(value, 'utf8')
const bankRoot = 'http://127.0.0.1:18925/v1/default/banks/learning-live-archive-v1'

type FixtureRow = {
  runId: string; workflowRunId: string | null; sessionId: string; markerSha256: string;
  promptSha256: string; replySha256: string | null; promptBytes: number; replyBytes: number | null;
  sourcePath: string; sourceDevice: string | null; sourceInode: string | null; sourceId: string | null;
  archiveRunId: string | null; versionIds: string[]; observationIds: string[]; messageIds: string[];
  chunkIds: string[]; operationIds: string[]; blobSha256: string[]; callAttempts: number; status: string;
  startedAt: Date; cliCompletedAt: Date | null; archivedAt: Date | null; indexedAt: Date | null;
  cleanedAt: Date | null; timings: Record<string, unknown>; cleanupCounts: Record<string, unknown>; error: string | null;
}

export type CliVectorE2EIdentity = { runId: string; sessionId: string; marker: string }

export class LearningCliVectorE2EService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly archive: LearningLosslessArchiveSyncService,
    private readonly exposure: LearningExposureIngestService,
    private readonly index: LearningSemanticIndexService,
    private readonly archiveRoot: string,
  ) {}

  private async row(runId: string): Promise<FixtureRow> {
    const result = await sql<FixtureRow>`SELECT run_id AS "runId",workflow_run_id AS "workflowRunId",session_id AS "sessionId",
      marker_sha256 AS "markerSha256",prompt_sha256 AS "promptSha256",reply_sha256 AS "replySha256",
      prompt_bytes AS "promptBytes",reply_bytes AS "replyBytes",source_path AS "sourcePath",source_device AS "sourceDevice",
      source_inode AS "sourceInode",source_id AS "sourceId",archive_run_id AS "archiveRunId",version_ids AS "versionIds",
      observation_ids AS "observationIds",message_ids AS "messageIds",chunk_ids AS "chunkIds",operation_ids AS "operationIds",
      blob_sha256 AS "blobSha256",call_attempts AS "callAttempts",status,started_at AS "startedAt",
      cli_completed_at AS "cliCompletedAt",archived_at AS "archivedAt",indexed_at AS "indexedAt",cleaned_at AS "cleanedAt",
      timings,cleanup_counts AS "cleanupCounts",error FROM learning_cli_vector_e2e_runs WHERE run_id=${runId}::uuid`.execute(this.db)
    if (!result.rows[0]) throw new Error('CLI vector E2E run not found')
    return result.rows[0]
  }

  private paths(runId: string, sessionId: string) {
    const cwd = join('/var/tmp', `biztools-learning-cli-e2e-${runId}`)
    return { cwd, sourcePath: join(this.archiveRoot, cwd.replaceAll('/', '-'), `${sessionId}.jsonl`) }
  }

  prompt({ runId, marker }: CliVectorE2EIdentity) {
    return `Testing funky bunny pillows. Reply with one short sentence that includes this exact audit marker: ${marker}. Run ${runId}.`
  }

  async prepare(identity: CliVectorE2EIdentity, workflowRunId: string) {
    const { cwd, sourcePath } = this.paths(identity.runId, identity.sessionId)
    const prompt = this.prompt(identity)
    await mkdir(cwd, { recursive: true, mode: 0o700 })
    await sql`INSERT INTO learning_cli_vector_e2e_runs
      (run_id,workflow_run_id,provider,model,session_id,marker_sha256,prompt_sha256,prompt_bytes,source_path,status)
      VALUES(${identity.runId}::uuid,${workflowRunId}::uuid,'claude','haiku',${identity.sessionId}::uuid,
        ${sha256(identity.marker)},${sha256(prompt)},${bytes(prompt)},${sourcePath},'prepared')
      ON CONFLICT(run_id) DO NOTHING`.execute(this.db)
    const row = await this.row(identity.runId)
    if (row.sessionId !== identity.sessionId || row.markerSha256 !== sha256(identity.marker) || row.promptSha256 !== sha256(prompt)) {
      throw new Error('CLI vector E2E identity was reused with different input')
    }
    return this.summary(row)
  }

  async call(identity: CliVectorE2EIdentity) {
    const row = await this.row(identity.runId)
    if (row.cliCompletedAt && row.replySha256) return this.summary(row)
    const reserved = await sql`UPDATE learning_cli_vector_e2e_runs SET call_attempts=1,status='call_started',updated_at=NOW()
      WHERE run_id=${identity.runId}::uuid AND call_attempts=0 AND status='prepared'`.execute(this.db)
    if (Number(reserved.numAffectedRows) !== 1) throw new Error('CLI call is already started or uncertain; automatic replay refuses a second model call')
    const started = performance.now()
    try {
      const { cwd } = this.paths(identity.runId, identity.sessionId)
      const result = await runCliAgent({ agent: AGENTS.CLAUDE, prompt: this.prompt(identity), model: 'haiku', reasoning: 'off',
        sessionId: identity.sessionId, cwd, timeoutSec: 90, chatOnly: true })
      const reply = String(result.stdout).trim()
      const source = await lstat(row.sourcePath)
      if (!source.isFile()) throw new Error('Dedicated CLI session did not create a regular transcript file')
      await sql`UPDATE learning_cli_vector_e2e_runs SET source_device=${String(source.dev)},source_inode=${String(source.ino)},updated_at=NOW()
        WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      if (!reply.includes(identity.marker)) throw new Error('CLI reply did not preserve the exact audit marker')
      await sql`UPDATE learning_cli_vector_e2e_runs SET reply_sha256=${sha256(reply)},reply_bytes=${bytes(reply)},cli_completed_at=NOW(),
        timings=jsonb_set(timings,'{cliMs}',to_jsonb(${Math.round(performance.now() - started)}::int),true),updated_at=NOW()
        WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      return this.summary(await this.row(identity.runId))
    } catch (error) {
      await this.failAndClean(identity.runId, error)
      throw error
    }
  }

  async capture(identity: CliVectorE2EIdentity) {
    const row = await this.row(identity.runId)
    if (['captured', 'indexed', 'verified', 'cleaned'].includes(row.status)) return this.summary(row)
    if (!row.cliCompletedAt || !row.replySha256) throw new Error('CLI transcript is not complete')
    const archiveRunId = row.archiveRunId ?? randomUUID()
    const started = performance.now()
    try {
      await sql`UPDATE learning_cli_vector_e2e_runs SET archive_run_id=${archiveRunId}::uuid,updated_at=NOW()
        WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      const inventory = defaultLosslessArchiveInventory()
      const root = inventory.roots.find(item => item.id === 'claude-projects' && item.provider === 'claude')
      if (!root || !row.sourcePath.startsWith(`${this.archiveRoot}/`)) throw new Error('Dedicated CLI transcript is outside the configured archive root')
      root.path = this.archiveRoot
      root.include = [{ relativePath: row.sourcePath.slice(this.archiveRoot.length + 1), optional: false }]
      inventory.roots = [root]
      await this.archive.discover(archiveRunId, 'backfill', [], inventory)
      const registered = await sql<{ sourceId: string }>`SELECT source_id AS "sourceId" FROM learning_archive_sources
        WHERE host=${hostname()} AND provider='claude' AND root_path=${this.archiveRoot}
          AND relative_path=${row.sourcePath.slice(this.archiveRoot.length + 1)} AND discovery_state<>'out_of_scope'`.execute(this.db)
      if (registered.rows.length !== 1) throw new Error('Expected one dedicated registered CLI E2E source')
      const source = { sourceId: registered.rows[0]!.sourceId }
      await sql`UPDATE learning_cli_vector_e2e_runs SET source_id=${source.sourceId}::uuid,updated_at=NOW()
        WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      await this.archive.captureBatch(archiveRunId)
      const versions = await sql<{ versionId: string }>`SELECT version_id AS "versionId" FROM learning_archive_versions
        WHERE source_id=${source.sourceId}::uuid ORDER BY version_number`.execute(this.db)
      const versionIds = versions.rows.map(item => item.versionId)
      const blobs = await sql<{ sha: string }>`SELECT DISTINCT encode(c.blob_sha256,'hex') AS sha FROM learning_archive_version_chunks c
        WHERE c.version_id=ANY(${versionIds}::uuid[])`.execute(this.db)
      await sql`UPDATE learning_cli_vector_e2e_runs SET version_ids=${versionIds}::uuid[],
        blob_sha256=${blobs.rows.map(item => item.sha)}::text[],updated_at=NOW()
        WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      await this.archive.verifyBatch(archiveRunId)
      const archiveReceipt = await this.archive.finish(archiveRunId)
      if (archiveReceipt.status !== 'completed' || archiveReceipt.totals.errors || archiveReceipt.totals.gaps) throw new Error('Dedicated transcript archive was not complete and gap-free')
      const projection = await this.exposure.projectActiveSource(source.sourceId)
      if (projection.pending || projection.gaps) throw new Error('Dedicated transcript exposure projection did not settle cleanly')
      const observations = await sql<{ observationId: string; rawVersionId: string; payload: unknown }>`SELECT observation_id AS "observationId",
        raw_version_id AS "rawVersionId",payload
        FROM learning_exposure_observations WHERE raw_version_id=ANY(${versionIds}::uuid[]) ORDER BY observed_at,observation_id`.execute(this.db)
      const messages = observations.rows.flatMap(item => {
        const observation = LearningExposureObservation.parse(item.payload)
        if (!['user_to_model', 'model_to_user'].includes(observation.direction)) return []
        return [{ observationId: item.observationId, observation, message: canonicalSemanticMessage(observation, item.rawVersionId) }]
      })
      await sql`UPDATE learning_cli_vector_e2e_runs SET observation_ids=${messages.map(item => item.observationId)}::uuid[],
        message_ids=${messages.map(item => item.message.messageId)}::text[],updated_at=NOW()
        WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      const user = messages.find(item => item.message.role === 'user')
      const assistant = messages.find(item => item.message.role === 'assistant')
      if (!user || !assistant || sha256(user.message.text) !== row.promptSha256 || sha256(assistant.message.text.trim()) !== row.replySha256) {
        throw new Error('Projected CLI user/assistant text, role, or source linkage differs from the genuine transcript')
      }
      if (user.message.conversationId !== identity.sessionId || assistant.message.conversationId !== identity.sessionId) throw new Error('Projected messages lost dedicated CLI session identity')
      await sql`UPDATE learning_cli_vector_e2e_runs SET status='captured',archived_at=NOW(),
        timings=jsonb_set(timings,'{archiveMs}',to_jsonb(${Math.round(performance.now() - started)}::int),true),updated_at=NOW()
        WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      return this.summary(await this.row(identity.runId))
    } catch (error) {
      await this.failAndClean(identity.runId, error)
      throw error
    }
  }

  async waitIndexed(identity: CliVectorE2EIdentity) {
    const started = performance.now()
    try {
      for (let attempt = 0; attempt < 180; attempt++) {
        const row = await this.row(identity.runId)
        const indexed = await sql<{ messageId: string; chunkId: string; operationId: string }>`SELECT m.message_id AS "messageId",c.chunk_id AS "chunkId",c.operation_id AS "operationId"
          FROM learning_semantic_index_messages m JOIN learning_semantic_index_chunks c USING(message_id)
          WHERE m.observation_id=ANY(${row.observationIds}::uuid[]) AND m.status='indexed' AND c.status='indexed'`.execute(this.db)
        if (indexed.rows.length >= 2 && new Set(indexed.rows.map(item => item.messageId)).size >= 2) {
          await sql`UPDATE learning_cli_vector_e2e_runs SET chunk_ids=${indexed.rows.map(item => item.chunkId)}::text[],
            operation_ids=${[...new Set(indexed.rows.map(item => item.operationId))]}::uuid[],status='indexed',indexed_at=NOW(),
            timings=jsonb_set(timings,'{indexMs}',to_jsonb(${Math.round(performance.now() - started)}::int),true),updated_at=NOW()
            WHERE run_id=${identity.runId}::uuid`.execute(this.db)
          return this.summary(await this.row(identity.runId))
        }
        await Bun.sleep(1000)
      }
      throw new Error('Dedicated CLI messages did not reach Hindsight within 180 seconds')
    } catch (error) {
      await this.failAndClean(identity.runId, error)
      throw error
    }
  }

  async verify(identity: CliVectorE2EIdentity) {
    const row = await this.row(identity.runId)
    try {
      const hits = await this.index.search({ query: identity.marker, limit: 12, conversationId: identity.sessionId, timeoutMs: 30000 })
      const hit = hits.find(item => row.chunkIds.includes(item.chunkId) && item.snippet.includes(identity.marker))
      if (!hit) throw new Error('Hindsight recall did not return the dedicated marker from the dedicated conversation')
      const hydrated = await this.index.hydrate({ chunkId: hit.chunkId })
      if (hydrated.observationId !== hit.observationId || hydrated.rawVersionId !== hit.rawVersionId
        || hydrated.role !== hit.role || hydrated.chunkText !== hit.snippet
        || hydrated.text.slice(hydrated.startOffset, hydrated.endOffset) !== hit.snippet) {
        throw new Error('Retrieved Hindsight chunk did not hydrate to exact PostgreSQL source identity and offsets')
      }
      const allHydrated = await Promise.all(row.chunkIds.map(chunkId => this.index.hydrate({ chunkId })))
      if (allHydrated.some(item => !row.observationIds.includes(item.observationId)
        || !row.versionIds.includes(item.rawVersionId) || !row.messageIds.includes(item.messageId)
        || item.conversationId !== identity.sessionId || !['user', 'assistant'].includes(item.role))) {
        throw new Error('Indexed fixture chunks lost exact observation, version, message, role, or session linkage')
      }
      const roles = new Set(allHydrated.map(item => item.role))
      if (!roles.has('user') || !roles.has('assistant')) throw new Error('Both genuine CLI roles must be represented in Hindsight')
      const remote = await fetch(`${bankRoot}/documents/${encodeURIComponent(hit.chunkId)}`, { signal: AbortSignal.timeout(15000) })
      if (!remote.ok) throw new Error(`Hindsight document verification HTTP ${remote.status}`)
      const document = await remote.json() as { original_text?: string }
      if (document.original_text !== hit.snippet || semanticHash(document.original_text) !== semanticHash(hit.snippet)) throw new Error('Hindsight stored bytes differ from the certified source chunk')
      await sql`UPDATE learning_cli_vector_e2e_runs SET status='verified',updated_at=NOW() WHERE run_id=${identity.runId}::uuid`.execute(this.db)
      return this.summary(await this.row(identity.runId))
    } catch (error) {
      await this.failAndClean(identity.runId, error)
      throw error
    }
  }

  async cleanup(runId: string) {
    const row = await this.row(runId)
    if (row.cleanedAt) return this.summary(row)
    const counts: Record<string, number> = {}
    const source = await lstat(row.sourcePath).catch(() => null)
    if (source) {
      const sourceIdentityMatches = row.sourceDevice !== null && row.sourceInode !== null
        ? String(source.dev) === row.sourceDevice && String(source.ino) === row.sourceInode
        : (await readFile(row.sourcePath, 'utf8')).includes(row.sessionId)
      if (!source.isFile() || !sourceIdentityMatches || row.sourcePath !== this.paths(runId, row.sessionId).sourcePath) {
        throw new Error('Cleanup refused a source file whose dedicated ownership changed')
      }
      await rm(row.sourcePath)
      counts.sourceFiles = 1
    } else counts.sourceFiles = 0
    await rm(join('/var/tmp', `biztools-learning-cli-e2e-${runId}`), { recursive: true, force: true })

    // The canonical index start fence closes the freeze/enumeration race: no
    // new index run can snapshot this source between the final read and delete.
    let deleted = false
    for (let attempt = 0; attempt < 120; attempt++) {
      deleted = await this.index.withStartLock(async () => {
        const state = await sql<{ archiveBusy: boolean; exposureBusy: boolean; indexBusy: boolean }>`SELECT
          EXISTS(SELECT 1 FROM learning_archive_sources WHERE source_id=${row.sourceId}::uuid
            AND lease_token IS NOT NULL AND lease_expires_at>NOW()) AS "archiveBusy",
          EXISTS(SELECT 1 FROM learning_exposure_work WHERE work_key=${`cli-source:${row.sourceId}`}
            AND token IS NOT NULL AND token<>${runId}::uuid AND lease_until>NOW()) AS "exposureBusy",
          EXISTS(SELECT 1 FROM learner_workflow_runs WHERE workflow='learningSemanticIndexWorkflow'
            AND status NOT IN ('completed','failed','cancelled','canceled')) AS "indexBusy"`.execute(this.db)
        const current = state.rows[0]!
        if (current.archiveBusy || current.exposureBusy || current.indexBusy) return false
        if (row.sourceId) {
          const claimed = await sql`INSERT INTO learning_exposure_work(work_key,token,lease_until,updated_at)
            VALUES(${`cli-source:${row.sourceId}`},${runId}::uuid,NOW()+INTERVAL '5 minutes',NOW())
            ON CONFLICT(work_key) DO UPDATE SET token=EXCLUDED.token,lease_until=EXCLUDED.lease_until,updated_at=NOW()
            WHERE learning_exposure_work.token=${runId}::uuid OR learning_exposure_work.lease_until IS NULL
              OR learning_exposure_work.lease_until<=NOW() RETURNING work_key`.execute(this.db)
          if (claimed.rows.length !== 1) return false
        }

        // A crash can happen after a child row is created but before its ID is
        // copied into the receipt. Enumerate again while the start fence is held.
        if (row.sourceId) {
          const owned = await sql<{ versionId: string; observationId: string | null; messageId: string | null;
            chunkId: string | null; operationId: string | null; blobSha256: string | null }>`
            SELECT version.version_id AS "versionId",observation.observation_id AS "observationId",
              message.message_id AS "messageId",chunk.chunk_id AS "chunkId",chunk.operation_id AS "operationId",
              encode(version_chunk.blob_sha256,'hex') AS "blobSha256"
            FROM learning_archive_versions version
            LEFT JOIN learning_archive_version_chunks version_chunk USING(version_id)
            LEFT JOIN learning_exposure_observations observation ON observation.raw_version_id=version.version_id
            LEFT JOIN learning_semantic_index_messages message ON message.observation_id=observation.observation_id
            LEFT JOIN learning_semantic_index_chunks chunk USING(message_id)
            WHERE version.source_id=${row.sourceId}::uuid`.execute(this.db)
          const unique = (items: Array<string | null>) => [...new Set(items.filter((item): item is string => Boolean(item)))]
          row.versionIds = unique([...row.versionIds, ...owned.rows.map(item => item.versionId)])
          row.observationIds = unique([...row.observationIds, ...owned.rows.map(item => item.observationId)])
          row.messageIds = unique([...row.messageIds, ...owned.rows.map(item => item.messageId)])
          row.chunkIds = unique([...row.chunkIds, ...owned.rows.map(item => item.chunkId)])
          row.operationIds = unique([...row.operationIds, ...owned.rows.map(item => item.operationId)])
          row.blobSha256 = unique([...row.blobSha256, ...owned.rows.map(item => item.blobSha256)])
          await sql`UPDATE learning_cli_vector_e2e_runs SET version_ids=${row.versionIds}::uuid[],
            observation_ids=${row.observationIds}::uuid[],message_ids=${row.messageIds}::text[],chunk_ids=${row.chunkIds}::text[],
            operation_ids=${row.operationIds}::uuid[],blob_sha256=${row.blobSha256}::text[],updated_at=NOW()
            WHERE run_id=${runId}::uuid`.execute(this.db)
        }
        const unsettled = await sql`SELECT 1 FROM learning_semantic_index_operations
          WHERE operation_id=ANY(${row.operationIds}::uuid[]) AND status IN ('pending','submitted') LIMIT 1`.execute(this.db)
        if (unsettled.rows.length) return false

        for (const chunkId of row.chunkIds) {
          const response = await fetch(`${bankRoot}/documents/${encodeURIComponent(chunkId)}`, { method: 'DELETE', signal: AbortSignal.timeout(30000) })
          if (!response.ok && response.status !== 404) throw new Error(`Hindsight exact document cleanup HTTP ${response.status}`)
          counts.hindsightDocuments = (counts.hindsightDocuments ?? 0) + (response.status === 404 ? 0 : 1)
        }
        await this.db.transaction().execute(async trx => {
          const affected = async (query: RawBuilder<unknown>) => Number((await query.execute(trx)).numAffectedRows ?? 0)
          counts.indexMembers = await affected(sql`DELETE FROM learning_semantic_index_members WHERE message_id=ANY(${row.messageIds}::text[])`)
          counts.indexChunks = await affected(sql`DELETE FROM learning_semantic_index_chunks WHERE chunk_id=ANY(${row.chunkIds}::text[])`)
          counts.indexMessages = await affected(sql`DELETE FROM learning_semantic_index_messages WHERE message_id=ANY(${row.messageIds}::text[])`)
          counts.indexOperations = await affected(sql`DELETE FROM learning_semantic_index_operations operation WHERE operation_id=ANY(${row.operationIds}::uuid[])
            AND NOT EXISTS(SELECT 1 FROM learning_semantic_index_chunks chunk WHERE chunk.operation_id=operation.operation_id)`)
          counts.exposureObservations = await affected(sql`DELETE FROM learning_exposure_observations WHERE observation_id=ANY(${row.observationIds}::uuid[])`)
          counts.exposureImports = await affected(sql`DELETE FROM learning_exposure_imports WHERE raw_version_id=ANY(${row.versionIds}::uuid[])`)
          if (row.sourceId) {
            counts.exposureCursors = await affected(sql`DELETE FROM learning_exposure_projection_cursors WHERE source_id=${row.sourceId}::uuid`)
            counts.exposureWork = await affected(sql`DELETE FROM learning_exposure_work
              WHERE work_key=${`cli-source:${row.sourceId}`} AND token=${runId}::uuid`)
            counts.archiveErrors = await affected(sql`DELETE FROM learning_archive_errors WHERE source_id=${row.sourceId}::uuid OR run_id=${row.archiveRunId}::uuid`)
            counts.archiveCheckpoints = await affected(sql`DELETE FROM learning_archive_checkpoints WHERE source_id=${row.sourceId}::uuid`)
            counts.archiveChunks = await affected(sql`DELETE FROM learning_archive_version_chunks WHERE version_id=ANY(${row.versionIds}::uuid[])`)
            counts.archiveVersions = await affected(sql`DELETE FROM learning_archive_versions WHERE version_id=ANY(${row.versionIds}::uuid[])`)
            counts.archiveSources = await affected(sql`DELETE FROM learning_archive_sources WHERE source_id=${row.sourceId}::uuid`)
          }
          if (row.archiveRunId) counts.archiveRuns = await affected(sql`DELETE FROM learning_archive_runs WHERE run_id=${row.archiveRunId}::uuid`)
          counts.archiveBlobs = await affected(sql`DELETE FROM learning_archive_blobs blob WHERE encode(blob.sha256,'hex')=ANY(${row.blobSha256}::text[])
            AND NOT EXISTS(SELECT 1 FROM learning_archive_version_chunks chunk WHERE chunk.blob_sha256=blob.sha256)`)
          await sql`UPDATE learning_cli_vector_e2e_runs SET status='cleanup_pending',cleanup_counts=${JSON.stringify(counts)}::jsonb,updated_at=NOW()
            WHERE run_id=${runId}::uuid`.execute(trx)
        })
        return true
      })
      if (deleted) break
      await Bun.sleep(500)
    }
    if (!deleted) throw new Error('Cleanup refused while archive, exposure, or canonical index work remained active')
    return this.summary(await this.row(runId))
  }

  async proveClean(runId: string) {
    const row = await this.row(runId)
    const residual = await sql<Record<string, string>>`SELECT
      (SELECT count(*) FROM learning_archive_sources WHERE source_id=${row.sourceId}::uuid) AS sources,
      (SELECT count(*) FROM learning_archive_versions WHERE version_id=ANY(${row.versionIds}::uuid[])) AS versions,
      (SELECT count(*) FROM learning_archive_version_chunks WHERE version_id=ANY(${row.versionIds}::uuid[])) AS "archiveChunks",
      (SELECT count(*) FROM learning_archive_checkpoints WHERE source_id=${row.sourceId}::uuid) AS checkpoints,
      (SELECT count(*) FROM learning_archive_errors WHERE source_id=${row.sourceId}::uuid OR run_id=${row.archiveRunId}::uuid) AS "archiveErrors",
      (SELECT count(*) FROM learning_archive_runs WHERE run_id=${row.archiveRunId}::uuid) AS "archiveRuns",
      (SELECT count(*) FROM learning_exposure_observations WHERE observation_id=ANY(${row.observationIds}::uuid[])) AS observations,
      (SELECT count(*) FROM learning_exposure_imports WHERE raw_version_id=ANY(${row.versionIds}::uuid[])) AS imports,
      (SELECT count(*) FROM learning_exposure_projection_cursors WHERE source_id=${row.sourceId}::uuid) AS cursors,
      (SELECT count(*) FROM learning_exposure_work WHERE work_key=${`cli-source:${row.sourceId}`}) AS "exposureWork",
      (SELECT count(*) FROM learning_semantic_index_members WHERE message_id=ANY(${row.messageIds}::text[])) AS members,
      (SELECT count(*) FROM learning_semantic_index_messages WHERE message_id=ANY(${row.messageIds}::text[])) AS messages,
      (SELECT count(*) FROM learning_semantic_index_chunks WHERE chunk_id=ANY(${row.chunkIds}::text[])) AS chunks`.execute(this.db)
    const proof = residual.rows[0]!
    if (Object.values(proof).some(value => Number(value) !== 0)) throw new Error(`Fixture PostgreSQL cleanup incomplete: ${JSON.stringify(proof)}`)
    for (const chunkId of row.chunkIds) {
      const response = await fetch(`${bankRoot}/documents/${encodeURIComponent(chunkId)}`, { signal: AbortSignal.timeout(15000) })
      if (response.status !== 404) throw new Error(`Fixture Hindsight document still resolves: ${chunkId}`)
    }
    if (await lstat(row.sourcePath).catch(() => null)) throw new Error('Fixture source file still exists and could be reingested')
    if (await lstat(this.paths(runId, row.sessionId).cwd).catch(() => null)) throw new Error('Fixture CLI working directory still exists')
    await sql`UPDATE learning_cli_vector_e2e_runs SET status=CASE WHEN error IS NULL THEN 'cleaned' ELSE 'failed' END,
      cleaned_at=NOW(),updated_at=NOW() WHERE run_id=${runId}::uuid`.execute(this.db)
    return this.summary(await this.row(runId))
  }

  async fail(runId: string, error: unknown) {
    await sql`UPDATE learning_cli_vector_e2e_runs SET status='failed',error=${String(error).slice(0, 1000)},updated_at=NOW()
      WHERE run_id=${runId}::uuid AND status<>'cleaned'`.execute(this.db)
  }

  async failAndClean(runId: string, error: unknown) {
    await this.fail(runId, error)
    await this.cleanup(runId)
    return this.proveClean(runId)
  }

  summary(row: FixtureRow) {
    return {
      runId: row.runId, workflowRunId: row.workflowRunId, provider: 'claude' as const, model: 'haiku' as const, sessionId: row.sessionId,
      markerSha256: row.markerSha256, promptSha256: row.promptSha256, replySha256: row.replySha256,
      promptBytes: row.promptBytes, replyBytes: row.replyBytes, sourcePath: row.sourcePath, sourceId: row.sourceId,
      archiveRunId: row.archiveRunId, versionIds: row.versionIds, observationIds: row.observationIds,
      messageIds: row.messageIds, chunkIds: row.chunkIds, operationIds: row.operationIds, callAttempts: row.callAttempts,
      masteryExcluded: true as const, status: row.status, startedAt: row.startedAt.toISOString(),
      cliCompletedAt: row.cliCompletedAt?.toISOString() ?? null, archivedAt: row.archivedAt?.toISOString() ?? null,
      indexedAt: row.indexedAt?.toISOString() ?? null, cleanedAt: row.cleanedAt?.toISOString() ?? null,
      timings: row.timings, cleanupCounts: row.cleanupCounts, error: row.error,
    }
  }

  async inspect(runId: string) { return this.summary(await this.row(runId)) }
  async inspectOrNull(runId: string) {
    try { return await this.inspect(runId) } catch (error) {
      if (error instanceof Error && error.message === 'CLI vector E2E run not found') return null
      throw error
    }
  }
}
