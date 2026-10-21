export const WorkerIdentity = z.object({ pid: z.number(), role: z.string() })
export const WorkerRuntime = z.object({ processes: z.array(z.object({ role: z.string(), pid: z.number(), revision: z.string(), queues: z.array(z.string()), observedAt: z.string(), live: z.boolean(), health: z.unknown() })) })
import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { runtimeRole, workerRuntimeDirectory } from '@learner/core/lib/learning/learning-worker-runtime.js'
export const Empty = z.object({})
export const learningWorkerIdentityStep = defineSessionlessFunction({
  input: Empty, output: WorkerIdentity,
  func: async () => {
    if (runtimeRole() !== 'learning-worker') throw new Error('Learning step executed outside its owner')
    return { pid: process.pid, role: runtimeRole() }
  },
})
export const getLearningWorkerRuntime = defineFunction({
  title: 'Read separate API and Learning worker liveness', expose: true, readonly: true, scopes: ['admin'],
  input: Empty, output: WorkerRuntime,
  func: async () => {
    const processes = []
    for (const role of ['api', 'learning-worker']) {
      const data = await readFile(`${workerRuntimeDirectory()}/${role}.json`, 'utf8').then(JSON.parse).catch(() => null)
      if (!data) continue
      let live = Date.now() - Date.parse(data.observedAt) < 20000
      try { process.kill(data.pid, 0) } catch { live = false }
      processes.push({ ...data, live })
    }
    return { processes }
  },
})


export const WorkerProbeRun = z.object({ runId: z.string() })
export const WorkerProbeStatus = z.object({ status: z.string(), sleeping: z.boolean(), output: z.unknown().optional() })
export const StartWorkerProbe = z.object({ delay: z.enum(['5s', '30s']).default('5s') })
export const startLearningWorkerProbe = defineFunction({
  title: 'Start a no-model Learning worker isolation probe', expose: true, scopes: ['admin'],
  input: StartWorkerProbe, output: WorkerProbeRun,
  func: async ({ workflowService }, data, { rpc }) => {
    const { runId } = await workflowService.startWorkflow('learningWorkerProbeWorkflow', data, { type: 'rpc' }, rpc)
    return { runId }
  },
})
export const getLearningWorkerProbe = defineFunction({
  title: 'Read the durable worker isolation probe', expose: true, readonly: true, scopes: ['admin'],
  input: WorkerProbeRun, output: WorkerProbeStatus,
  func: async ({ workflowRunService }, { runId }) => {
    const run = await workflowRunService.getRun(runId)
    if (!run || run.workflow !== 'learningWorkerProbeWorkflow') throw new Error('Worker probe not found')
    const steps = await workflowRunService.getRunSteps(runId)
    return { status: run.status, sleeping: steps.some(step => step.status === 'scheduled'), output: run.output }
  },
})
