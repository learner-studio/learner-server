import { PgBoss } from 'pg-boss'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { loadConfig, type LearnerConfig } from '@learner/server/config.js'
import { buildRegistry } from '@learner/server/functions/registry.js'
import { createCoreHandles, createServices, type Services } from '@learner/server/services.js'
import { WORKFLOW_QUEUE, WORKFLOW_QUEUE_OPTIONS } from '@learner/server/wiring/queues.js'
import { FunctionRuntime } from './host.js'
import { PgBossQueue } from './queue.js'
import { DurableEngine, type DurableEngineOptions } from './workflow/durable.js'

/** One standalone process: shared services, plus this runtime's pg-boss queue and durable engine. */
export interface Learner { config: LearnerConfig; services: Services; runtime: FunctionRuntime; boss: PgBoss; queue: PgBossQueue; engine: DurableEngine }

/** Fault injection for the crash/resume smoke: `LEARNER_FAULT_PAUSE_AFTER_STEP="<step key>:<ms>"`. */
function engineOptionsFromEnv(env: NodeJS.ProcessEnv): DurableEngineOptions {
  const options: DurableEngineOptions = {}
  if (env.LEARNER_WORKFLOW_LEASE_MS) options.leaseMs = Number(env.LEARNER_WORKFLOW_LEASE_MS)
  const pause = env.LEARNER_FAULT_PAUSE_AFTER_STEP
  if (pause) {
    const at = pause.lastIndexOf(':')
    options.pauseAfterStep = { stepName: pause.slice(0, at), ms: Number(pause.slice(at + 1)) }
  }
  return options
}

/**
 * Build one process: pg-boss, the durable engine, the shared services on top
 * of them, and the function registry, with workflow runs dispatched onto the
 * workflow queue (executed by the worker).
 */
export async function bootstrap(role: LearnerConfig['role']): Promise<Learner> {
  setRuntimeRole(role)
  const config = loadConfig(role)
  const handles = createCoreHandles(config)
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: config.pgbossSchema, max: config.bossPoolMax, application_name: `learner-boss-${config.role}` })
  boss.on('error', (error) => handles.logger.error({ event: 'pg-boss-error', message: (error as Error).message }))
  await boss.start()
  const queue = new PgBossQueue(boss)
  const engine = new DurableEngine(handles.db, engineOptionsFromEnv(process.env))
  const services = await createServices(config, handles, {
    queueService: queue, queueCancellationService: queue, workflowService: engine, workflowRunService: engine,
    close: () => boss.stop({ graceful: true, timeout: 10_000 }),
  })
  await queue.ensureQueue(WORKFLOW_QUEUE, WORKFLOW_QUEUE_OPTIONS)
  const runtime = new FunctionRuntime(buildRegistry(), () => services)
  runtime.dispatch = async (workflow, runId) => {
    await queue.add(WORKFLOW_QUEUE, { runId, workflow }, { jobId: runId })
  }
  engine.attach(runtime)
  return { config, services, runtime, boss, queue, engine }
}
