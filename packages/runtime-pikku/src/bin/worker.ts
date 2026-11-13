// The worker process under this runtime: no HTTP server. It drains the
// generated queue workers (the shared Learning queues and the framework's own
// workflow queues), runs Pikku's workflow recovery (at start and every 30 s:
// lapsed steps, lost dispatches, lost sleep wake-ups) and, when
// LEARNER_SCHEDULES_ENABLED=true, runs the schedules. The sim worker
// (sim-worker.ts) is this same worker on learner_sim.
import { acquireRuntimeRole, publishRuntimeState, releaseRuntimeRole, setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { QUEUES } from '@learner/server/wiring/queues.js'
import { DEFAULT_STEP_RETRIES } from '@pikku/core/workflow'
import { sweepAttemptDirectories } from '@learner/llm/lib/cli/durable-cli-call.js'

type Services = Awaited<ReturnType<typeof import('../services.js')['createSingletonServices']>>

/**
 * `prepare` runs on the booted services before the fence is taken: the sim worker checks its database and turns
 * off telemetry with it, and the sim tests install their stub wiring.
 */
export async function runWorker({ prepare }: { prepare?: (services: Services) => Promise<void> | void } = {}) {
  setRuntimeRole('learning-worker')
  await import('../../.pikku/pikku-bootstrap.gen.js')
  const { createConfig } = await import('../config.js')
  const { createSingletonServices } = await import('../services.js')

  const config = await createConfig()
  const services = await createSingletonServices(config)
  const { backgroundJobs, workflowService } = services
  if (!backgroundJobs) throw new Error('services.ts must provide backgroundJobs')
  const log = services.logger
  await prepare?.(services)
  await acquireRuntimeRole()
  // The one gap in Pikku's recovery (core 0.12.157): a step's retry is two writes (workflow-step-retry.js setStepError,
  // then createRetryAttempt), and a process that dies between them leaves it `failed` with attempts left; replay then
  // fails the run. Under the fence every such row is a dead holder's, so it gets its retry here, before recovery
  // resumes the run. Remove once Pikku's replay takes back a failed step with attempts left.
  for (let offset = 0, page; (page = await services.workflowRunService.listRuns({ status: 'running', limit: 500, offset })).length; offset += 500) {
    for (const run of page) for (const step of await services.workflowRunService.getRunSteps(run.id)) {
      if (step.status === 'failed' && step.attemptCount <= (step.retries ?? DEFAULT_STEP_RETRIES)) await workflowService.createRetryAttempt(step.stepId, 'pending')
    }
  }
  await backgroundJobs.start()
  // As `pikku serve` does: recovery starts once the queues consume.
  workflowService.startRecovery()
  log.info({ event: 'worker-started', runtime: 'pikku' })

  const heartbeat = setInterval(() => { try { publishRuntimeState(QUEUES.map((q) => q.queue), { ok: true }) } catch { /* optional */ } }, 10_000)
  // Detached model-call results (durable-cli-call.ts) are removed when their receipt is written; this drops the ones
  // whose receipt never came (an attempt stopped for review), a week after their last write. At boot only: no timer
  // in a long-lived process (restart-safety.md), and every deploy restarts the worker. Never throws.
  const swept = sweepAttemptDirectories()
  if (swept) log.info({ event: 'llm-attempt-sweep', removed: swept })
  let stopping = false
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
    if (stopping) return
    stopping = true
    clearInterval(heartbeat)
    workflowService.stopRecovery()
    await backgroundJobs.stop()
    await releaseRuntimeRole()
    process.exit(0)
  })
  return services
}

if (import.meta.main) await runWorker()
