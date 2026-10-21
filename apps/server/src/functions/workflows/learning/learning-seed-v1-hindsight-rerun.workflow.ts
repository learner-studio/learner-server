import { defineWorkflow } from '../../../runtime/define.js'
import { z } from 'zod'

export const LearningSeedV1HindsightRerunWorkflowInput = z.object({ runId: z.string().uuid() })
export const LearningSeedV1HindsightRerunWorkflowOutput = z.record(z.string(), z.unknown())

export const learningSeedV1HindsightRerunWorkflow = defineWorkflow({
  input: LearningSeedV1HindsightRerunWorkflowInput,
  output: LearningSeedV1HindsightRerunWorkflowOutput,
  func: async ({}, data, { workflow }) => {
    await workflow.do('Zero-call Seed V1 Hindsight rerun preflight', 'preflightLearningSeedV1Step', data)
    await workflow.do('Seed V1 Hindsight-only custom extraction at 420s', 'runLearningSeedV1HindsightArmStep', data)
    return await workflow.do('Finalize Seed V1 Hindsight-only rerun', 'finalizeLearningSeedV1HindsightRerunStep', data)
  },
})
