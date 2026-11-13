import { afterAll, describe, expect, test } from 'bun:test'
import { bootRuntime } from './runtime-harness.js'
import { randomUUID } from 'node:crypto'
import { SPACED_REPETITION_FIXTURE, experimentUserId, spacedRepetitionRunProblems, type SpacedRepetitionSummary } from '@learner/core/lib/learning/learning-spaced-repetition-experiment.js'

/**
 * learningSpacedRepetitionExperimentWorkflow end to end on learner_test, under this runtime the way
 * production runs workflows: started as a queued run, every step executed by the framework's queue
 * workers on pg-boss, state in learner_workflow_*.
 * pg-boss uses its own schema on learner_test, so no live queue is touched.
 */
const exportToLangfuse = process.env.SPACED_REPETITION_LANGFUSE === 'true'
const BOSS_SCHEMA_PREFIX = 'learner_pikku_boss_test_sr_'
describe.skipIf(!process.env.TEST_DATABASE_URL)('spaced-repetition experiment workflow, framework runtime (learner_test)', () => {
  // A queue schema of THIS RUN's own: the whole workflow runs inside one orchestrator job, which pg-boss hands to any
  // worker on the queue, so on a shared schema another checkout's run of this file could take it.
  const runtime = bootRuntime({ schemaPrefix: BOSS_SCHEMA_PREFIX })
  const booted = runtime.booted
  afterAll(runtime.stop, 60_000)

  test(`every prompt (${SPACED_REPETITION_FIXTURE.cases.length}) matches its expectation through queued steps, then fixture rows are removed`, async () => {
    const services = await booted
    const runId = randomUUID()
    const workflowRunId = await runtime.start('learningSpacedRepetitionExperimentWorkflow', { runId, export: exportToLangfuse })
    const run = await runtime.awaitRun(workflowRunId, 280_000)
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
