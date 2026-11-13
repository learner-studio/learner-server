import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { STALE_RUNNING_RUN_MS, listUnsettledRuns, settleAbandonedRuns } from '@learner/core/lib/workflow/workflow-runs.js'

/**
 * A singleton sweep's guard (workflow-runs.ts): a `running` run whose run row AND steps have not moved for
 * STALE_RUNNING_RUN_MS lost its executor and is settled `failed`, so it stops blocking the sweep and leaves every
 * recovery query; one whose step still reports progress keeps blocking however old the run is (the stuck archive
 * sweeps on 2026-10-27). Through the Pikku runtime's own workflow services, on its own migrated database.
 */
const url = await ownTestDatabaseUrl('settle')
describe.skipIf(!url)('abandoned runs are settled, live ones block (learner_settle_test_<checkout>)', () => {
  Object.assign(process.env, { LEARNER_DATABASE_URL: url!, DATABASE_URL: url! })
  setRuntimeRole('api')
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    return createSingletonServices(await createConfig())
  })()
  const WORKFLOW = 'learningWorkerProbeWorkflow'
  const dead = randomUUID(), live = randomUUID()
  afterAll(async () => {
    const { db, close } = await booted
    await db.query('DELETE FROM learner_workflow_runs WHERE workflow_run_id = ANY($1)', [[dead, live]])
    await close()
  })

  test('a dead run is failed and drops out; a run whose step moved keeps blocking', async () => {
    const services = await booted
    const old = new Date(Date.now() - STALE_RUNNING_RUN_MS - 60_000)
    await services.db.query(`INSERT INTO learner_workflow_runs (workflow_run_id, workflow, status, input, created_at, updated_at)
      VALUES ($1, $3, 'running', '{}', $4, $4), ($2, $3, 'running', '{}', $4, $4)`, [dead, live, WORKFLOW, old])
    await services.db.query(`INSERT INTO learner_workflow_steps (workflow_run_id, step_name, status, created_at, updated_at)
      VALUES ($1, 'one', 'running', $3, $3), ($2, 'one', 'running', $3, now())`, [dead, live, old])

    const runs = (await listUnsettledRuns(services.workflowRunService, WORKFLOW)).filter((r) => r.id === dead || r.id === live)
    expect(runs).toHaveLength(2)
    const blocking = await settleAbandonedRuns(services.workflowRunService, services.workflowService, runs)

    expect(blocking.map((r) => r.id)).toEqual([live])
    expect(await services.workflowRunService.getRun(dead)).toMatchObject({ status: 'failed', error: { name: 'AbandonedRunError' } })
    expect((await services.workflowRunService.getRun(live))?.status).toBe('running')
    expect((await listUnsettledRuns(services.workflowRunService, WORKFLOW)).map((r) => r.id)).not.toContain(dead)
  })
})
