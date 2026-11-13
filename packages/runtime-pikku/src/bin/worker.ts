// The worker process under this runtime: no HTTP server. It drains the
// generated queue workers (the shared Learning queues and the framework's own
// workflow queues), runs Pikku's workflow recovery (at start and every 30 s:
// lapsed steps, lost dispatches, lost sleep wake-ups) and, when
// LEARNER_SCHEDULES_ENABLED=true, runs the schedules.
import { acquireRuntimeRole, publishRuntimeState, releaseRuntimeRole, setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { QUEUES } from '@learner/server/wiring/queues.js'
import { sweepAttemptDirectories } from '@learner/llm/lib/cli/durable-cli-call.js'

setRuntimeRole('learning-worker')
await import('../../.pikku/pikku-bootstrap.gen.js')
const { createConfig } = await import('../config.js')
const { createSingletonServices } = await import('../services.js')

const config = await createConfig()
const services = await createSingletonServices(config)
const { backgroundJobs, workflowService } = services
if (!backgroundJobs) throw new Error('services.ts must provide backgroundJobs')
const log = services.logger
await acquireRuntimeRole()
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
