import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'

import {
  captureOpaqueFile,
  captureOpaqueRange,
  captureSqliteLogicalSnapshot,
  createStagedSqliteSnapshot,
  defaultLosslessArchiveInventory,
  inventoryApprovedRoots,
  losslessRootAdmits,
  restoreCapturedChunks,
  removeStagedSqliteSnapshot,
  verifyOpaquePrefix,
} from './lossless-archive-files.js'

const temporaryRoots: string[] = []
const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'lossless-archive-files-'))
  temporaryRoots.push(root)
  return root
}
const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('lossless provider inventory', () => {
  test('adapts approved provider layouts and inventories arbitrary depth without following boundary symlinks', async () => {
    const home = await fixtureRoot()
    const deep = join(home, '.codex', 'sessions', '1', '2', '3', '4', '5', '6', '7', '8', '9')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'session.jsonl'), '{malformed}\r\npartial')
    await mkdir(join(home, '.codex', 'archived_sessions'), { recursive: true })
    await writeFile(join(home, '.codex', 'archived_sessions', 'old.jsonl'), '{}\n')
    await mkdir(join(home, '.gemini', 'antigravity-cli', 'conversations'), { recursive: true })
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'conversations', 'agy-1.db'), Buffer.from('opaque'))
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'conversations', 'agy-1.db-wal'), Buffer.from('physical sidecar'))
    await mkdir(join(home, '.gemini', 'antigravity-cli', 'brain', 'agy-1'), { recursive: true })
    await writeFile(join(home, '.gemini', 'antigravity-cli', 'brain', 'agy-1', 'tool.bin'), new Uint8Array([0, 255, 1]))
    await symlink('/etc/passwd', join(home, '.codex', 'sessions', 'outside-link'))

    const config = defaultLosslessArchiveInventory(home)
    const report = await inventoryApprovedRoots(config)
    expect(config.roots.map((root) => root.id)).toContain('codex-archived-sessions')
    expect(config.roots.find((root) => root.id === 'codex-state-databases')?.include?.map((item) => item.relativePath)).toContain('state_5.sqlite')
    expect(config.roots.find((root) => root.id === 'codex-state-databases')?.include?.some((item) => item.relativePath.startsWith('logs_2.sqlite'))).toBe(false)
    expect(config.excluded.some((item) => item.pattern.includes('logs_2.sqlite'))).toBe(true)
    expect(config.upstreamLayoutAttribution).toHaveLength(2)
    expect(report.entries.some((entry) => entry.relativePath.endsWith(join('8', '9', 'session.jsonl')))).toBe(true)
    expect(report.entries.find((entry) => entry.rootId === 'antigravity-conversations')?.relatedConversationId).toBe('agy-1')
    expect(report.entries.find((entry) => entry.fileKind === 'sqlite-wal')?.relatedConversationId).toBe('agy-1')
    expect(report.entries.find((entry) => entry.rootId === 'antigravity-brain')?.relatedConversationId).toBe('agy-1')
    expect(report.entries.find((entry) => entry.fileKind === 'symlink')?.linkBoundary).toBe('outside-approved-root')
    expect(report.entries.some((entry) => entry.absolutePath === '/etc/passwd')).toBe(false)
    expect(report.gaps.some((gap) => gap.code === 'outside-approved-root')).toBe(true)
    expect(report.gaps.some((gap) => gap.rootId === 'claude-projects' && gap.code === 'missing-root')).toBe(true)
  })
})

