export const WorkerProbeInput = z.object({ delay: z.enum(['5s', '30s']).default('5s') })
export const WorkerProbeOutput = z.object({ before: z.object({ pid: z.number(), role: z.string() }), after: z.object({ pid: z.number(), role: z.string() }) })
import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'
export const learningWorkerProbeWorkflow = defineWorkflow({
  title: 'Learning worker identity across a durable sleep; no learner data',
  input: WorkerProbeInput, output: WorkerProbeOutput,
  func: async ({}, data, { workflow }) => {
    const before = await workflow.do('Record worker before sleep', 'learningWorkerIdentityStep', {})
    await workflow.sleep('Durable isolation witness', data.delay)
    const after = await workflow.do('Record worker after sleep', 'learningWorkerIdentityStep', {})
    return { before, after }
  },
})
