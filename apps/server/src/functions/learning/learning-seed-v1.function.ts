import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import { createSeedV1HindsightRerun, createSeedV1Run, freezeSeedV1Dataset } from '@learner/core/lib/learning/learning-seed-v1.js'
import { createThreeStepProofRun } from '@learner/core/lib/learning/learning-three-step-proof.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const PrepareLearningSeedV1Output = z.object({ runId: z.string().uuid(), dataset: z.record(z.string(), z.unknown()) })
export const PrepareLearningSeedV1Input = z.object({})
export const StartLearningSeedV1Input = z.object({ runId: z.string().uuid() })
export const StartLearningSeedV1Output = z.object({ runId: z.string().uuid(), started: z.literal(true) })
export const PrepareLearningSeedV1HindsightRerunInput = z.object({ sourceRunId: z.string().uuid(), runId: z.string().uuid().optional() })
export const PrepareLearningSeedV1HindsightRerunOutput = z.object({ runId: z.string().uuid(), sourceRunId: z.string().uuid() })
export const StartLearningSeedV1HindsightRerunInput = z.object({ runId: z.string().uuid() })
export const StartLearningSeedV1HindsightRerunOutput = z.object({ runId: z.string().uuid(), started: z.literal(true) })
export const PrepareLearningThreeStepProofInput = z.object({ sourceRunId: z.string().uuid(), runId: z.string().uuid().optional(), maxBatchTokens: z.number().int().positive().max(400_000).default(400_000) })
export const PrepareLearningThreeStepProofOutput = z.object({ runId: z.string().uuid(), inputSha256: z.string().length(64), concepts: z.number(), matches: z.number() })
export const StartLearningThreeStepProofInput = z.object({ runId: z.string().uuid(), maxBatchTokens: z.number().int().positive().max(400_000).default(400_000) })
export const StartLearningThreeStepProofOutput = z.object({ runId: z.string().uuid(), started: z.literal(true) })

export const prepareLearningSeedV1 = defineFunction({
  title: 'Freeze Learning seed V1 operator-pair dataset',
  description: 'Freeze the latest 100 complete verified-human/assistant pairs from the permanent Hindsight archive without model calls.',
  expose: true,
  scopes: ['admin'],
  input: PrepareLearningSeedV1Input,
  output: PrepareLearningSeedV1Output,
  func: async () => {
    assertLearningLocalMvpEnabled()
    const runId = await createSeedV1Run()
    const dataset = await freezeSeedV1Dataset(runId)
    return { runId, dataset }
  },
})

export const startLearningSeedV1 = defineFunction({
  title: 'Start Learning seed V1 extractor A/B',
  description: 'Run the frozen seed V1 BizTools and native custom-Hindsight arms through a durable workflow.',
  expose: true,
  scopes: ['admin'],
  input: StartLearningSeedV1Input,
  output: StartLearningSeedV1Output,
  func: async ({ workflowService }, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    await workflowService.startWorkflow('learningSeedV1ExperimentWorkflow', input, { type: 'http', userId: session.userId }, rpc)
    return { runId: input.runId, started: true as const }
  },
})

export const prepareLearningSeedV1HindsightRerun = defineFunction({
  title: 'Freeze a Hindsight-only Seed V1 rerun',
  description: 'Clone the exact immutable Seed V1 membership into a distinct Hindsight-only 420-second rerun without model calls.',
  expose: true, scopes: ['admin'], input: PrepareLearningSeedV1HindsightRerunInput, output: PrepareLearningSeedV1HindsightRerunOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    const runId = await createSeedV1HindsightRerun(input.sourceRunId, input.runId)
    return { runId, sourceRunId: input.sourceRunId }
  },
})

export const startLearningSeedV1HindsightRerun = defineFunction({
  title: 'Start the Hindsight-only Seed V1 rerun',
  description: 'Run only installed Hindsight custom extraction through a durable workflow with no BizTools execution.',
  expose: true, scopes: ['admin'], input: StartLearningSeedV1HindsightRerunInput, output: StartLearningSeedV1HindsightRerunOutput,
  func: async ({ workflowService }, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    await workflowService.startWorkflow('learningSeedV1HindsightRerunWorkflow', input, { type: 'http', userId: session.userId }, rpc)
    return { runId: input.runId, started: true as const }
  },
})

export const prepareLearningThreeStepProof = defineFunction({
  title: 'Freeze a Hindsight consolidation and node-assessment proof',
  description: 'Freeze the successful adapter-v2 classifications, original evidence, and current node versions without model calls.',
  expose: true, scopes: ['admin'], input: PrepareLearningThreeStepProofInput, output: PrepareLearningThreeStepProofOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    const frozen = await createThreeStepProofRun(input.sourceRunId, input.runId, input.maxBatchTokens)
    return { runId: frozen.runId, inputSha256: frozen.inputSha256, concepts: frozen.concepts, matches: frozen.matches }
  },
})

export const startLearningThreeStepProof = defineFunction({
  title: 'Start the Hindsight three-step proof',
  description: 'Run one native Hindsight consolidation and one review-only assessment through a durable workflow.',
  expose: true, scopes: ['admin'], input: StartLearningThreeStepProofInput, output: StartLearningThreeStepProofOutput,
  func: async ({ workflowService }, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    await workflowService.startWorkflow('learningThreeStepProofWorkflow', input, { type: 'http', userId: session.userId }, rpc)
    return { runId: input.runId, started: true as const }
  },
})
