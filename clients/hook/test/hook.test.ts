import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The installed hook entry point, run as a subprocess. Every path it touches
 * is redirected by env (config.ts) into a temp dir, and the network is
 * replaced by network.preload.ts (an outage unless a status is injected).
 */
const ENTRY = join(import.meta.dir, '../src/index.ts')
const PRELOAD = join(import.meta.dir, 'network.preload.ts')
const SESSION = '33333333-3333-4333-8333-333333333333'
const CODEX_SESSION = '01a15e94-7caf-78c0-aa56-ac0559adf6cb'
const CATALOG = { catalogVersion: 'test-catalog-v1', catalog: [{ id: 'data-storage-indexes--b-tree-index', title: 'B-tree index' }] }

async function withDir(run: (dir: string) => Promise<void>, { catalog = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'learner-hook-test-'))
  try {
    await writeFile(join(dir, 'hook.json'), JSON.stringify({ foundationFirst: true, timeoutMs: 2500, liveFeedback: true }))
    // Deferral during an outage hands the model the last catalog the server sent.
    if (catalog) await writeFile(join(dir, 'catalog.json'), JSON.stringify(CATALOG))
    await run(dir)
  } finally { await rm(dir, { recursive: true, force: true }) }
}
type HookOutput = { systemMessage?: string; hookSpecificOutput?: { additionalContext: string } }
async function hook(dir: string, event: Record<string, unknown>, { args = [] as string[], env = {} as Record<string, string> } = {}) {
  const child = Bun.spawn(['bun', '--preload', PRELOAD, ENTRY, ...args], {
    env: { ...process.env, LEARNER_HOOK_CONFIG: join(dir, 'hook.json'), LEARNER_HOOK_TRACE_DIR: dir, LEARNER_API_KEY: 'isolated-test-key', LEARNER_URL: 'http://127.0.0.1:9', ...env },
    stdin: new Blob([JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, ...event })]), stdout: 'pipe', stderr: 'pipe',
  })
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(stderr).toBe('')
  expect(exit).toBe(0)
  return JSON.parse(stdout) as HookOutput
}
async function healthReports(dir: string) {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.health.pending'))
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8'))))
}

