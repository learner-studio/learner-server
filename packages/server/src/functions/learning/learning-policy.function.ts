import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { LearningPolicyConfig, LearningPolicySettings } from '@learner/contract/learning/learning-policy.js'
import { loadLearningPolicy, saveLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const getLearningPolicy = defineFunction({
  title: 'Get Learning intervention policy',
  description: 'Read the injection rate, prerequisite fallback and spaced-repetition settings the live hook path enforces.',
  expose: true,
  readonly: true,
  input: z.object({}),
  output: LearningPolicyConfig,
  func: async () => {
    assertLearningLocalMvpEnabled()
    return loadLearningPolicy()
  },
})

export const saveLearningPolicyFunction = defineFunction({
  title: 'Save Learning intervention policy',
  description: 'Validate and persist the Learning intervention policy; the next hook turn reads it.',
  expose: true,
  audit: true,
  scopes: ['admin'],
  input: LearningPolicySettings,
  output: LearningPolicyConfig,
  func: async ({ logger }, input, { session }) => {
    assertLearningLocalMvpEnabled()
    const config = await saveLearningPolicy(input, session.userId)
    logger.info({ event: 'audit', action: 'learning.policy.saved', actorUserId: session.userId, ...config })
    return config
  },
})
