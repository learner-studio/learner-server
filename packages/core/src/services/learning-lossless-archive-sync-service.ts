import { createHash } from 'node:crypto'
import { mkdir, readdir, stat, statfs } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { sql, type Kysely } from 'kysely'
import { z } from 'zod'
import type { DB } from '../types/db.types.js'
import {
  captureOpaqueFile, captureOpaqueRange, createStagedSqliteSnapshot, inventoryApprovedRoots,
  removeStagedSqliteSnapshot, restoreCapturedChunks, verifyOpaquePrefix,
  type ArchiveFileIdentity, type InventoryEntry, type LosslessArchiveInventoryConfig, type LosslessArchiveProvider,
} from '../lib/learning/lossless-archive-files.js'
import { scanLosslessArchiveReferences } from '../lib/learning/lossless-archive-references.js'
import { LosslessArchiveBatchResult, LosslessArchiveStatusOutput } from '../lib/learning/lossless-archive-schemas.js'
import { LearningLosslessArchiveService, type ArchiveClaim } from './learning-lossless-archive-service.js'

const LIMITATIONS = [
  'Polling cannot recover transient versions or files deleted before discovery, or provider stream events never persisted.',
  'SQLite restores are logical consistent snapshots. Independently captured physical sidecars are not an atomic multi-file restore point.',
  'Historical prefixes are rehashed on every selected source visit; mutation detection is bounded by fair backlog traversal, not the one-minute trigger.',
  'Only known structured Codex and Claude attachment fields are metadata-scanned; unknown formats remain a gap and remote content is never fetched.',
  'Original files and frozen datasets are retained. Hindsight remains a separate downstream projection during verification.',
  'Off-machine backup coverage is not established by database persistence. Consult the restore rehearsal report.',
]
const PlannedSource = z.object({
  sourceId: z.string(), approvedRoot: z.string(), absolutePath: z.string(), provider: z.string(),
  rootId: z.string(), fileKind: z.string(), byteLength: z.number(), deviceId: z.string(), inodeId: z.string(),
  mode: z.number(), mtimeNs: z.string(), ctimeNs: z.string(),
})
const SourceResult = z.object({
  sourceId: z.string(), provider: z.string(), versionId: z.string().nullable(),
  bytesRead: z.number(), bytesWritten: z.number(), rawBytes: z.number(), encodedBytes: z.number(),
  errorCode: z.string().nullable(), verified: z.boolean(), idempotent: z.boolean().default(false),
  pending: z.boolean().default(false), referenceGaps: z.number().nonnegative().optional(),
})
const InventoryGapRecord = z.object({
  provider: z.string(), rootId: z.string(), code: z.string(), relativePathDigest: z.string(),
})
const RunMetadata = z.object({
  planned: z.array(PlannedSource), discovered: z.number(), inventoryGaps: z.number(),
  providers: z.record(z.string(), z.number()), results: z.array(SourceResult).default([]), attempts: z.number().default(0),
  inventoryGapDetails: z.array(InventoryGapRecord).default([]),
})
const ReferenceScanCursor = z.object({
  generation: z.number().int().nonnegative(), cursor: z.number().int().nonnegative(),
  discardingOversizeRecord: z.boolean().default(false),
})
const ARCHIVE_LEASE_MS = 120_000

const captureFailure = (error: unknown): { code: string; message: string; isGap: boolean } => {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'disk-pressure') return { code: 'disk-pressure', message: 'Capture paused because local free space is below the configured floor', isGap: true }
  if (message === 'source-leased') return { code: 'source-leased', message: 'Capture deferred because another worker holds the source lease', isGap: false }
  if (message === 'source-unavailable') return { code: 'source-unavailable', message: 'The discovered source is no longer registered', isGap: true }
  if (message === 'sqlite-snapshot-exceeds-source-budget') return {
    code: 'sqlite-snapshot-exceeds-source-budget',
    message: 'Logical SQLite snapshot exceeds the bounded per-source capture budget; no partial logical snapshot was sealed',
    isGap: true,
  }
  if (/outside approved root|symlink|regular file/i.test(message)) return { code: 'source-boundary-refused', message: 'Capture refused a source outside the approved regular-file boundary', isGap: true }
  if (/changed|mismatch|truncat|identity|stable/i.test(message)) return { code: 'source-mutated-during-capture', message: 'Source mutation prevented a consistent capture; the prior archived version remains intact', isGap: true }
  if (/EACCES|EPERM|permission/i.test(message)) return { code: 'source-unreadable', message: 'Source could not be read with current filesystem permissions', isGap: true }
  return { code: 'capture-failed', message: 'Capture failed; original bytes and prior archived versions remain intact', isGap: true }
}

const provesNewGeneration = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /previously captured prefix digest no longer matches|verified prefix exceeds observed source size|source prefix changed during verification|source identity changed during prefix verification|source changed without an append during prefix verification/.test(message)
}

/**
 * The roots whose `match` narrows what may be archived, paired with the pattern
 * the sweep enforces. PostgreSQL's regex shares JS's `\d`/`\w` shorthands, so
 * the SAME string filters the walk and retires rows an earlier, unfiltered
 * sweep already discovered -- there is no second pattern to drift.
 */
/**
 * Where whole SQLite files are staged before capture. This is DISK, never
 * `os.tmpdir()`: on the dev box /tmp is a RAM-backed tmpfs, and a staged copy
 * (707 MB for one history file on 2026-09-21) stays resident across passes
 * until the capture seals, so a tmpdir default held ~1 GB of RAM per pass and
 * then failed `disk-pressure` once /tmp was sized honestly. `/var/tmp` matches
 * the lane-journal roots and survives a reboot. A configured root always wins
 * (tests stage kilobytes under a tmpdir fixture).
 */
export const DEFAULT_SQLITE_STAGING_ROOT = '/var/tmp/learner-lossless-sqlite'
export const resolveSqliteStagingRoot = (configured?: string): string => configured ?? DEFAULT_SQLITE_STAGING_ROOT

