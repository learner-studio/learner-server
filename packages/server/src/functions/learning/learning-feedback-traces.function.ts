import { defineFunction } from '../../runtime/define.js'
import { pikkuFunc, pikkuSessionlessFunc } from '#pikku/function'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { LearningFeedbackTraceInput,LearningFeedbackTraceOutput,LearningFeedbackTraceId,LearningFeedbackTraceIds,LearningFeedbackTraceEmpty,LearningFeedbackTraceStatus,recordFeedbackTrace,pendingFeedbackTraces,exportFeedbackTrace,getFeedbackTraceStatus } from '@learner/core/lib/learning/learning-feedback-traces.js'

export const getLearningFeedbackTrace = pikkuFunc({
  title:'Read owner-scoped Learning hook trace export state, outcome cohort and prompt provenance',expose:true,readonly:true,scopes:['admin'],
  input:LearningFeedbackTraceId,output:LearningFeedbackTraceStatus,
  func:async ({},{traceId},{session})=>{assertLearningLocalMvpEnabled();return getFeedbackTraceStatus(session.userId,traceId)},
})

// Stays shared: its input's superRefine (hash, unknown keys, submission fields) runs only under zod (recipe section 9).
export const recordLearningFeedbackTrace=defineFunction({
  title:'Capture versioned Learning hook I/O including foundation-first v1.3 evaluations',expose:true,scopes:['admin'],
  input:LearningFeedbackTraceInput,output:LearningFeedbackTraceOutput,
  func:async ({},input,{session})=>{assertLearningLocalMvpEnabled();return recordFeedbackTrace(session.userId,LearningFeedbackTraceInput.parse(input))},
})
export const listPendingLearningFeedbackTraceStep = pikkuSessionlessFunc({
  input:LearningFeedbackTraceEmpty,output:LearningFeedbackTraceIds,
  func:async()=>pendingFeedbackTraces(),
})
export const exportLearningFeedbackTraceStep = pikkuSessionlessFunc({
  input:LearningFeedbackTraceId,output:LearningFeedbackTraceOutput,
  func:async ({},{traceId})=>exportFeedbackTrace(traceId),
})
