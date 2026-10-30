/**
 * A real learner-server in either pairing configuration, against the TEST
 * database, for end-to-end pairing checks (docs/specs/server-desktop-pairing.md).
 * `bun run gate` runs it with --check; learner-desktop's own e2e runs it bare.
 *
 *   bun --env-file=/etc/learner/db.env --env-file=/etc/learner/learner.env scripts/pairing-server.ts \
 *     --topology same-machine|remote [--port 3019] [--runtime NAME] [--pairing-dir DIR] \
 *     [--client-id gate-…] [--public-host IP] [--advertise-host NAME] [--seed-mastery-gain] [--check]
 *
 * same-machine  the API on 127.0.0.1:<port>, serving the built web app.
 * remote        a throwaway nginx on <public-host>:<port> running the SHIPPED
 *               deploy/nginx/learner-api.conf, in front of the API on
 *               127.0.0.1:<port+1>. public-host defaults to this machine's first
 *               private-range address, so nothing listens publicly.
 *
 * Driving it from another machine over `ssh -L PORT:127.0.0.1:PORT`:
 *   same-machine  works as is: the desktop sees http://127.0.0.1:<port>.
 *   remote        --public-host 127.0.0.1 --advertise-host learner-pairing.test
 *                 binds nginx to loopback but advertises a NON-loopback name (the
 *                 topology comes from the advertised hostname, not from where it
 *                 resolves), so the server stays `remote`. Map that name to
 *                 127.0.0.1 on the client (/etc/hosts). Copy the pairing file
 *                 over ssh. --check is refused with it: this box cannot resolve the name.
 *
 * It mints a throwaway device (`gate-…` clientId) whose pairing payload goes to
 * <pairing-dir>/desktop-pairing.json (mode 600), prints one JSON line with the
 * URLs, and then either serves until SIGINT/SIGTERM (bare) or runs the desktop's
 * pairing flow from that file alone and exits 0/1 (--check). Either way it
 * revokes the device, deletes the file and stops what it started. Never prints the key.
 *
 * --seed-mastery-gain  the server's learner (LEARNER_ADMIN_EMAILS) becomes a throwaway
 *               `<clientId>@learners.learner.invalid` account holding one notification-worthy
 *               reading (docs/specs/mastery-notifications.md): a manual gain 50 → 65 at medium
 *               confidence, completed at start-up, with a quote. Its runId, conceptId and
 *               completedAt are in the start-up JSON line, so a client asserts on that exact gain.
 *               Assessment runs and receipts are immutable even here, so they stay behind; the
 *               learner account, its feedback rows and the concept are deleted, and the next
 *               run's new learner cannot see them. --check also proves the gain over the
 *               advertised URL: fetched once, not after its own cursor, feedback recorded and idempotent.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL } from 'bun'
import { GetPairingEndpointsOutput, LEARNER_PRODUCT, PAIRING_CONTRACT, PairingPayload, RecordAppHeartbeatOutput } from '@learner/contract'
import { selectedRuntime } from './runtime.ts'

const ROOT = join(import.meta.dir, '..')
const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const topology = flag('--topology')
if (topology !== 'same-machine' && topology !== 'remote') throw new Error('--topology same-machine|remote is required')
const port = Number(flag('--port') ?? 3019)
const runtime = flag('--runtime') ?? selectedRuntime()
const clientId = flag('--client-id') ?? `gate-${randomBytes(4).toString('hex')}`
if (!/^gate-[a-z0-9-]{1,57}$/.test(clientId)) throw new Error('--client-id must start with gate- (throwaway devices only)')
const check = args.includes('--check')
const seedGain = args.includes('--seed-mastery-gain')
const seedLearnerEmail = `${clientId}@learners.learner.invalid`

// The test database only: this harness mints keys and writes device rows.
const testDb = process.env.TEST_DATABASE_URL
if (!testDb || testDb === process.env.DATABASE_URL || !/test/.test(new URL(testDb).pathname)) {
  throw new Error('TEST_DATABASE_URL must name a test database distinct from DATABASE_URL (run with --env-file=/etc/learner/db.env)')
}

function privateHost(): string {
  const given = flag('--public-host')
  if (given) return given
  for (const addresses of Object.values(networkInterfaces())) {
    for (const a of addresses ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address
    }
  }
  throw new Error('no private-range IPv4 address for the remote configuration; pass --public-host')
}

const apiPort = topology === 'remote' ? port + 1 : port
const publicHost = topology === 'remote' ? privateHost() : '127.0.0.1'
const advertiseHost = flag('--advertise-host')
if (advertiseHost && (topology !== 'remote' || check)) throw new Error('--advertise-host is for a bare --topology remote run driven from another machine (no --check)')
if (advertiseHost && !/^[a-z0-9.-]+$/i.test(advertiseHost)) throw new Error('--advertise-host must be a bare hostname')
const apiUrl = topology === 'remote' ? `http://${advertiseHost ?? publicHost}:${port}/learner-api` : `http://127.0.0.1:${port}`
const directApi = `http://127.0.0.1:${apiPort}`
const work = mkdtempSync(join(tmpdir(), `learner-pairing-${topology}-`))
const pairingDir = flag('--pairing-dir') ?? join(work, 'pairing')
const pairingFile = join(pairingDir, 'desktop-pairing.json')

const env: NodeJS.ProcessEnv = {
  ...process.env,
  LEARNER_RUNTIME: runtime, LEARNER_PORT: String(apiPort), LEARNER_DATABASE_URL: testDb, DATABASE_URL: testDb,
  LEARNER_PGBOSS_SCHEMA: 'learner_boss_pairing', LEARNER_SCHEDULES_ENABLED: 'false',
  LEARNER_PUBLIC_API_URL: apiUrl, LEARNER_TRANSCRIPT_UPLOAD_ROOT: join(work, 'uploads'),
  ...(seedGain ? { LEARNER_ADMIN_EMAILS: seedLearnerEmail } : {}),
  ...(topology === 'same-machine' ? { LEARNER_WEB_DIST: join(ROOT, 'apps/web/dist') } : {}),
}
// Never let a harness server reach the real habits database or advertise a real GrowthBook.
for (const key of ['LEARNER_HABITS_DATABASE_URL', 'LEARNER_WEB_URL', 'LEARNER_GROWTHBOOK_URL', 'LEARNER_GROWTHBOOK_API_URL']) delete env[key]

const children: ChildProcess[] = []
function start(name: string, argv: string[]): ChildProcess {
  const log = Bun.file(join(work, `${name}.log`)).writer()
  const child = spawn(argv[0]!, argv.slice(1), { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', (c) => log.write(c))
  child.stderr!.on('data', (c) => log.write(c))
  child.on('exit', () => log.end())
  children.push(child)
  return child
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + ms
  let last: unknown
  for (;;) {
    try { const v = await probe(); if (v) return v } catch (error) { last = error }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ''}`)
    await sleep(500)
  }
}
function must(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message) }

let minting: Promise<unknown> = Promise.resolve()
async function mint(extra: string[]) {
  const run = mintOnce(extra)
  minting = run.catch(() => {})
  return run
}
async function mintOnce(extra: string[]) {
  const proc = Bun.spawn(['bun', 'packages/server/scripts/mint-api-key.ts', '--device', clientId, ...extra], { cwd: ROOT, env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  if (code !== 0) throw new Error(`mint-api-key ${extra[0] ?? ''}: ${err.trim().split('\n').slice(-3).join(' ')}`)
  return out
}

/** Revoke the device, then prove it: the old key is refused and no user, key or device row is left. */
async function revokeAndVerify(): Promise<void> {
  // A signal can land while a mint is still writing its key: revoke after it, or the key outlives the revoke.
  await minting
  const key = existsSync(pairingFile) ? PairingPayload.safeParse(JSON.parse(readFileSync(pairingFile, 'utf8'))).data?.apiKey : undefined
  await mint(['--revoke'])
  if (key && children.length) {
    const after = await rpc(directApi, 'getPairingEndpoints', { clientId }, key)
    must(after.status === 401, `the revoked key -> ${after.status}, want 401`)
  }
  const sql = new SQL(testDb!)
  try {
    const [row] = await sql`SELECT
      (SELECT count(*)::int FROM "user" WHERE email = ${`${clientId}@devices.learner.invalid`}) AS users,
      (SELECT count(*)::int FROM apikey WHERE name = ${`device:${clientId}`}) AS keys,
      (SELECT count(*)::int FROM learner_desktop_devices WHERE client_id = ${clientId}) AS devices`
    must(row.users === 0 && row.keys === 0 && row.devices === 0, `revoke left ${JSON.stringify(row)} for ${clientId}`)
  } finally {
    await sql.close()
  }
}