export const losslessMatchExclusions = (
  inventory: LosslessArchiveInventoryConfig,
): Array<{ rootId: string; pattern: string }> =>
  inventory.roots.flatMap((root) => (root.match ? [{ rootId: root.id, pattern: root.match }] : []))

type PlanCandidate = { sourceId: string; rootId: string; absolutePath: string }

const isPreferred = (plan: PlanCandidate, prefer: readonly string[]): boolean =>
  prefer.some((token) => token === plan.rootId || plan.absolutePath.startsWith(token))

/**
 * Round-robin across providers, exactly as the unpreferred sweep always has,
 * but drained in two passes: everything matching `prefer` (a root id, or an
 * absolute path prefix) first, then the rest in `ordered`'s normal
 * last-success-first sequence. `maxSources` still caps the whole plan, so a
 * preference reprioritises a bounded run rather than enlarging it.
 */
export const planLosslessArchiveSources = <T extends PlanCandidate>(
  ordered: ReadonlyArray<{ sourceId: string; provider: string }>,
  byId: ReadonlyMap<string, T>,
  maxSources: number,
  prefer: readonly string[] = [],
): T[] => {
  const preferred = new Map<string, T[]>()
  const remaining = new Map<string, T[]>()
  for (const row of ordered) {
    const plan = byId.get(row.sourceId)
    if (!plan) continue
    const queues = prefer.length && isPreferred(plan, prefer) ? preferred : remaining
    const queue = queues.get(row.provider) ?? []
    queue.push(plan)
    queues.set(row.provider, queue)
  }
  const planned: T[] = []
  for (const queues of [preferred, remaining]) {
    while (planned.length < maxSources && [...queues.values()].some((items) => items.length)) {
      for (const items of queues.values()) {
        const plan = items.shift()
        if (plan && planned.length < maxSources) planned.push(plan)
      }
    }
  }
  return planned
}

export class LearningLosslessArchiveSyncService {
  readonly implementationVersion = 3
  constructor(
    private readonly kysely: Kysely<DB>,
    private readonly archive: LearningLosslessArchiveService,
    private readonly config: { enabled: boolean; scheduleEnabled: boolean; inventory: LosslessArchiveInventoryConfig; maxSources?: number; maxBytesPerSource?: number; sqliteMaxBytesPerPass?: number; sqliteStagingRoot?: string },
  ) {}

  // A `prefer` request that arrives while a sweep is already in flight is held
  // here and merged into the NEXT discover instead of being dropped. It is
  // deliberately process-local: the run record belongs to the in-flight run, so
  // persisting there would attach the preference to the wrong plan, and a
  // restart losing a reprioritisation hint costs only ordering, never bytes.
  private pendingPrefer = new Set<string>()

  enqueuePrefer(prefer: readonly string[] = []): void {
    for (const token of prefer) this.pendingPrefer.add(token)
  }

  get scheduleEnabled() { return this.config.enabled && this.config.scheduleEnabled }
  assertEnabled() { if (!this.config.enabled) throw new Error('Lossless archive capture is disabled on this host') }

  private async reconcileTerminalWorkflowRuns(): Promise<void> {
    await this.kysely.transaction().execute(async (trx) => {
      await sql`UPDATE learning_archive_runs archive
        SET status='failed', completed_at=NOW(), updated_at=NOW(),
            summary='Workflow failed before publication; committed bytes retained'
        FROM public.learner_workflow_runs workflow
        WHERE archive.status='running' AND archive.run_id::text=workflow.workflow_run_id::text
          AND workflow.status IN ('failed','cancelled')`.execute(trx)
      // Claims are owned by the durable workflow run ID. Only a terminal
      // workflow can have its claim revoked early; unrelated/active owners keep
      // their lease until normal release or expiry. Incrementing the fence makes
      // any late write from the old worker fail even if it retained its token.
      await sql`UPDATE learning_archive_sources source
        SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
            fencing_token=fencing_token + 1,
            discovery_state=CASE WHEN discovery_state='capturing' THEN 'discovered' ELSE discovery_state END,
            updated_at=NOW()
        FROM public.learner_workflow_runs workflow
        WHERE source.lease_token IS NOT NULL
          AND source.lease_owner::text=workflow.workflow_run_id::text
          AND workflow.status IN ('failed','cancelled','completed')`.execute(trx)
    })
  }

  private async activeSources(sessionId: string) {
    return (await sql<{sourceId:string;rootId:string;relativePath:string}>`SELECT source_id AS "sourceId",
      metadata->>'rootId' AS "rootId",relative_path AS "relativePath" FROM learning_archive_sources
      WHERE host=${hostname()} AND provider='claude' AND file_kind='jsonl'
        AND relative_path LIKE ${`%/${sessionId}.jsonl`} AND discovery_state<>'out_of_scope'`.execute(this.kysely)).rows
  }

