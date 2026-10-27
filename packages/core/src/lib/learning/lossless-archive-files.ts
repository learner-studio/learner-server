import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants, createReadStream } from 'node:fs'
import type { Stats } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzip, gunzip } from 'node:zlib'

const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)

export const LOSSLESS_ARCHIVE_MIN_CHUNK_BYTES = 1024 * 1024
export const LOSSLESS_ARCHIVE_DEFAULT_CHUNK_BYTES = 1024 * 1024
export const LOSSLESS_ARCHIVE_MAX_CHUNK_BYTES = 4 * 1024 * 1024

export type LosslessArchiveProvider = 'codex' | 'claude' | 'antigravity'
export type LosslessArchiveFileKind = 'jsonl' | 'sqlite' | 'sqlite-wal' | 'sqlite-shm' | 'sqlite-journal' | 'binary' | 'symlink' | 'unknown'

export type LosslessArchiveRoot = {
  id: string
  provider: LosslessArchiveProvider
  path: string
  purpose: 'transcripts' | 'archive' | 'state' | 'history' | 'session-sidecars'
  capture: 'opaque' | 'sqlite-logical-and-opaque'
  optional: boolean
  relationship?: 'antigravity-conversation-id'
  include?: Array<{ relativePath: string; optional: boolean }>
  /**
   * Anchored pattern the root-relative path of a FILE must satisfy to be
   * inventoried. Directories are still traversed, so a match narrows what is
   * archived without narrowing what is looked at. A string rather than a
   * RegExp so the identical pattern can be handed to PostgreSQL, which shares
   * JS's `\d`/`\w` shorthands, when retiring already-discovered rows.
   */
  match?: string
}

export type LosslessArchiveInventoryConfig = {
  schemaVersion: 1
  roots: LosslessArchiveRoot[]
  excluded: Array<{ pattern: string; reason: string }>
  upstreamLayoutAttribution: Array<{ repository: string; revision: string; paths: string[]; use: 'data-adapted' }>
}

export type InventoryEntry = {
  provider: LosslessArchiveProvider
  rootId: string
  absolutePath: string
  relativePath: string
  fileKind: LosslessArchiveFileKind
  byteLength: number
  deviceId: string
  inodeId: string
  mode: number
  mtimeNs: string
  ctimeNs: string
  linkTarget?: string
  linkBoundary?: 'within-approved-root' | 'outside-approved-root' | 'unresolved'
  relatedConversationId?: string
}

export type InventoryGap = {
  provider: LosslessArchiveProvider
  rootId: string
  relativePath?: string
  code: 'missing-root' | 'unreadable-root' | 'unreadable-entry' | 'outside-approved-root'
  reason: string
}

export type LosslessArchiveInventoryReport = {
  schemaVersion: 1
  observedAt: string
  entries: InventoryEntry[]
  gaps: InventoryGap[]
  exclusions: LosslessArchiveInventoryConfig['excluded']
}

export type ArchiveFileIdentity = {
  deviceId: string
  inodeId: string
  mode: number
  size: number
  mtimeNs: string
  ctimeNs: string
}

export type CapturedArchiveChunk = {
  ordinal: number
  offset: number
  rawLength: number
  rawSha256: string
  codec: 'gzip'
  codecVersion: 'rfc1952'
  encodedLength: number
  encodedSha256: string
  encodedBytes: Uint8Array
}

export type CapturedArchiveBytes = {
  captureKind: 'opaque-complete' | 'opaque-range' | 'sqlite-logical-snapshot'
  consistency: 'stable-file' | 'stable-prefix' | 'logical-sqlite-snapshot'
  coverage: 'complete' | 'prefix'
  source: ArchiveFileIdentity
  captureStartedAt: string
  captureEndedAt: string
  offset: number
  rawLength: number
  rawSha256: string
  chunks: CapturedArchiveChunk[]
  limitations: string[]
}

export type StagedSqliteSnapshot = {
  path: string
  stagingKey: string
  rawLength: number
  rawSha256: string
  source: ArchiveFileIdentity
  stagingIdentity: ArchiveFileIdentity
  createdAt: string
  completedAt: string
  reused: boolean
  limitations: string[]
}

type CaptureOptions = {
  approvedRoot: string
  chunkBytes?: number
  expected?: Partial<Pick<ArchiveFileIdentity, 'deviceId' | 'inodeId' | 'size' | 'mtimeNs' | 'ctimeNs'>>
}

