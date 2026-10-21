export const LearningMaintenanceInput = z.object({})
import { z } from 'zod'
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { defineVoidFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { isRunActive } from '@learner/core/lib/workflow/workflow-runs.js'

export const scheduledLearningLosslessArchiveSweepOperation = defineSessionlessFunction({
  input: LearningMaintenanceInput,
  title: 'Scheduled lossless CLI archive capture',
  func: async ({ learningLosslessArchiveSyncService, workflowRunService, workflowService }, _data, { scheduledTask, rpc }) => {
    if (!learningLosslessArchiveSyncService.scheduleEnabled) {
      scheduledTask?.skip('Lossless archive scheduled capture is disabled')
      return
    }
    const runs = await workflowRunService.listRuns({ workflowName: 'learningLosslessArchiveWorkflow', limit: 20 })
    if (runs.some((run) => isRunActive(run))) {
      scheduledTask?.skip('A lossless archive sweep is active')
      return
    }
    await workflowService.startWorkflow('learningLosslessArchiveWorkflow', { mode: 'periodic' }, { type: 'scheduled' }, rpc)
  },
})

export const scheduledLearningLosslessArchiveSweep=defineVoidFunction({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'archive')
  },
})