type SeededGain = { conceptId: string; runId: string; previousRunId: string; completedAt: string }
let seeded: SeededGain | undefined
/** One gain of +15 over a counted reading an hour earlier, for a learner no other run can see. */
async function seedMasteryGain(): Promise<SeededGain> {
  const db = new SQL(testDb!)
  try {
    const learnerId = crypto.randomUUID()
    const conceptId = `pairing-e2e-${clientId}`
    const now = new Date(Math.floor(Date.now() / 1000) * 1000)
    const earlier = new Date(now.getTime() - 3_600_000).toISOString()
    const completedAt = now.toISOString()
    await db`INSERT INTO "user"(id, name, email, email_verified, created_at, updated_at) VALUES (${learnerId}, ${`pairing-e2e learner ${clientId}`}, ${seedLearnerEmail}, true, ${completedAt}, ${completedAt})`
    await db`INSERT INTO learning_concepts(id, title, summary, explanation, example, domain, capability, x, y, source_kind)
      VALUES (${conceptId}, 'Pairing e2e concept', 's', 'e', 'x', 'test', 'explain', 0, 0, 'user')`
    const reading = async (percent: number, at: string, quote: string | null) => {
      const runId = crypto.randomUUID()
      const receipt = { status: 'completed', completedAt: at, assessment: { conceptId, understandingPercent: percent, confidence: 'medium',
        demonstrated: quote ? [{ quote, sourceId: 'pairing-e2e', description: 'seeded' }] : [], gaps: [], nextCheck: 'n', needsReview: false } }
      await db`INSERT INTO learning_concept_assessment_runs(run_id, user_id, request_id, concept_id, node_version, input_hash, snapshot, created_at)
        VALUES (${runId}, ${learnerId}, ${runId}, ${conceptId}, 'pairing-e2e', 'pairing-e2e', ${JSON.stringify({ prompt: 'pairing-e2e' })}::text::jsonb, ${at})`
      await db`INSERT INTO learning_concept_assessment_receipts(run_id, receipt, completed_at) VALUES (${runId}, ${JSON.stringify(receipt)}::text::jsonb, ${at})`
      return runId
    }
    const previousRunId = await reading(50, earlier, null)
    const runId = await reading(65, completedAt, 'A seeded quote for the pairing e2e gain.')
    return { conceptId, runId, previousRunId, completedAt }
  } finally { await db.close() }
}
async function unseedMasteryGain(): Promise<void> {
  const db = new SQL(testDb!)
  try {
    if (seeded) await db`DELETE FROM learning_notification_feedback WHERE run_id IN (${seeded.runId}, ${seeded.previousRunId})`
    await db`DELETE FROM "user" WHERE email = ${seedLearnerEmail}`
    await db`DELETE FROM learning_concepts WHERE id = ${`pairing-e2e-${clientId}`}`
  } finally { await db.close() }
}