type CaptureRangeOptions = CaptureOptions & { offset: number; length: number }
type VerifyPrefixOptions = CaptureOptions & { length: number; sha256: string }

const ns = (value: bigint | undefined, milliseconds: number): string =>
  (value ?? BigInt(Math.trunc(milliseconds * 1_000_000))).toString()

const identityFromStat = (details: Stats): ArchiveFileIdentity => {
  const big = details as Stats & { mtimeNs?: bigint; ctimeNs?: bigint }
  return {
    deviceId: String(details.dev), inodeId: String(details.ino), mode: details.mode,
    size: Number(details.size), mtimeNs: ns(big.mtimeNs, details.mtimeMs), ctimeNs: ns(big.ctimeNs, details.ctimeMs),
  }
}

const sameIdentity = (left: ArchiveFileIdentity, right: ArchiveFileIdentity): boolean =>
  left.deviceId === right.deviceId && left.inodeId === right.inodeId

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const sha256File = async (path: string): Promise<string> => {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path, { highWaterMark: LOSSLESS_ARCHIVE_MAX_CHUNK_BYTES })) hash.update(bytes as Buffer)
  return hash.digest('hex')
}

const checkedChunkBytes = (value = LOSSLESS_ARCHIVE_DEFAULT_CHUNK_BYTES): number => {
  if (!Number.isSafeInteger(value) || value < LOSSLESS_ARCHIVE_MIN_CHUNK_BYTES || value > LOSSLESS_ARCHIVE_MAX_CHUNK_BYTES) {
    throw new Error(`chunkBytes must be an integer between ${LOSSLESS_ARCHIVE_MIN_CHUNK_BYTES} and ${LOSSLESS_ARCHIVE_MAX_CHUNK_BYTES}`)
  }
  return value
}

const isWithin = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

const approvedPaths = async (path: string, approvedRoot: string): Promise<{ path: string; root: string }> => {
  const [root, source] = await Promise.all([realpath(approvedRoot), realpath(path)])
  if (!isWithin(root, source)) throw new Error('source resolves outside approved root')
  const link = await lstat(path)
  if (link.isSymbolicLink()) throw new Error('opaque capture refuses symlinks; archive link metadata from inventory')
  if (!link.isFile()) throw new Error('opaque capture requires a regular file')
  return { path: source, root }
}

const assertExpected = (actual: ArchiveFileIdentity, expected: CaptureOptions['expected']): void => {
  if (!expected) return
  for (const key of ['deviceId', 'inodeId', 'size', 'mtimeNs', 'ctimeNs'] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) throw new Error(`source ${key} changed before capture`)
  }
}

export const losslessRootAdmits = (root: Pick<LosslessArchiveRoot, 'match'>, relativePath: string): boolean =>
  !root.match || new RegExp(root.match).test(relativePath)

