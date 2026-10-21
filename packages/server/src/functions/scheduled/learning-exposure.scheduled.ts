export const LearningMaintenanceInput = z.object({})
import { z } from 'zod'
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { defineVoidFunction, defineSessionlessFunction } from '../../runtime/define.js'

export const scheduledLearningExposureDrainOperation = defineSessionlessFunction({
  input: LearningMaintenanceInput,
  title: 'Reconcile and recover continuous Learning exposure workers',
  func: async ({ learningExposureIngestService, queueService }) => {
    if (!learningExposureIngestService.drainEnabled) return
    await Promise.all([0, 1].map((slot) => queueService.add('learning.exposure-drain', { slot }, {
      attempts: 3, backoff: { type: 'exponential', delay: 1000 },
    })))
  },
})

export const scheduledLearningExposureDrain=defineVoidFunction({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'exposure')
  },
})
