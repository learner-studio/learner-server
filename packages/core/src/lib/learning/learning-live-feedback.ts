import { z } from 'zod'
import { LIVE_FEEDBACK_INSTRUCTIONS } from '@learner/contract/learning/learning-teaching-policy.js'
import { LIVE, LIVE_CATALOG_VERSION, type LiveCatalog } from './learning-live-catalog.js'
import { CLASSIFIER_V6_CATALOG, CLASSIFIER_V6_CATALOG_HASH } from './learning-classifier-v6.js'
import { LearningHookContextOutput } from './learning-hook-context.js'

export { LIVE_CATALOG, LIVE_CATALOG_VERSION } from './learning-live-catalog.js'
const legacyIds = new Set(CLASSIFIER_V6_CATALOG.map(item=>item.id))
// The previous host's JSON-schema type generator emits an impossible index signature for
// additionalProperties:false. Preserve strict runtime validation explicitly.
function rejectExtraKeys(value:Record<string,unknown>,allowed:readonly string[],ctx:z.RefinementCtx) {
  for(const key of Object.keys(value)) if(!allowed.includes(key)) ctx.addIssue({code:'custom',path:[key],message:'Unknown property'})
}
export const LearningFeedbackCatalogInput=z.object({}).catchall(z.unknown()).superRefine((value,ctx)=>rejectExtraKeys(value,[],ctx))
export const LearningFeedbackCatalogOutput=z.object({catalogVersion:z.string(),catalog:z.array(z.object({id:z.string(),title:z.string()}))})
/** The submission schemas for one catalog: concept IDs are refined against it, so another catalog
 * (the simulated-learner experiment) needs its own set. The module exports are this for LIVE. */
export function liveFeedbackSchemas(catalog:LiveCatalog) {
  const ids = new Set(catalog.concepts.map(item=>item.id))
  const ConceptId=z.string().refine(id=>ids.has(id),'Unknown concept ID')
  const LiveFeedbackMatch=z.object({
    conceptId:ConceptId,quote:z.string().min(1).max(6000),
    relationship:z.enum(['mention','task_context','learner_evidence','misconception']),
    outcome:z.enum(['demonstrated','partial','unclear','not_assessed']),
    reason:z.string().min(1).max(1000),remainingGap:z.string().min(1).max(500).optional(),
  }).catchall(z.unknown()).superRefine((match,ctx)=>{
    rejectExtraKeys(match,['conceptId','quote','relationship','outcome','reason','remainingGap'],ctx)
    if(['demonstrated','partial'].includes(match.outcome)&&match.relationship!=='learner_evidence')
      ctx.addIssue({code:'custom',message:'Only learner evidence may demonstrate understanding'})
    if(match.outcome==='partial'&&!match.remainingGap)
      ctx.addIssue({code:'custom',message:'Partial understanding requires the remaining gap'})
  })
  const Matches=z.array(LiveFeedbackMatch).max(catalog.concepts.length).refine(matches=>new Set(matches.map(item=>item.conceptId)).size===matches.length,'Duplicate concept IDs')
  const TaughtIds=z.array(ConceptId).max(catalog.concepts.length).refine(values=>new Set(values).size===values.length,'Duplicate taught concept IDs')
  const SubmitLearningTurnFeedbackInput=z.object({sessionId:z.string().min(1).max(200),turnId:z.string().uuid(),catalogVersion:z.string(),matches:Matches,taughtConceptIds:TaughtIds.default([])}).catchall(z.unknown()).superRefine((value,ctx)=>rejectExtraKeys(value,['sessionId','turnId','catalogVersion','matches','taughtConceptIds'],ctx))
  const RecentLiveFeedback=z.object({turnId:z.string().uuid(),matches:Matches,taughtConceptIds:TaughtIds})
  return { ids, LiveFeedbackMatch, SubmitLearningTurnFeedbackInput, RecentLiveFeedback }
}
const liveSchemas=liveFeedbackSchemas(LIVE)
const schemasByVersion=new Map<string,ReturnType<typeof liveFeedbackSchemas>>([[LIVE.version,liveSchemas]])
/** Schemas are built once per catalog version. */
export const schemasFor=(catalog:LiveCatalog)=>{
  let found=schemasByVersion.get(catalog.version)
  if(!found) schemasByVersion.set(catalog.version,found=liveFeedbackSchemas(catalog))
  return found
}
export const LiveFeedbackMatch=liveSchemas.LiveFeedbackMatch
export const BeginLearningFeedbackTurnInput=z.object({sessionId:z.string().min(1).max(200),turnId:z.string().uuid(),message:z.string().min(1).max(100000),foundationFirst:z.boolean().default(true),catalogVersion:z.string().optional()}).catchall(z.unknown()).superRefine((value,ctx)=>rejectExtraKeys(value,['sessionId','turnId','message','foundationFirst','catalogVersion'],ctx))
export const SubmitLearningTurnFeedbackInput=liveSchemas.SubmitLearningTurnFeedbackInput
export type BeginLearningFeedbackTurnInput=z.infer<typeof BeginLearningFeedbackTurnInput>
export type SubmitLearningTurnFeedbackInput=z.infer<typeof SubmitLearningTurnFeedbackInput>
export const RecentLiveFeedback=liveSchemas.RecentLiveFeedback
export const BeginLearningFeedbackTurnOutput=z.object({turnId:z.string().uuid(),catalogVersion:z.string(),catalog:z.array(z.object({id:z.string(),title:z.string()})).nullable(),instructions:z.string(),recentFeedback:z.array(RecentLiveFeedback),alerts:z.array(z.string()).default([])})
export const SubmitLearningTurnFeedbackOutput=z.object({status:z.literal('provisional'),replayed:z.boolean(),guidance:LearningHookContextOutput})
export type LiveFeedback=z.infer<typeof RecentLiveFeedback>
export { LIVE_FEEDBACK_INSTRUCTIONS }