export const defaultLosslessArchiveInventory = (home = homedir()): LosslessArchiveInventoryConfig => ({
  schemaVersion: 1,
  roots: [
    { id: 'codex-sessions', provider: 'codex', path: join(home, '.codex', 'sessions'), purpose: 'transcripts', capture: 'opaque', optional: false },
    { id: 'codex-archived-sessions', provider: 'codex', path: join(home, '.codex', 'archived_sessions'), purpose: 'archive', capture: 'opaque', optional: true },
    { id: 'codex-history', provider: 'codex', path: join(home, '.codex', 'history.jsonl'), purpose: 'history', capture: 'opaque', optional: true },
    { id: 'codex-session-index', provider: 'codex', path: join(home, '.codex', 'session_index.jsonl'), purpose: 'state', capture: 'opaque', optional: true },
    {
      id: 'codex-state-databases', provider: 'codex', path: join(home, '.codex'), purpose: 'state',
      capture: 'sqlite-logical-and-opaque', optional: true,
      include: ['state_5.sqlite', 'thread_history_1.sqlite', 'memories_1.sqlite', 'goals_1.sqlite', 'queue_1.sqlite']
        .flatMap((name) => ['', '-wal', '-shm', '-journal'].map((suffix) => ({ relativePath: `${name}${suffix}`, optional: true }))),
    },
    { id: 'claude-projects', provider: 'claude', path: join(home, '.claude', 'projects'), purpose: 'transcripts', capture: 'opaque', optional: false },
    { id: 'claude-history', provider: 'claude', path: join(home, '.claude', 'history.jsonl'), purpose: 'history', capture: 'opaque', optional: true },
    { id: 'antigravity-conversations', provider: 'antigravity', path: join(home, '.gemini', 'antigravity-cli', 'conversations'), purpose: 'transcripts', capture: 'sqlite-logical-and-opaque', optional: false, relationship: 'antigravity-conversation-id' },
    { id: 'antigravity-history', provider: 'antigravity', path: join(home, '.gemini', 'antigravity-cli', 'history.jsonl'), purpose: 'history', capture: 'opaque', optional: true, relationship: 'antigravity-conversation-id' },
    { id: 'antigravity-brain', provider: 'antigravity', path: join(home, '.gemini', 'antigravity-cli', 'brain'), purpose: 'session-sidecars', capture: 'opaque', optional: true, relationship: 'antigravity-conversation-id' },
  ],
  excluded: [
    { pattern: 'credentials and auth files', reason: 'not transcript/archive/state payloads; access secrets remain outside archive scope' },
    { pattern: 'arbitrary workspace paths', reason: 'only explicitly approved provider roots and separately approved referenced attachments are in scope' },
    { pattern: 'remote URLs', reason: 'inventory never fetches remote content or accesses additional accounts' },
    { pattern: 'codex logs_2.sqlite (and -wal/-shm/-journal)', reason: 'Codex internal tracing ring buffer (~2k rows, rewritten continuously): no conversation content, and every snapshot is a near-new 69 MB file that cannot deduplicate (243 MB/day, 12 GB of the archive by 2026-10-27)' },
  ],
  upstreamLayoutAttribution: [
    { repository: 'rush-skills/sessionvault', revision: '7827732a2bff460a232078793823d7ac1ecb7e62', paths: ['src/registry.js'], use: 'data-adapted' },
    { repository: 'korvol/codeteleport', revision: '6548ff1518d0ab0f0d293a4fba5a21c06bcd4ff6', paths: ['src/core/agents/antigravity/local.ts', 'src/core/agents/antigravity/bundle.ts'], use: 'data-adapted' },
  ],
})

const kindForPath = (path: string): LosslessArchiveFileKind => {
  if (path.endsWith('.jsonl')) return 'jsonl'
  if (path.endsWith('-wal')) return 'sqlite-wal'
  if (path.endsWith('-shm')) return 'sqlite-shm'
  if (path.endsWith('-journal')) return 'sqlite-journal'
  if (/\.(?:db|sqlite|sqlite3)$/i.test(path)) return 'sqlite'
  return 'unknown'
}

const relatedConversationId = (root: LosslessArchiveRoot, relativePath: string): string | undefined => {
  if (root.relationship !== 'antigravity-conversation-id') return undefined
  if (root.id === 'antigravity-conversations') {
    const match = /^(.*)\.db(?:-(?:wal|shm|journal))?$/.exec(basename(relativePath))
    if (match?.[1]) return match[1]
  }
  if (root.id === 'antigravity-brain') return relativePath.split(sep)[0] || undefined
  return undefined
}

