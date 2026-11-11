import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { rpcService } from '@pikku/core/rpc'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { SPACED_REPETITION_FIXTURE, experimentUserId, spacedRepetitionRunProblems, type SpacedRepetitionSummary } from '@learner/core/lib/learning/learning-spaced-repetition-experiment.js'

/**
 * learningSpacedRepetitionExperimentWorkflow end to end on learner_test, under this runtime the way
 * production runs workflows: started as a queued run, every step executed by the framework's queue
 * workers on pg-boss, state in learner_workflow_*. The standalone engine's twin is
 * runtime-standalone/src/workflow/spaced-repetition-experiment.test.ts; both apply the same checks.
 * pg-boss uses its own schema on learner_test, so no live queue is touched.
 */
const exportToLangfuse = process.env.SPACED_REPETITION_LANGFUSE === 'true'
const BOSS_SCHEMA_PREFIX = 'learner_pikku_boss_test_sr_'
describe.skipIf(!process.env.TEST_DATABASE_URL)('spaced-repetition experiment workflow, framework runtime (learner_test)', () => {
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  // A queue schema of THIS RUN's own. The whole workflow runs inside one orchestrator job, and
  // pg-boss hands that job to any worker on the queue: on a shared schema a concurrent run of this
  // file in another checkout took it, stopped its workers at its own end and left this run
  // `running` until the deadline. The fixture rows are per run already (runId). Dropped in afterAll;
  // one left by a killed run is dropped by a later run once it is an hour old (the name carries its
  // start in epoch seconds).
  const bossSchema = `${BOSS_SCHEMA_PREFIX}${Math.floor(Date.now() / 1000)}_${randomUUID().slice(0, 8)}`
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = bossSchema
  delete process.env.LEARNER_SCHEDULES_ENABLED
  setRuntimeRole('learning-worker')
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    const services = await createSingletonServices(await createConfig())
    await services.backgroundJobs.start()
    return services
  })()
  afterAll(async () => {
    await (await booted).backgroundJobs.stop() // ends the services' pool too
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    try {
      const stale = (await client.query<{ name: string }>(`SELECT nspname AS name FROM pg_namespace WHERE starts_with(nspname, $1)`, [BOSS_SCHEMA_PREFIX])).rows
        .map((r) => r.name).filter((name) => name === bossSchema || Number(name.slice(BOSS_SCHEMA_PREFIX.length).split('_')[0]) < Date.now() / 1000 - 3600)
      for (const name of stale) await client.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
    } finally { await client.end() }
  }, 60_000)

  test(`every prompt (${SPACED_REPETITION_FIXTURE.cases.length}) matches its expectation through queued steps, then fixture rows are removed`, async () => {
    const services = await booted
    const runId = randomUUID()
    const rpc = rpcService.getContextRPCService(services, {}, false)
    const { runId: workflowRunId } = await services.workflowService.startWorkflow('learningSpacedRepetitionExperimentWorkflow', { runId, export: exportToLangfuse }, { type: 'internal' }, rpc)
    let run = await services.workflowRunService.getRun(workflowRunId)
    for (const deadline = Date.now() + 280_000; run && !['completed', 'failed', 'cancelled'].includes(run.status) && Date.now() < deadline;) {
      await Bun.sleep(500)
      run = await services.workflowRunService.getRun(workflowRunId)
    }
    expect(run?.status).toBe('completed')
    expect(run?.inline).toBeFalsy()
    const summary = run!.output as SpacedRepetitionSummary
    console.log(JSON.stringify({ workflowRunId, ...summary }))
    const steps = await services.workflowRunService.getRunSteps(workflowRunId)
    expect(steps.filter((s) => s.status === 'succeeded').length).toBe(SPACED_REPETITION_FIXTURE.cases.length + (exportToLangfuse ? 4 : 2))
    expect(spacedRepetitionRunProblems(summary, { exported: exportToLangfuse })).toEqual([])
    const left = await services.db.query('SELECT count(*)::int n FROM learning_live_feedback_turns WHERE user_id LIKE $1', [`${experimentUserId(runId, '')}%`])
    expect(left.rows[0]).toEqual({ n: 0 })
  }, 300_000)
})
