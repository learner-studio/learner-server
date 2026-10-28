/**
 * Render (and with --apply, install) the configuration that makes a new
 * learner-server advertise the right URLs to learner-desktop
 * (docs/specs/server-desktop-pairing.md).
 *
 *   bun scripts/install.ts --out DIR [--api-url URL] [--web-url URL] [--growthbook [--growthbook-url URL --growthbook-api-url URL]] [--port N] [--apply]
 *
 * --api-url   the URL clients use for the API. Default http://127.0.0.1:<port>,
 *             which makes this a same-machine install; anything else is remote.
 * --growthbook  render a loopback-bound GrowthBook (deploy/growthbook). Its
 *             APP_ORIGIN / API_HOST default to http://127.0.0.1:3200 / :3201
 *             (same-machine). A remote install must name its own gated
 *             GrowthBook origins: a fresh GrowthBook gives its owner account to
 *             the first visitor, and it cannot run under a subpath.
 *
 * Without --apply it only writes DIR (mode 700) and touches nothing else:
 *   learner.env.fragment   the endpoint keys, exactly what the server will read
 *   growthbook/            docker-compose.yml + growthbook.env (secrets, mode 600)
 *   nginx/                 remote only: learner-api.conf (the shipped file) + learner-upstream.conf
 * --apply merges the fragment into /etc/learner/learner.env (those keys only,
 * after a backup) and starts GrowthBook from /etc/learner/growthbook, refusing
 * when something already listens on its ports. Device keys are a separate step:
 *   packages/server/scripts/mint-api-key.ts --device <id> --pairing <file> [--owner <user>]
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { resolveEndpoints } from '../packages/server/src/pairing.js'

const ROOT = join(import.meta.dir, '..')
export const SAME_MACHINE_GROWTHBOOK = { app: 'http://127.0.0.1:3200', api: 'http://127.0.0.1:3201' }

export interface InstallOptions {
  port: number
  apiUrl?: string
  webUrl?: string
  growthbook: boolean
  growthbookUrl?: string
  growthbookApiUrl?: string
}

export interface Rendered {
  /** path relative to the output dir → [content, mode] */
  files: Record<string, [string, number]>
  env: Record<string, string>
  topology: 'same-machine' | 'remote'
}

const secret = () => randomBytes(32).toString('hex')

/** Pure: everything the install writes, derived from one endpoint record. */
export function render(options: InstallOptions): Rendered {
  const apiUrl = options.apiUrl ?? `http://127.0.0.1:${options.port}`
  const probe = resolveEndpoints({ port: options.port, publicApiUrl: apiUrl, servesWeb: false })
  let growthbook: { app: string; api: string } | undefined
  if (options.growthbook) {
    if (options.growthbookUrl || options.growthbookApiUrl) growthbook = { app: options.growthbookUrl ?? '', api: options.growthbookApiUrl ?? '' }
    else if (probe.topology === 'same-machine') growthbook = SAME_MACHINE_GROWTHBOOK
    else throw new Error('a remote install needs --growthbook-url and --growthbook-api-url: its own gated origins (GrowthBook cannot run under a subpath, and must not be public ungated)')
  }
  const env: Record<string, string> = { LEARNER_PORT: String(options.port), LEARNER_PUBLIC_API_URL: probe.apiBase }
  if (options.webUrl) env.LEARNER_WEB_URL = options.webUrl
  if (growthbook) Object.assign(env, { LEARNER_GROWTHBOOK_URL: growthbook.app, LEARNER_GROWTHBOOK_API_URL: growthbook.api })
  // The exact record the server will advertise; throws on any bad URL before anything is written.
  const endpoints = resolveEndpoints({ port: options.port, publicApiUrl: env.LEARNER_PUBLIC_API_URL, webUrl: env.LEARNER_WEB_URL, servesWeb: false, growthbookUrl: env.LEARNER_GROWTHBOOK_URL, growthbookApiUrl: env.LEARNER_GROWTHBOOK_API_URL })

  const files: Rendered['files'] = {
    'learner.env.fragment': [`# learner-server endpoints (${endpoints.topology}); rendered by scripts/install.ts\n${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, 0o644],
  }
  if (endpoints.growthbook) {
    const mongo = secret()
    files['growthbook/docker-compose.yml'] = [readFileSync(join(ROOT, 'deploy/growthbook/docker-compose.yml'), 'utf8'), 0o644]
    files['growthbook/growthbook.env'] = [[
      'NODE_ENV=production',
      `APP_ORIGIN=${endpoints.growthbook.app}`,
      `API_HOST=${endpoints.growthbook.api}`,
      'MONGO_INITDB_ROOT_USERNAME=root',
      `MONGO_INITDB_ROOT_PASSWORD=${mongo}`,
      `MONGODB_URI=mongodb://root:${mongo}@mongo:27017/growthbook?authSource=admin`,
      `JWT_SECRET=${secret()}`,
      `ENCRYPTION_KEY=${secret()}`,
    ].join('\n') + '\n', 0o600]
  }
  if (endpoints.topology === 'remote') {
    files['nginx/learner-api.conf'] = [readFileSync(join(ROOT, 'deploy/nginx/learner-api.conf'), 'utf8'), 0o644]
    const upstream = readFileSync(join(ROOT, 'deploy/nginx/learner-upstream.conf'), 'utf8')
    if (!upstream.includes('127.0.0.1:3010')) throw new Error('deploy/nginx/learner-upstream.conf no longer names 127.0.0.1:3010; update the port rewrite')
    files['nginx/learner-upstream.conf'] = [upstream.replace('127.0.0.1:3010', `127.0.0.1:${options.port}`), 0o644]
  }
  return { files, env, topology: endpoints.topology }
}

