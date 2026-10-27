// The worker process under this runtime: no HTTP server. It recovers the runs
// a dead worker left behind, then drains the generated queue workers (the
// shared Learning queues and the framework's own workflow queues) and, when
// LEARNER_SCHEDULES_ENABLED=true, runs the schedules.
import { acquireRuntimeRole, publishRuntimeState, releaseRuntimeRole, setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { QUEUES } from '@learner/server/wiring/queues.js'

setRuntimeRole('learning-worker')
await import('../../.pikku/pikku-bootstrap.gen.js')
const { createConfig } = await import('../config.js')
const { createSingletonServices } = await import('../services.js')
const { recoverInterruptedRuns } = await import('../recovery.js')

const config = await createConfig()
const services = await createSingletonServices(config)
const { backgroundJobs } = services
if (!backgroundJobs) throw new Error('services.ts must provide backgroundJobs')
const log = services.logger
await acquireRuntimeRole()
// The recovery boundary, taken once the fence is ours: every run row written
// before it belongs to a previous holder (one may have kept writing while this
// process waited for the fence), and this process writes none before it.
const bootedAt = Date.now()
const recovery = await recoverInterruptedRuns(services.workflowRunService, services.workflowService, { bootedAt, logger: log })
if (recovery.failed.length) throw new Error(`Failed to recover ${recovery.failed.length} interrupted workflow run(s); queue workers stay stopped`)
await backgroundJobs.start()
log.info({ event: 'worker-started', runtime: 'pikku', recovered: recovery.recovered.length })

const heartbeat = setInterval(() => { try { publishRuntimeState(QUEUES.map((q) => q.queue), { ok: true }) } catch { /* optional */ } }, 10_000)
let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, async () => {
  if (stopping) return
  stopping = true
  clearInterval(heartbeat)
  await backgroundJobs.stop()
  await releaseRuntimeRole()
  process.exit(0)
})