let cleaned = false
/** False when the revoke failed or left anything behind: a leftover device key is a live credential. */
async function cleanup(): Promise<boolean> {
  if (cleaned) return true
  cleaned = true
  let revoked = true
  await revokeAndVerify().catch((error) => {
    revoked = false
    console.error(JSON.stringify({ event: 'revoke-failed', clientId, message: (error as Error).message }))
  })
  rmSync(pairingFile, { force: true })
  if (seedGain) await unseedMasteryGain().catch((error) => {
    revoked = false
    console.error(JSON.stringify({ event: 'unseed-failed', clientId, message: (error as Error).message }))
  })
  for (const child of children) { try { process.kill(-child.pid!, 'SIGTERM') } catch { /* gone */ } }
  await sleep(500)
  for (const child of children) { try { process.kill(-child.pid!, 'SIGKILL') } catch { /* gone */ } }
  rmSync(work, { recursive: true, force: true })
  return revoked
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { void cleanup().then(() => process.exit(130)) })

/** The nginx a remote install runs, reduced to the shipped machine-route file and its upstream. */
function nginxConfig(): string {
  const temp = join(work, 'nginx')
  mkdirSync(temp, { recursive: true })
  const shipped = readFileSync(join(ROOT, 'deploy/nginx/learner-upstream.conf'), 'utf8')
  if (!shipped.includes('127.0.0.1:3010')) throw new Error('deploy/nginx/learner-upstream.conf no longer names 127.0.0.1:3010; update the port rewrite')
  const upstream = shipped.replace('127.0.0.1:3010', `127.0.0.1:${apiPort}`)
  return `worker_processes 1;
pid ${temp}/nginx.pid;
error_log ${temp}/error.log;
events { worker_connections 64; }
http {
  access_log off;
  client_body_temp_path ${temp}/body; proxy_temp_path ${temp}/proxy; fastcgi_temp_path ${temp}/fastcgi; uwsgi_temp_path ${temp}/uwsgi; scgi_temp_path ${temp}/scgi;
  ${upstream}
  server {
    listen ${publicHost}:${port};
    include ${join(ROOT, 'deploy/nginx/learner-api.conf')};
  }
}
`
}

