export const LearningMaintenanceInput = z.object({})
import { z } from 'zod'
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { pikkuSessionlessFunc, pikkuVoidFunc } from '#pikku/function'

export const scheduledLearningExposureDrainOperation = pikkuSessionlessFunc({
  input: LearningMaintenanceInput,
  title: 'Reconcile and recover continuous Learning exposure workers',
  func: async ({ learningExposureIngestService, queueService }) => {
    if (!learningExposureIngestService.drainEnabled) return
    await Promise.all([0, 1].map((slot) => queueService.add('learning.exposure-drain', { slot }, {
      attempts: 3, backoff: { type: 'exponential', delay: 1000 },
    })))
  },
})

export const scheduledLearningExposureDrain = pikkuVoidFunc({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'exposure')
  },
})
