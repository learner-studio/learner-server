import { afterAll, describe, expect, test } from 'bun:test'
import { PgBoss } from 'pg-boss'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { STOPPED_WORKFLOW_STATUSES } from '@learner/core/lib/workflow/workflow-runs.js'
import { until } from '@learner/llm/lib/cli/testing/crash-harness.js'
import { RECURRING_TASK_PREFIX, drain } from '../src/drain.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * The deploy's drain (scripts/deploy.ts, src/drain.ts) against a real worker on its own database
 * (learner_drain_test_<checkout>): a schedule that fires every second starts runs of the probe workflow (a 5 s
 * durable sleep). A drain that times out pauses the schedule and names the runs still in flight; a drain with time
 * finishes once they end, and no run starts after it. A worker start (every unit boot) schedules the tasks again,
 * so the pause does not outlive a restart.
 */
const url = await ownTestDatabaseUrl('drain')
describe.skipIf(!url)('deploy drain (learner_drain_test_<checkout>)', () => {
  const runtime = bootRuntime({ schemaPrefix: 'lp_boss_drain_', databaseUrl: url! })
  let ticker: PgBoss | undefined
  afterAll(async () => {
    await ticker?.stop({ graceful: false, close: true })
    await (await runtime.booted).schedulerService.stop()
    await runtime.stop()
  })

  test('pauses a per-second schedule, waits out the runs in flight, reports them on a timeout; a worker start schedules again', async () => {
    const services = await runtime.booted
    const bossSchema = process.env.LEARNER_PIKKU_PGBOSS_SCHEMA!
    // This file's own database: a run an earlier, killed run of it left in flight would never end (its queue schema is gone).
    await services.db.query(`DELETE FROM learner_workflow_runs WHERE status <> ALL($1::text[])`, [[...STOPPED_WORKFLOW_STATUSES, 'completed']])
    const tick = `${RECURRING_TASK_PREFIX}drainTestTick`
    // A recurring task the way PgBossSchedulerService.start() registers one, on a per-second cron.
    ticker = new PgBoss({ connectionString: url!, schema: bossSchema, max: 2, cronMonitorIntervalSeconds: 1, cronWorkerIntervalSeconds: 1, supervise: false, migrate: false })
    ticker.on('error', () => {})
    await ticker.start()
    await ticker.createQueue(tick)
    const started: string[] = []
    await ticker.work(tick, { pollingIntervalSeconds: 0.5 }, async () => { started.push(await runtime.start('learningWorkerProbeWorkflow', { delay: '5s' })) })
    // pg-boss sends a cron schedule at most one job per 60 s slot (timekeeper.js:46, :539-541), so a per-second
    // expression fires once a minute; the first pass sends the current slot's job at once.
    await ticker.schedule(tick, '* * * * * *')
    await until(() => started.length >= 1, 70_000, 'a scheduled run')
    // A job due but not yet taken can still start a run, so it holds the drain too.
    const pending = 'drain-test-pending'
    await ticker.createQueue(pending)
    await ticker.send(pending, {})

    const timedOut = await drain({ connectionString: url!, bossSchema, timeoutMs: 0 })
    expect(timedOut.drained).toBe(false)
    expect(timedOut.paused).toContain(tick)
    expect(timedOut.left.runs.map((r) => r.runId)).toEqual(started)
    expect(timedOut.left.runs.map((r) => r.workflow)).toEqual(['learningWorkerProbeWorkflow'])
    expect(timedOut.left.jobs).toContainEqual({ queue: pending, count: 1 })

    await ticker.deleteQueuedJobs(pending)
    const drained = await drain({ connectionString: url!, bossSchema, timeoutMs: 60_000, pollMs: 300 })
    expect(drained.drained).toBe(true)
    for (const runId of started) expect((await services.workflowRunService.getRun(runId))?.status).toBe('completed')
    expect((await ticker.getSchedules()).map((s) => s.name)).not.toContain(tick)

    await services.schedulerService.start()
    expect((await ticker.getSchedules()).filter((s) => s.name.startsWith(RECURRING_TASK_PREFIX)).length).toBeGreaterThan(0)
  }, 120_000)
})
