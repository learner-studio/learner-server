import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { rpcService } from '@pikku/core/rpc'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'

/**
 * learningReactiveStallCheckWorkflow under this runtime the way production runs it: a queued run
 * whose steps execute on the framework's pg-boss workers (a schema of its own on learner_test), state in
 * learner_workflow_*. Twin of runtime-standalone/src/workflow/reactive-stall-check.test.ts.
 * Fixture owners have their own ids and are removed after; no shared row is truncated.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('reactive stall check workflow, framework runtime (learner_test)', () => {
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  // Its OWN queue schema: a worker sharing learner_pikku_boss_test (another test file, or another
  // checkout's suite with an older registry) would take these step jobs, or this one would take theirs.
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = 'learner_pikku_boss_test_stall_check'
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
  const stalled = `stall-check-red-${randomUUID()}`, idle = `stall-check-idle-${randomUUID()}`
  afterAll(async () => {
    const services = await booted
    await services.db.query('DELETE FROM learning_reactive_admission WHERE user_id=ANY($1)', [[stalled, idle]])
    await services.db.query('DELETE FROM learning_reactive_settings WHERE user_id=ANY($1)', [[stalled, idle]])
    await services.backgroundJobs.stop()
  })
  const run = async (userId: string, activatedHoursAgo = 0) => {
    const services = await booted
    await services.db.query(`INSERT INTO learning_reactive_settings(user_id,enabled,activated_at,config,revision)
      VALUES($1,true,now()-make_interval(hours=>$2::int),'{"enabled":true,"assessmentEnabled":true,"concurrency":4}','stall-check-fixture')`, [userId, activatedHoursAgo])
    return services
  }
  const finish = async (services: Awaited<typeof booted>, userId: string) => {
    const rpc = rpcService.getContextRPCService(services, {}, false)
    const { runId } = await services.workflowService.startWorkflow('learningReactiveStallCheckWorkflow', { userId }, { type: 'internal' }, rpc)
    let state = await services.workflowRunService.getRun(runId)
    for (const deadline = Date.now() + 100_000; state && !['completed', 'failed', 'cancelled'].includes(state.status) && Date.now() < deadline;) {
      await Bun.sleep(300)
      state = await services.workflowRunService.getRun(runId)
    }
    expect(state?.inline).toBeFalsy()
    return { state, steps: await services.workflowRunService.getRunSteps(runId) }
  }

  test('a concept waiting past the bound with no settled pass fails the named step with its reason', async () => {
    // Switched on before the concept began waiting (7 h): health floors its waiting rules at the switch-on.
    const services = await run(stalled, 8)
    await services.db.query(`INSERT INTO learning_reactive_admission(user_id,session_id,requested_generation,captured_generation,attempts,last_notified_at)
      VALUES($1,$2,1,0,0,now()-interval '7 hours')`, [stalled, randomUUID()])
    const { state, steps } = await finish(services, stalled)
    expect(state?.status).toBe('failed')
    expect(steps.map(s => [s.stepName, s.status])).toEqual([['Measure reactive grading progress', 'succeeded'], ['Fail when grading has stalled', 'failed']])
    // Arrivals are global: other files' fixtures in the window may add a routing message, so the two are checked apart.
    expect(JSON.stringify(steps[1]!.error)).toContain(`Reactive grading stalled: ${stalled}: `)
    expect(JSON.stringify(steps[1]!.error)).toContain('Grading stalled: 1 concepts waiting since')
  }, 120_000)

  test('an idle owner completes green', async () => {
    const { state } = await finish(await run(idle), idle)
    expect(state?.status).toBe('completed')
    expect(state?.output).toEqual({ checked: 1, status: 'ok', messages: [] })
  }, 120_000)
})
