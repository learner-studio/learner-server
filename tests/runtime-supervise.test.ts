import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnCrashable, until } from '../packages/llm/src/lib/cli/testing/crash-harness.ts'

// scripts/runtime.ts supervises the server it starts (restart-safety.md, "Deploys"; 2026-11-11: a `git pull` left a
// stale generated file, `bun --watch` children died on load, and both units stayed "active" with nothing serving).
// A fake runtime package counts its prepare/migrate runs and writes its server's pid; the wrapper is a real process.
const root = mkdtempSync(join(tmpdir(), 'runtime-supervise-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let n = 0
const SERVER = (version: number) => `// v${version}\nimport { appendFileSync, existsSync } from 'node:fs'\nif (existsSync('broken')) throw new Error('Export named x not found')\n` +
  `appendFileSync('pids', process.pid + '\\n')\nsetInterval(() => {}, 1000)\n`
function fakeRuntime(opts: { migrateFails?: boolean; prepareSleep?: number } = {}) {
  const dir = join(root, `case-${++n}`, 'runtime-fake')
  mkdirSync(dir, { recursive: true })
  const count = (file: string) => `bun -e "require('fs').appendFileSync('${file}','x')"`
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { prepare: `${opts.prepareSleep ? `sleep ${opts.prepareSleep} && ` : ''}${count('prepared.count')}`, migrate: opts.migrateFails ? 'exit 3' : count('migrated.count'), api: 'bun server.ts' } }))
  writeFileSync(join(dir, 'server.ts'), SERVER(1))
  const read = (file: string) => existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : ''
  const pids = () => read('pids').split('\n').filter(Boolean).map(Number)
  const wrapper = (command: string) => spawnCrashable([process.execPath, join(import.meta.dir, '..', 'scripts', 'runtime.ts'), command],
    { env: { ...process.env, LEARNER_RUNTIME: dir, LEARNER_RELOAD_DEBOUNCE_MS: '200' } })
  return { dir, wrapper, pids, prepared: () => read('prepared.count').length, migrated: () => read('migrated.count').length }
}

test('a server that dies unasked takes the wrapper down non-zero, so systemd restarts the unit', async () => {
  const rt = fakeRuntime()
  const w = rt.wrapper('api')
  await until(() => rt.pids().length === 1, 20_000, 'the server', w)
  expect([rt.prepared(), rt.migrated()]).toEqual([1, 1]) // prepare and migrate run before it serves
  process.kill(rt.pids()[0]!, 'SIGKILL')
  expect(await w.proc.exited).not.toBe(0)
}, 30_000)

test('a pending migration that fails to apply never reaches a serving process', async () => {
  const rt = fakeRuntime({ migrateFails: true })
  expect(await rt.wrapper('api').proc.exited).toBe(3)
  expect(rt.pids()).toEqual([])
})

test('dev: a source change re-runs prepare (never migrate) and restarts the server; a change that fails to load exits non-zero', async () => {
  const rt = fakeRuntime()
  const w = rt.wrapper('dev')
  await until(() => rt.pids().length === 1, 20_000, 'the server', w)
  writeFileSync(join(rt.dir, 'server.ts'), SERVER(2))
  await until(() => rt.pids().length === 2, 20_000, 'the restarted server', w)
  expect([rt.prepared(), rt.migrated()]).toEqual([2, 1]) // a draft migration saved in the checkout is not applied
  expect(() => process.kill(rt.pids()[0]!, 0)).toThrow() // the old one was stopped, not leaked
  writeFileSync(join(rt.dir, 'broken'), '')
  writeFileSync(join(rt.dir, 'server.ts'), SERVER(3))
  expect(await w.proc.exited).not.toBe(0)
}, 60_000)

test('dev: a change during a slow reload re-runs prepare before the one new server starts, never a second live server (review)', async () => {
  const rt = fakeRuntime({ prepareSleep: 2 })
  const w = rt.wrapper('dev')
  await until(() => rt.pids().length === 1, 30_000, 'the server', w)
  writeFileSync(join(rt.dir, 'server.ts'), SERVER(2))
  await Bun.sleep(800) // the debounce fired: the first reload is inside its prepare
  writeFileSync(join(rt.dir, 'server.ts'), SERVER(3))
  await until(() => rt.prepared() === 3 && rt.pids().length === 2, 30_000, 'prepare re-run for the second change, then one server', w)
  await Bun.sleep(1_000)
  expect(rt.pids().length).toBe(2)
  expect(rt.pids().filter((p) => { try { process.kill(p, 0); return true } catch { return false } })).toEqual([rt.pids()[1]!])
  await w.stop('SIGTERM')
}, 60_000)

test('SIGTERM to the wrapper stops the server with it', async () => {
  const rt = fakeRuntime()
  const w = rt.wrapper('dev')
  await until(() => rt.pids().length === 1, 20_000, 'the server', w)
  await w.stop('SIGTERM')
  await until(() => { try { process.kill(rt.pids()[0]!, 0); return false } catch { return true } }, 10_000, 'the server to stop')
})