describe('opaque file capture', () => {
  test('restores chunk-spanning malformed JSONL, partial bytes, Unicode, and invalid UTF-8 exactly', async () => {
    const root = await fixtureRoot()
    const path = join(root, 'session.jsonl')
    const longToolResult = Buffer.from(JSON.stringify({ type: 'tool_result', value: 'x'.repeat(1_200_000) }))
    const source = Buffer.concat([
      Buffer.from('  leading\r\n東京🙂\n{malformed}\n'),
      longToolResult,
      Buffer.from([10, 0, 255, 254, 128]),
      Buffer.from('partial-final-record'),
    ])
    await writeFile(path, source)

    const captured = await captureOpaqueFile(path, { approvedRoot: root })
    expect(captured.chunks.length).toBe(2)
    expect(captured.rawLength).toBe(source.length)
    expect(captured.rawSha256).toBe(digest(source))
    expect(captured.consistency).toBe('stable-file')
    const restored = await restoreCapturedChunks(captured.chunks, captured)
    expect(restored.equals(source)).toBe(true)
  })

  test('captures an append range and rejects a same-size rewrite of the archived prefix', async () => {
    const root = await fixtureRoot()
    const path = join(root, 'growing.jsonl')
    const prefix = Buffer.alloc(1024 * 1024, 17)
    const suffix = Buffer.from('terminal partial')
    await writeFile(path, Buffer.concat([prefix, suffix]))
    const first = await captureOpaqueRange(path, { approvedRoot: root, offset: 0, length: prefix.length })
    await expect(verifyOpaquePrefix(path, {
      approvedRoot: root, length: prefix.length, sha256: first.rawSha256,
      expected: { deviceId: first.source.deviceId, inodeId: first.source.inodeId },
    })).resolves.toMatchObject({ verified: true, rawLength: prefix.length })

    const rewritten = Buffer.from(await readFile(path))
    rewritten[100] = 99
    await writeFile(path, rewritten)
    await expect(verifyOpaquePrefix(path, {
      approvedRoot: root, length: prefix.length, sha256: first.rawSha256,
      expected: { deviceId: first.source.deviceId, inodeId: first.source.inodeId },
    })).rejects.toThrow('digest no longer matches')
  })

  test('fails restoration after encoded-byte corruption', async () => {
    const root = await fixtureRoot()
    const path = join(root, 'attachment.bin')
    await writeFile(path, Buffer.alloc(1024 * 1024 + 5, 23))
    const captured = await captureOpaqueFile(path, { approvedRoot: root })
    const damaged = captured.chunks.map((chunk) => ({ ...chunk, encodedBytes: new Uint8Array(chunk.encodedBytes) }))
    const first = damaged[0]!
    first.encodedBytes[20] = first.encodedBytes[20]! ^ 0xff
    await expect(restoreCapturedChunks(damaged)).rejects.toThrow('encoded archive chunk 0 failed verification')
  })

  test('refuses traversal outside the explicitly approved root', async () => {
    const approved = await fixtureRoot()
    const outside = await fixtureRoot()
    const path = join(outside, 'private.bin')
    await writeFile(path, 'secret')
    await expect(captureOpaqueFile(path, { approvedRoot: approved })).rejects.toThrow('outside approved root')
  })
})

