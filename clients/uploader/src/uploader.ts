import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { z } from 'zod'
import { GetTranscriptUploadStateInput, RpcError, TRANSCRIPT_UPLOAD_MAX_BYTES, TRANSCRIPT_UPLOAD_STATE_MAX_PATHS, UploadTranscriptInput, type LearnerClient } from '@learner/contract'

/**
 * Remote capture of Claude Code and Codex CLI sessions: tails the native
 * `.jsonl` transcripts under each provider root and appends their raw bytes
 * to the server spool with `uploadTranscript`, which the server's own archive
 * sweep then reads like a local file. Nothing is parsed here.
 *
 * Durability: the offset of every file is in `state.json`, rewritten
 * atomically (tmp + fsync + rename) after each acknowledged chunk, so a crash
 * loses at most one in-flight chunk, and resending that chunk is a server
 * no-op. Self-healing: the server is the source of truth. A missing or
 * corrupt state file, a file with no entry, a 409, or a file that shrank all
 * resolve the same way: ask `getTranscriptUploadState`, check the local
 * file's prefix against the server's digest, resume at the server's size.
 * A file whose prefix no longer matches is `diverged`: reported, skipped
 * until it changes, never overwritten.
 */
export type Provider = 'claude' | 'codex'
export interface UploaderOptions {
  rpc: LearnerClient
  clientId: string
  roots: Partial<Record<Provider, string>>
  stateDir: string
  /** Chunk ceiling (bytes); the server caps at TRANSCRIPT_UPLOAD_MAX_BYTES. */
  maxChunkBytes?: number
  /** A file unchanged this long has its unterminated last line sent too. */
  settleMs?: number
  now?: () => number
  timeoutMs?: number
}

const FileState = z.object({
  offset: z.number().int().min(0),
  /** Set when the local prefix disagrees with the server copy; cleared when the file changes. */
  diverged: z.object({ size: z.number(), mtimeMs: z.number(), reason: z.string() }).optional(),
  /** A per-file refusal (not UTF-8, invalid input): skipped until the file changes. */
  failed: z.object({ size: z.number(), mtimeMs: z.number(), reason: z.string() }).optional(),
})
const State = z.object({ version: z.literal(1), clientId: z.string(), files: z.record(z.string(), FileState) })
type State = z.infer<typeof State>

export const UploaderStatus = z.object({
  version: z.literal(1),
  clientId: z.string(),
  pid: z.number(),
  state: z.enum(['ok', 'syncing', 'backoff', 'auth-error', 'error']),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  files: z.number(),
  pendingFiles: z.number(),
  pendingBytes: z.number(),
  /** Bytes appended by this process since it started (`healed` likewise). */
  uploadedBytes: z.number(),
  healed: z.number(),
  diverged: z.array(z.object({ provider: z.string(), path: z.string(), reason: z.string() })),
  failed: z.array(z.object({ provider: z.string(), path: z.string(), reason: z.string() })),
  skippedPaths: z.number(),
  lastError: z.string().nullable(),
})
export type UploaderStatus = z.infer<typeof UploaderStatus>

export interface PassResult { files: number; pendingFiles: number; pendingBytes: number; uploadedBytes: number; chunks: number; healed: number; diverged: UploaderStatus['diverged']; failed: UploaderStatus['failed']; skippedPaths: number }

/** Cannot reach the server or it is temporarily failing: stop the pass, back off, retry. */
export class TransientUploadError extends Error { override name = 'TransientUploadError' }
/** The key is wrong or not bound to this clientId: nothing will succeed until the config changes. */
export class AuthUploadError extends Error { override name = 'AuthUploadError' }

const statePath = (dir: string) => join(dir, 'state.json')
export const statusPath = (dir: string) => join(dir, 'status.json')
const key = (provider: Provider, path: string) => `${provider}:${path}`

export async function writeAtomic(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  const handle = await open(tmp, 'w', 0o600)
  try { await handle.writeFile(text); await handle.sync() } finally { await handle.close() }
  await rename(tmp, path)
}

/** A missing, unreadable or foreign state file is an empty one: every file then resyncs from the server. */
async function loadState(dir: string, clientId: string): Promise<{ state: State; recovered: boolean }> {
  const text = await readFile(statePath(dir), 'utf8').catch(() => null)
  if (text === null) return { state: { version: 1, clientId, files: {} }, recovered: false }
  try {
    const state = State.parse(JSON.parse(text))
    if (state.clientId === clientId) return { state, recovered: false }
  } catch { /* corrupt: rebuilt from the server below */ }
  await writeFile(`${statePath(dir)}.corrupt-${Date.now()}`, text, { mode: 0o600 }).catch(() => undefined)
  return { state: { version: 1, clientId, files: {} }, recovered: true }
}