  /** The hook can outrun the minute sweep that catalogues a new transcript. Look for it once, one project
   * directory deep, under the approved Claude roots only; discover() still applies each root's match/exclusions. */
  private async uncataloguedActiveSource(sessionId: string) {
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) return []
    const found:{rootId:string;relativePath:string}[]=[]
    for(const root of this.config.inventory.roots.filter(root=>root.provider==='claude')) {
      const dirs=await readdir(root.path,{withFileTypes:true}).catch(()=>[])
      for(const dir of dirs) {
        if(!dir.isDirectory()) continue
        const relativePath=`${dir.name}/${sessionId}.jsonl`
        if(await stat(join(root.path,relativePath)).then(info=>info.isFile(),()=>false)) found.push({rootId:root.id,relativePath})
      }
    }
    return found
  }

  async discoverActive(runId: string, sessionId: string) {
    // Session ID is validated at the API. Paths come only from our approved catalogue or approved roots.
    const sources:{sourceId?:string;rootId:string;relativePath:string}[]=await this.activeSources(sessionId)
    if(sources.length===0) sources.push(...await this.uncataloguedActiveSource(sessionId))
    if(sources.length!==1) throw new Error('Expected one approved Claude transcript for session')
    const source=sources[0]!
    const root=this.config.inventory.roots.find(root=>root.id===source.rootId && root.provider==='claude')
    if(!root || source.relativePath.split('/').includes('..')) throw new Error('Approved transcript root unavailable')
    const inventory={...this.config.inventory,roots:[{...root,include:[{relativePath:source.relativePath,optional:false}]}]}
    await this.discover(runId,'periodic',[],inventory)
    const sourceId=source.sourceId ?? (await this.activeSources(sessionId))[0]?.sourceId
    if(!sourceId) throw new Error('Expected one approved Claude transcript for session')
    return {runId,sourceId}
  }

  async captureActive(runId: string) {
    await this.captureBatch(runId)
    const run=await this.archive.getRun(runId)
    const metadata=RunMetadata.parse(run?.metadata)
    if(metadata.planned.length!==1 || metadata.results.length!==1 || metadata.results.some(item=>item.pending || item.errorCode)) {
      throw new Error('Active transcript capture pending; retry from durable checkpoint')
    }
  }

  async discover(runId: string, mode: 'periodic' | 'backfill', prefer: readonly string[] = [], targetedInventory?: LosslessArchiveInventoryConfig) {
    this.assertEnabled()
    await this.reconcileTerminalWorkflowRuns()
    const existing = await this.archive.getRun(runId)
    if (existing && RunMetadata.safeParse(existing.metadata).success) {
      const metadata = RunMetadata.parse(existing.metadata)
      await this.persistInventoryGaps(runId, metadata.inventoryGapDetails)
      return { runId, sourcesDiscovered: metadata.discovered }
    }
    // Consumed only once this run really plans, so the early return above
    // cannot swallow a queued preference.
    const effectivePrefer = [...new Set([...(targetedInventory ? [] : this.pendingPrefer), ...prefer])]
    if(!targetedInventory) this.pendingPrefer.clear()
    const inventory = await inventoryApprovedRoots(targetedInventory ?? this.config.inventory)
    const providers: Record<string, number> = {}
    const byId = new Map<string, z.infer<typeof PlannedSource>>()
    for (const entry of inventory.entries) {
      providers[entry.provider] = (providers[entry.provider] ?? 0) + 1
      const root = this.config.inventory.roots.find((item) => item.id === entry.rootId)!
      const rootIsFile = entry.relativePath === '.'
      const storageRoot = rootIsFile ? dirname(root.path) : root.path
      const storageRelativePath = rootIsFile ? basename(root.path) : entry.relativePath
      const source = await this.archive.registerSource({
        host: hostname(), provider: entry.provider, rootPath: storageRoot,
        relativePath: storageRelativePath, fileKind: entry.fileKind === 'jsonl' || entry.fileKind === 'sqlite' ? entry.fileKind : 'sidecar',
        deviceId: entry.deviceId, inodeId: entry.inodeId, sourceSize: entry.byteLength,
        sourceMtimeNs: entry.mtimeNs, sourceCtimeNs: entry.ctimeNs, observedAt: inventory.observedAt,
        metadata: { rootId: root.id, linkTarget: entry.linkTarget ?? null, linkBoundary: entry.linkBoundary ?? null, relatedConversationId: entry.relatedConversationId ?? null },
      })
      if (entry.fileKind === 'symlink') {
        await sql`UPDATE learning_archive_sources SET discovery_state = 'out_of_scope', last_error_code = 'symlink-metadata-only' WHERE source_id = ${source.sourceId}::uuid`.execute(this.kysely)
      } else byId.set(source.sourceId, this.planEntry(source.sourceId, root.path, entry))
    }
    // Only a complete inventory may mark unrelated catalogue entries missing.
    if(!targetedInventory) {
    // A vanished known source remains in the catalogue with an explicit gap.
    await sql`UPDATE learning_archive_sources SET discovery_state = 'missing', last_error_code = 'missing-after-discovery'
      WHERE host = ${hostname()} AND metadata ? 'rootId'
        AND last_observed_at < ${inventory.observedAt}::timestamptz`.execute(this.kysely)
    // Rows an earlier, unfiltered sweep discovered under a root that has SINCE
    // declared a `match` are retired rather than deleted: bytes and history
    // stay, but `out_of_scope` is already excluded from planning and from the
    // backlog, so they stop being work. Ordered after the missing sweep so an
    // undiscoverable path settles on the more specific reason. Compared against
    // relative_path, which equals the inventory's relative path for the
    // directory roots a match applies to.
    for (const exclusion of losslessMatchExclusions(this.config.inventory)) {
      await sql`UPDATE learning_archive_sources
        SET discovery_state='out_of_scope', last_error_code='root-match-excluded', updated_at=NOW()
        WHERE host=${hostname()} AND metadata->>'rootId'=${exclusion.rootId}
          AND discovery_state <> 'out_of_scope' AND relative_path !~ ${exclusion.pattern}`.execute(this.kysely)
    }
    }
    const ordered = targetedInventory ? {rows:[...byId.values()].map(item=>({sourceId:item.sourceId,provider:item.provider}))} : await sql<{ sourceId: string; provider: string }>`
      SELECT source_id AS "sourceId", provider
        FROM learning_archive_sources source
       CROSS JOIN LATERAL (SELECT COALESCE((SELECT checkpoint.cursor_offset FROM learning_archive_checkpoints checkpoint
         WHERE checkpoint.source_id=source.source_id AND checkpoint.generation=source.generation), 0) < COALESCE(source.source_size, 0) AS uncaptured) pending
       WHERE host = ${hostname()} AND discovery_state <> 'out_of_scope'
       -- A half-written version is finished first. Then uncaptured bytes, newest
       -- file first, working backwards in time: a fresh install drains its
       -- history from the present, and after downtime the sessions that grew
       -- meanwhile lead. Fully captured files come last, oldest verification
       -- first, so every historical prefix is still rehashed in turn.
       ORDER BY EXISTS (
         SELECT 1 FROM learning_archive_versions version
          WHERE version.source_id=source.source_id AND version.generation=source.generation
            AND version.manifest_status='writing'
       ) DESC,
       pending.uncaptured DESC,
       CASE WHEN pending.uncaptured THEN source_mtime_ns END DESC NULLS LAST,
       last_success_at ASC NULLS FIRST, last_error_at ASC NULLS FIRST, first_observed_at, source_id`.execute(this.kysely)
    const planned = planLosslessArchiveSources(ordered.rows, byId, this.config.maxSources ?? 12, effectivePrefer)
    const inventoryGapDetails = inventory.gaps.map((gap) => ({
      provider: gap.provider, rootId: gap.rootId, code: gap.code, relativePathDigest: digest(gap.relativePath ?? ''),
    }))
    await this.archive.createRun({ runId, runKind: mode === 'periodic' ? 'scheduled' : 'backfill', metadata: {
      planned, discovered: inventory.entries.length, inventoryGaps: inventory.gaps.length,
      providers, results: [], attempts: 0, inventoryGapDetails,
    } })
    await this.persistInventoryGaps(runId, inventoryGapDetails)
    return { runId, sourcesDiscovered: inventory.entries.length }
  }

  private planEntry(sourceId: string, rootPath: string, entry: InventoryEntry) {
    return PlannedSource.parse({ ...entry, sourceId, approvedRoot: entry.relativePath === '.' ? dirname(rootPath) : rootPath })
  }

  private async persistInventoryGaps(runId: string, gaps: z.infer<typeof InventoryGapRecord>[]): Promise<void> {
    for (const gap of gaps) {
      const details = JSON.stringify({ provider: gap.provider, rootId: gap.rootId, relativePathDigest: gap.relativePathDigest })
      await sql`INSERT INTO learning_archive_errors (run_id,error_code,error_message,retryable,is_gap,details)
        SELECT ${runId}::uuid, ${gap.code}, 'Inventory coverage gap', true, true, ${details}::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM learning_archive_errors
           WHERE run_id = ${runId}::uuid AND error_code = ${gap.code} AND details = ${details}::jsonb
        )`.execute(this.kysely)
    }
  }

  private async scanReferences(
    runId: string,
    plan: z.infer<typeof PlannedSource>,
    generation: number,
  ): Promise<{ gaps: number; bytesRead: number }> {
    if (plan.fileKind !== 'jsonl') return { gaps: 0, bytesRead: 0 }
    const row = await sql<{ metadata: unknown }>`SELECT metadata FROM learning_archive_sources
      WHERE source_id=${plan.sourceId}::uuid AND generation=${generation}`.execute(this.kysely)
    const metadata = (row.rows[0]?.metadata && typeof row.rows[0].metadata === 'object')
      ? row.rows[0].metadata as Record<string, unknown> : {}
    const stored = ReferenceScanCursor.safeParse(metadata.referenceScan)
    const cursor = stored.success && stored.data.generation === generation
      ? stored.data : { generation, cursor: 0, discardingOversizeRecord: false }
    try {
      const scan = await scanLosslessArchiveReferences({
        sourceId: plan.sourceId, provider: plan.provider as LosslessArchiveProvider,
        sourcePath: plan.absolutePath,
        approvedRoots: this.config.inventory.roots.map((root) => ({ id: root.id, path: root.path })),
        startOffset: cursor.cursor, discardingOversizeRecord: cursor.discardingOversizeRecord,
        maxSourceBytes: 1024 * 1024, maxRecordBytes: 256 * 1024,
      })
      const next = JSON.stringify({ generation, cursor: scan.nextOffset,
        discardingOversizeRecord: scan.discardingOversizeRecord })
      await sql`UPDATE learning_archive_sources
        SET metadata=jsonb_set(COALESCE(metadata,'{}'::jsonb),'{referenceScan}',${next}::jsonb,true), updated_at=NOW()
        WHERE source_id=${plan.sourceId}::uuid AND generation=${generation}`.execute(this.kysely)
      for (const gap of scan.gaps) {
        const details = JSON.stringify({ provenanceUri: gap.provenanceUri, locatorDigest: gap.locatorDigest ?? null })
        await sql`INSERT INTO learning_archive_errors
          (run_id,source_id,generation,error_code,error_message,retryable,is_gap,details)
          SELECT ${runId}::uuid,${plan.sourceId}::uuid,${generation},${`reference-${gap.code}`},
            'Structured attachment reference could not be covered automatically',true,true,${details}::jsonb
          WHERE NOT EXISTS (SELECT 1 FROM learning_archive_errors
            WHERE run_id=${runId}::uuid AND source_id=${plan.sourceId}::uuid
              AND generation=${generation} AND error_code=${`reference-${gap.code}`} AND details=${details}::jsonb)`.execute(this.kysely)
      }
      return { gaps: scan.gaps.length, bytesRead: scan.bytesScanned }
    } catch (error) {
      const sourceMutated = error instanceof Error && /mutated|cursor exceeds source size|record boundary/.test(error.message)
      const code = sourceMutated ? 'reference-source-mutated' : 'reference-scan-failed'
      const details = JSON.stringify({ provenanceUri: `archive-source://${encodeURIComponent(plan.sourceId)}#byte=${cursor.cursor}`, locatorDigest: null })
      await sql`INSERT INTO learning_archive_errors
        (run_id,source_id,generation,error_code,error_message,retryable,is_gap,details)
        SELECT ${runId}::uuid,${plan.sourceId}::uuid,${generation},${code},
          'Bounded attachment reference metadata scan could not complete',true,true,${details}::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM learning_archive_errors
          WHERE run_id=${runId}::uuid AND source_id=${plan.sourceId}::uuid
            AND generation=${generation} AND error_code=${code} AND details=${details}::jsonb)`.execute(this.kysely)
      return { gaps: 1, bytesRead: 0 }
    }
  }

  async captureBatch(runId: string) {
    const run = await this.archive.getRun(runId)
    if (!run) throw new Error('Archive run not found')
    if (run.status !== 'running') return
    const metadata = RunMetadata.parse(run.metadata)
    metadata.attempts++
    for (const plan of metadata.planned) {
      if (metadata.results.some((item) => item.sourceId === plan.sourceId && !item.errorCode && !item.pending)) continue
      let claim: ArchiveClaim | null = null
      let bytesRead = 0
      try {
        const disk = await statfs(plan.approvedRoot)
        const freeBytes = Number(disk.bavail) * Number(disk.bsize)
        if (freeBytes < 512 * 1024 * 1024) throw new Error('disk-pressure')
        let source = await this.archive.getSource(plan.sourceId)
        if (!source) throw new Error('source-unavailable')
        let checkpoint = await this.archive.getCheckpoint(source.sourceId)
        const identity: ArchiveFileIdentity = { deviceId: plan.deviceId, inodeId: plan.inodeId, mode: plan.mode,
          size: plan.byteLength, mtimeNs: plan.mtimeNs, ctimeNs: plan.ctimeNs }
        if (checkpoint?.lastVerifiedVersionId && plan.fileKind !== 'sqlite') {
          const version = (await this.archive.listVersions(source.sourceId)).find((item) => item.versionId === checkpoint?.lastVerifiedVersionId)
          if (!version) throw new Error('checkpoint-version-missing')
          try {
            await verifyOpaquePrefix(plan.absolutePath, { approvedRoot: plan.approvedRoot, length: checkpoint.cursorOffset, sha256: version.aggregateSha256 })
            bytesRead += checkpoint.cursorOffset * 2
          } catch (error) {
            if (!provesNewGeneration(error)) throw error
            source = await this.archive.openGeneration({ sourceId: source.sourceId, expectedGeneration: source.generation,
              reason: plan.byteLength < checkpoint.cursorOffset ? 'truncation' : 'prefix-rewrite', source: identity })
            checkpoint = await this.archive.getCheckpoint(source.sourceId)
          }
        }
        const offset = checkpoint?.cursorOffset ?? 0
        const sqlite = plan.fileKind === 'sqlite'
        const maxBytes = this.config.maxBytesPerSource ?? 4 * 1024 * 1024
        const length = Math.min(Math.max(0, plan.byteLength - offset), maxBytes)
        if (!sqlite && length === 0 && checkpoint?.lastVerifiedVersionId) {
          const referenceScan = await this.scanReferences(runId, plan, source.generation)
          bytesRead += referenceScan.bytesRead
          await sql`UPDATE learning_archive_sources SET discovery_state='current', last_success_at=NOW(),
            last_error_at=NULL, last_error_code=NULL, last_error_message=NULL, updated_at=NOW()
            WHERE source_id=${source.sourceId}::uuid AND generation=${source.generation}`.execute(this.kysely)
          metadata.results = metadata.results.filter((item) => item.sourceId !== source.sourceId)
          metadata.results.push({ sourceId: source.sourceId, provider: plan.provider, versionId: checkpoint?.lastVerifiedVersionId ?? null,
            bytesRead, bytesWritten: 0, rawBytes: 0, encodedBytes: 0, errorCode: null, verified: true, idempotent: true, pending: false,
            referenceGaps: referenceScan.gaps })
          await this.archive.updateRunMetadata(runId, { results: metadata.results, attempts: metadata.attempts })
          continue
        }
        claim = await this.archive.claimSource({
          sourceId: source.sourceId, generation: source.generation, ownerId: runId, leaseMs: ARCHIVE_LEASE_MS,
        })
        if (!claim) throw new Error('source-leased')
        if (sqlite) {
          const walBytes = await stat(`${plan.absolutePath}-wal`).then((item) => item.size).catch(() => 0)
          const stagingRoot = resolveSqliteStagingRoot(this.config.sqliteStagingRoot)
          await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
          const stagingDisk = await statfs(stagingRoot)
          const stagingFreeBytes = Number(stagingDisk.bavail) * Number(stagingDisk.bsize)
          if (stagingFreeBytes < 512 * 1024 * 1024 + plan.byteLength + walBytes) throw new Error('disk-pressure')
          const fileStagingKey = `${source.sourceId}-${source.generation}-active`
          const staged = await createStagedSqliteSnapshot(plan.absolutePath, {
            approvedRoot: plan.approvedRoot, stagingRoot, stagingKey: fileStagingKey,
            expected: { deviceId: plan.deviceId, inodeId: plan.inodeId },
          })
          bytesRead += staged.reused ? staged.rawLength : staged.rawLength * 2
          claim = await this.archive.renewClaim(claim, ARCHIVE_LEASE_MS)
          const stagedVersion = await this.archive.beginStagedCapture({
            claim, runId, expectedCursor: offset, captureKind: 'consistent-sqlite-snapshot',
            consistencyStatus: 'logical-sqlite-snapshot', coverageStatus: 'complete', source: staged.source,
            captureStartedAt: staged.createdAt, limitations: staged.limitations,
            stagingKey: `${source.sourceId}:${source.generation}:${staged.rawSha256}`,
            expectedRawLength: staged.rawLength, expectedAggregateSha256: staged.rawSha256,
          })
          if (stagedVersion.sealed) {
            await this.archive.verifyVersion(stagedVersion.versionId)
            await removeStagedSqliteSnapshot(stagingRoot, fileStagingKey)
            metadata.results = metadata.results.filter((item) => item.sourceId !== source.sourceId)
            metadata.results.push({ sourceId: source.sourceId, provider: plan.provider, versionId: stagedVersion.versionId,
              bytesRead: staged.rawLength, bytesWritten: 0, rawBytes: 0, encodedBytes: 0,
              errorCode: null, verified: true, idempotent: true, pending: false })
            await this.archive.updateRunMetadata(runId, { results: metadata.results, attempts: metadata.attempts })
            continue
          }
          const stagedLength = Math.min(this.config.sqliteMaxBytesPerPass ?? maxBytes, staged.rawLength - stagedVersion.nextOffset)
          const range = await captureOpaqueRange(staged.path, {
            approvedRoot: stagingRoot, offset: stagedVersion.nextOffset, length: stagedLength,
          })
          let nextOffset = stagedVersion.nextOffset
          let nextOrdinal = stagedVersion.nextOrdinal
          let encodedBytes = 0
          for (const item of range.chunks) {
            const chunk = { ...item, ordinal: nextOrdinal }
            claim = await this.archive.renewClaim(claim, ARCHIVE_LEASE_MS)
            const appended = await this.archive.appendStagedChunk({ claim, versionId: stagedVersion.versionId, expectedOffset: nextOffset, chunk })
            nextOffset = appended.nextOffset
            nextOrdinal = appended.nextOrdinal
            if (!appended.idempotent) encodedBytes += chunk.encodedLength
          }
          bytesRead += range.rawLength * 2
          const priorResult = metadata.results.find((item) => item.sourceId === source.sourceId)
          if (nextOffset < staged.rawLength) {
            metadata.results = metadata.results.filter((item) => item.sourceId !== source.sourceId)
            metadata.results.push({ sourceId: source.sourceId, provider: plan.provider, versionId: stagedVersion.versionId,
              bytesRead: (priorResult?.bytesRead ?? 0) + bytesRead, bytesWritten: (priorResult?.bytesWritten ?? 0) + encodedBytes,
              rawBytes: (priorResult?.rawBytes ?? 0) + range.rawLength, encodedBytes: (priorResult?.encodedBytes ?? 0) + encodedBytes,
              errorCode: null, verified: false, idempotent: false, pending: true })
            await this.archive.updateRunMetadata(runId, { results: metadata.results, attempts: metadata.attempts })
            continue
          }
          claim = await this.archive.renewClaim(claim, ARCHIVE_LEASE_MS)
          const sealed = await this.archive.sealStagedCapture({
            claim, versionId: stagedVersion.versionId, checkpointCursorAfter: Math.max(offset, staged.source.size),
            captureEndedAt: staged.completedAt,
          })
          await this.archive.verifyVersion(sealed.versionId)
          await removeStagedSqliteSnapshot(stagingRoot, fileStagingKey)
          metadata.results = metadata.results.filter((item) => item.sourceId !== source.sourceId)
          metadata.results.push({ sourceId: source.sourceId, provider: plan.provider, versionId: sealed.versionId,
            bytesRead: (priorResult?.bytesRead ?? 0) + bytesRead, bytesWritten: (priorResult?.bytesWritten ?? 0) + encodedBytes,
            rawBytes: (priorResult?.rawBytes ?? 0) + range.rawLength, encodedBytes: (priorResult?.encodedBytes ?? 0) + encodedBytes,
            errorCode: null, verified: true, idempotent: false, pending: false })
          await this.archive.updateRunMetadata(runId, { results: metadata.results, attempts: metadata.attempts })
          continue
        }
        // A complete capture may not reuse a base, and a file captured empty (a WAL
        // after wal_checkpoint(TRUNCATE)) keeps that empty base when it regrows: a
        // zero-length prefix always verifies, so no new generation opens.
        const completeOpaque = plan.fileKind !== 'jsonl' && offset === 0 && !checkpoint?.lastVerifiedVersionId && plan.byteLength <= maxBytes
        let capture = completeOpaque
            ? await captureOpaqueFile(plan.absolutePath, { approvedRoot: plan.approvedRoot,
                expected: { deviceId: plan.deviceId, inodeId: plan.inodeId, size: plan.byteLength } })
            : await captureOpaqueRange(plan.absolutePath, { approvedRoot: plan.approvedRoot, offset, length,
                expected: { deviceId: plan.deviceId, inodeId: plan.inodeId } })
        bytesRead += capture.rawLength * 2
        if (capture.captureKind === 'opaque-range') {
          const aggregate = createHash('sha256')
          if (offset && checkpoint?.lastVerifiedVersionId) {
            for await (const bytes of this.archive.restoreVersionChunks(checkpoint.lastVerifiedVersionId)) {
              aggregate.update(bytes)
              bytesRead += bytes.byteLength
            }
          }
          const capturedBytes = await restoreCapturedChunks(capture.chunks, capture)
          aggregate.update(capturedBytes)
          bytesRead += capturedBytes.byteLength
          const aggregateSha256 = aggregate.digest('hex')
          await verifyOpaquePrefix(plan.absolutePath, { approvedRoot: plan.approvedRoot,
            length: offset + capture.rawLength, sha256: aggregateSha256,
            expected: { deviceId: capture.source.deviceId, inodeId: capture.source.inodeId } })
          bytesRead += (offset + capture.rawLength) * 2
          capture = { ...capture, captureEndedAt: new Date().toISOString() }
        }
        claim = await this.archive.renewClaim(claim, ARCHIVE_LEASE_MS)
        const result = await this.archive.commitCapture({ claim, runId, expectedCursor: offset,
          checkpointCursorAfter: offset + capture.rawLength,
          baseVersionId: checkpoint?.lastVerifiedVersionId, capture })
        const referenceScan = await this.scanReferences(runId, plan, source.generation)
        bytesRead += referenceScan.bytesRead
        metadata.results = metadata.results.filter((item) => item.sourceId !== source.sourceId)
        metadata.results.push({ sourceId: source.sourceId, provider: plan.provider, versionId: result.versionId,
          bytesRead, bytesWritten: result.encodedBytes, rawBytes: capture.rawLength, encodedBytes: result.encodedBytes,
          errorCode: null, verified: result.idempotent, idempotent: result.idempotent, pending: false,
          referenceGaps: referenceScan.gaps })
      } catch (error) {
        const failure = captureFailure(error)
        // The classified message is deliberately generic; the raw cause is what a
        // reader of learning_archive_errors needs (a unique-violation hid behind
        // `capture-failed` for an hour on 2026-09-21), so it travels in details.
        const cause = (error instanceof Error ? error.message : String(error)).slice(0, 500)
        if (claim) await this.archive.failCapture({ claim, runId, errorCode: failure.code, errorMessage: failure.message, retryable: true, isGap: failure.isGap, details: { cause } })
        else if (failure.code === 'source-leased') {
          await sql`INSERT INTO learning_archive_errors (run_id,source_id,error_code,error_message,retryable,is_gap,details)
            VALUES (${runId}::uuid,${plan.sourceId}::uuid,${failure.code},${failure.message},true,false,'{}'::jsonb)`.execute(this.kysely)
          metadata.results = metadata.results.filter((item) => item.sourceId !== plan.sourceId)
          metadata.results.push({ sourceId: plan.sourceId, provider: plan.provider, versionId: null, bytesRead,
            bytesWritten: 0, rawBytes: 0, encodedBytes: 0, errorCode: null, verified: false, idempotent: false, pending: true })
        }
        else {
          await sql`UPDATE learning_archive_sources SET last_error_at = NOW(), last_error_code = ${failure.code}, discovery_state = 'error' WHERE source_id = ${plan.sourceId}::uuid`.execute(this.kysely)
          await sql`INSERT INTO learning_archive_errors (run_id,source_id,error_code,error_message,retryable,is_gap,details)
            VALUES (${runId}::uuid,${plan.sourceId}::uuid,${failure.code},${failure.message},true,${failure.isGap},'{}'::jsonb)`.execute(this.kysely)
        }
        if (failure.code !== 'source-leased') {
          metadata.results = metadata.results.filter((item) => item.sourceId !== plan.sourceId)
          metadata.results.push({ sourceId: plan.sourceId, provider: plan.provider, versionId: null, bytesRead,
            bytesWritten: 0, rawBytes: 0, encodedBytes: 0, errorCode: failure.code, verified: false, idempotent: false, pending: false })
        }
      } finally { if (claim) await this.archive.releaseClaim(claim) }
      await this.archive.updateRunMetadata(runId, { results: metadata.results, attempts: metadata.attempts })
    }
    // The workflow gives pending/error sources three explicit durable passes.
    // A partial source result must reach finish() so the run cannot masquerade
    // as perpetually running after the framework has exhausted its retries.
  }

  async verifyBatch(runId: string) {
    const run = await this.archive.getRun(runId)
    if (!run) throw new Error('Archive run not found')
    const metadata = RunMetadata.parse(run.metadata)
    for (const result of metadata.results) if (result.versionId && !result.verified && !result.pending) {
      await this.archive.verifyVersion(result.versionId)
      result.verified = true
      await this.archive.updateRunMetadata(runId, { results: metadata.results })
    }
  }

  async finish(runId: string) {
    const run = await this.archive.getRun(runId)
    if (!run) throw new Error('Archive run not found')
    const existing = LosslessArchiveBatchResult.safeParse(run.result)
    if (existing.success) return existing.data
    const metadata = RunMetadata.parse(run.metadata)
    const errors = metadata.results.filter((item) => item.errorCode).length
    const pending = metadata.results.filter((item) => item.pending).length
    const referenceGaps = metadata.results.reduce((total, item) => total + (item.referenceGaps ?? 0), 0)
    const sum = (key: 'bytesRead' | 'bytesWritten' | 'rawBytes' | 'encodedBytes') => metadata.results.reduce((total, item) => total + item[key], 0)
    const versionIds = metadata.results.flatMap((item) => item.versionId && !item.pending ? [item.versionId] : [])
    const newlySealedVersionIds = metadata.results.flatMap((item) => item.versionId && !item.idempotent && !item.pending ? [item.versionId] : [])
    const finishedAt = new Date().toISOString()
    const result = LosslessArchiveBatchResult.parse({
      runId, status: errors || pending || metadata.inventoryGaps || referenceGaps ? 'partial' : 'completed', startedAt: run.startedAt, finishedAt,
      elapsedMs: Date.parse(finishedAt) - Date.parse(run.startedAt), versionIds, limitations: LIMITATIONS,
      totals: { sourcesDiscovered: metadata.discovered, sourcesScanned: metadata.results.length - errors - pending,
        bytesRead: sum('bytesRead'), bytesWritten: sum('bytesWritten'), rawBytes: sum('rawBytes'), encodedBytes: sum('encodedBytes'),
        versionsSealed: newlySealedVersionIds.length, versionsVerified: metadata.results.filter((item) => item.versionId && item.verified).length,
        gaps: metadata.inventoryGaps + referenceGaps + errors, errors, providerCalls: 0, llmCalls: 0, masteryMutations: 0 },
      providers: Object.entries(metadata.providers).map(([provider, sourcesDiscovered]) => {
        const entries = metadata.results.filter((item) => item.provider === provider)
        return { provider, sourcesDiscovered, sourcesScanned: entries.filter((item) => !item.errorCode && !item.pending).length,
          bytesRead: entries.reduce((total, item) => total + item.bytesRead, 0), versionsSealed: entries.filter((item) => item.versionId && !item.idempotent && !item.pending).length,
          gaps: entries.filter((item) => item.errorCode).length + entries.reduce((total, item) => total + (item.referenceGaps ?? 0), 0) }
      }),
    })
    await this.archive.finishRun(runId, { status: result.status, result, sourcesDiscovered: metadata.discovered,
      sourcesCaptured: result.totals.sourcesScanned, versionsSealed: newlySealedVersionIds.length, gapsRecorded: result.totals.gaps,
      errorsRecorded: errors, bytesRead: result.totals.bytesRead, rawBytesStored: result.totals.rawBytes, encodedBytesStored: result.totals.bytesWritten })
    return result
  }

  async status() {
    const sources = await sql<{ sourceId: string; provider: string; rootId: string; relativePath: string; fileKind: string; size: string; generation: number;
      cursor: string; state: string; lastSuccessfulCapture: Date | null; errorCode: string | null }>`
      SELECT s.source_id AS "sourceId", s.provider, COALESCE(s.metadata->>'rootId','unknown') AS "rootId", s.relative_path AS "relativePath",
      s.file_kind AS "fileKind", COALESCE(s.source_size,0) AS size, s.generation, COALESCE(c.cursor_offset,0) AS cursor,
      s.discovery_state AS state, s.last_success_at AS "lastSuccessfulCapture", s.last_error_code AS "errorCode"
      FROM learning_archive_sources s LEFT JOIN learning_archive_checkpoints c ON c.source_id=s.source_id AND c.generation=s.generation
      WHERE s.host=${hostname()} ORDER BY s.last_error_at DESC NULLS LAST, s.last_success_at DESC NULLS LAST LIMIT 200`.execute(this.kysely)
    const backlog = await sql<{ pending: string; bytes: string }>`SELECT count(*) FILTER (WHERE COALESCE(c.cursor_offset,0)<COALESCE(s.source_size,0)) AS pending,
      COALESCE(sum(GREATEST(0,COALESCE(s.source_size,0)-COALESCE(c.cursor_offset,0))),0) AS bytes FROM learning_archive_sources s
      LEFT JOIN learning_archive_checkpoints c ON c.source_id=s.source_id AND c.generation=s.generation
      WHERE s.host=${hostname()} AND s.discovery_state <> 'out_of_scope'`.execute(this.kysely)
    const runs = await sql<{ runId: string; status: string; startedAt: Date; completedAt: Date | null; metadata: unknown; summary: string | null; result: unknown }>`
      SELECT run_id AS "runId",status,started_at AS "startedAt",completed_at AS "completedAt",metadata,summary,result
      FROM learning_archive_runs WHERE result IS NOT NULL OR status='failed' ORDER BY started_at DESC LIMIT 20`.execute(this.kysely)
    return LosslessArchiveStatusOutput.parse({ enabled: this.config.enabled, scheduleEnabled: this.scheduleEnabled, retention: 'keep-originals',
      sources: sources.rows.map((item) => ({ ...item, relativePathDigest: digest(item.relativePath), size: Number(item.size), cursor: Number(item.cursor),
        lastSuccessfulCapture: item.lastSuccessfulCapture?.toISOString() ?? null })),
      recentRuns: runs.rows.flatMap((item) => {
        const parsed = LosslessArchiveBatchResult.safeParse(item.result)
        if (parsed.success) return [parsed.data]
        const run = RunMetadata.safeParse(item.metadata)
        if (item.status !== 'failed' || !run.success) return []
        const errors = run.data.results.filter((entry) => entry.errorCode).length
        const referenceGaps = run.data.results.reduce((total, entry) => total + (entry.referenceGaps ?? 0), 0)
        const finishedAt = item.completedAt?.toISOString() ?? item.startedAt.toISOString()
        const sum = (key: 'bytesRead' | 'bytesWritten' | 'rawBytes' | 'encodedBytes') => run.data.results.reduce((total, entry) => total + entry[key], 0)
        return [LosslessArchiveBatchResult.parse({
          runId: item.runId, status: 'failed', startedAt: item.startedAt.toISOString(), finishedAt,
          elapsedMs: Math.max(0, Date.parse(finishedAt) - item.startedAt.getTime()),
          versionIds: run.data.results.flatMap((entry) => entry.versionId && !entry.pending ? [entry.versionId] : []),
          limitations: [...LIMITATIONS, item.summary ?? 'Workflow ended before a final archive result was published.'],
          totals: { sourcesDiscovered: run.data.discovered,
            sourcesScanned: run.data.results.filter((entry) => !entry.errorCode && !entry.pending).length,
            bytesRead: sum('bytesRead'), bytesWritten: sum('bytesWritten'), rawBytes: sum('rawBytes'), encodedBytes: sum('encodedBytes'),
            versionsSealed: run.data.results.filter((entry) => entry.versionId && !entry.idempotent && !entry.pending).length,
            versionsVerified: run.data.results.filter((entry) => entry.versionId && entry.verified).length,
            gaps: run.data.inventoryGaps + referenceGaps + errors, errors: Math.max(1, errors),
            providerCalls: 0, llmCalls: 0, masteryMutations: 0 },
          providers: Object.entries(run.data.providers).map(([provider, sourcesDiscovered]) => {
            const entries = run.data.results.filter((entry) => entry.provider === provider)
            return { provider, sourcesDiscovered,
              sourcesScanned: entries.filter((entry) => !entry.errorCode && !entry.pending).length,
              bytesRead: entries.reduce((total, entry) => total + entry.bytesRead, 0),
              versionsSealed: entries.filter((entry) => entry.versionId && !entry.idempotent && !entry.pending).length,
              gaps: entries.filter((entry) => entry.errorCode).length + entries.reduce((total, entry) => total + (entry.referenceGaps ?? 0), 0) }
          }),
        })]
      }),
      pendingSources: Number(backlog.rows[0]?.pending ?? 0), backlogBytes: Number(backlog.rows[0]?.bytes ?? 0), limitations: LIMITATIONS })
  }

  async verifyVersion(versionId: string) {
    const result = await this.archive.verifyVersion(versionId)
    return { versionId, sha256: result.sha256, byteLength: result.rawLength, verified: true as const }
  }
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
