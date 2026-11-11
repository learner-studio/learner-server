import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import {
  BeginLearningFeedbackTurnInput,BeginLearningFeedbackTurnOutput,SubmitLearningTurnFeedbackInput,SubmitLearningTurnFeedbackOutput,
  LIVE_CATALOG,LIVE_CATALOG_VERSION,
  LearningFeedbackCatalogInput,LearningFeedbackCatalogOutput,
} from '@learner/core/lib/learning/learning-live-feedback.js'
import { loadLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { beginLiveTurn, submitLiveTurnFeedback } from '@learner/core/lib/learning/learning-live-turn.js'

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
    return beginLiveTurn(session.userId,BeginLearningFeedbackTurnInput.parse(input))
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
