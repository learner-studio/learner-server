export const LearningMaintenanceInput = z.object({})
import { z } from 'zod'
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { defineVoidFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { listUnsettledRuns, settleAbandonedRuns } from '@learner/core/lib/workflow/workflow-runs.js'
import { langfuseTargetFromEnv } from '@learner/llm/harness/langfuse-export.js'

export const scheduledLearningFeedbackTracesOperation=defineSessionlessFunction({input: LearningMaintenanceInput,
  title:'Reconcile pending Learning hook traces without replaying uncertain exports',
  func:async ({workflowRunService,workflowService,locks},_data,{rpc})=>{
    if(!langfuseTargetFromEnv()) return
    await locks.withLock('learning-feedback-export','scheduled',async()=>{
      const runs=await listUnsettledRuns(workflowRunService,'learningFeedbackTraceExportWorkflow')
      if((await settleAbandonedRuns(workflowRunService,workflowService,runs)).length>0) return
      await workflowService.startWorkflow('learningFeedbackTraceExportWorkflow',{}, {type:'scheduled'},rpc)
    })
  },
})

export const scheduledLearningFeedbackTraces=defineVoidFunction({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'traces')
  },
})