const HEALTH_KEYS = ['contract', 'db', 'ok', 'product', 'role', 'uptime']

async function rpc(base: string, name: string, data: unknown, key: string | null) {
  const res = await fetch(`${base}/rpc/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) }, body: JSON.stringify({ data }) })
  return { status: res.status, body: await res.json().catch(() => null) as unknown }
}

/** What learner-desktop does with a pairing file, and nothing it could not know from it. */
async function desktopFlow(): Promise<string[]> {
  const proven: string[] = []
  const payload = PairingPayload.parse(JSON.parse(readFileSync(pairingFile, 'utf8')))
  must(payload.apiUrl === apiUrl && payload.clientId === clientId, `pairing payload names ${payload.apiUrl} / ${payload.clientId}`)
  const mode = (Bun.spawnSync(['stat', '-c', '%a', pairingFile]).stdout.toString().trim())
  must(mode === '600', `pairing file mode ${mode}, want 600`)
  proven.push('pairing file: mode 600, pinned apiUrl')

  // 1. Is this URL a learner-server? Before the key goes anywhere.
  const health = await fetch(`${payload.apiUrl}/api/health`).then((r) => r.json()) as Record<string, unknown>
  must(health.ok === true && health.product === LEARNER_PRODUCT && health.contract === PAIRING_CONTRACT, `health: ${JSON.stringify(health)}`)
  // Unauthenticated, so it says what the server is and nothing an attacker could fingerprint.
  must(JSON.stringify(Object.keys(health).sort()) === JSON.stringify(HEALTH_KEYS), `health exposes ${Object.keys(health).sort().join(', ')}, want exactly ${HEALTH_KEYS.join(', ')}`)
  proven.push(`health via ${topology === 'remote' ? 'nginx' : 'loopback'}: product ${health.product}, contract ${health.contract}`)

  // 2. The server's side.
  const asked = await rpc(payload.apiUrl, 'getPairingEndpoints', { clientId }, payload.apiKey)
  must(asked.status === 200, `getPairingEndpoints -> ${asked.status} ${JSON.stringify(asked.body)}`)
  const ends = GetPairingEndpointsOutput.parse(asked.body)
  must(ends.topology === topology, `topology ${ends.topology}, want ${topology}`)
  must(ends.api.base === payload.apiUrl, `advertised api ${ends.api.base} is not the pinned ${payload.apiUrl}`)
  must(ends.uploader.required === (topology === 'remote'), `uploader.required ${ends.uploader.required}`)
  must(ends.device.pairingState === 'unknown', `fresh device pairingState ${ends.device.pairingState}`)
  must(ends.growthbook === null, 'the harness runs no GrowthBook, yet one is advertised')
  proven.push(`getPairingEndpoints: ${ends.topology}, uploader ${ends.uploader.required ? 'required' : 'not needed'}`)

  // 3. Follow every advertised URL.
  const healthRes = await fetch(ends.api.health)
  must(healthRes.status === 200, `advertised health -> ${healthRes.status}`)
  if (topology === 'same-machine') {
    must(ends.web, 'same-machine with a web build advertises no web URL')
    const index = await fetch(ends.web).then((r) => r.text())
    const script = index.match(/<script[^>]+src="([^"]+)"/)?.[1]
    must(script, 'web index references no script')
    // The SPA fallback answers 200 with index.html for ANY path, so only a real asset proves the URL.
    const asset = await fetch(new URL(script, ends.web))
    must(asset.status === 200 && /javascript/.test(asset.headers.get('content-type') ?? ''), `web asset ${script} -> ${asset.status} ${asset.headers.get('content-type')}`)
    proven.push(`web: index + ${script} (${asset.headers.get('content-type')})`)
  } else {
    must(ends.web === null, `remote advertises an ungated web UI ${ends.web}`)
    proven.push('web: none published (remote)')
  }

  // 4. The desktop's side, through the advertised URL: ok.
  const beat = (base: string, apiUrlInUse: string) => rpc(base, 'recordAppHeartbeat', {
    clientId, appVersion: 'pairing-e2e', captureState: 'stopped', outboxDepth: 0, detail: {},
    pairing: { apiUrlInUse, endpointsVersionHeld: ends.endpointsVersion, hostname: 'pairing-e2e', services: [{ name: 'screenpipe', url: 'http://localhost:3030' }] },
  }, payload.apiKey)
  const first = await beat(ends.api.base, ends.api.base)
  must(first.status === 200, `heartbeat -> ${first.status} ${JSON.stringify(first.body)}`)
  must(RecordAppHeartbeatOutput.parse(first.body).endpointsVersion === ends.endpointsVersion, 'heartbeat endpointsVersion differs from getPairingEndpoints')
  const seen = GetPairingEndpointsOutput.parse((await rpc(ends.api.base, 'getPairingEndpoints', { clientId }, payload.apiKey)).body)
  must(seen.device.pairingState === 'ok', `after a heartbeat through ${ends.api.base}: ${seen.device.pairingState}`)
  must(seen.device.lastPairing?.services[0]?.url === 'http://localhost:3030', 'the reported services were not stored')
  proven.push('heartbeat through the advertised URL: ok')

  // 5. A desktop going around the advertised URL is visible as a mismatch.
  if (topology === 'remote') {
    await beat(directApi, directApi)
    const around = GetPairingEndpointsOutput.parse((await rpc(ends.api.base, 'getPairingEndpoints', { clientId }, payload.apiKey)).body)
    must(around.device.pairingState === 'mismatch', `a heartbeat straight to ${directApi}: ${around.device.pairingState}, want mismatch`)
    proven.push('a direct loopback heartbeat: mismatch')

    // The shipped nginx file publishes only the machine routes. Each private path answers on the
    // API itself, so the 404 through nginx is nginx's catch-all, not a missing route.
    for (const path of ['/api/auth/get-session', '/api/learning/graph']) {
      const direct = await fetch(`${directApi}${path}`, { headers: { 'x-api-key': payload.apiKey } })
      must(direct.status !== 404, `${path} -> 404 on the API itself; pick a path the API serves`)
      const published = await fetch(`${payload.apiUrl}${path}`, { headers: { 'x-api-key': payload.apiKey } })
      must(published.status === 404 && !/json/.test(published.headers.get('content-type') ?? ''), `nginx publishes ${path}: ${published.status} ${published.headers.get('content-type')}`)
    }
    proven.push('Better Auth + REST: 404 from nginx (the API serves them directly)')
    // The webhook route reaches the API's own token check (nginx would answer 404 on a miss).
    const hook = await fetch(`${payload.apiUrl}/webhooks/readai/not-a-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    const hookDirect = await fetch(`${directApi}/api/webhooks/readai/not-a-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    must(hook.status === 401 && hookDirect.status === 401, `Read.ai webhook with a bad token: ${hook.status} via nginx, ${hookDirect.status} direct, want 401 both`)
    proven.push('Read.ai webhook via nginx: the API rejects a bad token (401)')
  }

  // 6. The key only works for itself, and nothing works without one.
  const foreign = await rpc(ends.api.base, 'getPairingEndpoints', { clientId: 'gate-someone-else' }, payload.apiKey)
  must(foreign.status === 403, `another device's endpoints -> ${foreign.status}, want 403`)
  const anonymous = await rpc(ends.api.base, 'getPairingEndpoints', { clientId }, null)
  must(anonymous.status === 401, `no key -> ${anonymous.status}, want 401`)
  proven.push('another device 403, no key 401')

  // 7. mint-api-key --api-url and --owner: the payload pins the given URL, the file and its new
  // parent directory belong to the desktop's user, and nobody else can read either.
  const owned = join(work, 'owned', 'Learner', 'desktop-pairing.json')
  const asRoot = process.getuid?.() === 0
  await mint(['--pairing', owned, '--api-url', 'https://pinned.example.invalid/learner-api', ...(asRoot ? ['--owner', 'nobody'] : [])])
  must(PairingPayload.parse(JSON.parse(readFileSync(owned, 'utf8'))).apiUrl === 'https://pinned.example.invalid/learner-api', '--api-url did not reach the payload')
  const stat = (path: string) => Bun.spawnSync(['stat', '-c', '%a %u', path]).stdout.toString().trim()
  const nobody = asRoot ? Bun.spawnSync(['id', '-u', 'nobody']).stdout.toString().trim() : String(process.getuid?.())
  must(stat(owned) === `600 ${nobody}` && stat(join(owned, '..')) === `700 ${nobody}`, `owned pairing file ${stat(owned)}, dir ${stat(join(owned, '..'))}, want 600/700 owned by uid ${nobody}`)
  proven.push(`mint --api-url pinned; ${asRoot ? '--owner nobody' : 'own user'}: file 600, dir 700`)

  // 8. The seeded gain, the way the desktop's feed reads it: once, then never past its own cursor.
  if (seeded) {
    const since = new Date(Date.parse(seeded.completedAt) - 15 * 60_000).toISOString()
    const page = await rpc(ends.api.base, 'getMasteryNotifications', { since, limit: 20 }, payload.apiKey)
    must(page.status === 200, `getMasteryNotifications -> ${page.status} ${JSON.stringify(page.body)}`)
    const notes = (page.body as { notifications: Array<Record<string, unknown>> }).notifications
    must(notes.length === 1 && notes[0]!.runId === seeded.runId && notes[0]!.kind === 'gain' && notes[0]!.previousPercent === 50
      && notes[0]!.percent === 65 && notes[0]!.delta === 15 && notes[0]!.completedAt === seeded.completedAt && typeof notes[0]!.quote === 'string',
      `the seeded gain came back as ${JSON.stringify(notes)}`)
    const after = await rpc(ends.api.base, 'getMasteryNotifications', { since: seeded.completedAt, limit: 20 }, payload.apiKey)
    must(after.status === 200 && (after.body as { notifications: unknown[] }).notifications.length === 0, `past its own cursor: ${JSON.stringify(after.body)}`)
    const opened = await rpc(ends.api.base, 'recordNotificationFeedback', { runId: seeded.runId, action: 'opened' }, payload.apiKey)
    const again = await rpc(ends.api.base, 'recordNotificationFeedback', { runId: seeded.runId, action: 'opened' }, payload.apiKey)
    const [o, a] = [opened.body, again.body] as Array<{ recorded: boolean; at: string }>
    must(opened.status === 200 && o.recorded === true && again.status === 200 && a.recorded === true && a.at === o.at, `feedback ${JSON.stringify(o)} then ${JSON.stringify(a)}`)
    proven.push('seeded gain: fetched once with previous/delta/quote, none past its cursor, feedback recorded + idempotent')
  }
  return proven
}

let exitCode = 0
try {
  if (topology === 'remote') {
    writeFileSync(join(work, 'nginx.conf'), nginxConfig())
    const test = Bun.spawnSync(['nginx', '-t', '-p', work, '-c', join(work, 'nginx.conf')], { stderr: 'pipe' })
    if (test.exitCode !== 0) throw new Error(`nginx -t: ${test.stderr.toString().trim()}`)
    start('nginx', ['nginx', '-p', work, '-c', join(work, 'nginx.conf'), '-g', 'daemon off;'])
  }
  if (await fetch(`${directApi}/api/health`).then(() => true, () => false)) throw new Error(`something already answers on ${directApi}; pick another --port`)
  start('api', ['bun', 'scripts/runtime.ts', 'api'])
  await until('API health', 180_000, async () => (await fetch(`${directApi}/api/health`)).ok)
  if (!existsSync(pairingDir)) mkdirSync(pairingDir, { recursive: true, mode: 0o700 })
  await mint(['--pairing', pairingFile, '--force'])
  if (seedGain) seeded = await seedMasteryGain()
  console.log(JSON.stringify({ event: 'pairing-server', topology, runtime, apiUrl, directApi, clientId, pairingFile, ...(topology === 'remote' ? { nginx: `${publicHost}:${port}` } : {}), ...(seeded ? { seededGain: seeded } : {}), logs: work }))
  if (check) {
    const proven = await desktopFlow()
    console.log(JSON.stringify({ event: 'pairing-check', topology, runtime, ok: true, proven }))
  } else {
    await new Promise(() => {}) // serve until a signal
  }
} catch (error) {
  exitCode = 1
  const tail = (name: string) => existsSync(join(work, `${name}.log`)) ? readFileSync(join(work, `${name}.log`), 'utf8').split('\n').slice(-8).join('\n') : ''
  console.error(JSON.stringify({ event: 'pairing-check', topology, runtime, ok: false, message: (error as Error).message }))
  console.error(tail('api'))
} finally {
  if (!(await cleanup())) exitCode = 1
}
process.exit(exitCode)