interface LocalFile { provider: Provider; path: string; abs: string; size: number; mtimeMs: number }

/** Every `.jsonl` under the provider roots, most recently written first (live sessions go before backfill). */
async function scan(roots: UploaderOptions['roots']): Promise<{ files: LocalFile[]; skipped: number; unreadable: Set<Provider> }> {
  const files: LocalFile[] = []
  const unreadable = new Set<Provider>()
  let skipped = 0
  for (const provider of ['claude', 'codex'] as const) {
    const root = roots[provider]
    if (!root) continue
    // An unreadable (or not yet created) root lists nothing, but its files are not gone: keep their offsets.
    const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => { unreadable.add(provider); return [] })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const abs = join(entry.parentPath, entry.name)
      const path = relative(root, abs).split(sep).join('/')
      if (!UploadTranscriptInput.shape.path.safeParse(path).success) { skipped++; continue }
      const info = await stat(abs).catch(() => null)
      if (info) files.push({ provider, path, abs, size: info.size, mtimeMs: info.mtimeMs })
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return { files, skipped, unreadable }
}

async function prefixDigest(abs: string, bytes: number): Promise<string> {
  const hash = createHash('sha256')
  if (bytes > 0) await new Promise<void>((resolve, reject) => createReadStream(abs, { start: 0, end: bytes - 1 }).on('data', (b) => hash.update(b)).on('end', resolve).on('error', reject))
  return hash.digest('hex')
}

async function readSlice(abs: string, offset: number, length: number): Promise<Buffer> {
  const handle = await open(abs, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead)
  } finally { await handle.close() }
}

/** Largest prefix of `buf` that ends on a UTF-8 character boundary. */
function utf8Boundary(buf: Buffer): number {
  const end = buf.length
  let i = end - 1
  while (i >= 0 && (buf[i]! & 0xc0) === 0x80) i--
  if (i < 0) return 0
  const lead = buf[i]!
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return end - i >= need ? end : i
}

/**
 * The bytes to send from `offset`: whole lines only, unless one line is
 * longer than a chunk (cut on a character boundary) or the file has settled
 * with an unterminated last line.
 */
export function chunkEnd(buf: Buffer, reachesEof: boolean, settled: boolean, max: number): number {
  const lastNewline = buf.lastIndexOf(0x0a)
  if (reachesEof && settled) return utf8Boundary(buf)
  if (lastNewline >= 0) return lastNewline + 1
  return buf.length >= max ? utf8Boundary(buf) : 0
}

const classify = (error: unknown): Error => {
  if (error instanceof RpcError) {
    if (error.status === 401 || error.status === 403) return new AuthUploadError(error.message)
    if (error.status === 408 || error.status === 429 || error.status >= 500) return new TransientUploadError(error.message)
    return error
  }
  return new TransientUploadError(error instanceof Error ? error.message : String(error))
}

