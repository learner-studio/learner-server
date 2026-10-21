import { defineWorkflow } from '../../../runtime/define.js'
import { ArchiveDispatchInput } from '@learner/core/lib/learning/learning-archive-coordinator.js'
import { LearningActiveArchiveReceipt } from '@learner/core/lib/learning/learning-active-archive.js'

export const learningCoalescedArchiveWorkflow=defineWorkflow({
  title:'Coalesced lossless transcript capture with fenced follow-up',input:ArchiveDispatchInput,output:LearningActiveArchiveReceipt,
  func:async({},data,{workflow})=>{
    // Gather tool-event bursts without postponing indefinitely while typing.
    await workflow.sleep('Allow transcript append to settle','1s')
    const pass=await workflow.do('Claim latest notification generation','claimLearningArchivePassStep',{...data,runId:workflow.runId},{retries:2,retryDelay:'1s'})
    const source=await workflow.do('Discover only the active approved transcript','discoverLearningActiveArchiveStep',
      {sessionId:data.sessionId,invocationId:data.dispatchId,runId:workflow.runId},{retries:3,retryDelay:'1s'})
    await workflow.do('Capture active transcript with existing fences','captureLearningActiveArchiveStep',source,{retries:5,retryDelay:'1s'})
    const projection=await workflow.do('Immediately project the captured transcript','projectLearningActiveArchiveStep',source,{retries:8,retryDelay:'1s'})
    await workflow.do('Durably notify canonical index','markLearningIndexDirtyStep',{runId:workflow.runId},{retries:3,retryDelay:'1s'})
    await workflow.do('Verify captured bytes','verifyLearningLosslessArchiveStep',{runId:source.runId},{retries:2,retryDelay:'1s'})
    const archive=await workflow.do('Publish active archive receipt','finishLearningLosslessArchiveStep',{runId:source.runId},{retries:2,retryDelay:'1s'})
    await workflow.do('Settle only the captured generation','settleLearningArchivePassStep',pass,{retries:3,retryDelay:'1s'})
    await workflow.do('Immediately dispatch dirty follow-up sessions','dispatchLearningArchiveSessionsStep',{}, {retries:3,retryDelay:'1s'})
    await workflow.do('Wake canonical index without waiting for embeddings','dispatchLearningIndexStep',{}, {retries:3,retryDelay:'1s'})
    return {archive,projection}
  },
})