export async function inventoryApprovedRoots(config: LosslessArchiveInventoryConfig): Promise<LosslessArchiveInventoryReport> {
  const entries: InventoryEntry[] = []
  const gaps: InventoryGap[] = []
  const inspect = async (
    root: LosslessArchiveRoot,
    absolutePath: string,
    rootReal: string,
    relativePath: string,
    optional = false,
  ): Promise<void> => {
    let details: Awaited<ReturnType<typeof lstat>>
    try { details = await lstat(absolutePath, { bigint: true }) }
    catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      gaps.push({ provider: root.provider, rootId: root.id, relativePath, code: 'unreadable-entry', reason: error instanceof Error ? error.message : String(error) })
      return
    }
    if (details.isSymbolicLink()) {
      let linkTarget = ''
      let linkBoundary: InventoryEntry['linkBoundary'] = 'unresolved'
      try {
        const { readlink } = await import('node:fs/promises')
        linkTarget = await readlink(absolutePath)
        const target = await realpath(resolve(dirname(absolutePath), linkTarget))
        linkBoundary = isWithin(rootReal, target) ? 'within-approved-root' : 'outside-approved-root'
        if (linkBoundary === 'outside-approved-root') gaps.push({
          provider: root.provider, rootId: root.id, relativePath, code: 'outside-approved-root',
          reason: 'symlink target is outside the approved root and was not followed',
        })
      } catch { /* broken links remain explicit inventory entries */ }
      if (!losslessRootAdmits(root, relativePath)) return
      const relationship = relatedConversationId(root, relativePath)
      entries.push({
        provider: root.provider, rootId: root.id, absolutePath, relativePath, fileKind: 'symlink',
        byteLength: Number(details.size), deviceId: String(details.dev), inodeId: String(details.ino), mode: Number(details.mode),
        mtimeNs: String(details.mtimeNs), ctimeNs: String(details.ctimeNs), linkTarget, linkBoundary,
        ...(relationship ? { relatedConversationId: relationship } : {}),
      })
      return
    }
    if (details.isDirectory()) {
      const children = await readdir(absolutePath, { withFileTypes: true }).catch((error: unknown) => {
        gaps.push({ provider: root.provider, rootId: root.id, relativePath, code: 'unreadable-entry', reason: error instanceof Error ? error.message : String(error) })
        return null
      })
      if (!children) return
      for (const child of children) {
        const childRelative = relativePath === '.' ? child.name : join(relativePath, child.name)
        await inspect(root, join(absolutePath, child.name), rootReal, childRelative)
      }
      return
    }
    if (!details.isFile()) return
    // Filtered here rather than at readdir: a directory carries no matchable
    // relative path of its own, so pruning the walk would need the pattern's
    // depth, while an unmatched file simply never becomes an entry.
    if (!losslessRootAdmits(root, relativePath)) return
    const relationship = relatedConversationId(root, relativePath)
    entries.push({
      provider: root.provider, rootId: root.id, absolutePath, relativePath, fileKind: kindForPath(absolutePath),
      byteLength: Number(details.size), deviceId: String(details.dev), inodeId: String(details.ino), mode: Number(details.mode),
      mtimeNs: String(details.mtimeNs), ctimeNs: String(details.ctimeNs),
      ...(relationship ? { relatedConversationId: relationship } : {}),
    })
  }

  for (const root of config.roots) {
    let rootReal: string
    try { rootReal = await realpath(root.path) }
    catch (error) {
      if (root.optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      const code = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing-root' : 'unreadable-root'
      gaps.push({ provider: root.provider, rootId: root.id, code, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    try {
      if (root.include) {
        for (const item of root.include) {
          const target = resolve(rootReal, item.relativePath)
          if (!isWithin(rootReal, target)) {
            gaps.push({ provider: root.provider, rootId: root.id, relativePath: item.relativePath, code: 'outside-approved-root', reason: 'configured include is outside its approved root' })
            continue
          }
          await inspect(root, target, rootReal, item.relativePath, item.optional)
        }
      } else await inspect(root, root.path, rootReal, '.')
    }
    catch (error) {
      gaps.push({ provider: root.provider, rootId: root.id, code: 'unreadable-root', reason: error instanceof Error ? error.message : String(error) })
    }
  }
  entries.sort((a, b) => a.provider.localeCompare(b.provider) || a.rootId.localeCompare(b.rootId) || a.relativePath.localeCompare(b.relativePath))
  return { schemaVersion: 1, observedAt: new Date().toISOString(), entries, gaps, exclusions: config.excluded }
}

async function encodeChunks(rawChunks: Array<{ offset: number; bytes: Buffer }>): Promise<CapturedArchiveChunk[]> {
  return Promise.all(rawChunks.map(async ({ offset, bytes }, ordinal) => {
    const encoded = await gzipAsync(bytes, { level: 6 })
    const decoded = await gunzipAsync(encoded)
    if (!decoded.equals(bytes)) throw new Error(`gzip verification failed for chunk ${ordinal}`)
    return {
      ordinal, offset, rawLength: bytes.length, rawSha256: sha256(bytes), codec: 'gzip' as const,
      codecVersion: 'rfc1952' as const, encodedLength: encoded.length, encodedSha256: sha256(encoded),
      encodedBytes: new Uint8Array(encoded),
    }
  }))
}

async function readExactRange(path: string, approvedRoot: string, offset: number, length: number, chunkBytes: number, expected?: CaptureOptions['expected']) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error('offset and length must be non-negative safe integers')
  const approved = await approvedPaths(path, approvedRoot)
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const handle = await open(approved.path, constants.O_RDONLY | noFollow)
  try {
    const before = identityFromStat(await handle.stat())
    assertExpected(before, expected)
    if (offset + length > before.size) throw new Error('requested range exceeds observed source size')
    const rawChunks: Array<{ offset: number; bytes: Buffer }> = []
    const aggregate = createHash('sha256')
    let position = offset
    while (position < offset + length) {
      const bytes = Buffer.allocUnsafe(Math.min(chunkBytes, offset + length - position))
      const read = await handle.read(bytes, 0, bytes.length, position)
      if (read.bytesRead !== bytes.length) throw new Error('source disappeared or truncated during capture')
      const exact = bytes.subarray(0, read.bytesRead)
      rawChunks.push({ offset: position, bytes: exact })
      aggregate.update(exact)
      position += read.bytesRead
    }
    const afterRead = identityFromStat(await handle.stat())
    if (!sameIdentity(before, afterRead) || afterRead.size < offset + length) throw new Error('source identity changed during capture')

    // Re-read the captured interval from the same descriptor. This distinguishes a
    // stable prefix from an append and rejects in-place rewrites during capture.
    const verify = createHash('sha256')
    position = offset
    while (position < offset + length) {
      const bytes = Buffer.allocUnsafe(Math.min(chunkBytes, offset + length - position))
      const read = await handle.read(bytes, 0, bytes.length, position)
      if (read.bytesRead !== bytes.length) throw new Error('source changed during capture verification')
      verify.update(bytes)
      position += read.bytesRead
    }
    const rawSha256 = aggregate.digest('hex')
    if (verify.digest('hex') !== rawSha256) throw new Error('captured range changed during verification')
    const afterVerify = identityFromStat(await handle.stat())
    if (!sameIdentity(before, afterVerify) || afterVerify.size < offset + length) throw new Error('source identity changed during capture verification')
    if (afterVerify.size === before.size && (afterVerify.mtimeNs !== before.mtimeNs || afterVerify.ctimeNs !== before.ctimeNs)) {
      throw new Error('source changed without an append during capture verification')
    }
    return { before, after: afterVerify, rawChunks, rawSha256 }
  } finally { await handle.close() }
}

export async function captureOpaqueRange(path: string, options: CaptureRangeOptions): Promise<CapturedArchiveBytes> {
  const captureStartedAt = new Date().toISOString()
  const chunkBytes = checkedChunkBytes(options.chunkBytes)
  const captured = await readExactRange(path, options.approvedRoot, options.offset, options.length, chunkBytes, options.expected)
  return {
    captureKind: 'opaque-range', consistency: 'stable-prefix', coverage: 'prefix', source: captured.before,
    captureStartedAt, captureEndedAt: new Date().toISOString(), offset: options.offset, rawLength: options.length,
    rawSha256: captured.rawSha256, chunks: await encodeChunks(captured.rawChunks),
    limitations: captured.after.size > captured.before.size
      ? ['source appended during capture; only the verified requested prefix is represented']
      : ['polling cannot prove capture of transient versions between observations'],
  }
}

export async function verifyOpaquePrefix(
  path: string,
  options: VerifyPrefixOptions,
): Promise<{ verified: true; rawLength: number; rawSha256: string; source: ArchiveFileIdentity }> {
  const chunkBytes = checkedChunkBytes(options.chunkBytes)
  if (!Number.isSafeInteger(options.length) || options.length < 0) throw new Error('prefix length must be a non-negative safe integer')
  const approved = await approvedPaths(path, options.approvedRoot)
  const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0
  const handle = await open(approved.path, constants.O_RDONLY | noFollow)
  try {
    const before = identityFromStat(await handle.stat())
    assertExpected(before, options.expected)
    if (options.length > before.size) throw new Error('verified prefix exceeds observed source size')
    const hashPass = async (): Promise<string> => {
      const hash = createHash('sha256')
      let position = 0
      while (position < options.length) {
        const bytes = Buffer.allocUnsafe(Math.min(chunkBytes, options.length - position))
        const read = await handle.read(bytes, 0, bytes.length, position)
        if (read.bytesRead !== bytes.length) throw new Error('source changed during prefix verification')
        hash.update(bytes)
        position += read.bytesRead
      }
      return hash.digest('hex')
    }
    const first = await hashPass()
    if (first !== options.sha256) throw new Error('previously captured prefix digest no longer matches the source')
    if (await hashPass() !== first) throw new Error('source prefix changed during verification')
    const after = identityFromStat(await handle.stat())
    if (!sameIdentity(before, after) || after.size < options.length) throw new Error('source identity changed during prefix verification')
    if (after.size === before.size && (after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs)) {
      throw new Error('source changed without an append during prefix verification')
    }
    return { verified: true, rawLength: options.length, rawSha256: first, source: after }
  } finally { await handle.close() }
}

export async function captureOpaqueFile(path: string, options: CaptureOptions): Promise<CapturedArchiveBytes> {
  const captureStartedAt = new Date().toISOString()
  const chunkBytes = checkedChunkBytes(options.chunkBytes)
  const approved = await approvedPaths(path, options.approvedRoot)
  const observed = identityFromStat(await stat(approved.path))
  assertExpected(observed, options.expected)
  const captured = await readExactRange(path, options.approvedRoot, 0, observed.size, chunkBytes, { ...options.expected, size: observed.size })
  if (captured.after.size !== captured.before.size || captured.after.mtimeNs !== captured.before.mtimeNs || captured.after.ctimeNs !== captured.before.ctimeNs) {
    throw new Error('complete source was not stable for the full capture window')
  }
  return {
    captureKind: 'opaque-complete', consistency: 'stable-file', coverage: 'complete', source: captured.before,
    captureStartedAt, captureEndedAt: new Date().toISOString(), offset: 0, rawLength: captured.before.size,
    rawSha256: captured.rawSha256, chunks: await encodeChunks(captured.rawChunks),
    limitations: ['polling cannot prove capture of transient versions between observations'],
  }
}

export async function restoreCapturedChunks(
  chunks: readonly CapturedArchiveChunk[],
  expected?: { rawLength: number; rawSha256: string },
): Promise<Buffer> {
  const restored: Buffer[] = []
  let expectedOffset = chunks[0]?.offset ?? 0
  for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
    const chunk = chunks[ordinal]!
    if (chunk.ordinal !== ordinal || chunk.offset !== expectedOffset) throw new Error('archive chunks contain an ordinal or byte-offset gap')
    const encoded = Buffer.from(chunk.encodedBytes)
    if (encoded.length !== chunk.encodedLength || sha256(encoded) !== chunk.encodedSha256) throw new Error(`encoded archive chunk ${ordinal} failed verification`)
    const raw = await gunzipAsync(encoded)
    if (raw.length !== chunk.rawLength || sha256(raw) !== chunk.rawSha256) throw new Error(`raw archive chunk ${ordinal} failed verification`)
    restored.push(raw)
    expectedOffset += raw.length
  }
  const result = Buffer.concat(restored)
  if (expected && (result.length !== expected.rawLength || sha256(result) !== expected.rawSha256)) {
    throw new Error('restored archive aggregate failed verification')
  }
  return result
}

export async function captureSqliteLogicalSnapshot(path: string, options: CaptureOptions): Promise<CapturedArchiveBytes> {
  const captureStartedAt = new Date().toISOString()
  const chunkBytes = checkedChunkBytes(options.chunkBytes)
  const approved = await approvedPaths(path, options.approvedRoot)
  const source = identityFromStat(await stat(approved.path))
  assertExpected(source, options.expected)
  const walBytes = await stat(`${approved.path}-wal`).then((details) => details.size).catch(() => 0)
  if (source.size + walBytes > LOSSLESS_ARCHIVE_MAX_CHUNK_BYTES) {
    throw new Error('SQLite snapshot exceeds in-memory capture bound; use createStagedSqliteSnapshot')
  }
  const { Database } = await import('bun:sqlite')
  const database = new Database(approved.path, { readonly: true, strict: true })
  let snapshot: Uint8Array
  try {
    database.exec('BEGIN')
    snapshot = database.serialize('main')
    database.exec('COMMIT')
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK')
    throw error
  } finally { database.close() }
  if (snapshot.byteLength > LOSSLESS_ARCHIVE_MAX_CHUNK_BYTES) {
    throw new Error('SQLite snapshot exceeds in-memory capture bound; use createStagedSqliteSnapshot')
  }

  const sourceAfter = identityFromStat(await stat(await realpath(path)))
  if (!sameIdentity(source, sourceAfter)) throw new Error('SQLite source identity changed during logical snapshot')
  const approvedRootAfter = await realpath(options.approvedRoot)
  if (!isWithin(approvedRootAfter, await realpath(path))) throw new Error('SQLite source resolved outside approved root after snapshot')

  const verificationRoot = await mkdtemp(join(tmpdir(), 'lossless-sqlite-verify-'))
  const verificationPath = join(verificationRoot, 'snapshot.sqlite')
  try {
    await writeFile(verificationPath, snapshot, { flag: 'wx', mode: 0o600 })
    const restored = new Database(verificationPath, { readonly: true, strict: true })
    try {
      const result = restored.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
      if (result?.integrity_check !== 'ok') throw new Error(`SQLite snapshot integrity check failed: ${result?.integrity_check ?? 'no result'}`)
    } finally { restored.close() }
  } finally { await rm(verificationRoot, { recursive: true, force: true }) }

  const raw = Buffer.from(snapshot)
  const rawChunks: Array<{ offset: number; bytes: Buffer }> = []
  for (let offset = 0; offset < raw.length; offset += chunkBytes) rawChunks.push({ offset, bytes: raw.subarray(offset, offset + chunkBytes) })
  return {
    captureKind: 'sqlite-logical-snapshot', consistency: 'logical-sqlite-snapshot', coverage: 'complete', source,
    captureStartedAt, captureEndedAt: new Date().toISOString(), offset: 0, rawLength: raw.length,
    rawSha256: sha256(raw), chunks: await encodeChunks(rawChunks),
    limitations: [
      'SQLite serialization is a transactionally consistent logical snapshot, not the exact physical database, WAL, or journal bytes',
      'physical multi-file consistency requires quiescence or a supported atomic filesystem snapshot and is not claimed',
    ],
  }
}

const SQLITE_BACKUP_SCRIPT = String.raw`
import pathlib, sqlite3, sys
source_path, destination_path = sys.argv[1], sys.argv[2]
source_uri = pathlib.Path(source_path).resolve().as_uri() + '?mode=ro'
source = sqlite3.connect(source_uri, uri=True, timeout=30)
destination = sqlite3.connect(destination_path, timeout=30)
try:
    source.backup(destination, pages=256, sleep=0.05)
    row = destination.execute('PRAGMA integrity_check').fetchone()
    if not row or row[0] != 'ok':
        raise RuntimeError('snapshot integrity check failed')
finally:
    destination.close()
    source.close()
`

const runSqliteBackup = async (pythonExecutable: string, sourcePath: string, destinationPath: string): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(pythonExecutable, ['-c', SQLITE_BACKUP_SCRIPT, sourcePath, destinationPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (bytes: Buffer) => { if (stderr.length < 4_000) stderr += bytes.toString('utf8').slice(0, 4_000 - stderr.length) })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0
      ? resolvePromise()
      : reject(new Error(`SQLite online backup failed (${signal ?? `exit ${code}`}): ${stderr.trim().slice(0, 500)}`)))
  })

