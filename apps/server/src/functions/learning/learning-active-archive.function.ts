import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineFunction,defineSessionlessFunction } from '../../runtime/define.js'
import { LearningActiveArchiveInput,LearningActiveArchiveRunInput,LearningActiveArchiveSource,LearningActiveArchiveOutput } from '@learner/core/lib/learning/learning-active-archive.js'
import { LearningExposureIngestOutput } from '@learner/core/lib/learning/learning-exposure-schemas.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { markArchiveDirty,dispatchArchiveSessions,archiveSessionStatus } from '@learner/core/lib/learning/learning-archive-coordinator.js'

export const notifyLearningTranscriptChanged=defineFunction({
  title:'Durably enqueue active Claude transcript capture',expose:true,scopes:['admin'],
  input:LearningActiveArchiveInput,output:LearningActiveArchiveOutput,
  func:async ({learningLosslessArchiveSyncService,workflowService,locks},input,{session,rpc})=>{
    assertLearningLocalMvpEnabled()
    learningLosslessArchiveSyncService.assertEnabled()
    await markArchiveDirty(session.userId,input.sessionId,input.invocationId)
    // Never queue a tool-event burst behind a busy dispatcher lock. The dirty
    // watermark is already durable; completion/reconciliation picks it up.
    if (!learningAdmissionPaused()) await locks.tryWithLock('learning-archive-coalescing','admission',()=>dispatchArchiveSessions(async data=>(await workflowService.startWorkflow('learningCoalescedArchiveWorkflow',data,{type:'http',userId:data.userId},rpc)).runId))
    const state=await archiveSessionStatus(session.userId,input.sessionId)
    return {runId:state.runId,coalesced:state.requestedGeneration-state.capturedGeneration>1,pending:state.state!=='idle'}
  },
})
export const discoverLearningActiveArchiveStep=defineSessionlessFunction({
  input:LearningActiveArchiveRunInput,output:LearningActiveArchiveSource,
  func:async ({learningLosslessArchiveSyncService},{runId,sessionId})=>learningLosslessArchiveSyncService.discoverActive(runId,sessionId),
})
export const captureLearningActiveArchiveStep=defineSessionlessFunction({
  input:LearningActiveArchiveSource,output:LearningActiveArchiveSource,
  func:async ({learningLosslessArchiveSyncService},input)=>{await learningLosslessArchiveSyncService.captureActive(input.runId);return input},
})
export const projectLearningActiveArchiveStep=defineSessionlessFunction({
  input:LearningActiveArchiveSource,output:LearningExposureIngestOutput,
  func:async ({learningExposureIngestService},{sourceId})=>learningExposureIngestService.projectActiveSource(sourceId),
})