export async function syncOnce(options: UploaderOptions): Promise<PassResult> {
  const { rpc, clientId, stateDir } = options
  const max = Math.min(options.maxChunkBytes ?? TRANSCRIPT_UPLOAD_MAX_BYTES, TRANSCRIPT_UPLOAD_MAX_BYTES)
  const settleMs = options.settleMs ?? 10 * 60_000
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? 60_000
  const { state } = await loadState(stateDir, clientId)
  const save = () => writeAtomic(statePath(stateDir), JSON.stringify(state))
  const { files, skipped, unreadable } = await scan(options.roots)
  const result: PassResult = { files: files.length, pendingFiles: 0, pendingBytes: 0, uploadedBytes: 0, chunks: 0, healed: 0, diverged: [], failed: [], skippedPaths: skipped }
  const call = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn() } catch (e) { throw classify(e) } }

  // Local read failures (EACCES, EIO, a file deleted mid-pass) skip that file for this pass only.
  const unreadableNow = new Map<string, string>()
  const localReason = (error: unknown) => `cannot read the local file: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`
  /** Resume points from the server's copy, for files with no trustworthy offset. */
  async function resync(batch: LocalFile[]) {
    for (const provider of ['claude', 'codex'] as const) {
      const mine = batch.filter((f) => f.provider === provider)
      for (let i = 0; i < mine.length; i += TRANSCRIPT_UPLOAD_STATE_MAX_PATHS) {
        const part = mine.slice(i, i + TRANSCRIPT_UPLOAD_STATE_MAX_PATHS)
        const input: z.input<typeof GetTranscriptUploadStateInput> = { provider, clientId, paths: part.map((f) => f.path) }
        const { files: held } = await call(() => rpc('getTranscriptUploadState', input, { timeoutMs }))
        for (const f of part) {
          const server = held.find((h) => h.path === f.path)
          if (!server) throw new TransientUploadError(`server state omitted ${f.path}`)
          const entry = state.files[key(provider, f.path)] ??= { offset: 0 }
          entry.offset = 0
          delete entry.diverged
          delete entry.failed
          if (server.size === 0) continue
          let local: string
          try { local = server.size <= f.size ? await prefixDigest(f.abs, server.size) : '' }
          catch (error) { delete state.files[key(provider, f.path)]; unreadableNow.set(key(provider, f.path), localReason(error)); continue }
          if (local === server.sha256) { entry.offset = server.size; result.healed++; continue }
          Object.assign(entry, { diverged: { size: f.size, mtimeMs: f.mtimeMs, reason: server.size > f.size ? `the server holds ${server.size} bytes; the local file has ${f.size}` : `the first ${server.size} bytes differ from the server copy` } })
        }
      }
    }
    await save()
  }

  const changedSince = (mark: { size: number; mtimeMs: number }, f: LocalFile) => mark.size !== f.size || mark.mtimeMs !== f.mtimeMs
  const needsResync = files.filter((f) => {
    const entry = state.files[key(f.provider, f.path)]
    if (!entry) return true
    for (const field of ['diverged', 'failed'] as const) if (entry[field] && changedSince(entry[field], f)) return true
    return !entry.diverged && !entry.failed && f.size < entry.offset
  })
  if (needsResync.length) await resync(needsResync)

  for (const f of files) {
    const skippedNow = unreadableNow.get(key(f.provider, f.path))
    if (skippedNow) { result.failed.push({ provider: f.provider, path: f.path, reason: skippedNow }); continue }
    const entry = state.files[key(f.provider, f.path)]!
    if (entry.diverged) { result.diverged.push({ provider: f.provider, path: f.path, reason: entry.diverged.reason }); continue }
    if (entry.failed) { result.failed.push({ provider: f.provider, path: f.path, reason: entry.failed.reason }); continue }
    let healedOnce = false
    while (entry.offset < f.size) {
      let buf: Buffer
      try { buf = await readSlice(f.abs, entry.offset, Math.min(max, f.size - entry.offset)) }
      catch (error) { result.failed.push({ provider: f.provider, path: f.path, reason: localReason(error) }); break }
      const reachesEof = entry.offset + buf.length >= f.size
      const end = chunkEnd(buf, reachesEof, now() - f.mtimeMs >= settleMs, max)
      if (end === 0) break // an unterminated line still being written
      let bytes = buf.subarray(0, end)
      let content = bytes.toString('utf8')
      const encoded = Buffer.from(content, 'utf8')
      if (!encoded.equals(bytes)) {
        // Send the whole lines before the first invalid byte; the file stops there.
        let bad = 0
        while (bad < bytes.length && bytes[bad] === encoded[bad]) bad++
        const cut = bytes.lastIndexOf(0x0a, bad - 1) + 1
        if (cut > 0) { bytes = bytes.subarray(0, cut); content = bytes.toString('utf8') }
      }
      if (!Buffer.from(content, 'utf8').equals(bytes)) {
        entry.failed = { size: f.size, mtimeMs: f.mtimeMs, reason: `not valid UTF-8 at byte ${entry.offset}` }
        result.failed.push({ provider: f.provider, path: f.path, reason: entry.failed.reason })
        await save()
        break
      }
      try {
        const sha256 = createHash('sha256').update(bytes).digest('hex')
        const answer = await call(() => rpc('uploadTranscript', { provider: f.provider, clientId, path: f.path, offset: entry.offset, content, sha256 }, { timeoutMs }))
        result.uploadedBytes += answer.appended
        result.chunks++
        entry.offset = entry.offset + bytes.length
        await save()
      } catch (error) {
        if (!(error instanceof RpcError)) throw error
        if (error.status === 409 && !healedOnce) {
          // Our offset and the server's copy disagree (a lost answer, a second uploader): take the server's.
          healedOnce = true
          await resync([f]) // updates `entry` in place
          const diverged = (entry as z.infer<typeof FileState>).diverged
          if (diverged) { result.diverged.push({ provider: f.provider, path: f.path, reason: diverged.reason }); break }
          continue
        }
        entry.failed = { size: f.size, mtimeMs: f.mtimeMs, reason: error.message.slice(0, 300) }
        result.failed.push({ provider: f.provider, path: f.path, reason: entry.failed.reason })
        await save()
        break
      }
    }
    if (!entry.diverged && !entry.failed && entry.offset < f.size && !result.failed.some((x) => x.provider === f.provider && x.path === f.path)) { result.pendingFiles++; result.pendingBytes += f.size - entry.offset }
  }
  // Forget files that are gone locally; the server keeps its copy.
  const live = new Set(files.map((f) => key(f.provider, f.path)))
  let pruned = false
  for (const k of Object.keys(state.files)) if (!live.has(k) && !unreadable.has(k.split(':')[0] as Provider)) { delete state.files[k]; pruned = true }
  if (pruned) await save()
  return result
}

