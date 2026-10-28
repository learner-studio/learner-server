// The runtime gate: boots the API and the worker under one runtime package and
// proves the paths every runtime must keep working.
//
//   bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env scripts/gate.ts [runtime ...]
//
// With no arguments it runs every installed runtime (packages/runtime-*), one
// after the other, on LEARNER_PORT (3010). Per runtime:
//   api      health, keyed RPC, 401 without a key, 404 for an unknown RPC, the Read AI webhook, a REST route, the SPA
//   queue    a provider hook POST is queued by the API and drained by the worker into learning_hook_events
//   hook     the CLI hook round trip: UserPromptSubmit -> injected context -> --submit -> stored turn
//   durable  a workflow sleeping across `kill -9` of its worker completes on a NEW worker
//   pairing  scripts/pairing-server.ts --check in both configurations (same-machine, remote via nginx), test DB
// Writes only throwaway rows (a hook event, a feedback turn, a probe run). Never prints the key.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { READAI_WEBHOOK_TEST_PAYLOAD } from '@learner/contract'

const ROOT = join(import.meta.dir, '..')
const PORT = Number(process.env.LEARNER_PORT ?? 3010)
const BASE = `http://127.0.0.1:${PORT}`
// The pairing harness's own servers (remote uses this and the next port).
const PAIRING_PORT = PORT + 20
const WORK = '/var/tmp/learner-gate'
const KEY = readFileSync('/etc/learner/agent-key.env', 'utf8').match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim()
if (!KEY) throw new Error('/etc/learner/agent-key.env has no LEARNER_API_KEY')
// A concept that exists in the seeded catalog; the hook submission names it.
const CONCEPT = 'data-storage-indexes--b-tree-index'

const installed = readdirSync(join(ROOT, 'packages')).filter((d) => d.startsWith('runtime-')).map((d) => d.slice('runtime-'.length))
const runtimes = process.argv.slice(2).length ? process.argv.slice(2) : installed.sort((a, b) => Number(a === 'standalone') - Number(b === 'standalone'))

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined | null | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: unknown
  for (;;) {
    try { const value = await probe(); if (value) return value } catch (error) { last = error }
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`)
    await sleep(500)
  }
}
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function rpc(name: string, data: unknown, key: string | null = KEY!) {
  const res = await fetch(`${BASE}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: JSON.stringify({ data }) })
  return { status: res.status, body: await res.json().catch(() => null) as any }
}
async function ok(name: string, data: unknown) {
  const { status, body } = await rpc(name, data)
  check(status === 200, `${name} -> ${status} ${JSON.stringify(body)?.slice(0, 300)}`)
  return body
}

/** One SQL statement against the learner DB, as postgres, SQL on stdin (postgres cannot read our files). */
async function sql(query: string): Promise<string> {
  const proc = Bun.spawn(['runuser', '-u', 'postgres', '--', 'psql', '-d', 'learner', '-AtqX', '-v', 'ON_ERROR_STOP=1'], { cwd: '/var/tmp', stdin: new Blob([query]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`psql: ${err.trim()}`)
  return out.trim()
}
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`

/** A launcher process in its own group, so teardown reaches the process the launcher starts. */
function launch(runtime: string, command: 'api' | 'worker', log: string, uploads: string): ChildProcess {
  const out = Bun.file(log).writer()
  const child = spawn('bun', ['scripts/runtime.ts', command], {
    cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LEARNER_RUNTIME: runtime, LEARNER_WEB_DIST: join(ROOT, 'apps/web/dist'), LEARNER_WORKFLOW_LEASE_MS: '10000', LEARNER_TRANSCRIPT_UPLOAD_ROOT: uploads,
      // The DB is shared with the dev stack: a gate worker running its schedules starts
      // runs (the singleton archive sweep) that only its runtime may resume, and they
      // block the dev worker's schedule until they go stale.
      LEARNER_SCHEDULES_ENABLED: 'false' },
  })
  child.stdout!.on('data', (chunk) => out.write(chunk))
  child.stderr!.on('data', (chunk) => out.write(chunk))
  launched.add(child)
  child.on('exit', () => { out.end(); launched.delete(child) })
  return child
}
/** Every API and worker the gate has running; an interrupted gate kills these first. */
const launched = new Set<ChildProcess>()
async function stop(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  try { process.kill(-child.pid, signal) } catch { return }
  await Promise.race([exited, sleep(15_000).then(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } })])
}

type Workers = { processes: { role: string; pid: number; live: boolean }[] }
/** True when `pid` is `root` or runs under it: the only workers the gate may watch or kill. */
function descendsFrom(pid: number, root: number | undefined): boolean {
  for (let p = pid, hops = 0; root && p > 1 && hops < 64; hops++) {
    if (p === root) return true
    try { p = Number(readFileSync(`/proc/${p}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[1]) } catch { return false }
  }
  return false
}
/** A live worker the gate launched itself. The registry is shared, so never take one by role alone. */
const liveWorker = async (owner: ChildProcess | undefined, notPid?: number) => {
  const { processes } = await ok('getLearningWorkerRuntime', {}) as Workers
  return processes.find((p) => p.role === 'learning-worker' && p.live && p.pid !== notPid && descendsFrom(p.pid, owner?.pid))
}

