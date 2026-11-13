// The worker process under this runtime: no HTTP server. It recovers the runs
// a dead worker left behind, then drains the generated queue workers (the
// shared Learning queues and the framework's own workflow queues) and, when
// LEARNER_SCHEDULES_ENABLED=true, runs the schedules. The sim worker
// (sim-worker.ts) is this same worker on learner_sim.
import { acquireRuntimeRole, publishRuntimeState, releaseRuntimeRole, setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { QUEUES } from '@learner/server/wiring/queues.js'
import { sweepAttemptDirectories } from '@learner/llm/lib/cli/durable-cli-call.js'

type Services = Awaited<ReturnType<typeof import('../services.js')['createSingletonServices']>>

/**
 * `prepare` runs on the booted services before the fence is taken: the sim worker checks its database and turns
 * off telemetry with it, and the sim tests install their stub wiring. `adoptUnversioned` moves pre-upgrade runs onto
 * the current graph (recovery.ts); the sim worker never does, so a run of old sim code fails instead of resuming.
 */
export async function runWorker({ prepare, adoptUnversioned = true }: { prepare?: (services: Services) => Promise<void> | void; adoptUnversioned?: boolean } = {}) {
  setRuntimeRole('learning-worker')
  await import('../../.pikku/pikku-bootstrap.gen.js')
  const { createConfig } = await import('../config.js')
  const { createSingletonServices } = await import('../services.js')
  const { adoptUnversionedRuns, recoverInterruptedRuns } = await import('../recovery.js')

  const config = await createConfig()
  const services = await createSingletonServices(config)
  const { backgroundJobs } = services
  if (!backgroundJobs) throw new Error('services.ts must provide backgroundJobs')
  const log = services.logger
  await prepare?.(services)
  await acquireRuntimeRole()
  // The recovery boundary, taken once the fence is ours: every run row written
  // before it belongs to a previous holder (one may have kept writing while this
  // process waited for the fence), and this process writes none before it.
  const bootedAt = Date.now()
  if (adoptUnversioned) await adoptUnversionedRuns(services.kysely, services.workflowService, log)
  const recovery = await recoverInterruptedRuns(services.workflowRunService, services.workflowService, { bootedAt, logger: log })
  if (recovery.failed.length) throw new Error(`Failed to recover ${recovery.failed.length} interrupted workflow run(s); queue workers stay stopped`)
  await backgroundJobs.start()
  log.info({ event: 'worker-started', runtime: 'pikku', recovered: recovery.recovered.length })

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
    await backgroundJobs.stop()
    await releaseRuntimeRole()
    process.exit(0)
  })
  return services
}

if (import.meta.main) await runWorker()
