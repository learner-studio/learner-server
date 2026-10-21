export const LearningMaintenanceInput = z.object({})
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineFunction,defineSessionlessFunction,defineVoidFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { z } from 'zod'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { cancelWorkflowRuns } from '@learner/core/lib/workflow/workflow-runs.js'
import { LearningActiveArchiveReceipt } from '@learner/core/lib/learning/learning-active-archive.js'
import { ArchiveClaimInput,ArchivePass,ArchiveEmpty,ArchiveDispatchOutput,ArchiveSessionInput,ArchiveStatus,
  archiveAdmission,claimArchivePass,settleArchivePass,dispatchArchiveSessions,archiveSessionStatus,retryArchiveSession } from '@learner/core/lib/learning/learning-archive-coordinator.js'

export const getLearningArchiveSession=defineFunction({expose:true,readonly:true,scopes:['admin'],input:ArchiveSessionInput,output:ArchiveStatus,
  func:async({},{sessionId},{session})=>{assertLearningLocalMvpEnabled();return archiveSessionStatus(session.userId,sessionId)},
})
export const ArchiveCaptureInput=z.object({runId:z.string().uuid()})
export const ArchiveCaptureOutput=z.object({status:z.string(),createdAt:z.string(),updatedAt:z.string(),receipt:LearningActiveArchiveReceipt.nullable()})
export const getLearningArchiveCapture=defineFunction({expose:true,readonly:true,scopes:['admin'],input:ArchiveCaptureInput,output:ArchiveCaptureOutput,
  func:async({},{runId},{session})=>{
    assertLearningLocalMvpEnabled()
    const row=(await metaDbQuery<{status:string;created_at:Date;updated_at:Date;output:unknown}>("SELECT status,created_at,updated_at,output FROM learner_workflow_runs WHERE workflow_run_id=$1 AND workflow='learningCoalescedArchiveWorkflow' AND input::jsonb->>'userId'=$2",[runId,session.userId])).rows[0]
    if(!row) throw new Error('Archive capture not found')
    const receipt=LearningActiveArchiveReceipt.safeParse(typeof row.output==='string'?JSON.parse(row.output):row.output)
    return {status:row.status,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString(),receipt:receipt.success?receipt.data:null}
  },
})
export const retryLearningArchiveSession=defineFunction({expose:true,scopes:['admin'],input:ArchiveSessionInput,output:ArchiveStatus,
  func:async({locks},{sessionId},{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    await archiveAdmission(locks,()=>retryArchiveSession(session.userId,sessionId))
    await rpc.invoke('dispatchLearningArchiveSessionsStep',{})
    return archiveSessionStatus(session.userId,sessionId)
  },
})
export const claimLearningArchivePassStep=defineSessionlessFunction({input:ArchiveClaimInput,output:ArchivePass,
  func:async({locks},data)=>archiveAdmission(locks,()=>claimArchivePass(data)),
})
export const settleLearningArchivePassStep=defineSessionlessFunction({input:ArchivePass,output:ArchiveDispatchOutput,
  func:async({locks},data)=>archiveAdmission(locks,()=>settleArchivePass(data)),
})
export const dispatchLearningArchiveSessionsStep=defineSessionlessFunction({input:ArchiveEmpty,output:ArchiveDispatchOutput,
  func:async({locks,workflowService,workflowRunService,learningLosslessArchiveSyncService},_data,{rpc})=>{
    if(learningAdmissionPaused()) return {started:0}
    assertLearningLocalMvpEnabled();learningLosslessArchiveSyncService.assertEnabled()
    // This step is the archive lane's only dispatcher (each capture's follow-up
    // and the scheduled sweep both invoke it), so it is where a run idle past
    // the reclaim bound gets cancelled. Capture is repeatable, so a reclaimed
    // session simply re-dispatches; the assessment lane is not handed cancel.
    return archiveAdmission(locks,()=>dispatchArchiveSessions(async data=>(await workflowService.startWorkflow('learningCoalescedArchiveWorkflow',data,{type:'scheduled',userId:data.userId},rpc)).runId,undefined,undefined,
      {cancel:async runId=>{const run=await workflowRunService.getRun(runId);if(run) await cancelWorkflowRuns(workflowService,[run])}}))
  },
})
export const scheduledLearningArchiveAdmissionOperation=defineSessionlessFunction({input: LearningMaintenanceInput,
  title:'Recover pending archive admission and terminal failures without stealing live captures',
  func:async({},_data,{rpc})=>{await rpc.invoke('dispatchLearningArchiveSessionsStep',{})},
})

export const scheduledLearningArchiveAdmission=defineVoidFunction({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'archive-admission')
  },
})
