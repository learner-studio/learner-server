import { describe, expect, test } from 'bun:test'
import { ForbiddenError } from '@learner/core/runtime/errors.js'
import { buildRegistry } from '../functions/registry.js'
import { ROUTES } from '../http/routes.js'
import { checkAccess } from './invoke.js'

// A confined credential (docs/specs/server-desktop-pairing.md, "Confined credentials") reaches only the
// functions that opt in; every other externally reachable function, including any added later, refuses it.
const registry = buildRegistry()
const routed = new Set(ROUTES.map((r) => r.func))
const reachable = [...registry].filter(([name, def]) => def.meta.expose || routed.has(name))
const callable = (session: { scopes: string[] }) => reachable.filter(([name, def]) => {
  try {
    checkAccess(name, def, { userId: 'u', email: 'x@devices.learner.invalid', ...session }, routed.has(name) && !def.meta.expose ? 'route' : 'rpc')
    return true
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error
    return false
  }
}).map(([name]) => name).sort()

describe('confined credentials', () => {
  test('ci-mint reaches only the test-device lifecycle', () => {
    expect(callable({ scopes: ['ci-mint'] })).toEqual(['createTestDevice', 'revokeTestDevice', 'seedMasteryGain'])
  })

  test('a test device reaches only its heartbeat, its endpoints, its own feed and feedback, and the coach design', () => {
    expect(callable({ scopes: ['app', 'test-device'] })).toEqual(
      ['getMasteryNotifications', 'getPairingEndpoints', 'getSpeakingCoachDesign', 'recordAppHeartbeat', 'recordNotificationFeedback'])
  })

  test('a real device key is not narrowed, and an admin cannot call the ci-mint functions', () => {
    const app = callable({ scopes: ['app'] })
    for (const name of ['recordHabitEvents', 'recordCalls', 'uploadTranscript', 'getBaselineStatus']) expect(app).toContain(name)
    expect(callable({ scopes: ['admin'] })).not.toContain('createTestDevice')
  })
})
