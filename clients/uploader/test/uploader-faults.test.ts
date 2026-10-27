import { afterAll, describe, expect, mock, test } from 'bun:test'
import * as realFs from 'node:fs/promises'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Faults found by the adversarial review of the uploader. Separate file: the
// fs mock below applies to the whole process (each test file runs in its own).
// One transcript this user cannot read (e.g. written by `sudo claude`): open() -> EACCES.
const realCopy = { ...realFs }
mock.module('node:fs/promises', () => ({ ...realCopy, open: async (p: string, ...rest: unknown[]) => {
  if (String(p).endsWith('root-owned.jsonl')) throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), { code: 'EACCES' })
  return (realCopy.open as (...a: unknown[]) => unknown)(p, ...rest)
}}))
const { createLearnerClient } = await import('@learner/contract')
const { acquireLock, processStartTime, runUploader, syncOnce } = await import('../src/uploader.js')
const { spoolServer } = await import('./spool-server.js')

const base = mkdtempSync(join(tmpdir(), 'learner-uploader-faults-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))
const setup = () => {
  const dir = mkdtempSync(join(base, 'case-'))
  const server = spoolServer(join(dir, 'spool'))
  const options = { rpc: createLearnerClient({ baseUrl: server.url }), clientId: 'laptop', roots: { claude: join(dir, 'claude') }, stateDir: join(dir, 'state') }
  mkdirSync(join(dir, 'claude/p'), { recursive: true })
  return { dir, server, options }
}
const line = (n: number) => `{"n":${n}}\n`

describe('uploader faults', () => {
  test('an unreadable transcript is reported for the pass; every other file keeps flowing', async () => {
    const { dir, server, options } = setup()
    writeFileSync(join(dir, 'claude/p/root-owned.jsonl'), line(1))
    writeFileSync(join(dir, 'claude/p/ok.jsonl'), line(2))
    const pass = await syncOnce(options)
    expect(pass.failed).toEqual([{ provider: 'claude', path: 'p/root-owned.jsonl', reason: expect.stringContaining('EACCES') }])
    expect(readFileSync(join(dir, 'spool/claude/laptop/p/ok.jsonl'), 'utf8')).toBe(line(2))
    server.stop()
  })

  test('a held partial line never turns the watch loop into a busy loop', async () => {
    const { dir, server, options } = setup()
    writeFileSync(join(dir, 'claude/p/a.jsonl'), line(1) + '{"unfinished"')
    writeFileSync(join(dir, 'claude/p/b.jsonl'), line(2))
    const waits: number[] = []
    const controller = new AbortController()
    await runUploader({ ...options, intervalMs: 30_000, signal: controller.signal, sleep: async (ms) => {
      waits.push(ms)
      writeFileSync(join(dir, 'claude/p/b.jsonl'), line(waits.length + 2), { flag: 'a' }) // another file keeps growing
      if (waits.length === 4) controller.abort()
    } })
    expect(waits).toEqual([30_000, 30_000, 30_000, 30_000])
    server.stop()
  })

  test('a lock naming a live but different process (a pid reused after reboot) is taken over', async () => {
    const { server, options } = setup()
    mkdirSync(options.stateDir, { recursive: true })
    writeFileSync(join(options.stateDir, 'uploader.lock'), JSON.stringify({ pid: 1, started: 'Thu Jan  1 00:00:00 1970' }))
    const release = await acquireLock(options.stateDir)
    expect(release).not.toBeNull()
    // And the lock it wrote names this process exactly, so a second taker is refused.
    expect(JSON.parse(readFileSync(join(options.stateDir, 'uploader.lock'), 'utf8'))).toEqual({ pid: process.pid, started: processStartTime(process.pid) })
    expect(await acquireLock(options.stateDir)).toBeNull()
    await release!()
    server.stop()
  })

  test('a root that is briefly missing keeps its offsets: nothing is resynced when it returns', async () => {
    const { dir, server, options } = setup()
    writeFileSync(join(dir, 'claude/p/a.jsonl'), line(1))
    await syncOnce(options)
    renameSync(join(dir, 'claude'), join(dir, 'claude-away'))
    await syncOnce(options)
    renameSync(join(dir, 'claude-away'), join(dir, 'claude'))
    server.calls.length = 0
    expect(await syncOnce(options)).toMatchObject({ healed: 0, uploadedBytes: 0 })
    expect(server.calls).toEqual([])
    server.stop()
  })
})