describe('native Learning hook enablement', () => {
  test('ANY top-level session is enabled: no pinned session id', () => withDir(async (dir) => {
    const out = await hook(dir, { prompt: 'Explain why the index lags.' })
    expect(out.hookSpecificOutput!.additionalContext).toContain('--submit')
  }))

  test('subagents are excluded', () => withDir(async (dir) => {
    expect(await hook(dir, { prompt: 'delegated task', agent_id: 'agent-1' })).toEqual({})
  }))

  test('/learner-off disables only this session, /learner-on resumes it', () => withDir(async (dir) => {
    const off = await hook(dir, { prompt: '/learner-off' })
    expect(off.systemMessage).toContain('OFF')
    expect(off.hookSpecificOutput!.additionalContext).toContain('LEARNER OFF')
    expect(await hook(dir, { prompt: 'Explain the index.' })).toEqual({})
    expect(await hook(dir, { prompt: 'Explain the index.' }, { args: ['--catalog-part', '0'] })).toEqual({})
    const other = await hook(dir, { prompt: 'Explain the index.', session_id: '44444444-4444-4444-8444-444444444444' })
    expect(other.hookSpecificOutput!.additionalContext).toContain('--submit')
    expect((await hook(dir, { prompt: '/learner-on' })).systemMessage).toContain('ON')
    expect((await hook(dir, { prompt: 'Explain the index.' })).hookSpecificOutput!.additionalContext).toContain('--submit')
    expect((await healthReports(dir)).map((r) => r.kind).sort()).toEqual(expect.arrayContaining(['session_disabled', 'session_enabled']))
  }))

  test('a toggle report that missed an outage still reaches the app while the session stays off', () => withDir(async (dir) => {
    // 2026-10-22: /learner-off during the cutover outage left session_disabled in a .health.pending file.
    // The off session then returned before any replay, so the app never learned the session was off and
    // flagged every later prompt as a silent hook.
    await hook(dir, { prompt: '/learner-off' })
    expect((await healthReports(dir)).map((r) => r.kind)).toEqual(['session_disabled'])
    const requests = join(dir, 'requests.log')
    expect(await hook(dir, { prompt: 'Explain the index.' }, { env: { LEARNER_HOOK_TEST_HTTP_STATUS: '200', LEARNER_HOOK_TEST_REQUEST_LOG: requests } })).toEqual({})
    const sent = (await readFile(requests, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
    expect(sent).toEqual([expect.stringMatching(/^recordLearningHookHealth .*"session_disabled"/)])
    expect(await healthReports(dir)).toEqual([])
  }))

  test('a stranded health report is replayed ahead of a backlog of archive notices', () => withDir(async (dir) => {
    // The live trace dir held 46 .archive.pending files beside the toggle; a two-file replay budget
    // spent on archive notices would starve the report the health check depends on.
    await hook(dir, { prompt: '/learner-off' })
    for (let i = 10; i < 40; i++) await writeFile(join(dir, `${SESSION}.000000${i}-0000-4000-8000-000000000000.archive.pending`), JSON.stringify({ sessionId: SESSION, invocationId: `000000${i}-0000-4000-8000-000000000000` }))
    await hook(dir, { prompt: '/learner-on' }, { env: { LEARNER_HOOK_TEST_HTTP_STATUS: '200' } })
    const requests = join(dir, 'requests.log')
    await hook(dir, { hook_event_name: 'Stop' }, { env: { LEARNER_HOOK_TEST_HTTP_STATUS: '200', LEARNER_HOOK_TEST_REQUEST_LOG: requests } })
    const sent = (await readFile(requests, 'utf8')).trim().split('\n')
    expect(sent.some((line) => /^recordLearningHookHealth .*"session_disabled"/.test(line))).toBe(true)
    expect(await healthReports(dir)).toEqual([])
  }))

  test('a catalog companion never acts on a toggle prompt (it runs concurrently with the control hook)', () => withDir(async (dir) => {
    expect(await hook(dir, { prompt: '/learner-off' }, { args: ['--catalog-part', '0'] })).toEqual({})
    expect((await readdir(dir)).some((name) => name.endsWith('.off'))).toBe(false)
  }))

  test('a catalog companion emits the cached catalog without calling the server', () => withDir(async (dir) => {
    const out = await hook(dir, { prompt: 'Explain the index.' }, { args: ['--catalog-part', '0'] })
    expect(out.hookSpecificOutput!.additionalContext).toContain('data-storage-indexes--b-tree-index')
  }))
})

describe('native Learning hook failures are loud', () => {
  test('service outage: the turn is deferred with a durable request, the human is WARNED and the app is told', () => withDir(async (dir) => {
    const out = await hook(dir, { prompt: 'I distinguish user evidence from assistant explanations.' })
    expect(out.systemMessage).toContain('service unreachable')
    const text = out.hookSpecificOutput!.additionalContext
    expect(text).toContain('--submit')
    expect(text).toContain('LEARNING SERVICE DELAYED')
    expect(text.length).toBeLessThan(8000)
    const names = await readdir(dir)
    const deferred = names.find((name) => name.endsWith('.begin.json'))!
    expect(JSON.parse(await readFile(join(dir, deferred), 'utf8')).message).toBe('I distinguish user evidence from assistant explanations.')
    expect(names.some((name) => name.endsWith('.injection.pending'))).toBe(true)
    expect(await healthReports(dir)).toEqual([expect.objectContaining({ provider: 'claude', sessionId: SESSION, level: 'warning', kind: 'service_delayed' })])
    const trace = (await readFile(join(dir, `${SESSION}.jsonl`), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(trace.at(-1).outcome).toBe('feedback_deferred')
  }))

  test('an outage with no cached catalog cannot defer, and says so', () => withDir(async (dir) => {
    const out = await hook(dir, { prompt: 'Explain the index.' })
    expect(out.systemMessage).toContain('NO Learning context')
    expect(out.hookSpecificOutput).toBeUndefined()
  }, { catalog: false }))

  test('a rejected request is an ERROR the human sees, never a silent {}', () => withDir(async (dir) => {
    const out = await hook(dir, { prompt: 'Explain the index.' }, { env: { LEARNER_HOOK_TEST_HTTP_STATUS: '400' } })
    expect(out.systemMessage).toContain('NO Learning context')
    expect(out.hookSpecificOutput).toBeUndefined()
    expect(await healthReports(dir)).toEqual([expect.objectContaining({ level: 'error', kind: 'hook_failed', stage: 'packet_request', status: 400 })])
  }))

  test('a missing config crashes LOUDLY', () => withDir(async (dir) => {
    const out = await hook(dir, { prompt: 'Explain the index.' }, { env: { LEARNER_HOOK_CONFIG: join(dir, 'missing.json') } })
    expect(out.systemMessage).toContain('hook crashed')
  }))
})

describe('Codex provider', () => {
  test('Codex sessions get the same context, reports are tagged codex, and no Claude archive notice is queued', () => withDir(async (dir) => {
    const out = await hook(dir, { prompt: 'Explain the index.', session_id: CODEX_SESSION, turn_id: 'codex-turn-1' }, { args: ['--provider', 'codex'] })
    expect(out.hookSpecificOutput!.additionalContext).toContain('--submit')
    expect((await healthReports(dir))[0]).toEqual(expect.objectContaining({ provider: 'codex', sessionId: CODEX_SESSION }))
    expect((await readdir(dir)).some((name) => name.endsWith('.archive.pending'))).toBe(false)
  }))

  test('Codex toggles with the $learner-off / $learner-on skills and is told the Codex command', () => withDir(async (dir) => {
    const opts = { args: ['--provider', 'codex'] }
    const off = await hook(dir, { prompt: '$learner-off', session_id: CODEX_SESSION }, opts)
    expect(off.systemMessage).toContain('until $learner-on')
    expect(await hook(dir, { prompt: 'Explain the index.', session_id: CODEX_SESSION }, opts)).toEqual({})
    expect((await hook(dir, { prompt: '$learner-on', session_id: CODEX_SESSION }, opts)).systemMessage).toContain('ON')
    expect((await hook(dir, { prompt: 'Explain the index.', session_id: CODEX_SESSION }, opts)).hookSpecificOutput!.additionalContext).toContain('--submit')
  }))
})
