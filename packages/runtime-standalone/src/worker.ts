import type { Job } from 'pg-boss'
import { acquireRuntimeRole, publishRuntimeState } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { bootstrap } from './bootstrap.js'
import { QUEUES, SCHEDULES, WORKFLOW_QUEUE, WORKFLOW_QUEUE_CONFIG } from '@learner/server/wiring/queues.js'
import { WorkflowLeasedError } from './workflow/durable.js'

/**
 * The worker process: drains the Learning queues, executes durable workflow
 * runs from the workflow queue, and (only when LEARNER_SCHEDULES_ENABLED=true)
 * runs the schedules.
 *
 *   bun packages/runtime-standalone/src/worker.ts            run until stopped
 *   bun packages/runtime-standalone/src/worker.ts --once     process exactly one workflow job, then exit
 *                       [--queue <name>]     (or one job from another queue)
 *                       [--wait <seconds>]   how long --once waits for a job (default 60)
 */
const args = process.argv.slice(2)
const once = args.includes('--once')
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

const learner = await bootstrap('learning-worker')
const { services, runtime, config, boss, queue, engine } = learner
const log = services.logger

async function handleWorkflowJob(job: Job<{ runId: string; workflow?: string }>) {
  log.info({ event: 'workflow-job', jobId: job.id, runId: job.data.runId, workflow: job.data.workflow })
  try {
    await engine.runWorkflowJob(job.data.runId)
  } catch (error) {
    // Another live executor holds the run: let pg-boss retry the job later.
    if (error instanceof WorkflowLeasedError) log.warn({ event: 'workflow-leased', runId: job.data.runId })
    throw error
  }
  const run = await engine.getRun(job.data.runId)
  log.info({ event: 'workflow-job-settled', runId: job.data.runId, status: run?.status })
  return { runId: job.data.runId, status: run?.status }
}

async function handleQueueJob(func: string, queue: string, job: Job<unknown>) {
  return runtime.call(func, job.data, { context: { queue: { queueName: queue, jobId: job.id } } })
}

/** Runs whose executor died and that have no live job are handed back to the queue. */
async function recoverOrphans() {
  for (const { runId, workflow } of await engine.findOrphanedRuns()) {
    if ((await queue.findByKey(WORKFLOW_QUEUE, runId)).length) continue
    await queue.add(WORKFLOW_QUEUE, { runId, workflow }, { jobId: runId })
    log.info({ event: 'workflow-orphan-redispatched', runId, workflow })
  }
}

async function runOnce(queueName: string, waitSeconds: number) {
  await recoverOrphans()
  const wiring = QUEUES.find((q) => q.queue === queueName)
  if (queueName !== WORKFLOW_QUEUE && !wiring) throw new Error(`Unknown queue: ${queueName}`)
  const deadline = Date.now() + waitSeconds * 1000
  for (;;) {
    const [job] = await boss.fetch<any>(queueName, { batchSize: 1 })
    if (job) {
      // work() heartbeats for us; a fetched job must do it itself or pg-boss retries it mid-run.
      const touch = setInterval(() => { boss.touch(queueName, job.id).catch(() => undefined) }, 10_000)
      try {
        const output = queueName === WORKFLOW_QUEUE ? await handleWorkflowJob(job) : await handleQueueJob(wiring!.func, queueName, job)
        await boss.complete(queueName, job.id, (output ?? {}) as object)
        log.info({ event: 'once-complete', queue: queueName, jobId: job.id, output })
        return 0
      } catch (error) {
        await boss.fail(queueName, job.id, { message: (error as Error).message })
        log.error({ event: 'once-failed', queue: queueName, jobId: job.id, message: (error as Error).message })
        return 1
      } finally {
        clearInterval(touch)
      }
    }
    if (Date.now() > deadline) { log.warn({ event: 'once-no-job', queue: queueName, waitSeconds }); return 2 }
    await new Promise((r) => setTimeout(r, 500))
  }
}

// A one-shot drain fails fast instead of queueing behind a running worker.
await acquireRuntimeRole(once ? { waitMs: 0 } : {})

if (once) {
  const code = await runOnce(arg('--queue') ?? WORKFLOW_QUEUE, Number(arg('--wait') ?? 60))
  await services.close()
  process.exit(code)
}

await queue.work(WORKFLOW_QUEUE, WORKFLOW_QUEUE_CONFIG, handleWorkflowJob)
for (const { queue: name, func, config: workerConfig } of QUEUES) {
  await queue.work(name, workerConfig, (job) => handleQueueJob(func, name, job))
}
if (config.schedulesEnabled) {
  for (const { name, cron, func } of SCHEDULES) {
    await queue.ensureQueue(name)
    await boss.schedule(name, cron, {})
    await queue.work(name, { batchSize: 1 }, async () => runtime.call(func, {}, {
      context: { scheduledTask: { name, skip: (reason) => log.info({ event: 'schedule-skip', name, reason }) } },
    }))
  }
} else {
  // Never leave a stale schedule firing from an earlier run with schedules on.
  for (const { name } of SCHEDULES) await boss.unschedule(name).catch(() => undefined)
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
