import { afterAll, describe, expect, test } from 'bun:test'
import { rpcService } from '@pikku/core/rpc'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { getRunUserId } from '@learner/core/lib/workflow/workflow-runs.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * A run started by a Pikku-native function keeps the owner the shared start wrote (`{ type: 'http', userId }`):
 * startLearningHindsightRealtimeConsolidation passes that wire explicitly, so `getRunUserId` (what
 * getLearningHindsightRealtimeConsolidation's ownership check reads) is the caller. On this checkout's OWN database,
 * with the Hindsight trigger replaced by a fixed 'disabled' result (no native call).
 */
const url = await ownTestDatabaseUrl('hindsight')

describe.skipIf(!url)('a native start keeps the run owner (learner_hindsight_test_<checkout>)', () => {
  const runtime = bootRuntime({ databaseUrl: url!, schemaPrefix: 'learner_pikku_boss_test_hrc_', prepare: (services) => {
    services.learningHindsightConsolidationTriggerService = { trigger: async () => ({ state: 'disabled' }), poll: async () => ({ state: 'disabled' }) }
  } })
  afterAll(() => runtime.stop())

  test('startLearningHindsightRealtimeConsolidation: the run is the caller\'s and an http run', async () => {
    const services = await runtime.booted
    const userId = `hindsight-owner-${crypto.randomUUID()}`
    const rpc = rpcService.getContextRPCService(services, { session: { userId, email: 'owner@example.invalid', scopes: ['admin'] } }, false)
    const { runId } = await rpc.invoke('startLearningHindsightRealtimeConsolidation',
      { bankId: 'bank', scope: ['s'], sequence: 1, watermark: 'w', pendingFacts: 0, oldestPendingAt: null })
    const run = await runtime.awaitRun(runId)
    expect(run?.wire?.type).toBe('http')
    expect(getRunUserId(run!)).toBe(userId)
    expect(run?.status).toBe('completed')
    expect(run?.output).toEqual({ state: 'disabled' })
  }, 120_000)
})
