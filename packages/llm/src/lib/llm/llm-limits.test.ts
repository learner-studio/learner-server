import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_RATE_LIMITED, cliGovernorState, cliPauseMs, disableCliGovernor, enableCliGovernor, getCliMaxConcurrent, noteCliRateLimited, noteCliSuccess, thrownMessage } from './llm-limits.js'

afterEach(() => disableCliGovernor())

test('the CLI rate-limit governor: off by default; a 429 pauses the pool with doubling jittered backoff; repeated 429s step the cap down once per pause; successes give it back', () => {
  expect(CLI_RATE_LIMITED.test('{"type":"error","message":"exceeded retry limit, last status: 429 Too Many Requests"}')).toBe(true)
  expect(CLI_RATE_LIMITED.test('stream disconnected before completion')).toBe(false)
  // _spawnCLI throws a plain object, not an Error (review 7 B1).
  expect(thrownMessage({ type: 'llm_error', message: 'codex CLI exited with code 1: 429 Too Many Requests', retryable: false })).toContain('429')
  expect(thrownMessage(new Error('x'))).toBe('x')
  expect(thrownMessage('plain')).toBe('plain')
  // Off: the product's cap and no pause, whatever is noted.
  const productCap = getCliMaxConcurrent()
  expect(noteCliRateLimited(0)).toBe(0)
  noteCliSuccess()
  expect(cliPauseMs(0)).toBe(0)
  expect(getCliMaxConcurrent()).toBe(productCap)
  let draw = 0.5 // jitter factor 0.5 + draw = 1
  enableCliGovernor({ max: 6, min: 2, baseMs: 1000, capMs: 5000, recoverAfter: 3, random: () => draw })
  expect(getCliMaxConcurrent()).toBe(6)
  expect(noteCliRateLimited(0)).toBe(1000)              // first 429: pause, cap kept
  expect(cliPauseMs(400)).toBe(600)
  expect(cliGovernorState()).toMatchObject({ max: 6, streak: 1, rateLimited: 1, stepDowns: 0 })
  expect(noteCliRateLimited(0)).toBe(2000)              // repeated: doubled, and one step down
  expect(getCliMaxConcurrent()).toBe(5)
  // The rest of the burst (calls in flight, within the pause) does not step again (review 7 S5).
  for (let i = 0; i < 4; i++) noteCliRateLimited(100)
  expect(getCliMaxConcurrent()).toBe(5)
  // A repeated 429 after the pause has run out steps once more.
  noteCliRateLimited(60_000)
  expect(getCliMaxConcurrent()).toBe(4)
  // Successes end the streak, and recoverAfter of them in a row give one slot back, up to the ceiling.
  noteCliSuccess(); noteCliSuccess()
  expect(getCliMaxConcurrent()).toBe(4)
  noteCliSuccess()
  expect(cliGovernorState()).toMatchObject({ max: 5, stepUps: 1, streak: 0 })
  for (let i = 0; i < 30; i++) noteCliSuccess()
  expect(getCliMaxConcurrent()).toBe(6)
  draw = 1                                              // jitter 1.5x, capped base; never below min
  for (let i = 0; i < 12; i++) noteCliRateLimited(100_000 + i * 20_000)
  expect(cliGovernorState().max).toBe(2)
  expect(cliPauseMs(320_000)).toBe(7500)                // capMs 5000 x 1.5
  disableCliGovernor()
  expect(getCliMaxConcurrent()).toBe(productCap)
  expect(cliPauseMs(0)).toBe(0)
})

// Review 7 B1: through the real callLLM -> callAdminCLI -> _spawnCLI path, with a fake codex binary in its own process.
const drive = (env: Record<string, string>) => {
  const out = Bun.spawnSync(['bun', join(import.meta.dir, 'testing/governor-driver.ts')], {
    env: { ...process.env, CODEX_CLI_BIN: join(import.meta.dir, 'testing/fake-codex-governor.ts'), LEARNER_LLM_CHILD_SCOPE: '', ...env }, stdout: 'pipe', stderr: 'pipe' })
  const line = out.stdout.toString().trim().split('\n').at(-1) ?? ''
  if (!line.startsWith('{')) throw new Error(`driver failed: ${out.stderr.toString().slice(-2000)}`)
  return JSON.parse(line)
}

test('a real codex 429 (the plain object _spawnCLI throws) reaches the governor: counted, the pool paused, repeated ones step the cap down', () => {
  const r = drive({ FAKE_CODEX_MODE: '429' })
  expect(r.errors).toHaveLength(2)
  expect(r.errors[0]).toContain('429')
  expect(r.state).toMatchObject({ rateLimited: 2, streak: 2, max: 5, stepDowns: 1 })
}, 30_000)

test('lowering the cap under running calls holds the queued ones to the new cap (the releaseCliSlot guard, review 7 S6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-governor-'))
  try {
    const spans = join(dir, 'spans')
    const r = drive({ FAKE_CODEX_SPANS: spans, FAKE_CODEX_SLEEP_MS: '600' })
    const s = readFileSync(spans, 'utf8').trim().split('\n').map((l) => l.split(' ').map(Number) as [number, number]).sort((a, b) => a[0] - b[0])
    expect(s).toHaveLength(8)
    const overlap = (t: number) => s.filter(([a, b]) => a <= t && t < b).length
    // The first 4 ran together; two 429s lowered the cap to 3, and every later start saw at most 3 running (without
    // the guard, each release hands its slot straight on and 4 run again).
    expect(r.state.max).toBe(3)
    expect(overlap(s[0]![0] + 50)).toBe(4)
    expect(Math.max(...s.slice(4).map(([a]) => overlap(a)))).toBeLessThanOrEqual(3)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 30_000)
