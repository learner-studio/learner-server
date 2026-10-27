import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createLearnerClient } from '@learner/contract'
import { acquireLock, chunkEnd, runUploader, statusPath, syncOnce, UploaderStatus, type UploaderOptions } from '../src/uploader.js'
import { spoolServer } from './spool-server.js'

const base = mkdtempSync(join(tmpdir(), 'learner-uploader-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let dir: string, server: ReturnType<typeof spoolServer>, options: UploaderOptions
beforeEach(() => {
  dir = mkdtempSync(join(base, 'case-'))
  server = spoolServer(join(dir, 'spool'))
  options = { rpc: createLearnerClient({ baseUrl: server.url }), clientId: 'laptop', roots: { claude: join(dir, 'claude'), codex: join(dir, 'codex') }, stateDir: join(dir, 'state'), timeoutMs: 5000 }
})
afterEach(() => server.stop())

const local = (provider: 'claude' | 'codex', path: string) => join(dir, provider, path)
const write = (provider: 'claude' | 'codex', path: string, text: string, append = false) => {
  mkdirSync(dirname(local(provider, path)), { recursive: true })
  ;(append ? appendFileSync : writeFileSync)(local(provider, path), text)
}
const spooled = (provider: 'claude' | 'codex', path: string) => { const p = join(dir, 'spool', provider, 'laptop', path); return existsSync(p) ? readFileSync(p, 'utf8') : null }
const line = (n: number, extra = '') => `${JSON.stringify({ type: 'user', uuid: `u${n}`, message: { content: `line ${n}${extra}` } })}\n`
const CLAUDE = '-Users-me-repo/0b9c.jsonl', CODEX = '2026/10/27/rollout-2026-10-27T10-00-00-abc.jsonl'

describe('uploader: append and resume', () => {
  test('backfills every provider file, then sends only what grew', async () => {
    write('claude', CLAUDE, line(1) + line(2))
    write('codex', CODEX, line(3))
    const first = await syncOnce(options)
    expect(first).toMatchObject({ files: 2, pendingFiles: 0, healed: 0 })
    expect(spooled('claude', CLAUDE)).toBe(line(1) + line(2))
    expect(spooled('codex', CODEX)).toBe(line(3))
    write('claude', CLAUDE, line(4), true)
    server.calls.length = 0
    const second = await syncOnce(options)
    expect(second.uploadedBytes).toBe(line(4).length)
    expect(server.calls.map((c) => [c.name, c.offset])).toEqual([['uploadTranscript', (line(1) + line(2)).length]])
    expect(spooled('claude', CLAUDE)).toBe(line(1) + line(2) + line(4))
  })

  test('holds an unterminated last line until it is finished, or the file settles', async () => {
    write('claude', CLAUDE, line(1) + '{"type":"user","par')
    await syncOnce(options)
    expect(spooled('claude', CLAUDE)).toBe(line(1))
    write('claude', CLAUDE, 'tial":1}\n', true)
    await syncOnce(options)
    expect(spooled('claude', CLAUDE)).toBe(line(1) + '{"type":"user","partial":1}\n')
    write('claude', CLAUDE, '{"never":"finished"', true)
    await syncOnce({ ...options, now: () => Date.now() + 11 * 60_000 })
    expect(spooled('claude', CLAUDE)).toBe(readFileSync(local('claude', CLAUDE), 'utf8'))
  })

  test('splits a line longer than a chunk on character boundaries, byte-exact', async () => {
    const giant = `${JSON.stringify({ text: 'héllo wörld ✓ 𝄞 '.repeat(40) })}\n`
    write('claude', CLAUDE, giant + line(1))
    const pass = await syncOnce({ ...options, maxChunkBytes: 64 })
    expect(pass.chunks).toBeGreaterThan(10)
    expect(spooled('claude', CLAUDE)).toBe(giant + line(1))
  })

  test('chunkEnd: whole lines, a cut-short UTF-8 tail is never sent', () => {
    expect(chunkEnd(Buffer.from('a\nb'), true, false, 100)).toBe(2)
    expect(chunkEnd(Buffer.from('ab'), true, false, 100)).toBe(0)
    expect(chunkEnd(Buffer.from('ab'), true, true, 100)).toBe(2)
    const euro = Buffer.from('xx€') // € is 3 bytes
    expect(chunkEnd(euro.subarray(0, 4), false, false, 4)).toBe(2)
    expect(chunkEnd(euro, false, false, 5)).toBe(5)
  })

  test('skips paths the server would refuse, and counts them', async () => {
    write('claude', 'has space/x.jsonl', line(1))
    write('claude', CLAUDE, line(2))
    expect(await syncOnce(options)).toMatchObject({ files: 1, skippedPaths: 1 })
  })
})

describe('uploader: self-healing', () => {
  test('a deleted or corrupt state file is rebuilt from the server, with no bytes resent', async () => {
    write('claude', CLAUDE, line(1) + line(2))
    write('codex', CODEX, line(3))
    await syncOnce(options)
    for (const damage of [() => unlinkSync(join(options.stateDir, 'state.json')), () => writeFileSync(join(options.stateDir, 'state.json'), '{"version":1,"clie')]) {
      damage()
      server.calls.length = 0
      const pass = await syncOnce(options)
      expect(pass).toMatchObject({ healed: 2, uploadedBytes: 0, pendingFiles: 0 })
      expect(server.calls.every((c) => c.name === 'getTranscriptUploadState')).toBe(true)
    }
    write('claude', CLAUDE, line(4), true)
    await syncOnce(options)
    expect(spooled('claude', CLAUDE)).toBe(line(1) + line(2) + line(4))
  })

  test('a lost answer: the resend is a replay, not a duplicate', async () => {
    write('claude', CLAUDE, line(1))
    Object.assign(server.fault, { only: 'uploadTranscript', status: 502, afterApply: true })
    await expect(syncOnce(options)).rejects.toThrow(/injected after apply/)
    expect(spooled('claude', CLAUDE)).toBe(line(1))
    server.fault.status = undefined
    expect(await syncOnce(options)).toMatchObject({ uploadedBytes: 0, pendingFiles: 0 })
    expect(spooled('claude', CLAUDE)).toBe(line(1))
  })

  test('a 409 (server lost its spool, or another uploader) resyncs and resumes from the server copy', async () => {
    write('claude', CLAUDE, line(1) + line(2))
    await syncOnce(options)
    rmSync(join(dir, 'spool'), { recursive: true })
    write('claude', CLAUDE, line(3), true)
    const pass = await syncOnce(options)
    expect(pass).toMatchObject({ pendingFiles: 0, failed: [], diverged: [] })
    expect(spooled('claude', CLAUDE)).toBe(line(1) + line(2) + line(3))
  })

  test('a rewritten local file is reported diverged, never overwritten, and rechecked only when it changes', async () => {
    write('claude', CLAUDE, line(1) + line(2))
    await syncOnce(options)
    write('claude', CLAUDE, line(9)) // shorter than what the server holds
    const pass = await syncOnce(options)
    expect(pass.diverged).toEqual([{ provider: 'claude', path: CLAUDE, reason: expect.stringContaining('server holds') }])
    expect(spooled('claude', CLAUDE)).toBe(line(1) + line(2))
    server.calls.length = 0
    expect((await syncOnce(options)).diverged).toHaveLength(1)
    expect(server.calls).toEqual([])
    // The original content comes back (restored from a backup): it heals.
    write('claude', CLAUDE, line(1) + line(2) + line(5))
    const healed = await syncOnce(options)
    expect(healed).toMatchObject({ diverged: [], pendingFiles: 0 })
    expect(spooled('claude', CLAUDE)).toBe(line(1) + line(2) + line(5))
  })

  test('invalid UTF-8 is refused locally and reported, the rest keeps flowing', async () => {
    mkdirSync(dirname(local('claude', CLAUDE)), { recursive: true })
    writeFileSync(local('claude', CLAUDE), Buffer.concat([Buffer.from(line(1)), Buffer.from([0xff, 0xfe, 0x0a])]))
    write('codex', CODEX, line(2))
    const pass = await syncOnce(options)
    expect(pass.failed).toEqual([{ provider: 'claude', path: CLAUDE, reason: expect.stringContaining('UTF-8') }])
    expect(spooled('claude', CLAUDE)).toBe(line(1))
    expect(spooled('codex', CODEX)).toBe(line(2))
  })
})

describe('uploader: service loop and status file', () => {
  const sleeps: number[] = []
  const sleep = async (ms: number) => { sleeps.push(ms) }
  const status = () => UploaderStatus.parse(JSON.parse(readFileSync(statusPath(options.stateDir), 'utf8')))

  test('an outage backs off with doubling waits, then recovers on its own', async () => {
    write('claude', CLAUDE, line(1))
    server.fault.down = true
    const controller = new AbortController()
    let passes = 0
    sleeps.length = 0
    await runUploader({ ...options, intervalMs: 30_000, signal: controller.signal, sleep, onStatus: (s) => {
      if (s.state === 'syncing') return
      if (++passes === 3) server.fault.down = false
      if (s.state === 'ok') controller.abort()
    } })
    expect(sleeps).toEqual([5_000, 10_000, 20_000])
    expect(status()).toMatchObject({ state: 'ok', lastError: null, pendingFiles: 0, uploadedBytes: line(1).length })
    expect(spooled('claude', CLAUDE)).toBe(line(1))
  })

  test('a rejected key is auth-error, waits the longest, and touches nothing', async () => {
    write('claude', CLAUDE, line(1))
    server.fault.status = 403
    sleeps.length = 0
    const s = await runUploader({ ...options, intervalMs: 30_000, once: true, sleep })
    expect(s.state).toBe('auth-error')
    expect(status()).toMatchObject({ state: 'auth-error', lastError: expect.stringContaining('403') })
    expect(spooled('claude', CLAUDE)).toBeNull()
  })

  test('one uploader per state directory; a dead holder\'s lock is taken over', async () => {
    const release = await acquireLock(options.stateDir)
    expect(release).not.toBeNull()
    expect(await acquireLock(options.stateDir)).toBeNull()
    await release!()
    writeFileSync(join(options.stateDir, 'uploader.lock'), '999999999')
    const takeover = await acquireLock(options.stateDir)
    expect(takeover).not.toBeNull()
    await takeover!()
  })
})

describe('uploader: the installed CLI survives kill -9', () => {
  test('a killed --watch process restarts and finishes byte-exact, with no duplicate bytes', async () => {
    const text = Array.from({ length: 400 }, (_, n) => line(n, ' padding'.repeat(8))).join('')
    write('claude', CLAUDE, text)
    write('codex', CODEX, text)
    server.fault.delayMs = 15
    const env = { ...process.env, LEARNER_URL: server.url, LEARNER_API_KEY: 'test', LEARNER_CLIENT_ID: 'laptop', LEARNER_UPLOAD_STATE_DIR: options.stateDir, LEARNER_CLAUDE_ROOT: options.roots.claude!, LEARNER_CODEX_ROOT: options.roots.codex!, LEARNER_UPLOAD_CHUNK_BYTES: '2048', LEARNER_UPLOAD_CONFIG: join(dir, 'none.json') }
    const cli = join(import.meta.dir, '../src/index.ts')
    const first = Bun.spawn(['bun', cli, '--watch', '--interval', '1'], { env, stderr: 'pipe', stdout: 'pipe' })
    const deadline = Date.now() + 20_000
    while ((spooled('claude', CLAUDE)?.length ?? 0) < 20_000 && Date.now() < deadline) await Bun.sleep(25)
    first.kill(9)
    await first.exited
    expect(spooled('claude', CLAUDE)!.length).toBeLessThan(text.length) // it really died mid-backfill
    // The lock file of the dead process stays behind; the next run must take it over.
    expect(existsSync(join(options.stateDir, 'uploader.lock'))).toBe(true)
    server.fault.delayMs = 0
    const second = Bun.spawn(['bun', cli, '--once'], { env, stderr: 'pipe', stdout: 'pipe' })
    expect(await second.exited).toBe(0)
    // --once stops after one pass even with bytes left; run until the backlog is clear.
    for (let i = 0; i < 5 && spooled('codex', CODEX) !== text; i++) expect(await Bun.spawn(['bun', cli, '--once'], { env }).exited).toBe(0)
    expect(spooled('claude', CLAUDE)).toBe(text)
    expect(spooled('codex', CODEX)).toBe(text)
    expect(UploaderStatus.parse(JSON.parse(readFileSync(statusPath(options.stateDir), 'utf8')))).toMatchObject({ state: 'ok', pendingFiles: 0 })
  }, 60_000)
})