describe('SQLite logical snapshots', () => {
  test('includes committed WAL data, unknown columns, and BLOB bytes without changing source files', async () => {
    const root = await fixtureRoot()
    const path = join(root, 'conversation.db')
    const writer = new Database(path, { create: true, strict: true })
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    writer.exec('CREATE TABLE unknown_provider_table (id INTEGER PRIMARY KEY, future_field TEXT, payload BLOB)')
    writer.query('INSERT INTO unknown_provider_table (future_field, payload) VALUES (?, ?)').run('東京', new Uint8Array([0, 255, 128, 7]))
    const walPath = `${path}-wal`
    const sourceBefore = await readFile(path)
    const walBefore = await readFile(walPath)

    const captured = await captureSqliteLogicalSnapshot(path, { approvedRoot: root })
    const snapshotBytes = await restoreCapturedChunks(captured.chunks, captured)
    const restoredPath = join(root, 'restored.sqlite')
    await writeFile(restoredPath, snapshotBytes)
    const restored = new Database(restoredPath, { readonly: true, strict: true })
    try {
      const row = restored.query<{ future_field: string; payload: Uint8Array }, []>(
        'SELECT future_field, payload FROM unknown_provider_table',
      ).get()
      expect(row?.future_field).toBe('東京')
      expect(Buffer.from(row!.payload)).toEqual(Buffer.from([0, 255, 128, 7]))
      expect(restored.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check).toBe('ok')
    } finally { restored.close() }
    expect(Buffer.from(await readFile(path)).equals(sourceBefore)).toBe(true)
    expect(Buffer.from(await readFile(walPath)).equals(walBefore)).toBe(true)
    expect(captured.consistency).toBe('logical-sqlite-snapshot')
    expect(captured.limitations.join(' ')).toContain('not the exact physical')
    writer.close()
  })

  test('uses an online backup file for snapshots above the in-memory bound and resumes it by staging key', async () => {
    const root = await fixtureRoot()
    const stagingRoot = join(root, 'staging')
    const path = join(root, 'large-conversation.db')
    const writer = new Database(path, { create: true, strict: true })
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE payloads (id INTEGER PRIMARY KEY, payload BLOB)')
    writer.query('INSERT INTO payloads (payload) VALUES (?)').run(new Uint8Array(5 * 1024 * 1024).fill(91))
    const sourceBefore = await readFile(path)
    const walBefore = await readFile(`${path}-wal`)

    await expect(captureSqliteLogicalSnapshot(path, { approvedRoot: root }))
      .rejects.toThrow('use createStagedSqliteSnapshot')
    const staged = await createStagedSqliteSnapshot(path, {
      approvedRoot: root, stagingRoot, stagingKey: 'source-generation-active',
    })
    expect(staged.rawLength).toBeGreaterThan(4 * 1024 * 1024)
    const resumed = await createStagedSqliteSnapshot(path, {
      approvedRoot: root, stagingRoot, stagingKey: 'source-generation-active',
    })
    expect(resumed).toMatchObject({ path: staged.path, rawLength: staged.rawLength, rawSha256: staged.rawSha256, reused: true })
    const first = await captureOpaqueRange(staged.path, {
      approvedRoot: stagingRoot, offset: 0, length: 1024 * 1024,
    })
    expect(first.rawLength).toBe(1024 * 1024)
    expect(Buffer.from(await readFile(path)).equals(sourceBefore)).toBe(true)
    expect(Buffer.from(await readFile(`${path}-wal`)).equals(walBefore)).toBe(true)
    writer.close()
    // Identity is (device, inode). Build the replacement while the original still holds its inode, then
    // rename it over: a file created after the rm can reuse the freed inode on a disk filesystem.
    const replacement = new Database(`${path}.replacement`, { create: true, strict: true })
    replacement.exec('CREATE TABLE replacement (id INTEGER PRIMARY KEY)')
    replacement.close()
    await rm(path)
    await rm(`${path}-wal`, { force: true })
    await rm(`${path}-shm`, { force: true })
    await rename(`${path}.replacement`, path)
    await expect(createStagedSqliteSnapshot(path, {
      approvedRoot: root, stagingRoot, stagingKey: 'source-generation-active',
    })).rejects.toThrow('different source identity')
    await removeStagedSqliteSnapshot(stagingRoot, staged.stagingKey)
    await expect(readFile(staged.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('root match filter', () => {
  const laneMatch = String.raw`^[^/]+/events(\.\d{6})?\.jsonl$`

  const laneTree = async (): Promise<string> => {
    const root = await fixtureRoot()
    const lane = join(root, 'lane-a')
    await mkdir(join(lane, 'red-tree'), { recursive: true })
    await Promise.all([
      writeFile(join(lane, 'events.jsonl'), '{"a":1}\n'),
      writeFile(join(lane, 'events.000001.jsonl'), '{"a":2}\n'),
      writeFile(join(lane, 'status.json'), '{}'),
      writeFile(join(lane, 'supervisor.pid'), '42'),
      writeFile(join(lane, 'red-tree', 'x.out'), 'noise'),
    ])
    return root
  }

  test('inventories only the files whose relative path matches, never the surrounding lane noise', async () => {
    const root = await laneTree()
    const report = await inventoryApprovedRoots({
      schemaVersion: 1, excluded: [], upstreamLayoutAttribution: [],
      roots: [{ id: 'codex-lane-journals', provider: 'codex', path: root, purpose: 'transcripts', capture: 'opaque', optional: true, match: laneMatch }],
    })
    expect(report.entries.map((entry) => entry.relativePath).sort())
      .toEqual(['lane-a/events.000001.jsonl', 'lane-a/events.jsonl'])
    expect(report.gaps).toEqual([])
  })

  test('inventories every file when a root declares no match', async () => {
    const root = await laneTree()
    const report = await inventoryApprovedRoots({
      schemaVersion: 1, excluded: [], upstreamLayoutAttribution: [],
      roots: [{ id: 'codex-lane-journals', provider: 'codex', path: root, purpose: 'transcripts', capture: 'opaque', optional: true }],
    })
    expect(report.entries).toHaveLength(5)
  })

  test('reports which relative paths a root admits', () => {
    const root = { id: 'r', provider: 'codex', path: '/var/tmp/codex-lanes', purpose: 'transcripts', capture: 'opaque', optional: true, match: laneMatch } as const
    expect(losslessRootAdmits(root, 'lane-a/events.jsonl')).toBe(true)
    expect(losslessRootAdmits(root, 'lane-a/events.000001.jsonl')).toBe(true)
    expect(losslessRootAdmits(root, 'lane-a/status.json')).toBe(false)
    expect(losslessRootAdmits(root, 'lane-a/red-tree/x.out')).toBe(false)
    expect(losslessRootAdmits(root, 'events.jsonl')).toBe(false)
    expect(losslessRootAdmits({}, 'lane-a/status.json')).toBe(true)
  })
})