async function gate(runtime: string) {
  const dir = join(WORK, runtime)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'traces'), { recursive: true })
  const results: string[] = []
  const pass = (step: string, detail: string) => { results.push(`${step}: ${detail}`); console.log(`  ok   ${step}: ${detail}`) }
  let api: ChildProcess | undefined, worker: ChildProcess | undefined
  try {
    // --- api ----------------------------------------------------------------
    api = launch(runtime, 'api', join(dir, 'api.log'), join(dir, 'uploads'))
    const health = await until('API health', 120_000, async () => (await fetch(`${BASE}/api/health`)).json() as Promise<{ ok: boolean }>)
    check(health.ok && (health as { product?: string }).product === 'learner-server', `health: ${JSON.stringify(health)}`)
    const catalog = await ok('getLearningFeedbackCatalog', {})
    check(Array.isArray(catalog?.catalog) && catalog.catalog.length > 0, 'catalog is empty')
    const anonymous = await rpc('getLearningFeedbackCatalog', {}, null)
    check(anonymous.status === 401, `no key -> ${anonymous.status}, want 401`)
    const unknown = await rpc('noSuchLearnerFunction', {})
    check(unknown.status === 404, `unknown RPC -> ${unknown.status}, want 404`)
    // Machine-only route (requireApiKey): no credential is 401 in every runtime, never 403.
    const bridge = await fetch(`${BASE}/api/internal/hindsight/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    check(bridge.status === 401, `keyless hindsight bridge -> ${bridge.status}, want 401`)
    // The unauthenticated Read AI webhook route: an unknown path token is 401. When no token is
    // configured, a throwaway one proves a test delivery reaches the function (then it is removed;
    // a token an admin saves during these few seconds would be removed with it).
    const webhook = (token: string, test: boolean) => fetch(`${BASE}/api/webhooks/readai/${token}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(test ? { 'x-learner-webhook-test': '1' } : {}) }, body: JSON.stringify(READAI_WEBHOOK_TEST_PAYLOAD) })
    const stranger = await webhook(`gate-unknown-${crypto.randomUUID()}`, true)
    // The message proves the function ran: a route whose auth: false was ignored is also a 401.
    const strangerBody = await stranger.json().catch(() => ({})) as { message?: string }
    check(stranger.status === 401 && strangerBody.message === 'Unknown webhook token', `Read AI webhook with an unknown token -> ${stranger.status} ${strangerBody.message}, want 401 Unknown webhook token`)
    let webhookDetail = 'webhook 401'
    if (!(await ok('getReadAiWebhook', {})).configured) {
      const token = `gate-${crypto.randomUUID()}`
      await ok('saveReadAiWebhook', { token })
      try {
        const delivered = await webhook(token, true)
        check(delivered.status === 200 && (await delivered.json() as { outcome?: string }).outcome === 'test-ok', `Read AI webhook test delivery -> ${delivered.status}`)
      } finally { await ok('clearReadAiWebhook', {}) }
      webhookDetail = 'webhook 401 + test delivery'
    }
    const graph = await fetch(`${BASE}/api/learning/graph`, { headers: { 'x-api-key': KEY! } })
    check(graph.status === 200, `GET /api/learning/graph -> ${graph.status}`)
    const spa = await fetch(`${BASE}/learning`)
    check(spa.status === 200 && (await spa.text()).includes('<div id="root">'), `SPA fallback -> ${spa.status}`)
    pass('api', `health ok, ${catalog.catalog.length} catalog concepts, 401/404 as expected (RPC + machine route), ${webhookDetail}, REST + SPA served`)

    // --- remote transcript upload: offset-addressed, replay-safe -------------
    const line = (n: number) => `${JSON.stringify({ type: 'user', n })}\n`
    const upload = (offset: number, content: string) => ok('uploadTranscript', { provider: 'claude', clientId: 'gate', path: 'gate-project/session.jsonl', offset, content, sha256: new Bun.CryptoHasher('sha256').update(content).digest('hex') })
    const a = await upload(0, line(1)), b = await upload(a.size, line(2)), again = await upload(a.size, line(2))
    const conflict = await rpc('uploadTranscript', { provider: 'claude', clientId: 'gate', path: 'gate-project/session.jsonl', offset: 0, content: line(9), sha256: new Bun.CryptoHasher('sha256').update(line(9)).digest('hex') })
    const spooled = readFileSync(join(dir, 'uploads/claude/gate/gate-project/session.jsonl'), 'utf8')
    check(!a.replayed && !b.replayed && again.replayed && spooled === line(1) + line(2), `upload: ${JSON.stringify({ a, b, again })}`)
    check(conflict.status === 409, `disagreeing chunk -> ${conflict.status}, want 409`)
    pass('upload', `2 chunks spooled (${b.size} bytes), resend replayed, disagreeing chunk 409`)

    // --- uploader CLI: real process, real API; a corrupted state heals from the server
    const roots = join(dir, 'uploader'), session = 'gate-uploader/s.jsonl'
    mkdirSync(join(roots, 'claude/gate-uploader'), { recursive: true })
    writeFileSync(join(roots, 'claude', session), line(1) + line(2) + line(3))
    const uploader = async () => {
      const proc = Bun.spawn(['bun', join(ROOT, 'clients/uploader/src/index.ts'), '--once'], { stdout: 'pipe', stderr: 'pipe', env: {
        ...process.env, LEARNER_URL: BASE, LEARNER_API_KEY: KEY!, LEARNER_CLIENT_ID: 'gate-uploader', LEARNER_UPLOAD_CONFIG: join(roots, 'none.json'),
        LEARNER_UPLOAD_STATE_DIR: join(roots, 'state'), LEARNER_CLAUDE_ROOT: join(roots, 'claude'), LEARNER_CODEX_ROOT: join(roots, 'codex'),
      } })
      const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      check(code === 0, `uploader exit ${code}: ${err.slice(-400)}`)
      return JSON.parse(readFileSync(join(roots, 'state/status.json'), 'utf8')) as { state: string; uploadedBytes: number; healed: number; pendingFiles: number }
    }
    const sent = await uploader()
    writeFileSync(join(roots, 'state/state.json'), '{"corrupt')
    const healed = await uploader()
    const held = readFileSync(join(dir, 'uploads/claude/gate-uploader', session), 'utf8')
    check(sent.state === 'ok' && sent.uploadedBytes === held.length && held === line(1) + line(2) + line(3), `uploader first pass: ${JSON.stringify(sent)}`)
    check(healed.state === 'ok' && healed.healed === 1 && healed.uploadedBytes === 0, `uploader heal pass: ${JSON.stringify(healed)}`)
    pass('uploader', `CLI spooled ${held.length} bytes; a corrupted state file healed from the server with 0 bytes resent`)

    // --- queue: the API enqueues, the worker drains --------------------------
    worker = launch(runtime, 'worker', join(dir, 'worker-1.log'), join(dir, 'uploads'))
    const first = await until('a live worker', 120_000, () => liveWorker(worker))
    const sessionId = crypto.randomUUID()
    const hook = await fetch(`${BASE}/api/learning/hooks/anthropic`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: `runtime gate ${runtime}`, cwd: WORK }),
    })
    const accepted = await hook.json() as { queued: number; eventIds: string[] }
    check(hook.status === 200 && accepted.queued > 0, `hook POST -> ${hook.status} ${JSON.stringify(accepted)}`)
    const ids = accepted.eventIds.map(literal).join(',')
    await until('the hook event row', 60_000, async () => Number(await sql(`select count(*) from learning_hook_events where event_id in (${ids})`)) === accepted.eventIds.length)
    pass('queue', `${accepted.queued} hook job(s) drained by worker pid ${first.pid} into learning_hook_events`)

    // --- hook client round trip ------------------------------------------------
    const hookEnv = { ...process.env, LEARNER_URL: BASE, LEARNER_HOOK_CONFIG: join(dir, 'hook.json'), LEARNER_HOOK_TRACE_DIR: join(dir, 'traces') }
    writeFileSync(hookEnv.LEARNER_HOOK_CONFIG, JSON.stringify({ foundationFirst: true, timeoutMs: 5000, liveFeedback: true }))
    const hookClient = async (args: string[], stdin: string) => {
      const proc = Bun.spawn(['bun', 'clients/hook/src/index.ts', ...args], { cwd: ROOT, env: hookEnv, stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      check(code === 0, `hook ${args.join(' ')} exited ${code}: ${err.slice(0, 300)}`)
      return JSON.parse(out)
    }
    const clientSession = crypto.randomUUID()
    const begin = await hookClient(['--provider', 'codex'], JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: clientSession, prompt: 'I think we should add an index on user_id because the query filters by it and a sequential scan reads every row.' }))
    const context: string = begin?.hookSpecificOutput?.additionalContext ?? ''
    const identity = JSON.parse(context.match(/Submission identity: (\{[^\n]*\})/)?.[1] ?? 'null') as { sessionId: string; turnId: string; catalogVersion: string } | null
    check(identity?.turnId, `UserPromptSubmit injected no submission identity: ${context.slice(0, 200)}`)
    const submitted = await hookClient(['--submit'], JSON.stringify({
      ...identity, taughtConceptIds: [],
      matches: [{ conceptId: CONCEPT, quote: 'a sequential scan reads every row', relationship: 'learner_evidence', outcome: 'partial', reason: 'Knows an index avoids a full scan but not how the B-tree finds rows.', remainingGap: 'How a B-tree lookup locates matching rows in O(log n).' }],
    }))
    check(submitted?.guidance?.decision, `--submit returned no guidance: ${JSON.stringify(submitted).slice(0, 300)}`)
    const turns = Number(await sql(`select count(*) from learning_live_feedback_turns where session_id = ${literal(clientSession)}`))
    check(turns > 0, 'no learning_live_feedback_turns row for the hook session')
    pass('hook', `injection -> submit (${submitted.status}, ${submitted.guidance.decision}) -> ${turns} stored turn(s)`)

    // --- durable: a sleeping run survives kill -9 of its worker ---------------
    const { runId } = await ok('startLearningWorkerProbe', { delay: '30s' })
    await until('the probe to sleep', 60_000, async () => (await ok('getLearningWorkerProbe', { runId })).sleeping)
    const victim = await until('the worker pid', 20_000, () => liveWorker(worker))
    process.kill(victim.pid, 'SIGKILL')
    await until('the killed worker to exit', 20_000, async () => worker!.exitCode !== null || worker!.signalCode !== null)
    worker = launch(runtime, 'worker', join(dir, 'worker-2.log'), join(dir, 'uploads'))
    const probe = await until('the probe to complete on a new worker', 180_000, async () => {
      const p = await ok('getLearningWorkerProbe', { runId })
      check(!['failed', 'cancelled'].includes(p.status), `probe ${p.status}`)
      return p.status === 'completed' && p
    })
    const { before, after } = probe.output as { before: { pid: number; role: string }; after: { pid: number; role: string } }
    check(before.pid === victim.pid, `probe started on pid ${before.pid}, but the gate killed ${victim.pid}`)
    check(after.pid !== before.pid && after.role === 'learning-worker', `probe resumed on ${JSON.stringify(after)}`)
    pass('durable', `run ${runId} slept on pid ${before.pid} (killed -9), completed on pid ${after.pid}`)

    // --- pairing: both configurations, against the test DB --------------------
    // scripts/pairing-server.ts runs the desktop's pairing flow from a pairing file
    // alone; remote goes through a throwaway nginx running the shipped learner-api.conf.
    for (const topology of ['same-machine', 'remote']) {
      const proc = Bun.spawn(['bun', 'scripts/pairing-server.ts', '--topology', topology, '--runtime', runtime, '--port', String(PAIRING_PORT), '--check'],
        { cwd: ROOT, env: process.env, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      const verdict = JSON.parse(`${out}${err}`.split('\n').find((line) => line.includes('"pairing-check"')) ?? 'null') as { ok: boolean; proven?: string[]; message?: string } | null
      check(code === 0 && verdict?.ok, `pairing ${topology}: ${verdict?.message ?? err.trim().slice(-400)}`)
      pass(`pairing ${topology}`, verdict.proven!.join('; '))
    }
    pass('pairing', 'GrowthBook URLs are checked against the installer render (scripts/install.test.ts), not loaded in a browser')
    return { runtime, ok: true, results }
  } catch (error) {
    console.log(`  FAIL ${(error as Error).message}`)
    return { runtime, ok: false, results: [...results, `FAIL ${(error as Error).message}`] }
  } finally {
    await stop(worker)
    await stop(api)
  }
}

