import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../packages/server/src/config.js'
import { SAME_MACHINE_GROWTHBOOK, mergeEnv, render, writeRendered } from './install.js'

const ROOT = join(import.meta.dir, '..')
const envOf = (fragment: string) => Object.fromEntries(fragment.split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const fileEnv = (text: string) => envOf(text)
/** What the server will advertise once it reads the rendered fragment. */
const advertised = (fragment: string) => loadConfig('api', { LEARNER_DATABASE_URL: 'postgres://x/y', ...envOf(fragment) }).endpoints

describe('install render: the two configurations', () => {
  test('same-machine by default: loopback API, no nginx, and the server reads back what was rendered', () => {
    const { files, topology } = render({ port: 3010, growthbook: false })
    expect(topology).toBe('same-machine')
    expect(Object.keys(files)).toEqual(['learner.env.fragment'])
    expect(advertised(files['learner.env.fragment']![0])).toEqual({ topology: 'same-machine', apiBase: 'http://127.0.0.1:3010', web: null, growthbook: null })
  })

  test('same-machine GrowthBook: one value feeds both GrowthBook and what the server advertises', () => {
    const { files } = render({ port: 3010, growthbook: true })
    const gb = fileEnv(files['growthbook/growthbook.env']![0])
    expect({ app: gb.APP_ORIGIN, api: gb.API_HOST }).toEqual(SAME_MACHINE_GROWTHBOOK)
    expect(advertised(files['learner.env.fragment']![0]).growthbook).toEqual({ app: gb.APP_ORIGIN!, api: gb.API_HOST! })
    // The compose file binds both ports to loopback; nothing listens on all interfaces.
    const compose = files['growthbook/docker-compose.yml']![0]
    expect(compose).toBe(readFileSync(join(ROOT, 'deploy/growthbook/docker-compose.yml'), 'utf8'))
    expect(compose.match(/- "[^"]*:\d+:\d+"/g)).toEqual(['- "127.0.0.1:3200:3000"', '- "127.0.0.1:3201:3100"'])
    expect(compose).not.toMatch(/image: [^@\s]+:latest/)
  })

  test('remote ships the exact nginx machine-route file, pointed at the API port', () => {
    const { files, topology } = render({ port: 3019, apiUrl: 'https://learner.example.org/learner-api', growthbook: true, growthbookUrl: 'https://gb.example.org', growthbookApiUrl: 'https://gb-api.example.org' })
    expect(topology).toBe('remote')
    expect(files['nginx/learner-api.conf']![0]).toBe(readFileSync(join(ROOT, 'deploy/nginx/learner-api.conf'), 'utf8'))
    expect(files['nginx/learner-upstream.conf']![0]).toContain('server 127.0.0.1:3019;')
    expect(advertised(files['learner.env.fragment']![0])).toEqual({
      topology: 'remote', apiBase: 'https://learner.example.org/learner-api', web: null, growthbook: { app: 'https://gb.example.org', api: 'https://gb-api.example.org' },
    })
  })

  test('a remote GrowthBook without its own origins is refused, as is any bad URL', () => {
    expect(() => render({ port: 3010, apiUrl: 'https://learner.example.org/learner-api', growthbook: true })).toThrow('--growthbook-url')
    expect(() => render({ port: 3010, apiUrl: 'https://learner.example.org/x?k=1', growthbook: false })).toThrow('LEARNER_PUBLIC_API_URL')
    expect(() => render({ port: 3010, growthbook: true, growthbookUrl: 'https://gb.example.org' })).toThrow('set together')
  })
})

describe('install render: secrets and files', () => {
  const out = mkdtempSync(join(tmpdir(), 'install-test-'))
  afterAll(() => rmSync(out, { recursive: true, force: true }))

  test('secrets are fresh per render, only in growthbook.env, and that file is mode 600', () => {
    const a = render({ port: 3010, growthbook: true }), b = render({ port: 3010, growthbook: true })
    const secrets = (r: typeof a) => { const e = fileEnv(r.files['growthbook/growthbook.env']![0]); return [e.MONGO_INITDB_ROOT_PASSWORD, e.JWT_SECRET, e.ENCRYPTION_KEY] }
    for (const s of secrets(a)) expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(secrets(a)).not.toEqual(secrets(b))
    expect(fileEnv(a.files['growthbook/growthbook.env']![0]).MONGODB_URI).toContain(secrets(a)[0]!)
    for (const s of secrets(a)) expect(a.files['learner.env.fragment']![0]).not.toContain(s!)
    writeRendered(out, a)
    expect(statSync(out).mode & 0o777).toBe(0o700)
    expect(statSync(join(out, 'growthbook/growthbook.env')).mode & 0o777).toBe(0o600)
  })

  test('mergeEnv replaces only the rendered keys and keeps every other line as it was', () => {
    const before = 'LEARNER_AUTH_SECRET=keep\n# comment\nLEARNER_PUBLIC_API_URL=http://old\nOTHER=x'
    expect(mergeEnv(before, { LEARNER_PUBLIC_API_URL: 'https://new', LEARNER_PORT: '3010' }))
      .toBe('LEARNER_AUTH_SECRET=keep\n# comment\nLEARNER_PUBLIC_API_URL=https://new\nOTHER=x\nLEARNER_PORT=3010\n')
    expect(mergeEnv('', { A_B: '1' })).toBe('A_B=1\n')
  })
})
