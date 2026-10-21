import { defineSessionlessFunction } from '../../../runtime/define.js'

import { storeLearningHookEvent } from '@learner/core/lib/learning/learning-hook-event-store.js'
import {
  LearningHookEventSchema,
  type LearningHookEvent,
} from '@learner/core/lib/learning/learning-hooks.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const learningHookIngestQueue = defineSessionlessFunction({
  title: 'Ingest Learning Hook',
  description: 'Persist one normalized provider hook event in the local learning spool.',
  input: LearningHookEventSchema,
  func: async ({ logger }, input) => {
    assertLearningLocalMvpEnabled()
    const event = LearningHookEventSchema.parse(input) as LearningHookEvent
    const result = await storeLearningHookEvent(event)
    logger.info(`[learning] ${result.stored ? 'stored' : 'deduplicated'} hook ${event.id}`)
    return result
  },
})
