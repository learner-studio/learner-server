import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

import { Database } from 'bun:sqlite'
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from 'kysely'
import { Pool } from 'pg'

import type { DB } from '../types/db.types.js'
import type { LosslessArchiveInventoryConfig } from '../lib/learning/lossless-archive-files.js'
import { LearningLosslessArchiveService } from './learning-lossless-archive-service.js'
import { LearningLosslessArchiveSyncService, losslessMatchExclusions, planLosslessArchiveSources } from './learning-lossless-archive-sync-service.js'
import { LosslessArchiveStartInput } from '../lib/learning/lossless-archive-schemas.js'
import { LearningExposureService } from './learning-exposure-service.js'
import { LearningExposureIngestService } from './learning-exposure-ingest-service.js'

const integrationUrl = process.env.LOSSLESS_ARCHIVE_TEST_DATABASE_URL
const describePostgres = integrationUrl ? describe : describe.skip

describePostgres('active transcript archive fast path',()=>{
  test('captures appended bytes and projects immediately without marking unrelated sources missing',async()=>{
    const db=new Kysely<DB>({dialect:new PostgresDialect({pool:new Pool({connectionString:integrationUrl!,max:2})}),plugins:[new CamelCasePlugin()]})
    const root=await mkdtemp(join(tmpdir(),'active-archive-test-'))
    try {
      const folder=join(root,'project');await mkdir(folder)
      const sessionId=randomUUID(),native=randomUUID()
      const path=join(folder,`${sessionId}.jsonl`)
      await writeFile(path,'{}\n')
      await writeFile(join(folder,'unrelated.jsonl'),'{}\n')
      const archive=new LearningLosslessArchiveService(db)
      const inventory:LosslessArchiveInventoryConfig={schemaVersion:1,roots:[{id:'active-test',provider:'claude',path:root,purpose:'transcripts',capture:'opaque',optional:false}],excluded:[],upstreamLayoutAttribution:[]}
      const sync=new LearningLosslessArchiveSyncService(db,archive,{enabled:true,scheduleEnabled:false,inventory,maxSources:2})
      const initial=randomUUID();await sync.discover(initial,'periodic');await sync.captureBatch(initial);await sync.verifyBatch(initial);await sync.finish(initial)
      const before=(await sql<{state:string}>`SELECT discovery_state AS state FROM learning_archive_sources WHERE root_path=${root} AND relative_path='project/unrelated.jsonl'`.execute(db)).rows[0]!.state
      const text='Explain why HTTP requests and responses are separate.'
      await writeFile(path,JSON.stringify({type:'user',uuid:native,sessionId,timestamp:new Date().toISOString(),message:{role:'user',content:text}})+'\n',{flag:'a'})
      const active=randomUUID();const source=await sync.discoverActive(active,sessionId)
      await sync.captureActive(active);await sync.verifyBatch(active);const finished=await sync.finish(active)
      expect(finished.totals.sourcesScanned).toBe(1)
      expect((await sql<{state:string}>`SELECT discovery_state AS state FROM learning_archive_sources WHERE root_path=${root} AND relative_path='project/unrelated.jsonl'`.execute(db)).rows[0]!.state).toBe(before)
      const exposure=new LearningExposureService(db)
      const ingest=new LearningExposureIngestService(db,archive,exposure,{enabled:true,spoolRoot:join(root,'spool')})
      expect((await ingest.projectActiveSource(source.sourceId)).pending).toBe(0)
      expect((await exposure.query({logicalMessageKey:`claude:${sessionId}:user:${native}`,includeUnknown:true})).items).toHaveLength(1)
      await ingest.projectActiveSource(source.sourceId)
      expect((await exposure.query({logicalMessageKey:`claude:${sessionId}:user:${native}`,includeUnknown:true})).items).toHaveLength(1)
      await writeFile(path,'{"incomplete":',{flag:'a'})
      const partial=randomUUID();await sync.discoverActive(partial,sessionId);await sync.captureActive(partial)
      expect((await ingest.projectActiveSource(source.sourceId)).gaps).toBeGreaterThan(0)
      expect((await ingest.projectActiveSource(source.sourceId)).gaps).toBeGreaterThan(0)
      const fresh=randomUUID();await writeFile(join(folder,`${fresh}.jsonl`),'{}\n')
      const raced=await sync.discoverActive(randomUUID(),fresh)
      expect((await sql<{id:string}>`SELECT source_id AS id FROM learning_archive_sources WHERE root_path=${root} AND relative_path=${`project/${fresh}.jsonl`}`.execute(db)).rows[0]!.id).toBe(raced.sourceId)
      await expect(sync.discoverActive(randomUUID(),randomUUID())).rejects.toThrow('Expected one approved')
    } finally {await db.destroy();await rm(root,{recursive:true,force:true})}
  })
})

