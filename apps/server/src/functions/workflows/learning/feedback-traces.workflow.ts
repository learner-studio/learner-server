import { defineWorkflow } from '../../../runtime/define.js'
import { LearningFeedbackTraceEmpty,LearningFeedbackTraceDrainOutput } from '@learner/core/lib/learning/learning-feedback-traces.js'

export const learningFeedbackTraceExportWorkflow=defineWorkflow({
  title:'Export immutable Learning feedback traces through the existing Langfuse transport',
  input:LearningFeedbackTraceEmpty,output:LearningFeedbackTraceDrainOutput,
  func:async ({},data,{workflow})=>{
    const pending=await workflow.do('Select pending traces and quarantine abandoned claims','listPendingLearningFeedbackTraceStep',data,{retries:2,retryDelay:'1s'})
    for(const traceId of pending.traceIds) {
      // Replay rechecks the durable claim. An uncertain append is never resent.
      await workflow.do(`Export trace ${traceId}`,'exportLearningFeedbackTraceStep',{traceId},{retries:2,retryDelay:'1s'})
    }
    return {processed:pending.traceIds.length}
  },
})