// The gate launches its own API on PORT; one already answering there (the dev
// stack's :3010) would serve the gate's requests instead.
if (await fetch(`${BASE}/api/health`).then(() => true, () => false)) {
  console.log(`gate FAILED: something already serves ${BASE} (the dev API?); run with LEARNER_PORT=<free port>`)
  process.exit(1)
}
// Both runtimes take the one learning-worker role fence in the shared DB, so a
// running dev worker would keep the gate's worker from ever starting. Pause it
// for the gate and always start it again.
const devWorker = Bun.spawnSync(['systemctl', 'is-active', '--quiet', 'learner-worker']).exitCode === 0
const resumeDevWorker = () => { if (devWorker) Bun.spawnSync(['systemctl', 'start', 'learner-worker']) }
if (devWorker) {
  console.log('pausing learner-worker for the gate (shared role fence); it restarts when the gate ends')
  Bun.spawnSync(['systemctl', 'stop', 'learner-worker'])
}
// An interrupted gate skips gate()'s finally. Its children are detached, so they
// would outlive it, and an orphaned gate worker keeps the role fence that the
// restarted dev worker waits on: kill them (process groups) BEFORE resuming it.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => {
  for (const child of launched) try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ }
  resumeDevWorker()
  process.exit(130)
})
const report = []
try {
  for (const runtime of runtimes) {
    console.log(`runtime ${runtime}`)
    report.push(await gate(runtime))
  }
} finally {
  resumeDevWorker()
}
writeFileSync(join(WORK, 'report.json'), JSON.stringify(report, null, 2))
console.log(report.every((r) => r.ok) ? `gate passed: ${runtimes.join(', ')}` : `gate FAILED: ${report.filter((r) => !r.ok).map((r) => r.runtime).join(', ')}`)
process.exit(report.every((r) => r.ok) ? 0 : 1)