/** When a process started, as `ps` reports it (Linux and macOS); null when no such process. */
export function processStartTime(pid: number): string | null {
  const out = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)], { stdout: 'pipe', stderr: 'ignore' })
  const text = out.stdout.toString().trim()
  return out.exitCode === 0 && text ? text : null
}

/**
 * One running uploader per state directory. The lock names its holder by pid
 * AND start time, so a pid reused after a reboot is not mistaken for the
 * holder: a lock whose process is gone (or is another process) is taken over.
 * Two processes taking over the same stale lock at once can both win; that
 * only costs replays, which the server answers without writing.
 */
export async function acquireLock(stateDir: string): Promise<(() => Promise<void>) | null> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = join(stateDir, 'uploader.lock')
  const me = { pid: process.pid, started: processStartTime(process.pid) }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      await handle.writeFile(JSON.stringify(me))
      await handle.close()
      return () => unlink(path).catch(() => undefined)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const holder: { pid?: unknown; started?: unknown } = await readFile(path, 'utf8').then((t) => Object(JSON.parse(t)), () => ({}))
      const pid = typeof holder.pid === 'number' ? holder.pid : 0
      if (pid > 0 && typeof holder.started === 'string' && processStartTime(pid) === holder.started) return null
      await unlink(path).catch(() => undefined)
    }
  }
  return null
}

export interface WatchOptions extends UploaderOptions {
  intervalMs: number
  maxBackoffMs?: number
  once?: boolean
  signal?: AbortSignal
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  onStatus?: (status: UploaderStatus) => void
}

const defaultSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

/**
 * The service loop. A pass never takes the process down: a transient failure
 * backs off (doubling to `maxBackoffMs`), an auth failure waits the longest,
 * and every pass ends with `status.json` saying what happened. Process-level
 * failures are the supervisor's (launchd KeepAlive / systemd Restart=always).
 */
export async function runUploader(options: WatchOptions): Promise<UploaderStatus> {
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const maxBackoff = options.maxBackoffMs ?? 5 * 60_000
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())
  const previous = await readFile(statusPath(options.stateDir), 'utf8').then((t) => UploaderStatus.parse(JSON.parse(t)), () => null)
  let status: UploaderStatus = {
    version: 1, clientId: options.clientId, pid: process.pid, state: 'syncing', lastRunAt: null, lastSuccessAt: previous?.lastSuccessAt ?? null, nextRunAt: null,
    files: 0, pendingFiles: 0, pendingBytes: 0, uploadedBytes: 0, healed: 0, diverged: [], failed: [], skippedPaths: 0, lastError: null,
  }
  const publish = async (next: Partial<UploaderStatus>) => {
    status = { ...status, ...next }
    await writeAtomic(statusPath(options.stateDir), JSON.stringify(status, null, 2)).catch(() => undefined)
    options.onStatus?.(status)
  }
  let backoff = 0
  while (!options.signal?.aborted) {
    const started = now()
    await publish({ state: 'syncing', lastRunAt: iso(started) })
    let wait = options.intervalMs
    try {
      const pass = await syncOnce(options)
      backoff = 0
      await publish({ state: 'ok', lastSuccessAt: iso(now()), lastError: null, ...pick(pass), uploadedBytes: status.uploadedBytes + pass.uploadedBytes, healed: status.healed + pass.healed, nextRunAt: options.once ? null : iso(now() + wait) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      let state: UploaderStatus['state'] = 'auth-error'
      if (error instanceof AuthUploadError) wait = maxBackoff
      else {
        backoff = Math.min(maxBackoff, Math.max(5_000, backoff * 2))
        wait = backoff
        state = error instanceof TransientUploadError ? 'backoff' : 'error'
      }
      await publish({ state, lastError: message, nextRunAt: options.once ? null : iso(now() + wait) })
    }
    if (options.once || options.signal?.aborted) break
    await sleep(wait, options.signal)
  }
  return status
}

const pick = (p: PassResult) => ({ files: p.files, pendingFiles: p.pendingFiles, pendingBytes: p.pendingBytes, uploadedBytes: p.uploadedBytes, healed: p.healed, diverged: p.diverged, failed: p.failed, skippedPaths: p.skippedPaths })
