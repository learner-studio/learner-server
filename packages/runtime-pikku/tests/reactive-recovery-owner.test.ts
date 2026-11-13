import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rpcService } from '@pikku/core/rpc'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { getRunUserId } from '@learner/core/lib/workflow/workflow-runs.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * The native recoverLearningReactiveGrading keeps the wire its shared start wrote (`{ type: 'internal', userId }`), so
 * the run is the caller's, and a repeated request id answers with the first run instead of starting a second. On this
 * checkout's OWN database; a dry run (the default) only measures.
 */
const url = await ownTestDatabaseUrl('recoveryowner')

describe.skipIf(!url)('a native recovery start keeps its owner and wire type (learner_recoveryowner_test_<checkout>)', () => {
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  const runtime = bootRuntime({ databaseUrl: url!, schemaPrefix: 'learner_boss_test_rcvowner_' })
  afterAll(() => runtime.stop(), 60_000)

  test('recoverLearningReactiveGrading: an internal run owned by the caller, started once per request id', async () => {
    const services = await runtime.booted
    const userId = `recoveryowner-${randomUUID()}`
    const rpc = rpcService.getContextRPCService(services, { session: { userId, scopes: ['admin'] } } as never, false)
    const requestId = randomUUID()
    const first = await rpc.invoke('recoverLearningReactiveGrading', { requestId })
    expect(first.existing).toBe(false)
    const run = await services.workflowRunService.getRun(first.workflowRunId)
    expect(run.wire.type).toBe('internal')
    expect(getRunUserId(run)).toBe(userId)
    expect(await rpc.invoke('recoverLearningReactiveGrading', { requestId })).toEqual({ workflowRunId: first.workflowRunId, existing: true })
  }, 60_000)
})
