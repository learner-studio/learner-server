import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { loadConfig, type LearnerConfig } from './config.js'
import { buildRegistry } from './functions/registry.js'
import { FunctionRuntime } from './runtime/host.js'
import { createServices, type Services } from './services.js'
import { WORKFLOW_QUEUE } from './wiring/queues.js'
import type { DurableEngineOptions } from './workflow/durable.js'

export interface Learner { config: LearnerConfig; services: Services; runtime: FunctionRuntime }

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
 * Build one process: services, the function registry, and the durable engine
 * wired to dispatch runs onto the workflow queue (executed by the worker).
 */
export async function bootstrap(role: LearnerConfig['role']): Promise<Learner> {
  setRuntimeRole(role)
  const config = loadConfig(role)
  const services = await createServices(config, { engine: engineOptionsFromEnv(process.env) })
  const runtime = new FunctionRuntime(buildRegistry(), () => services)
  runtime.dispatch = async (workflow, runId) => {
    await services.queue.add(WORKFLOW_QUEUE, { runId, workflow }, { jobId: runId })
  }
  services.engine.attach(runtime)
  return { config, services, runtime }
}
