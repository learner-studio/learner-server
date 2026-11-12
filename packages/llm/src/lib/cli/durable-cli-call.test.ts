import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DURABLE_PID, readDurableResult, runDurableCliCall, wrapperAlive } from './durable-cli-call.js'
import { fakeCli, spawnCrashable, until } from './testing/crash-harness.js'

// A durable CLI call outlives the process waiting for it (restart-safety.md): the fake codex child is slow and
// counts its (paid) invocations, and the "worker" is a separate process the test kills mid-call.
const root = mkdtempSync(join(tmpdir(), 'durable-cli-'))
const cli = fakeCli(root, 'durable', '{"grade":3}', 0)
Object.assign(process.env, cli.env)
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
let dir = ''
beforeEach(() => { dir = join(root, `call-${++n}`); rmSync(cli.env.FAKE_CODEX_COUNT, { force: true }) })
const calls = cli.calls
const request = { agentId: 'codex', prompt: 'grade this', timeoutSec: 60 }
const pidOf = () => Number(readFileSync(join(dir, DURABLE_PID), 'utf8'))
const driver = () => spawnCrashable([process.execPath, join(import.meta.dir, 'testing', 'durable-driver.ts'), dir], { env: process.env })

test('a finished call is adopted from disk: the CLI is not run again', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '0'
  const first = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  expect(first.stdout).toContain('{"grade":3}')
  const again = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  expect(again.stdout).toBe(first.stdout)
  expect([first.adopted, again.adopted]).toEqual([false, true]) // the owner traces the adopted one as such
  expect(calls()).toBe(1)
})

for (const signal of ['SIGKILL', 'SIGTERM'] as const) {
  test(`the worker is killed (${signal}) mid-call: the CLI child keeps running and the restarted worker waits for its result, paying once`, async () => {
    process.env.FAKE_CODEX_SLEEP_MS = '1500'
    const worker = driver()
    await until(() => calls() === 1, 10_000, 'the paid call') // the child is in its (paid) call
    await worker.stop(signal)
    expect(wrapperAlive(dir)).toBe(true)
    expect(readDurableResult(dir)).toBeNull()
    const restarted = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
    expect(restarted.stdout).toContain('{"grade":3}')
    expect(restarted.adopted).toBe(true) // waited for, not started here
    expect(calls()).toBe(1)
    // Gone (or a zombie awaiting its reaper, which wrapperAlive counts as gone): nothing keeps running.
    await until(() => !wrapperAlive(dir), 10_000, 'the wrapper to go')
  })
}

test('the child dies too (no result, no live wrapper): the call is started again', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '1500'
  const worker = driver()
  await until(() => calls() === 1, 10_000, 'the paid call')
  await worker.stop('SIGKILL')
  process.kill(-pidOf(), 'SIGKILL') // the whole detached group: wrapper and CLI child
  await until(() => !wrapperAlive(dir), 10_000, 'the wrapper to go')
  process.env.FAKE_CODEX_SLEEP_MS = '0'
  const again = await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  expect(again.stdout).toContain('{"grade":3}')
  expect(calls()).toBe(2)
})

test('a waiter whose wrapper dies without a result fails retryable, never hangs', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '3000'
  const waiting = runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  await until(() => existsSync(join(dir, DURABLE_PID)) && calls() === 1, 10_000, 'the paid call')
  process.kill(-pidOf(), 'SIGKILL')
  await expect(waiting).rejects.toMatchObject({ type: 'cli_agent.wrapper_died', retryable: true })
})

test('a result made for a different request (a reload changed the prompt or model) is not adopted: the call runs anew', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '0'
  await runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  await runDurableCliCall(dir, { ...request, prompt: 'grade this, v2' }, { pollMs: 20, log: () => {} })
  expect(calls()).toBe(2)
  expect(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8')).prompt).toBe('grade this, v2')
})

test('a takeover inside the start grace (the first wrapper not yet running) waits for it: one wrapper, one paid call', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '1500'
  const first = runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  const second = runDurableCliCall(dir, request, { pollMs: 20, log: () => {} }) // same tick: the wrapper has not booted
  expect((await second).stdout).toBe((await first).stdout)
  expect(calls()).toBe(1)
})

test('the CLI child alone is killed by a signal (a control-group stop reached it first): no failed result, the waiter sees a dead wrapper', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '3000'
  const waiting = runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  await until(() => existsSync(join(dir, DURABLE_PID)) && calls() === 1, 10_000, 'the paid call')
  const child = Number(Bun.spawnSync(['pgrep', '-P', String(pidOf())]).stdout.toString().trim().split('\n')[0])
  process.kill(child, 'SIGTERM')
  await expect(waiting).rejects.toMatchObject({ type: 'cli_agent.wrapper_died' })
  expect(readDurableResult(dir)).toBeNull()
})

test('a CLI that crashes on its own (SIGSEGV) is recorded as failed, not re-run as unknown', async () => {
  process.env.FAKE_CODEX_SLEEP_MS = '3000'
  const waiting = runDurableCliCall(dir, request, { pollMs: 20, log: () => {} })
  await until(() => existsSync(join(dir, DURABLE_PID)) && calls() === 1, 10_000, 'the paid call')
  process.kill(Number(Bun.spawnSync(['pgrep', '-P', String(pidOf())]).stdout.toString().trim().split('\n')[0]), 'SIGSEGV')
  await expect(waiting).rejects.toMatchObject({ type: 'cli_agent.nonzero_exit' })
  expect(readDurableResult(dir)).toMatchObject({ ok: false })
})