const safeStagingPath = async (stagingRoot: string, stagingKey: string): Promise<{ root: string; path: string; metadataPath: string }> => {
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(stagingKey)) throw new Error('SQLite staging key contains unsupported characters')
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  await chmod(stagingRoot, 0o700)
  const root = await realpath(stagingRoot)
  const path = resolve(root, `${stagingKey}.sqlite`)
  if (!isWithin(root, path)) throw new Error('SQLite staging path escapes its approved root')
  return { root, path, metadataPath: resolve(root, `${stagingKey}.json`) }
}

export async function inspectStagedSqliteSnapshot(
  stagingRoot: string,
  stagingKey: string,
): Promise<Omit<StagedSqliteSnapshot, 'source' | 'createdAt' | 'completedAt' | 'reused' | 'limitations'>> {
  const target = await safeStagingPath(stagingRoot, stagingKey)
  const details = await lstat(target.path)
  if (!details.isFile() || details.isSymbolicLink()) throw new Error('SQLite staging snapshot is not a regular file')
  const { Database } = await import('bun:sqlite')
  const database = new Database(target.path, { readonly: true, strict: true })
  try {
    const result = database.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
    if (result?.integrity_check !== 'ok') throw new Error(`SQLite staged snapshot integrity check failed: ${result?.integrity_check ?? 'no result'}`)
  } finally { database.close() }
  return {
    path: target.path, stagingKey, rawLength: details.size, rawSha256: await sha256File(target.path),
    stagingIdentity: identityFromStat(details),
  }
}

