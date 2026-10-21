import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import {
  extractShadowTurnContext,
  LearningTurnContextInput,
  LearningTurnContextPacket,
} from '@learner/core/lib/learning/learning-turn-context.js'

export const GetLearningTurnContextOutput = z.object({
  decisionId: z.string().uuid(),
  status: z.enum(['completed', 'failed']),
  packet: LearningTurnContextPacket,
  extraction: z.unknown().nullable(),
  error: z.string().nullable(),
})

export const getLearningTurnContext = defineFunction({
  title: 'Get Learning turn context',
  description: 'Extract one authenticated learner turn and durably log the strictly non-injecting shadow recommendation.',
  expose: true,
  audit: true,
  input: LearningTurnContextInput,
  output: GetLearningTurnContextOutput,
  func: async ({ llmService }, input) => {
    assertLearningLocalMvpEnabled()
    return extractShadowTurnContext(llmService, input)
  },
})
