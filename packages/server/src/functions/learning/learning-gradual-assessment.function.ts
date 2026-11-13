import { pikkuFunc } from '#pikku/function'
import { z } from 'zod'

import { createGradualAssessmentComparisonRun } from '@learner/core/lib/learning/learning-gradual-assessment-comparison-run.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const PrepareLearningGradualAssessmentComparisonInput = z.object({ runId: z.string().uuid().optional() })
export const PrepareLearningGradualAssessmentComparisonOutput = z.object({
  runId: z.string().uuid(),
  inputSha256: z.string().length(64),
  concepts: z.literal(34),
  matches: z.literal(49),
  observations: z.literal(5),
})
export const StartLearningGradualAssessmentComparisonInput = z.object({ runId: z.string().uuid() })
export const StartLearningGradualAssessmentComparisonOutput = z.object({ runId: z.string().uuid(), started: z.literal(true) })

export const prepareLearningGradualAssessmentComparison = pikkuFunc({
  title: 'Prepare the frozen gradual-understanding assessment comparison',
  description: 'Freeze the completed Seed V1 Hindsight proof into identical Luna High and AGY Gemini 3.7 Flash High assessment arms without a model call.',
  expose: true,
  scopes: ['admin'],
  input: PrepareLearningGradualAssessmentComparisonInput,
  output: PrepareLearningGradualAssessmentComparisonOutput,
  func: async (_services, input) => {
    assertLearningLocalMvpEnabled()
    const frozen = await createGradualAssessmentComparisonRun(input.runId)
    return { runId: frozen.runId, inputSha256: frozen.inputSha256, concepts: 34 as const, matches: 49 as const, observations: 5 as const }
  },
})

export const startLearningGradualAssessmentComparison = pikkuFunc({
  title: 'Start the gradual-understanding assessment comparison',
  description: 'Run the two frozen assessment arms through one durable replay-safe workflow, without extraction, consolidation, or mastery writes.',
  expose: true,
  scopes: ['admin'],
  input: StartLearningGradualAssessmentComparisonInput,
  output: StartLearningGradualAssessmentComparisonOutput,
  func: async (_services, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    await rpc.startWorkflow('learningGradualAssessmentComparisonWorkflow', input, { wire: { type: 'http', pikkuUserId: session.userId } })
    return { runId: input.runId, started: true as const }
  },
})
