import { describe, expect, test } from 'bun:test'
import { PairingPayload, PairingUrl } from '@learner/contract'
import { loadConfig } from './config.js'
import { apiUrls, endpointsVersion, isLoopback, pairingState, resolveEndpoints } from './pairing.js'

const base = { port: 3010, servesWeb: false }
const gb = { growthbookUrl: 'https://gb.example.org', growthbookApiUrl: 'https://gb-api.example.org' }

describe('resolveEndpoints', () => {
  test('defaults to same-machine on loopback, with the web UI only when the API serves one', () => {
    expect(resolveEndpoints(base)).toEqual({ topology: 'same-machine', apiBase: 'http://127.0.0.1:3010', web: null, growthbook: null })
    expect(resolveEndpoints({ ...base, servesWeb: true }).web).toBe('http://127.0.0.1:3010/')
    expect(resolveEndpoints({ ...base, port: 3019 }).apiBase).toBe('http://127.0.0.1:3019')
  })

  test('a non-loopback API URL is remote, publishes no web UI by default, and loses its trailing slash', () => {
    const remote = resolveEndpoints({ ...base, servesWeb: true, publicApiUrl: 'https://learner.example.org/learner-api/' })
    expect(remote).toEqual({ topology: 'remote', apiBase: 'https://learner.example.org/learner-api', web: null, growthbook: null })
    expect(apiUrls(remote)).toEqual({ base: 'https://learner.example.org/learner-api', rpcBase: 'https://learner.example.org/learner-api/rpc', health: 'https://learner.example.org/learner-api/api/health' })
  })

  test('explicit web and GrowthBook URLs are advertised as given', () => {
    const remote = resolveEndpoints({ ...base, publicApiUrl: 'https://h.example.org/learner-api', webUrl: 'https://h.example.org/learner/', ...gb })
    expect(remote.web).toBe('https://h.example.org/learner/')
    expect(remote.growthbook).toEqual({ app: 'https://gb.example.org', api: 'https://gb-api.example.org' })
  })

  test('loopback detection covers every loopback spelling and nothing else', () => {
    for (const url of ['http://127.0.0.1:1', 'http://127.4.5.6', 'http://localhost:3010', 'http://[::1]:3010']) expect(isLoopback(url)).toBe(true)
    for (const url of ['http://128.0.0.1', 'http://localhost.example.org', 'http://10.0.0.1', 'https://dev.biztoolz.app', 'http://127.0.0.1.nip.io']) expect(isLoopback(url)).toBe(false)
  })

  test('every invalid setting fails loudly instead of advertising a bad URL', () => {
    for (const publicApiUrl of ['not a url', 'ftp://h/x', 'https://user:pw@h/x', 'https://h/x?a=1', 'https://h/x#f', '/learner-api']) {
      expect(() => resolveEndpoints({ ...base, publicApiUrl })).toThrow('LEARNER_PUBLIC_API_URL')
    }
    expect(() => resolveEndpoints({ ...base, webUrl: 'javascript:alert(1)' })).toThrow('LEARNER_WEB_URL')
    expect(() => resolveEndpoints({ ...base, growthbookUrl: gb.growthbookUrl })).toThrow('set together')
    expect(() => resolveEndpoints({ ...base, growthbookApiUrl: gb.growthbookApiUrl })).toThrow('set together')
    expect(() => resolveEndpoints({ ...base, growthbookUrl: 'gb', growthbookApiUrl: gb.growthbookApiUrl })).toThrow('LEARNER_GROWTHBOOK_URL')
  })

  test('config reads it from the environment, and a bad value stops startup', () => {
    const env = { LEARNER_DATABASE_URL: 'postgres://x/y', LEARNER_PORT: '3019' }
    expect(loadConfig('api', env).endpoints.apiBase).toBe('http://127.0.0.1:3019')
    expect(loadConfig('api', { ...env, LEARNER_PUBLIC_API_URL: 'https://h.example.org/learner-api', LEARNER_GROWTHBOOK_URL: gb.growthbookUrl, LEARNER_GROWTHBOOK_API_URL: gb.growthbookApiUrl }).endpoints)
      .toMatchObject({ topology: 'remote', growthbook: { app: gb.growthbookUrl } })
    expect(() => loadConfig('api', { ...env, LEARNER_PUBLIC_API_URL: 'https://h/x?token=1' })).toThrow('LEARNER_PUBLIC_API_URL')
  })
})

describe('endpointsVersion and pairingState', () => {
  const remote = resolveEndpoints({ ...base, publicApiUrl: 'https://h.example.org/learner-api', ...gb })
  const version = endpointsVersion(remote)

  test('the version is stable and changes when any advertised URL changes', () => {
    expect(endpointsVersion(resolveEndpoints({ ...base, publicApiUrl: 'https://h.example.org/learner-api/', ...gb }))).toBe(version)
    const variants = [
      { ...remote, apiBase: 'https://h.example.org/other' }, { ...remote, web: 'https://h.example.org/learner/' },
      { ...remote, growthbook: null }, { ...remote, growthbook: { ...remote.growthbook!, api: 'https://gb-api2.example.org' } },
      { ...remote, growthbook: { ...remote.growthbook!, app: 'https://gb2.example.org' } },
      { ...remote, topology: 'same-machine' as const },
    ]
    for (const variant of variants) expect(endpointsVersion(variant)).not.toBe(version)
  })

  test('ok, stale, mismatch and unknown', () => {
    expect(pairingState(remote, null)).toBe('unknown')
    expect(pairingState(remote, { apiUrlInUse: 'https://h.example.org/learner-api/', endpointsVersionHeld: version, services: [] })).toBe('ok')
    expect(pairingState(remote, { apiUrlInUse: 'https://h.example.org/learner-api', endpointsVersionHeld: 'older', services: [] })).toBe('stale')
    expect(pairingState(remote, { apiUrlInUse: 'https://h.example.org/learner-api', services: [] })).toBe('stale')
    // A desktop going around the advertised URL (a tunnel to loopback) is visible as such.
    expect(pairingState(remote, { apiUrlInUse: 'http://127.0.0.1:3010', endpointsVersionHeld: version, services: [] })).toBe('mismatch')
  })
})

describe('pairing wire shapes', () => {
  test('a pairing payload carries a URL, a device id and a key, and rejects anything looser', () => {
    expect(PairingPayload.safeParse({ apiUrl: 'http://127.0.0.1:3010', clientId: 'ben-mbp', apiKey: 'k'.repeat(32) }).success).toBe(true)
    expect(PairingPayload.safeParse({ apiUrl: 'http://127.0.0.1:3010', clientId: 'Ben MBP', apiKey: 'k'.repeat(32) }).success).toBe(false)
    expect(PairingPayload.safeParse({ apiUrl: 'http://127.0.0.1:3010', clientId: 'ben-mbp', apiKey: 'short' }).success).toBe(false)
    expect(PairingUrl.safeParse('https://h.example.org/x?apiKey=leak').success).toBe(false)
  })
})
