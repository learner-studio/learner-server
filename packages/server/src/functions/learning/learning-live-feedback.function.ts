import { defineFunction } from '../../runtime/define.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import {
  BeginLearningFeedbackTurnInput,BeginLearningFeedbackTurnOutput,SubmitLearningTurnFeedbackInput,SubmitLearningTurnFeedbackOutput,
  LIVE_CATALOG,LIVE_CATALOG_VERSION,
  LearningFeedbackCatalogInput,LearningFeedbackCatalogOutput,
} from '@learner/core/lib/learning/learning-live-feedback.js'
import { loadLearningPolicy } from '@learner/core/lib/learning/learning-policy-settings.js'
import { beginLiveTurn, submitLiveTurnFeedback } from '@learner/core/lib/learning/learning-live-turn.js'
import { hookLearnerFor } from './mastery-notifications.function.js'
import { readReactiveGradingAlerts, withGradingAlerts } from '@learner/core/lib/learning/learning-reactive-health.js'

export const getLearningFeedbackCatalog=defineFunction({
  title:'Get the versioned live Learning concept catalog',expose:true,readonly:true,
  input:LearningFeedbackCatalogInput,output:LearningFeedbackCatalogOutput,
  func:async(services,_input,{session})=>{assertLearningLocalMvpEnabled();await hookLearnerFor(services,session);return {catalogVersion:LIVE_CATALOG_VERSION,catalog:LIVE_CATALOG}},
})

export const beginLearningFeedbackTurn=defineFunction({
  title:'Initialize provisional Learning feedback for a human turn',expose:true,
  input:BeginLearningFeedbackTurnInput,output:BeginLearningFeedbackTurnOutput,
  func:async (services,input,{session})=>{
    assertLearningLocalMvpEnabled()
    const {logger}=services
    const userId=await hookLearnerFor(services,session)
    // The reactive grading alarm reaches the person on their next prompt; a failed read never blocks the turn.
    return withGradingAlerts(beginLiveTurn(userId,BeginLearningFeedbackTurnInput.parse(input)),
      ()=>readReactiveGradingAlerts(userId,process.env.LEARNER_SCHEDULES_ENABLED==='true'),
      error=>logger.warn({event:'learning-grading-alerts-unavailable',error:String(error)}))
  },
})

/** One atomic provisional write; retrying only repeats the read, never changes mastery. */
export const submitLearningTurnFeedback=defineFunction({
  title:'Submit provisional human evidence and retrieve non-repeating guidance',expose:true,
  input:SubmitLearningTurnFeedbackInput,output:SubmitLearningTurnFeedbackOutput,
  func:async (services,input,{session})=>{
    assertLearningLocalMvpEnabled()
    return submitLiveTurnFeedback(services,await hookLearnerFor(services,session),SubmitLearningTurnFeedbackInput.parse(input),loadLearningPolicy)
  },
})
