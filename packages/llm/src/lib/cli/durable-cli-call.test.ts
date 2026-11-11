import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DURABLE_PID, readDurableResult, runDurableCliCall, wrapperAlive } from './durable-cli-call.js'

// A durable CLI call outlives the process waiting for it (restart-safety.md): the fake codex child is slow and
// counts its (paid) invocations, and the "worker" is a separate process the test kills mid-call.
const root = mkdtempSync(join(tmpdir(), 'durable-cli-'))
const count = join(root, 'calls')
Object.assign(process.env, { CODEX_CLI_BIN: join(import.meta.dir, 'testing', 'fake-codex.ts'), FAKE_CODEX_COUNT: count, FAKE_CODEX_ANSWER: '{"grade":3}' })
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
let dir = ''
beforeEach(() => { dir = join(root, `call-${++n}`); rmSync(count, { force: true }) })
const calls = () => existsSync(count) ? readFileSync(count, 'utf8').trim().split('\n').length : 0
const request = { agentId: 'codex', prompt: 'grade this', timeoutSec: 60 }
const until = async (ok: () => boolean, ms = 10_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error('timed out'); await Bun.sleep(20) } }
const pidOf = () => Number(readFileSync(join(dir, DURABLE_PID), 'utf8'))
const driver = () => Bun.spawn([process.execPath, join(import.meta.dir, 'testing', 'durable-driver.ts'), dir], { stdout: 'pipe', stderr: 'pipe', env: process.env })

test('a finished call is adopted from disk: the CLI is not run again', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '0'
  const first = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  expect(first.stdout).toContain('{"grade":3}')
  const again = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  expect(again.stdout).toBe(first.stdout)
  expect(calls()).toBe(1)
})

for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
  test(`the worker is killed (${signal}) mid-call: the CLI child keeps running and the restarted worker waits for its result, paying once`, async () => {
    process.env.FAKE_CODEX_SLEEP_MS = '1500'
    const worker = driver()
    await until(() => calls() === 1) // the child is in its (paid) call
    worker.kill(signal)
    await worker.exited
    expect(wrapperAlive(dir)).toBe(true)
    expect(readDurableResult(dir)).toBeNull()
    const restarted = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
    expect(restarted.stdout).toContain('{"grade":3}')
    expect(calls()).toBe(1)
    // Gone (or a zombie awaiting its reaper, which wrapperAlive counts as gone): nothing keeps running.
    await until(() => !wrapperAlive(dir))
  })
}

test('the child dies too (no result, no live wrapper): the call is started again', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '1500'
  const worker = driver()
  await until(() => calls() === 1)
  worker.kill('SIGKILL')
  process.kill(-pidOf(), 'SIGKILL') // the whole detached group: wrapper and CLI child
  await until(() => !wrapperAlive(dir))
  process.env.FAKE_CODEX_SLEEP_MS = '0'
  const again = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  expect(again.stdout).toContain('{"grade":3}')
  expect(calls()).toBe(2)
})

test('a waiter whose wrapper dies without a result fails retryable, never hangs', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '3000'
  const waiting = runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  await until(() => existsSync(join(dir, DURABLE_PID)) && calls() === 1)
  process.kill(-pidOf(), 'SIGKILL')
  await expect(waiting).rejects.toMatchObject({ type: 'cli_agent.wrapper_died', retryable: true })
})
