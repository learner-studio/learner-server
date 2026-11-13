import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rpcService } from '@pikku/core/rpc'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { reactiveCoalescer, reactiveIdentity } from '@learner/core/lib/learning/learning-reactive-consolidation.js'
import { getRunUserId } from '@learner/core/lib/workflow/workflow-runs.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * A run started by a Pikku-native function keeps the wire its shared definition wrote (recipe 9.1): the owner and the
 * type, on this checkout's OWN database. The reactive start has no concept target, so its run stops at the prepare
 * step before any model work.
 */
const url = await ownTestDatabaseUrl('runowner')

describe.skipIf(!url)('the run a native function starts keeps its owner and wire type (learner_runowner_test_<checkout>)', () => {
  process.env.LEARNING_PAUSE_FILE = `/nonexistent/learner-run-owner-${randomUUID()}`
  // This database only: an earlier run's fixture users would hold the one admission slot.
  const purge = async (services: { db: { query: (sql: string) => Promise<unknown> } }) => {
    await services.db.query(`DELETE FROM learning_reactive_admission WHERE user_id LIKE 'runowner-%'`)
    await services.db.query(`DELETE FROM learning_reactive_settings WHERE revision='runowner-fixture'`)
  }
  const runtime = bootRuntime({ databaseUrl: url!, schemaPrefix: 'learner_boss_test_runowner_', prepare: purge })
  afterAll(async () => { await purge(await runtime.booted); await runtime.stop() }, 60_000)

  test('dispatchLearningReactiveConceptsStep: the concept run is owned by the dirty row\'s user, wire type scheduled', async () => {
    const services = await runtime.booted
    const userId = `runowner-${randomUUID()}`
    await services.db.query(`INSERT INTO learning_reactive_settings(user_id,enabled,config,revision) VALUES($1,true,'{"enabled":true,"assessmentEnabled":true,"concurrency":1}','runowner-fixture')`, [userId])
    await reactiveCoalescer.markArchiveDirty(userId, reactiveIdentity(userId, 'runowner-concept'), randomUUID())
    await rpcService.getContextRPCService(services, {}, false).invoke('dispatchLearningReactiveConceptsStep', {})
    const row = (await services.db.query(`SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningReactiveConceptWorkflow' AND input::jsonb->>'userId'=$1`, [userId])).rows[0] as { workflow_run_id: string }
    const run = await services.workflowRunService.getRun(row.workflow_run_id)
    expect(run.wire).toMatchObject({ type: 'scheduled', userId })
    expect(getRunUserId(run)).toBe(userId)
  }, 60_000)

  test('startLearningWorkerProbe: no owner, wire type rpc, and the omitted delay defaults to 5s', async () => {
    const services = await runtime.booted
    const rpc = rpcService.getContextRPCService(services, { session: { userId: `runowner-admin-${randomUUID()}`, scopes: ['admin'] } } as never, false)
    const { runId } = await rpc.invoke('startLearningWorkerProbe', {})
    const run = await services.workflowRunService.getRun(runId)
    expect(run.wire.type).toBe('rpc')
    expect(getRunUserId(run)).toBeNull()
    expect(run.input).toEqual({ delay: '5s' })
  }, 60_000)
})
