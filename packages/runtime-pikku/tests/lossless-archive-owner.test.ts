import { afterAll, describe, expect, test } from 'bun:test'
import { rpcService } from '@pikku/core/rpc'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { cancelWorkflowRuns, getRunUserId } from '@learner/core/lib/workflow/workflow-runs.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * A run started by a Pikku-native function keeps the wire the shared start wrote (`{ type: 'http', userId }`), so the
 * Activity panel (wire.type 'http') and every ownership check (`getRunUserId`) see the caller. On this checkout's OWN
 * database; the run is cancelled once read, since its steps are not under test here.
 */
const url = await ownTestDatabaseUrl('lossless')

describe.skipIf(!url)('a native start keeps the run wire (learner_lossless_test_<checkout>)', () => {
  process.env.LEARNING_PAUSE_FILE = `/nonexistent/learner-pause-${crypto.randomUUID()}`
  const runtime = bootRuntime({ databaseUrl: url!, schemaPrefix: 'learner_pikku_boss_test_lla_', prepare: (services) => {
    services.learningLosslessArchiveSyncService.assertEnabled = () => {}
  } })
  afterAll(() => runtime.stop())

  test('startLearningLosslessArchiveSweep: an http run owned by the caller, with the default mode applied', async () => {
    const services = await runtime.booted
    await cancelWorkflowRuns(services.workflowService, await services.workflowRunService.listRuns({ workflowName: 'learningLosslessArchiveWorkflow', limit: 20 }))
    const userId = `lossless-owner-${crypto.randomUUID()}`
    const rpc = rpcService.getContextRPCService(services, { session: { userId, email: 'owner@example.invalid', scopes: ['admin'] } }, false)
    const { runId } = await rpc.invoke('startLearningLosslessArchiveSweep', {})
    const run = await services.workflowRunService.getRun(runId)
    await cancelWorkflowRuns(services.workflowService, [run!])
    expect(run?.wire?.type).toBe('http')
    expect(getRunUserId(run!)).toBe(userId)
    expect(run?.input).toMatchObject({ mode: 'backfill' })
  }, 60_000)
})
