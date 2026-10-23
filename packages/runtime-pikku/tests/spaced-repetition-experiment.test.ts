import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
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
describe.skipIf(!process.env.TEST_DATABASE_URL)('spaced-repetition experiment workflow, framework runtime (learner_test)', () => {
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_pikku_boss_test'
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
  afterAll(async () => { await (await booted).backgroundJobs.stop() })

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
