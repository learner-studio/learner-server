import { describe, expect, test } from 'bun:test'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { getLearningHookHealth, recordLearningHookHealth } from './learning-hook-health.function.js'

// Ported from the previous host's hook-health scenario, minus its HTTP harness:
// the same two functions against learner_test. A fresh user keeps the seeded
// failure out of anyone else's health window.
const logger = { info() {}, warn() {}, error() {}, debug() {} }

describe.skipIf(!process.env.TEST_DATABASE_URL)('Learning hook health (learner_test)', () => {
  test('a hook_failed report surfaces as an ERROR; an info toggle is not a failure', async () => {
    const userId = `hook-health-test-${crypto.randomUUID()}`
    const sessionId = crypto.randomUUID()
    const occurredAt = new Date().toISOString()
    const context = { session: { userId }, rpc: {} } as any
    try {
      const recorded = await recordLearningHookHealth.func({ logger } as any,
        { provider: 'claude', sessionId, level: 'error', kind: 'hook_failed', stage: 'packet_request', detail: 'integration', status: 400, occurredAt }, context)
      expect(recorded.recorded).toBe(true)
      await recordLearningHookHealth.func({ logger } as any, { provider: 'claude', sessionId, level: 'info', kind: 'session_disabled', occurredAt }, context)

      const health = await getLearningHookHealth.func({ logger } as any, { windowMinutes: 30 }, context)
      const failure = health.failures.find((f) => f.sessionId === sessionId)
      expect(health.status).toBe('error')
      expect(failure?.kind).toBe('hook_failed')
      expect(failure?.stage).toBe('packet_request')
      expect(health.messages.some((m) => m.includes(sessionId.slice(0, 8)) && m.includes('hook_failed'))).toBe(true)
      expect(health.failures.some((f) => f.kind === 'session_disabled')).toBe(false)
    } finally {
      await metaDbQuery('DELETE FROM learning_hook_health_events WHERE user_id=$1', [userId])
    }
  })
})