/** Latest relevant observation wins. A new misconception can reopen an older success. */
export function liveFeedbackPolicy(recent:LiveFeedback[]) {
  const latest=new Map<string,{match:z.infer<typeof LiveFeedbackMatch>;index:number}>()
  const taught=new Map<string,number>()
  for(const [index,feedback] of recent.entries()) {
    for(const match of feedback.matches) if(!latest.has(match.conceptId)&&match.relationship!=='mention'&&match.relationship!=='task_context') latest.set(match.conceptId,{match,index})
    for(const id of feedback.taughtConceptIds) if(!taught.has(id)) taught.set(id,index)
  }
  const suppressed=new Set(taught.keys())
  const gaps:Array<{conceptId:string;remainingGap:string}>=[]
  for(const [id,{match,index}] of latest) {
    if(match.outcome==='demonstrated') suppressed.add(id)
    if(match.outcome==='partial') {
      suppressed.add(id)
      if(index<=(taught.get(id)??Infinity)) gaps.push({conceptId:id,remainingGap:match.remainingGap!})
    }
    if(match.relationship==='misconception'&&index<=(taught.get(id)??Infinity)) suppressed.delete(id)
  }
  return {suppressed,gaps}
}

export function validateLiveFeedbackMessage(input:z.infer<typeof SubmitLearningTurnFeedbackInput>,message:string,storedVersion=LIVE_CATALOG_VERSION,catalog:LiveCatalog=LIVE) {
  // JSON Schema transport validation cannot execute Zod refinements. Enforce
  // IDs, duplicates and evidence invariants here BEFORE the provisional write.
  schemasFor(catalog).SubmitLearningTurnFeedbackInput.parse(input)
  // The legacy classifier catalog is a cutover allowance of the shipped catalog only.
  const accepted=catalog===LIVE?[LIVE_CATALOG_VERSION,CLASSIFIER_V6_CATALOG_HASH]:[catalog.version]
  if(input.catalogVersion!==storedVersion || !accepted.includes(storedVersion)) throw new Error('Concept catalog changed; initialize this turn again')
  // Let an already initialized original-catalog turn finish during the additive cutover.
  if(storedVersion===CLASSIFIER_V6_CATALOG_HASH && [...input.matches.map(match=>match.conceptId),...input.taughtConceptIds].some(id=>!legacyIds.has(id))) throw new Error('Concept was not in this turn catalog')
  for(const match of input.matches) if(!message.includes(match.quote)) throw new Error('Evidence quote must occur verbatim in the current user message')
}
