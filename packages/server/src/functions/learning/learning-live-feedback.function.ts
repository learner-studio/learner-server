import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { taskTeachingContext, TASK_TEACHING_DEFAULT } from '@learner/core/lib/learning/learning-teaching-default.js'
import {
  BeginLearningFeedbackTurnInput,BeginLearningFeedbackTurnOutput,SubmitLearningTurnFeedbackInput,SubmitLearningTurnFeedbackOutput,
  LIVE_CATALOG,LIVE_CATALOG_VERSION,LIVE_FEEDBACK_INSTRUCTIONS,liveFeedbackPolicy,validateLiveFeedbackMessage,
  LearningFeedbackCatalogInput,LearningFeedbackCatalogOutput,
} from '@learner/core/lib/learning/learning-live-feedback.js'
import { readRecentLiveFeedback } from '@learner/core/lib/learning/learning-feedback-history.js'

export const getLearningFeedbackCatalog=defineFunction({
  title:'Get the versioned live Learning concept catalog',expose:true,readonly:true,scopes:['admin'],
  input:LearningFeedbackCatalogInput,output:LearningFeedbackCatalogOutput,
  func:async()=>{assertLearningLocalMvpEnabled();return {catalogVersion:LIVE_CATALOG_VERSION,catalog:LIVE_CATALOG}},
})

export const beginLearningFeedbackTurn=defineFunction({
  title:'Initialize provisional Learning feedback for a human turn',expose:true,scopes:['admin'],
  input:BeginLearningFeedbackTurnInput,output:BeginLearningFeedbackTurnOutput,
  func:async ({},input,{session})=>{
    assertLearningLocalMvpEnabled()
    input=BeginLearningFeedbackTurnInput.parse(input)
    await metaDbQuery(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[session.userId,input.sessionId,input.turnId,input.message,input.foundationFirst,LIVE_CATALOG_VERSION])
    const row=(await metaDbQuery<{message:string;foundation_first:boolean;catalog_version:string}>(`SELECT message,foundation_first,catalog_version FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`,[session.userId,input.sessionId,input.turnId])).rows[0]
    if(!row||row.message!==input.message||row.foundation_first!==input.foundationFirst||row.catalog_version!==LIVE_CATALOG_VERSION) throw new Error('Turn identity conflicts with the stored message or configuration')
    return {turnId:input.turnId,catalogVersion:LIVE_CATALOG_VERSION,catalog:input.catalogVersion===LIVE_CATALOG_VERSION?null:LIVE_CATALOG,instructions:LIVE_FEEDBACK_INSTRUCTIONS,recentFeedback:await readRecentLiveFeedback(session.userId,input.sessionId)}
  },
})

/** One atomic provisional write; retrying only repeats the read, never changes mastery. */
export const submitLearningTurnFeedback=defineFunction({
  title:'Submit provisional human evidence and retrieve non-repeating guidance',expose:true,scopes:['admin'],
  input:SubmitLearningTurnFeedbackInput,output:SubmitLearningTurnFeedbackOutput,
  func:async ({learningVectorTurns,learningCurriculumStore},input,{session})=>{
    assertLearningLocalMvpEnabled()
    input=SubmitLearningTurnFeedbackInput.parse(input)
    const row=(await metaDbQuery<{message:string;foundation_first:boolean;catalog_version:string}>(`SELECT message,foundation_first,catalog_version FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`,[session.userId,input.sessionId,input.turnId])).rows[0]
    if(!row) throw new Error('Initialize the human turn before submitting feedback')
    if(row.catalog_version!==input.catalogVersion) throw new Error('Turn catalog version mismatch')
    validateLiveFeedbackMessage(input,row.message,row.catalog_version)
    const payload=JSON.stringify({matches:input.matches,taughtConceptIds:input.taughtConceptIds})
    const inserted=await metaDbQuery(`UPDATE learning_live_feedback_turns SET feedback=$4::jsonb,submitted_at=now() WHERE user_id=$1 AND session_id=$2 AND turn_id=$3 AND feedback IS NULL RETURNING turn_id`,[session.userId,input.sessionId,input.turnId,payload])
    if(!inserted.rowCount) {
      const same=(await metaDbQuery<{same:boolean}>(`SELECT feedback=$4::jsonb AS same FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`,[session.userId,input.sessionId,input.turnId,payload])).rows[0]?.same
      if(!same) throw new Error('Conflicting feedback for an already submitted turn')
    }
    const started=Date.now()
    const base={datasetTag:'dev1' as const,foundationFirst:row.foundation_first,policyRevision:'task-teaching-v2' as const,requestId:input.turnId}
    try {
      const recent=await readRecentLiveFeedback(session.userId,input.sessionId)
      const {suppressed,gaps}=liveFeedbackPolicy(recent)
      const graphs=await learningCurriculumStore.listGraphs()
      const projection=await learningVectorTurns.lookupAssessments(session.userId,graphs)
      const teaching=taskTeachingContext({ids:input.matches.map(match=>match.conceptId),catalog:LIVE_CATALOG,assessments:projection.assessments,suppressed,gaps,edges:graphs.flatMap(graph=>graph.edges),foundationFirst:row.foundation_first})
      return {status:'provisional' as const,replayed:!inserted.rowCount,guidance:{...base,experimentId:projection.experimentId,decision:'influence' as const,...teaching,durationMs:Date.now()-started}}
    } catch {
      return {status:'provisional' as const,replayed:!inserted.rowCount,guidance:{...base,experimentId:null,decision:'fail_open' as const,context:`Feedback saved; stored assessment lookup unavailable. ${TASK_TEACHING_DEFAULT}`,conceptIds:[],durationMs:Date.now()-started}}
    }
  },
})
