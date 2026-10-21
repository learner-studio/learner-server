export const LearningMaintenanceQueueInput = z.object({ action: z.enum(MAINTENANCE_ACTIONS) })
import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'
import { MAINTENANCE_ACTIONS } from '@learner/core/lib/learning/learning-maintenance.js'
import { runtimeRole, learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
export const learningMaintenanceQueue = defineSessionlessFunction({
  input: LearningMaintenanceQueueInput,
  func: async ({}, { action }, { rpc }) => {
    if (runtimeRole() !== 'learning-worker') throw new Error('Learning maintenance cannot execute in the API')
    if (learningAdmissionPaused()) return
    switch (action) {
      case 'archive': await rpc.invoke('scheduledLearningLosslessArchiveSweepOperation', {}); break
      case 'exposure': await rpc.invoke('scheduledLearningExposureDrainOperation', {}); break
      case 'index': await rpc.invoke('scheduledLearningSemanticIndexOperation', {}); break
      case 'traces': await rpc.invoke('scheduledLearningFeedbackTracesOperation', {}); break
      case 'archive-admission': await rpc.invoke('scheduledLearningArchiveAdmissionOperation', {}); break
      case 'reactive': await rpc.invoke('recoverLearningReactiveConsolidationOperation', {}); break
    }
  },
})
