import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import {
  BeginLearningFeedbackTurnInput,BeginLearningFeedbackTurnOutput,SubmitLearningTurnFeedbackInput,SubmitLearningTurnFeedbackOutput,
  LIVE_CATALOG,LIVE_CATALOG_VERSION,LIVE_FEEDBACK_INSTRUCTIONS,
  LearningFeedbackCatalogInput,LearningFeedbackCatalogOutput,
} from '@learner/core/lib/learning/learning-live-feedback.js'
import { readRecentLiveFeedback } from '@learner/core/lib/learning/learning-feedback-history.js'
import { loadLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { submitLiveTurnFeedback } from '@learner/core/lib/learning/learning-live-turn.js'

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
  func:async (services,input,{session})=>{
    assertLearningLocalMvpEnabled()
    return submitLiveTurnFeedback(services,session.userId,SubmitLearningTurnFeedbackInput.parse(input),loadLearningPolicy)
  },
})
