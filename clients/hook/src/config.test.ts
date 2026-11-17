import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'learner-hook-config-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
process.env.LEARNER_HOOK_CONFIG = join(dir, 'hook.json')
delete process.env.LEARNER_URL
const { serverUrl, loadConfig } = await import('./config.js')

test('the settings file can point the hook at a remote server; LEARNER_URL still wins', async () => {
  expect(await serverUrl()).toBe('http://127.0.0.1:3010')
  writeFileSync(process.env.LEARNER_HOOK_CONFIG!, JSON.stringify({ foundationFirst: true, timeoutMs: 2000, serverUrl: 'https://learner.example.test', keyFile: join(dir, 'key.env') }))
  expect(await serverUrl()).toBe('https://learner.example.test')
  expect((await loadConfig()).keyFile).toBe(join(dir, 'key.env'))
  process.env.LEARNER_URL = 'http://127.0.0.1:3999'
  expect(await serverUrl()).toBe('http://127.0.0.1:3999')
  delete process.env.LEARNER_URL
})

test('a key command prints the key; its failure is only "unavailable"', async () => {
  const { learner } = await import('./config.js')
  delete process.env.LEARNER_API_KEY; delete process.env.LEARNER_HOOK_KEY_FILE
  writeFileSync(process.env.LEARNER_HOOK_CONFIG!, JSON.stringify({ foundationFirst: true, timeoutMs: 2000, keyCommand: ['/bin/sh', '-c', 'echo leaked-detail >&2; exit 3'] }))
  await expect(learner()).rejects.toThrow('Learning credential unavailable')
  const seen: string[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { seen.push(new Headers(init?.headers).get('x-api-key') ?? ''); return new Response('{"recorded":true}', { headers: { 'content-type': 'application/json' } }) }) as unknown as typeof fetch
  try {
    writeFileSync(process.env.LEARNER_HOOK_CONFIG!, JSON.stringify({ foundationFirst: true, timeoutMs: 2000, serverUrl: 'http://127.0.0.1:9', keyCommand: ['/bin/echo', 'key-from-command'] }))
    await (await learner())('recordLearningHookHealth', { provider: 'claude', sessionId: crypto.randomUUID(), level: 'info', kind: 'session_enabled', occurredAt: new Date().toISOString() } as never, { validate: false })
    expect(seen).toEqual(['key-from-command'])
  } finally { globalThis.fetch = realFetch }
})