export async function createStagedSqliteSnapshot(
  path: string,
  options: CaptureOptions & { stagingRoot: string; stagingKey: string; pythonExecutable?: string },
): Promise<StagedSqliteSnapshot> {
  const approved = await approvedPaths(path, options.approvedRoot)
  const source = identityFromStat(await stat(approved.path))
  assertExpected(source, options.expected)
  const target = await safeStagingPath(options.stagingRoot, options.stagingKey)
  const stored = await readFile(target.metadataPath, 'utf8').then((value) => JSON.parse(value) as StagedSqliteSnapshot).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (stored) {
    let stagedDetails: Stats | null
    try { stagedDetails = await lstat(target.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await unlink(target.metadataPath)
      stagedDetails = null
    }
    if (stagedDetails) {
      if (!stagedDetails.isFile() || stagedDetails.isSymbolicLink()) throw new Error('SQLite staging snapshot is not a regular file')
      const stagingIdentity = identityFromStat(stagedDetails)
      if (stored.path !== target.path || stored.stagingKey !== options.stagingKey
        || stored.rawLength !== stagedDetails.size || !/^[0-9a-f]{64}$/.test(stored.rawSha256)
        || (stored.stagingIdentity && (!sameIdentity(stored.stagingIdentity, stagingIdentity)
          || stored.stagingIdentity.size !== stagingIdentity.size
          || stored.stagingIdentity.mtimeNs !== stagingIdentity.mtimeNs
          || stored.stagingIdentity.ctimeNs !== stagingIdentity.ctimeNs))) {
        throw new Error('SQLite staging metadata does not match the staged file identity')
      }
      if (!sameIdentity(stored.source, source)) throw new Error('SQLite staging snapshot belongs to a different source identity')
      if (!stored.stagingIdentity) {
        // Descriptors written before stagingIdentity was added can be upgraded
        // without replacing their snapshot. The full digest is deliberately
        // recomputed first: length alone cannot establish that the bytes still
        // match the already-persisted writing manifest.
        if (await sha256File(target.path) !== stored.rawSha256) {
          throw new Error('Legacy SQLite staging descriptor digest does not match the staged file')
        }
        const upgraded = { ...stored, stagingIdentity }
        const upgradePath = `${target.metadataPath}.${randomUUID()}.partial`
        try {
          await writeFile(upgradePath, `${JSON.stringify(upgraded)}\n`, { flag: 'wx', mode: 0o600 })
          await rename(upgradePath, target.metadataPath)
        } catch (error) {
          await unlink(upgradePath).catch(() => {})
          throw error
        }
        return { ...upgraded, reused: true }
      }
      return { ...stored, reused: true }
    }
  }
  await unlink(target.path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  const partialPath = resolve(target.root, `.${options.stagingKey}.${randomUUID()}.partial.sqlite`)
  let metadataPartial: string | null = null
  const captureStartedAt = new Date().toISOString()
  try {
    await runSqliteBackup(options.pythonExecutable ?? 'python3', approved.path, partialPath)
    await chmod(partialPath, 0o600)
    const sourceAfter = identityFromStat(await stat(await realpath(path)))
    if (!sameIdentity(source, sourceAfter)) throw new Error('SQLite source identity changed during staged logical snapshot')
    await rename(partialPath, target.path)
    const staged = await inspectStagedSqliteSnapshot(options.stagingRoot, options.stagingKey)
    const descriptor: StagedSqliteSnapshot = {
      ...staged, source, createdAt: captureStartedAt, completedAt: new Date().toISOString(), reused: false,
      limitations: [
        'SQLite online backup is a transactionally consistent logical snapshot, not the exact physical database, WAL, or journal bytes',
        'physical multi-file consistency requires quiescence or a supported atomic filesystem snapshot and is not claimed',
      ],
    }
    metadataPartial = `${target.metadataPath}.${randomUUID()}.partial`
    await writeFile(metadataPartial, `${JSON.stringify(descriptor)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(metadataPartial, target.metadataPath)
    metadataPartial = null
    return descriptor
  } catch (error) {
    await unlink(partialPath).catch(() => {})
    if (metadataPartial) await unlink(metadataPartial).catch(() => {})
    throw error
  }
}

export async function removeStagedSqliteSnapshot(stagingRoot: string, stagingKey: string): Promise<void> {
  const target = await safeStagingPath(stagingRoot, stagingKey)
  await unlink(target.path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
  await unlink(target.metadataPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}
