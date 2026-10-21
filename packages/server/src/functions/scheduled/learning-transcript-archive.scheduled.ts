import { defineVoidFunction } from '../../runtime/define.js'

import { learningTranscriptArchiveScheduleEnabled } from '@learner/core/lib/runtime-flags.js'
import { isRunActive } from '@learner/core/lib/workflow/workflow-runs.js'

export const scheduledLearningTranscriptArchiveSweep = defineVoidFunction({
  title: 'Scheduled: Learning transcript archive sweep',
  func: async ({ logger, workflowService, workflowRunService }, _data, { scheduledTask, rpc }) => {
    if (!learningTranscriptArchiveScheduleEnabled()) {
      scheduledTask?.skip('LEARNING_TRANSCRIPT_ARCHIVE_SCHEDULE_ENABLED is not set')
      return
    }
    const runs = await workflowRunService.listRuns({ workflowName: 'learningTranscriptArchiveWorkflow', limit: 20 })
    if (runs.some((run) => isRunActive(run))) {
      scheduledTask?.skip('a transcript archive sweep is still running')
      return
    }
    const { runId } = await workflowService.startWorkflow(
      'learningTranscriptArchiveWorkflow', { scanMode: 'periodic' }, { type: 'scheduled' }, rpc,
    )
    logger.info(`[learning-archive] started periodic sweep ${runId}`)
  },
})

export const scheduledLearningTranscriptArchiveDailySweep = defineVoidFunction({
  title: 'Scheduled: Learning transcript archive daily sweep',
  func: async ({ logger, workflowService, workflowRunService }, _data, { scheduledTask, rpc }) => {
    if (!learningTranscriptArchiveScheduleEnabled()) {
      scheduledTask?.skip('LEARNING_TRANSCRIPT_ARCHIVE_SCHEDULE_ENABLED is not set')
      return
    }
    const runs = await workflowRunService.listRuns({ workflowName: 'learningTranscriptArchiveWorkflow', limit: 20 })
    if (runs.some((run) => isRunActive(run))) {
      scheduledTask?.skip('a transcript archive sweep is still running')
      return
    }
    const { runId } = await workflowService.startWorkflow(
      'learningTranscriptArchiveWorkflow', { scanMode: 'daily' }, { type: 'scheduled' }, rpc,
    )
    logger.info(`[learning-archive] started daily sweep ${runId}`)
  },
})
