import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import type { z } from 'zod'
import type { PairingReport } from '@learner/contract'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { ForbiddenError, UnauthorizedError } from '@learner/core/runtime/errors.js'
import { deviceEmail } from '../../auth.js'
import { endpointsVersion, resolveEndpoints } from '../../pairing.js'
import { checkAccess } from '../../runtime/invoke.js'
import { getPairingEndpoints, recordAppHeartbeat } from './learner-desktop.function.js'

// The device's side of pairing goes in with its heartbeat; getPairingEndpoints
// answers with the server's side and how the two compare. Only the device itself
// (its `app` key) may ask, and only about itself.
type Report = z.input<typeof PairingReport>

describe.skipIf(!process.env.TEST_DATABASE_URL)('learner-desktop pairing (learner_test)', () => {
  const ID = 'pairing-it-mac', OTHER = 'pairing-it-other'
  const endpoints = resolveEndpoints({ port: 3010, servesWeb: false, publicApiUrl: 'https://h.example.org/learner-api', growthbookUrl: 'https://gb.example.org', growthbookApiUrl: 'https://gb.example.org/api' })
  const services = { config: { endpoints } } as never
  const device = (clientId: string) => ({ userId: `u-${clientId}`, email: deviceEmail(clientId), scopes: ['app'] })
  const beat = (pairing?: Report) => recordAppHeartbeat.func(services, heartbeatInput(pairing), { session: device(ID) } as never)
  const heartbeatInput = (pairing?: Report) => ({ clientId: ID, appVersion: '1.0', captureState: 'recording' as const, outboxDepth: 0, detail: {}, ...(pairing ? { pairing } : {}) })
  const ask = (clientId = ID, session = device(ID)) => getPairingEndpoints.func(services, { clientId }, { session } as never)
  const clean = () => metaDbQuery(`DELETE FROM learner_desktop_devices WHERE client_id = ANY($1)`, [[ID, OTHER]])
  beforeEach(clean)
  afterAll(clean)

  test('before any report the device is unknown, and the server side is the advertised record', async () => {
    expect(await ask()).toEqual({
      topology: 'remote', contract: 1, serverVersion: expect.any(String), endpointsVersion: endpointsVersion(endpoints),
      api: { base: 'https://h.example.org/learner-api', rpcBase: 'https://h.example.org/learner-api/rpc', health: 'https://h.example.org/learner-api/api/health' },
      web: null, growthbook: { app: 'https://gb.example.org', api: 'https://gb.example.org/api' }, uploader: { required: true },
      device: { pairingState: 'unknown', lastPairing: null, lastPairingAt: null },
    })
  })

  test('a heartbeat echoes endpointsVersion; its report is stored and compared', async () => {
    const version = endpointsVersion(endpoints)
    expect(await beat()).toMatchObject({ endpointsVersion: version })
    expect((await ask()).device.pairingState).toBe('unknown')

    const report = { apiUrlInUse: 'https://h.example.org/learner-api', endpointsVersionHeld: null, hostname: 'mac', services: [{ name: 'screenpipe', url: 'http://localhost:3030' }] }
    await beat(report)
    const stale = await ask()
    expect(stale.device).toMatchObject({ pairingState: 'stale', lastPairing: report, lastPairingAt: expect.any(String) })

    await beat({ ...report, endpointsVersionHeld: version })
    expect((await ask()).device.pairingState).toBe('ok')
    // A later heartbeat without a report keeps the last one (older clients send none).
    await beat()
    expect((await ask()).device.pairingState).toBe('ok')

    await beat({ ...report, apiUrlInUse: 'http://127.0.0.1:3010', endpointsVersionHeld: version })
    expect((await ask()).device.pairingState).toBe('mismatch')
  })

  test('only the device itself may ask, and only about itself', async () => {
    await expect(Promise.resolve().then(() => ask(OTHER))).rejects.toBeInstanceOf(ForbiddenError)
    expect(() => checkAccess('getPairingEndpoints', getPairingEndpoints, undefined, 'rpc')).toThrow(UnauthorizedError)
    expect(() => checkAccess('getPairingEndpoints', getPairingEndpoints, { userId: 'h', email: 'someone@example.com', scopes: [] } as never, 'rpc')).toThrow(ForbiddenError)
    expect(() => checkAccess('getPairingEndpoints', getPairingEndpoints, device(ID) as never, 'rpc')).not.toThrow()
  })

  test('a stored report that no longer parses is treated as none', async () => {
    await beat()
    await metaDbQuery(`UPDATE learner_desktop_devices SET pairing = '{"apiUrlInUse":"not a url"}'::jsonb, pairing_reported_at = now() WHERE client_id = $1`, [ID])
    expect((await ask()).device).toEqual({ pairingState: 'unknown', lastPairing: null, lastPairingAt: null })
  })
})
