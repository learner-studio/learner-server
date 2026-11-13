export const LearningMaintenanceInput = z.object({})
import { z } from 'zod'
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { pikkuSessionlessFunc, pikkuVoidFunc } from '#pikku/function'
import { listUnsettledRuns, settleAbandonedRuns } from '@learner/core/lib/workflow/workflow-runs.js'

export const scheduledLearningLosslessArchiveSweepOperation = pikkuSessionlessFunc({
  input: LearningMaintenanceInput,
  title: 'Scheduled lossless CLI archive capture',
  func: async ({ learningLosslessArchiveSyncService, workflowRunService, workflowService }, _data, { scheduledTask, rpc }) => {
    if (!learningLosslessArchiveSyncService.scheduleEnabled) {
      scheduledTask?.skip('Lossless archive scheduled capture is disabled')
      return
    }
    const runs = await listUnsettledRuns(workflowRunService, 'learningLosslessArchiveWorkflow')
    if ((await settleAbandonedRuns(workflowRunService, workflowService, runs)).length > 0) {
      scheduledTask?.skip('A lossless archive sweep is active')
      return
    }
    await rpc.startWorkflow('learningLosslessArchiveWorkflow', { mode: 'periodic' }, { wire: { type: 'scheduled' } })
  },
})

export const scheduledLearningLosslessArchiveSweep = pikkuVoidFunc({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'archive')
  },
})
