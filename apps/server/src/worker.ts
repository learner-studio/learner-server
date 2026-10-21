import type { Job } from 'pg-boss'
import { acquireRuntimeRole, publishRuntimeState } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { bootstrap, type Learner } from './bootstrap.js'
import { QUEUES, SCHEDULES, WORKFLOW_QUEUE, WORKFLOW_QUEUE_CONFIG } from './wiring/queues.js'
import { WorkflowLeasedError } from './workflow/durable.js'

/**
 * The worker process: drains the Learning queues, executes durable workflow
 * runs from the workflow queue, and (only when LEARNER_SCHEDULES_ENABLED=true)
 * runs the schedules.
 *
 *   bun apps/server/src/worker.ts            run until stopped
 *   bun apps/server/src/worker.ts --once     process exactly one workflow job, then exit
 *                       [--queue <name>]     (or one job from another queue)
 *                       [--wait <seconds>]   how long --once waits for a job (default 60)
 */
const args = process.argv.slice(2)
const once = args.includes('--once')
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const learner = await bootstrap('learning-worker')
const { services, runtime, config } = learner
const log = services.logger

async function handleWorkflowJob(job: Job<{ runId: string; workflow?: string }>) {
  log.info({ event: 'workflow-job', jobId: job.id, runId: job.data.runId, workflow: job.data.workflow })
  try {
    await services.engine.runWorkflowJob(job.data.runId)
  } catch (error) {
    // Another live executor holds the run: let pg-boss retry the job later.
    if (error instanceof WorkflowLeasedError) log.warn({ event: 'workflow-leased', runId: job.data.runId })
    throw error
  }
  const run = await services.engine.getRun(job.data.runId)
  log.info({ event: 'workflow-job-settled', runId: job.data.runId, status: run?.status })
  return { runId: job.data.runId, status: run?.status }
}

async function handleQueueJob(func: string, queue: string, job: Job<unknown>) {
  return runtime.call(func, job.data, { context: { queue: { queueName: queue, jobId: job.id } } })
}

/** Runs whose executor died and that have no live job are handed back to the queue. */
async function recoverOrphans() {
  for (const { runId, workflow } of await services.engine.findOrphanedRuns()) {
    if ((await services.queue.findByKey(WORKFLOW_QUEUE, runId)).length) continue
    await services.queue.add(WORKFLOW_QUEUE, { runId, workflow }, { jobId: runId })
    log.info({ event: 'workflow-orphan-redispatched', runId, workflow })
  }
}

async function runOnce({ services }: Learner, queue: string, waitSeconds: number) {
  await recoverOrphans()
  const wiring = QUEUES.find((q) => q.queue === queue)
  if (queue !== WORKFLOW_QUEUE && !wiring) throw new Error(`Unknown queue: ${queue}`)
  const deadline = Date.now() + waitSeconds * 1000
  for (;;) {
    const [job] = await services.boss.fetch<any>(queue, { batchSize: 1 })
    if (job) {
      // work() heartbeats for us; a fetched job must do it itself or pg-boss retries it mid-run.
      const touch = setInterval(() => { services.boss.touch(queue, job.id).catch(() => undefined) }, 10_000)
      try {
        const output = queue === WORKFLOW_QUEUE ? await handleWorkflowJob(job) : await handleQueueJob(wiring!.func, queue, job)
        await services.boss.complete(queue, job.id, (output ?? {}) as object)
        log.info({ event: 'once-complete', queue, jobId: job.id, output })
        return 0
      } catch (error) {
        await services.boss.fail(queue, job.id, { message: (error as Error).message })
        log.error({ event: 'once-failed', queue, jobId: job.id, message: (error as Error).message })
        return 1
      } finally {
        clearInterval(touch)
      }
    }
    if (Date.now() > deadline) { log.warn({ event: 'once-no-job', queue, waitSeconds }); return 2 }
    await new Promise((r) => setTimeout(r, 500))
  }
}

await acquireRuntimeRole()

if (once) {
  const code = await runOnce(learner, arg('--queue') ?? WORKFLOW_QUEUE, Number(arg('--wait') ?? 60))
  await services.close()
  process.exit(code)
}

await services.queue.work(WORKFLOW_QUEUE, WORKFLOW_QUEUE_CONFIG, handleWorkflowJob)
for (const { queue, func, config: workerConfig } of QUEUES) {
  await services.queue.work(queue, workerConfig, (job) => handleQueueJob(func, queue, job))
}
if (config.schedulesEnabled) {
  for (const { name, cron, func } of SCHEDULES) {
    await services.queue.ensureQueue(name)
    await services.boss.schedule(name, cron, {})
    await services.queue.work(name, { batchSize: 1 }, async () => runtime.call(func, {}, {
      context: { scheduledTask: { name, skip: (reason) => log.info({ event: 'schedule-skip', name, reason }) } },
    }))
  }
} else {
  // Never leave a stale schedule firing from an earlier run with schedules on.
  for (const { name } of SCHEDULES) await services.boss.unschedule(name).catch(() => undefined)
  log.info({ event: 'schedules-disabled', hint: 'set LEARNER_SCHEDULES_ENABLED=true to run them' })
}
await recoverOrphans()
const orphanTimer = setInterval(() => { recoverOrphans().catch((e) => log.error({ event: 'orphan-scan-failed', message: (e as Error).message })) }, 60_000)
const heartbeat = setInterval(() => { try { publishRuntimeState([WORKFLOW_QUEUE, ...QUEUES.map((q) => q.queue)], { ok: true }) } catch { /* optional */ } }, 10_000)
log.info({ event: 'worker-started', queues: QUEUES.length + 1, schedules: config.schedulesEnabled ? SCHEDULES.length : 0 })

const shutdown = async () => {
  clearInterval(orphanTimer); clearInterval(heartbeat)
  await services.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
