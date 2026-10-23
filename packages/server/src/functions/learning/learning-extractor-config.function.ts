import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import { cliEffortSchema } from '@learner/llm/lib/llm/model-catalog.js'
import { ExtractorBackend } from '@learner/contract/learning/learning-admin.js'
import {
  loadLearningExtractorConfig,
  saveLearningExtractorConfig,
} from '@learner/core/lib/learning/learning-extractor-config.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const LearningExtractorConfigInput = z.object({})
export const LearningExtractorConfigSelection = z.object({
  backend: ExtractorBackend,
  model: z.string().min(1),
  effort: cliEffortSchema,
})
export const LearningExtractorConfigOutput = LearningExtractorConfigSelection.extend({
  updatedAt: z.string().nullable(),
})

export const getLearningExtractorConfig = defineFunction({
  title: 'Get Learning extractor configuration',
  description: 'Read the CLI backend, model, and reasoning effort used by the Learning extractor.',
  expose: true,
  readonly: true,
  input: LearningExtractorConfigInput,
  output: LearningExtractorConfigOutput,
  func: async () => {
    assertLearningLocalMvpEnabled()
    return loadLearningExtractorConfig()
  },
})

export const saveLearningExtractorConfigFunction = defineFunction({
  title: 'Save Learning extractor configuration',
  description: 'Validate and persist the CLI backend, model, and effort used by the Learning extractor.',
  expose: true,
  audit: true,
  scopes: ['admin'],
  input: LearningExtractorConfigSelection,
  output: LearningExtractorConfigOutput,
  func: async ({ logger }, input, { session }) => {
    assertLearningLocalMvpEnabled()
    const config = await saveLearningExtractorConfig(input, session.userId)
    logger.info({ event: 'audit', action: 'learning.extractor_config.saved',
      actorUserId: session.userId,
      backend: config.backend,
      model: config.model,
      effort: config.effort,
    })
    return config
  },
})