export function writeRendered(out: string, rendered: Rendered) {
  mkdirSync(out, { recursive: true, mode: 0o700 })
  chmodSync(out, 0o700)
  for (const [path, [content, mode]] of Object.entries(rendered.files)) {
    const file = join(out, path)
    mkdirSync(join(file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(file, content, { mode })
    chmodSync(file, mode)
  }
}

/** Set or replace only `keys` in an env file's text; every other line stays byte for byte. */
export function mergeEnv(text: string, env: Record<string, string>): string {
  const lines = text.split('\n')
  const seen = new Set<string>()
  const merged = lines.map((line) => {
    const key = line.match(/^([A-Z0-9_]+)=/)?.[1]
    if (key && key in env) { seen.add(key); return `${key}=${env[key]}` }
    return line
  })
  const missing = Object.entries(env).filter(([k]) => !seen.has(k)).map(([k, v]) => `${k}=${v}`)
  const body = merged.join('\n').replace(/\n*$/, '')
  return `${body}${body ? '\n' : ''}${missing.join('\n')}${missing.length ? '\n' : ''}`
}

const listening = (port: number) => new Promise<boolean>((resolve) => {
  const socket = connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true) })
  socket.on('error', () => resolve(false))
})

async function apply(rendered: Rendered, out: string) {
  const envFile = '/etc/learner/learner.env'
  if (rendered.files['growthbook/docker-compose.yml']) {
    for (const port of [3200, 3201]) if (await listening(port)) throw new Error(`--apply: something already listens on 127.0.0.1:${port}; refusing to start a second GrowthBook (configure LEARNER_GROWTHBOOK_URL for the existing one instead)`)
  }
  mkdirSync('/etc/learner', { recursive: true, mode: 0o755 })
  if (existsSync(envFile)) copyFileSync(envFile, `${envFile}.bak-install-${Date.now()}`)
  writeFileSync(envFile, mergeEnv(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '', rendered.env), { mode: 0o600 })
  chmodSync(envFile, 0o600)
  console.log(JSON.stringify({ event: 'env-merged', file: envFile, keys: Object.keys(rendered.env) }))
  if (rendered.files['growthbook/docker-compose.yml']) {
    const dir = '/etc/learner/growthbook'
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    for (const name of ['docker-compose.yml', 'growthbook.env']) copyFileSync(join(out, 'growthbook', name), join(dir, name))
    chmodSync(join(dir, 'growthbook.env'), 0o600)
    const up = Bun.spawnSync(['docker', 'compose', '-f', join(dir, 'docker-compose.yml'), 'up', '-d'], { stdout: 'inherit', stderr: 'inherit' })
    if (up.exitCode !== 0) throw new Error('docker compose up failed')
  }
  console.log('applied; restart learner-api (systemctl restart learner-api) so it advertises the new endpoints')
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const out = flag('--out')
  if (!out) throw new Error('usage: install.ts --out DIR [--api-url URL] [--web-url URL] [--growthbook [--growthbook-url URL --growthbook-api-url URL]] [--port N] [--apply]')
  const rendered = render({
    port: Number(flag('--port') ?? 3010), apiUrl: flag('--api-url'), webUrl: flag('--web-url'),
    growthbook: args.includes('--growthbook'), growthbookUrl: flag('--growthbook-url'), growthbookApiUrl: flag('--growthbook-api-url'),
  })
  writeRendered(out, rendered)
  console.log(JSON.stringify({ event: 'rendered', out, topology: rendered.topology, files: Object.keys(rendered.files), env: rendered.env }))
  if (args.includes('--apply')) await apply(rendered, out)
}