describePostgres('LearningLosslessArchiveSyncService production capture path', () => {
  let kysely: Kysely<DB>
  let archive: LearningLosslessArchiveService
  let sync: LearningLosslessArchiveSyncService
  let fixtureRoot: string
  let stagingRoot: string
  let emptyPath: string
  let transcriptPath: string
  let sqlitePath: string
  let inventory: LosslessArchiveInventoryConfig
  const transcriptBytes = Buffer.from('  {"unknown":"雪"}\r\n{"partial":true}\n')

  beforeAll(async () => {
    kysely = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: integrationUrl!, max: 4 }) }),
      plugins: [new CamelCasePlugin()],
    })
    archive = new LearningLosslessArchiveService(kysely)
    fixtureRoot = await mkdtemp(join(tmpdir(), 'lossless-sync-integration-'))
    stagingRoot = join(fixtureRoot, 'staging')
    await mkdir(stagingRoot, { mode: 0o700 })
    emptyPath = join(fixtureRoot, 'empty.jsonl')
    transcriptPath = join(fixtureRoot, 'events.jsonl')
    sqlitePath = join(fixtureRoot, 'state.sqlite')
    await Promise.all([
      writeFile(emptyPath, Buffer.alloc(0), { flag: 'wx', mode: 0o600 }),
      writeFile(transcriptPath, transcriptBytes, { flag: 'wx', mode: 0o600 }),
    ])
    const sqlite = new Database(sqlitePath, { create: true, strict: true })
    try {
      sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE opaque(id INTEGER PRIMARY KEY, payload BLOB)')
      sqlite.query('INSERT INTO opaque(payload) VALUES (zeroblob(?))').run(5 * 1024 * 1024 + 333)
    } finally {
      sqlite.close()
    }
    inventory = {
      schemaVersion: 1,
      roots: [
        { id: 'empty-file-root', provider: 'codex', path: emptyPath, purpose: 'history', capture: 'opaque', optional: false },
        { id: 'transcript-file-root', provider: 'claude', path: transcriptPath, purpose: 'transcripts', capture: 'opaque', optional: false },
        { id: 'sqlite-file-root', provider: 'antigravity', path: sqlitePath, purpose: 'state', capture: 'sqlite-logical-and-opaque', optional: false },
      ],
      excluded: [],
      upstreamLayoutAttribution: [],
    }
    sync = new LearningLosslessArchiveSyncService(kysely, archive, {
      enabled: true, scheduleEnabled: false, inventory, maxSources: 3,
      maxBytesPerSource: 1024 * 1024, sqliteStagingRoot: stagingRoot,
    })
  })

  afterAll(async () => {
    await kysely?.destroy()
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  })

  const completeRun = async (runId: string) => {
    await sync.discover(runId, 'backfill')
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sync.captureBatch(runId).catch((error: unknown) => {
        if (!(error instanceof Error) || !error.message.includes('bounded durable retry')) throw error
      })
      const run = await archive.getRun(runId)
      const results = (run?.metadata.results ?? []) as Array<{ pending?: boolean; errorCode?: string | null }>
      if (results.length === 3 && results.every((item) => !item.pending && !item.errorCode)) break
    }
    await sync.verifyBatch(runId)
    return sync.finish(runId)
  }

  test('seals empty and nonempty roots, resumes staged SQLite, and reuses unchanged versions', async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS learning_seed_v1_frozen_fixture (
        fixture_id TEXT PRIMARY KEY,
        frozen_payload JSONB NOT NULL
      )
    `.execute(kysely)
    await sql`
      INSERT INTO learning_seed_v1_frozen_fixture (fixture_id, frozen_payload)
      VALUES ('seed-v1-sentinel', '{"caseCount":100,"messageCount":200,"status":"frozen"}'::jsonb)
      ON CONFLICT DO NOTHING
    `.execute(kysely)
    const frozenBefore = await sql<{ hash: string; count: string }>`
      SELECT md5(string_agg(fixture_id || ':' || frozen_payload::text, ',' ORDER BY fixture_id)) AS hash,
             count(*) AS count FROM learning_seed_v1_frozen_fixture
    `.execute(kysely)
    const first = await completeRun(randomUUID())
    expect(first.status).toBe('completed')
    expect(first.totals.sourcesScanned).toBe(3)
    expect(first.totals.versionsVerified).toBe(3)

    const sources = await sql<{ sourceId: string; relativePath: string; rootPath: string }>`
      SELECT source_id AS "sourceId", relative_path AS "relativePath", root_path AS "rootPath"
        FROM learning_archive_sources WHERE relative_path IN (${basename(emptyPath)}, ${basename(transcriptPath)}, ${basename(sqlitePath)})
          AND root_path=${fixtureRoot}
    `.execute(kysely)
    expect(sources.rows).toHaveLength(3)
    expect(sources.rows.every((row) => row.rootPath === dirname(row.relativePath === basename(emptyPath)
      ? emptyPath : row.relativePath === basename(transcriptPath) ? transcriptPath : sqlitePath))).toBe(true)

    const emptySource = sources.rows.find((row) => row.relativePath === basename(emptyPath))!
    const transcriptSource = sources.rows.find((row) => row.relativePath === basename(transcriptPath))!
    const sqliteSource = sources.rows.find((row) => row.relativePath === basename(sqlitePath))!
    const emptyVersion = (await archive.listVersions(emptySource.sourceId))[0]!
    const transcriptVersion = (await archive.listVersions(transcriptSource.sourceId))[0]!
    const sqliteVersion = (await archive.listVersions(sqliteSource.sourceId))[0]!
    expect((await archive.restoreVersion(emptyVersion.versionId)).byteLength).toBe(0)
    expect((await archive.restoreVersion(transcriptVersion.versionId)).equals(transcriptBytes)).toBe(true)
    const referenceCursor = await sql<{ metadata: { referenceScan?: { generation: number; cursor: number; discardingOversizeRecord: boolean } } }>`
      SELECT metadata FROM learning_archive_sources WHERE source_id=${transcriptSource.sourceId}::uuid`.execute(kysely)
    expect(referenceCursor.rows[0]?.metadata.referenceScan).toEqual({
      generation: 0, cursor: transcriptBytes.byteLength, discardingOversizeRecord: false,
    })

    const restoredSqlitePath = join(fixtureRoot, 'restored.sqlite')
    await writeFile(restoredSqlitePath, await archive.restoreVersion(sqliteVersion.versionId), { flag: 'wx', mode: 0o600 })
    const restored = new Database(restoredSqlitePath, { readonly: true, strict: true })
    try {
      expect(restored.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
      expect(restored.query<{ length: number }, []>('SELECT length(payload) AS length FROM opaque').get()?.length).toBe(5 * 1024 * 1024 + 333)
    } finally {
      restored.close()
    }
    expect((await readdir(stagingRoot)).filter((name) => name.endsWith('.sqlite') || name.endsWith('.json'))).toEqual([])

    const second = await completeRun(randomUUID())
    expect(second.status).toBe('completed')
    expect(second.totals.versionsSealed).toBe(0)
    expect(second.totals.versionsVerified).toBe(3)
    expect(second.versionIds.sort()).toEqual(first.versionIds.sort())
    const preservedCursor = await sql<{ metadata: { referenceScan?: { cursor: number } } }>`
      SELECT metadata FROM learning_archive_sources WHERE source_id=${transcriptSource.sourceId}::uuid`.execute(kysely)
    expect(preservedCursor.rows[0]?.metadata.referenceScan?.cursor).toBe(transcriptBytes.byteLength)
    const frozenAfter = await sql<{ hash: string; count: string }>`
      SELECT md5(string_agg(fixture_id || ':' || frozen_payload::text, ',' ORDER BY fixture_id)) AS hash,
             count(*) AS count FROM learning_seed_v1_frozen_fixture
    `.execute(kysely)
    expect(frozenAfter.rows[0]).toEqual(frozenBefore.rows[0])
  })

  test('treats a competing lease as pending without corrupting source state', async () => {
    await writeFile(transcriptPath, Buffer.from('\n{"new":true}\n'), { flag: 'a' })
    const runId = randomUUID()
    await sync.discover(runId, 'backfill')
    const source = await sql<{ sourceId: string; generation: number }>`
      SELECT source_id AS "sourceId", generation FROM learning_archive_sources WHERE relative_path = ${basename(transcriptPath)} AND root_path=${fixtureRoot}
    `.execute(kysely)
    const activeWorkflowId = randomUUID()
    await sql`INSERT INTO learner_workflow_runs (workflow_run_id,workflow,status,input)
      VALUES (${activeWorkflowId},'learningLosslessArchiveWorkflow','running','{}')`.execute(kysely)
    const held = await archive.claimSource({
      sourceId: source.rows[0]!.sourceId, generation: source.rows[0]!.generation,
      ownerId: activeWorkflowId, leaseMs: 60_000,
    })
    expect(held).not.toBeNull()
    await sync.discover(randomUUID(), 'backfill')
    const stillHeld = await sql<{ leaseOwner: string | null; leaseToken: string | null; fencingToken: string }>`
      SELECT lease_owner AS "leaseOwner", lease_token AS "leaseToken", fencing_token AS "fencingToken"
        FROM learning_archive_sources WHERE source_id=${source.rows[0]!.sourceId}::uuid`.execute(kysely)
    expect(stillHeld.rows[0]).toMatchObject({
      leaseOwner: activeWorkflowId, leaseToken: held!.claimToken, fencingToken: String(held!.fencingToken),
    })
    await sync.captureBatch(runId).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('bounded durable retry')) throw error
    })
    const stored = await archive.getSource(source.rows[0]!.sourceId)
    expect(stored?.discoveryState).toBe('capturing')
    const run = await archive.getRun(runId)
    const result = ((run?.metadata.results ?? []) as Array<{ sourceId: string; pending: boolean; errorCode: string | null }>)
      .find((item) => item.sourceId === source.rows[0]!.sourceId)
    expect(result).toMatchObject({ pending: true, errorCode: null })
    await archive.releaseClaim(held!)
  })

  test('revokes a terminal workflow fence and resumes its staged SQLite manifest', async () => {
    const sqlite = new Database(sqlitePath, { strict: true })
    try {
      sqlite.query('INSERT INTO opaque(payload) VALUES (zeroblob(?))').run(1024 * 1024 + 17)
    } finally {
      sqlite.close()
    }

    const orphanRunId = randomUUID()
    await sync.discover(orphanRunId, 'backfill')
    await sync.captureBatch(orphanRunId).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('bounded durable retry')) throw error
    })
    const sqliteSource = await sql<{ sourceId: string; generation: number }>`
      SELECT source_id AS "sourceId", generation FROM learning_archive_sources
       WHERE relative_path=${basename(sqlitePath)} AND root_path=${fixtureRoot}`.execute(kysely)
    const pendingRun = await archive.getRun(orphanRunId)
    const pendingResult = ((pendingRun?.metadata.results ?? []) as Array<{ sourceId: string; versionId: string | null; pending: boolean }>)
      .find((item) => item.sourceId === sqliteSource.rows[0]!.sourceId)
    expect(pendingResult?.pending).toBe(true)
    expect(typeof pendingResult?.versionId).toBe('string')
    const pendingVersionId = pendingResult!.versionId!
    const writing = await sql<{ status: string; chunks: string }>`
      SELECT manifest_status AS status,
             (SELECT count(*) FROM learning_archive_version_chunks c WHERE c.version_id=v.version_id) AS chunks
        FROM learning_archive_versions v WHERE version_id=${pendingVersionId}::uuid`.execute(kysely)
    expect(writing.rows[0]).toMatchObject({ status: 'writing', chunks: '1' })

    // Reproduce the live pre-upgrade descriptor: its snapshot digest and the
    // writing manifest are valid, but stagingIdentity was not yet serialized.
    const descriptorPath = join(stagingRoot, `${sqliteSource.rows[0]!.sourceId}-${sqliteSource.rows[0]!.generation}-active.json`)
    const legacyDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>
    delete legacyDescriptor.stagingIdentity
    await writeFile(descriptorPath, `${JSON.stringify(legacyDescriptor)}\n`, { mode: 0o600 })

    const orphanClaim = await archive.claimSource({
      sourceId: sqliteSource.rows[0]!.sourceId, generation: sqliteSource.rows[0]!.generation,
      ownerId: orphanRunId, leaseMs: 120_000,
    })
    expect(orphanClaim).not.toBeNull()
    await sql`INSERT INTO learner_workflow_runs (workflow_run_id,workflow,status,input)
      VALUES (${orphanRunId},'learningLosslessArchiveWorkflow','failed','{}')`.execute(kysely)

    const recoverySync = new LearningLosslessArchiveSyncService(kysely, archive, {
      enabled: true, scheduleEnabled: false, inventory, maxSources: 1,
      maxBytesPerSource: 1024 * 1024, sqliteStagingRoot: stagingRoot,
    })
    const recoveryRunId = randomUUID()
    await recoverySync.discover(recoveryRunId, 'backfill')
    const recoveryPlan = await archive.getRun(recoveryRunId)
    expect((recoveryPlan?.metadata.planned as Array<{ sourceId: string }>)).toEqual([
      expect.objectContaining({ sourceId: sqliteSource.rows[0]!.sourceId }),
    ])
    const reclaimed = await sql<{ leaseOwner: string | null; leaseToken: string | null; fencingToken: string }>`
      SELECT lease_owner AS "leaseOwner", lease_token AS "leaseToken", fencing_token AS "fencingToken"
        FROM learning_archive_sources WHERE source_id=${sqliteSource.rows[0]!.sourceId}::uuid`.execute(kysely)
    expect(reclaimed.rows[0]).toMatchObject({
      leaseOwner: null, leaseToken: null, fencingToken: String(orphanClaim!.fencingToken + 1),
    })
    const failedRun = await archive.getRun(orphanRunId)
    expect(failedRun).toMatchObject({ status: 'failed', summary: 'Workflow failed before publication; committed bytes retained' })

    await recoverySync.captureBatch(recoveryRunId).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('bounded durable retry')) throw error
    })
    const upgradedDescriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as Record<string, unknown>
    expect(upgradedDescriptor.stagingIdentity).toMatchObject({ size: expect.any(Number), deviceId: expect.any(String), inodeId: expect.any(String) })
    const recovered = await completeRun(recoveryRunId)
    expect(recovered.versionIds).toContain(pendingVersionId)
    const sealed = await sql<{ status: string }>`SELECT manifest_status AS status FROM learning_archive_versions
      WHERE version_id=${pendingVersionId}::uuid`.execute(kysely)
    expect(sealed.rows[0]?.status).toBe('sealed')
  })

  test('records unavailable reference provenance without leaking its locator', async () => {
    const locator = 'https://private.example.test/attachment?token=secret'
    const appended = Buffer.from(`${JSON.stringify({ type: 'attachment', attachment: { type: 'file', url: locator } })}\n`)
    await writeFile(transcriptPath, appended, { flag: 'a' })
    const runId = randomUUID()
    const result = await completeRun(runId)
    expect(result.status).toBe('partial')
    const errors = await sql<{ errorCode: string; details: Record<string, unknown> }>`
      SELECT error_code AS "errorCode",details FROM learning_archive_errors
      WHERE run_id=${runId}::uuid AND error_code='reference-remote-reference'`.execute(kysely)
    expect(errors.rows).toHaveLength(1)
    expect(errors.rows[0]?.details).toEqual({
      provenanceUri: expect.stringContaining('archive-source://'),
      locatorDigest: createHash('sha256').update(locator).digest('hex'),
    })
    expect(JSON.stringify(errors.rows[0])).not.toContain(locator)
    expect(JSON.stringify(errors.rows[0])).not.toContain(transcriptPath)
  })

  test('reconciles failed workflows while retaining committed run metadata in status', async () => {
    const runId = randomUUID()
    await archive.createRun({ runId, runKind: 'probe', metadata: {
      planned: [], discovered: 0, inventoryGaps: 0, providers: {}, results: [], attempts: 0, inventoryGapDetails: [],
      retainedMarker: 'keep-me',
    } })
    await sql`INSERT INTO learner_workflow_runs (workflow_run_id,workflow,status,input)
      VALUES (${runId},'learningLosslessArchiveWorkflow','failed','{}')`.execute(kysely)
    await sync.discover(runId, 'backfill')
    const stored = await archive.getRun(runId)
    expect(stored).toMatchObject({ status: 'failed', summary: 'Workflow failed before publication; committed bytes retained' })
    expect((stored?.metadata as Record<string, unknown>).retainedMarker).toBe('keep-me')
    const status = await sync.status()
    expect(status.recentRuns.find((item) => item.runId === runId)).toMatchObject({ status: 'failed' })
  })
})

describe('lossless archive sweep planning order', () => {
  type Candidate = { sourceId: string; rootId: string; absolutePath: string }
  const ordered = (...rows: Array<[string, string]>) => rows.map(([sourceId, provider]) => ({ sourceId, provider }))
  const byId = (...rows: Candidate[]) => new Map(rows.map((row) => [row.sourceId, row]))

  test('plans sources whose root id is preferred before the normal ordering', () => {
    const catalogue = byId(
      { sourceId: 'a', rootId: 'codex-sessions', absolutePath: '/root/.codex/sessions/a.jsonl' },
      { sourceId: 'b', rootId: 'claude-projects', absolutePath: '/root/.claude/projects/b.jsonl' },
      { sourceId: 'c', rootId: 'codex-lane-journals', absolutePath: '/var/tmp/codex-lanes/c.jsonl' },
    )
    const planned = planLosslessArchiveSources(ordered(['a', 'codex'], ['b', 'claude'], ['c', 'codex']), catalogue, 3, ['codex-lane-journals'])
    expect(planned.map((item) => item.sourceId)).toEqual(['c', 'a', 'b'])
  })

  test('plans sources under a preferred absolute path prefix first and still honours maxSources', () => {
    const catalogue = byId(
      { sourceId: 'a', rootId: 'codex-sessions', absolutePath: '/root/.codex/sessions/a.jsonl' },
      { sourceId: 'b', rootId: 'claude-projects', absolutePath: '/root/.claude/projects/b.jsonl' },
      { sourceId: 'c', rootId: 'agy-lane-journals', absolutePath: '/var/tmp/agy-lanes/lane-1/c.jsonl' },
    )
    const planned = planLosslessArchiveSources(ordered(['a', 'codex'], ['b', 'claude'], ['c', 'antigravity']), catalogue, 2, ['/var/tmp/agy-lanes/'])
    expect(planned.map((item) => item.sourceId)).toEqual(['c', 'a'])
  })

  test('keeps the normal provider round-robin when nothing is preferred', () => {
    const catalogue = byId(
      { sourceId: 'a', rootId: 'codex-sessions', absolutePath: '/root/.codex/sessions/a.jsonl' },
      { sourceId: 'a2', rootId: 'codex-sessions', absolutePath: '/root/.codex/sessions/a2.jsonl' },
      { sourceId: 'b', rootId: 'claude-projects', absolutePath: '/root/.claude/projects/b.jsonl' },
    )
    const planned = planLosslessArchiveSources(ordered(['a', 'codex'], ['a2', 'codex'], ['b', 'claude']), catalogue, 3, [])
    expect(planned.map((item) => item.sourceId)).toEqual(['a', 'b', 'a2'])
  })

  test('accepts a prefer list of strings and rejects non-string entries', () => {
    expect(LosslessArchiveStartInput.parse({ mode: 'periodic', prefer: ['codex-lane-journals', '/var/tmp/claude-lanes'] }))
      .toEqual({ mode: 'periodic', prefer: ['codex-lane-journals', '/var/tmp/claude-lanes'] })
    expect(LosslessArchiveStartInput.parse({})).toEqual({ mode: 'backfill' })
    expect(LosslessArchiveStartInput.safeParse({ prefer: ['ok', 7] }).success).toBe(false)
    expect(LosslessArchiveStartInput.safeParse({ prefer: 'codex-lane-journals' }).success).toBe(false)
    expect(LosslessArchiveStartInput.safeParse({ prefer: [''] }).success).toBe(false)
  })
})

describe('lossless archive root-match retirement', () => {
  test('names only the roots that declare a match, with the pattern the sweep enforces', () => {
    const exclusions = losslessMatchExclusions({
      schemaVersion: 1, excluded: [], upstreamLayoutAttribution: [],
      roots: [
        { id: 'codex-sessions', provider: 'codex', path: '/root/.codex/sessions', purpose: 'transcripts', capture: 'opaque', optional: false },
        { id: 'codex-lane-journals', provider: 'codex', path: '/var/tmp/codex-lanes', purpose: 'transcripts', capture: 'opaque', optional: true, match: String.raw`^[^/]+/events(\.\d{6})?\.jsonl$` },
        { id: 'agy-lane-journals', provider: 'antigravity', path: '/var/tmp/agy-lanes', purpose: 'transcripts', capture: 'opaque', optional: true, match: String.raw`^[^/]+/events\.jsonl$` },
      ],
    })
    expect(exclusions).toEqual([
      { rootId: 'codex-lane-journals', pattern: String.raw`^[^/]+/events(\.\d{6})?\.jsonl$` },
      { rootId: 'agy-lane-journals', pattern: String.raw`^[^/]+/events\.jsonl$` },
    ])
  })

  test('is empty when no root declares a match, so the sweep runs no retirement statement', () => {
    expect(losslessMatchExclusions({
      schemaVersion: 1, excluded: [], upstreamLayoutAttribution: [],
      roots: [{ id: 'codex-sessions', provider: 'codex', path: '/root/.codex/sessions', purpose: 'transcripts', capture: 'opaque', optional: false }],
    })).toEqual([])
  })
})
