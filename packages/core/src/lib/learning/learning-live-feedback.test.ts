import { describe,it,expect } from 'bun:test'
import { CLASSIFIER_V6_CATALOG,CLASSIFIER_V6_CATALOG_HASH } from './learning-classifier-v6.js'
import { LIVE_CATALOG,LIVE_CATALOG_VERSION,SubmitLearningTurnFeedbackInput,BeginLearningFeedbackTurnInput,liveFeedbackPolicy,validateLiveFeedbackMessage } from './learning-live-feedback.js'
import { projectRecentLiveFeedback } from './learning-feedback-history.js'
const conceptId=LIVE_CATALOG[0]!.id
const turnId='00000000-0000-4000-8000-000000000001'
const match={conceptId,quote:'request',relationship:'learner_evidence' as const,outcome:'demonstrated' as const,reason:'Explains distinction'}
const input={sessionId:'test',turnId,catalogVersion:LIVE_CATALOG_VERSION,matches:[match],taughtConceptIds:[]}
describe('live Learning feedback',()=>{
  it('rejects unknown taught IDs at the persistence boundary, not only the generated RPC schema',()=>{
    expect(()=>validateLiveFeedbackMessage({...input,taughtConceptIds:['delivery-testing--regression-test']},'request')).toThrow()
  })
  it('projects valid history without rewriting stale or invalid stored entries',()=>{
    const stored={matches:[match,{...match,conceptId:'retired-concept'}],taughtConceptIds:[conceptId,'delivery-testing--regression-test']}
    const before=JSON.stringify(stored)
    expect(projectRecentLiveFeedback(turnId,stored)).toEqual({turnId,matches:[match],taughtConceptIds:[conceptId]})
    expect(JSON.stringify(stored)).toBe(before)
    expect(projectRecentLiveFeedback(turnId,{matches:null})).toEqual({turnId,matches:[],taughtConceptIds:[]})
    expect(projectRecentLiveFeedback(turnId,{matches:[match],taughtConceptIds:null}).matches).toEqual([match])
    expect(projectRecentLiveFeedback(turnId,{matches:null,taughtConceptIds:[conceptId]}).taughtConceptIds).toEqual([conceptId])
  })
  it('enforces semantic invariants and duplicate rejection at the persistence boundary',()=>{
    for(const bad of [{...input,matches:[match,match]},{...input,matches:[{...match,relationship:'mention' as const}]},{...input,matches:[{...match,outcome:'partial' as const}]}])
      expect(()=>validateLiveFeedbackMessage(bad,'request')).toThrow()
  })
  it('allows in-flight legacy turns without allowing new concepts under the old catalog',()=>{
    const legacy={...input,catalogVersion:CLASSIFIER_V6_CATALOG_HASH,matches:[{...match,conceptId:CLASSIFIER_V6_CATALOG[0]!.id}]}
    expect(()=>validateLiveFeedbackMessage(legacy,'request',CLASSIFIER_V6_CATALOG_HASH)).not.toThrow()
    const oldIds=new Set(CLASSIFIER_V6_CATALOG.map(item=>item.id))
    const added=LIVE_CATALOG.find(item=>!oldIds.has(item.id))!
    expect(added).toBeDefined()
    expect(()=>validateLiveFeedbackMessage({...legacy,taughtConceptIds:[added.id]},'request',CLASSIFIER_V6_CATALOG_HASH)).toThrow()
    expect(()=>validateLiveFeedbackMessage(legacy,'request')).toThrow()
  })
  it('rejects unknown fields at both input roots and nested matches',()=>{
    expect(BeginLearningFeedbackTurnInput.safeParse({sessionId:'test',turnId,message:'request',unexpected:true}).success).toBe(false)
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,unexpected:true}).success).toBe(false)
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:[{...match,unexpected:true}]}).success).toBe(false)
  })
  it('allows no tags and more than five without accepting unknown or duplicate IDs',()=>{
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:[]}).success).toBe(true)
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:LIVE_CATALOG.slice(0,8).map(item=>({...match,conceptId:item.id}))}).success).toBe(true)
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:[match,match]}).success).toBe(false)
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:[{...match,conceptId:'not-real'}]}).success).toBe(false)
  })
  it('requires a partial gap and rejects mastery attributed to topic mentions',()=>{
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:[{...match,outcome:'partial'}]}).success).toBe(false)
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:[{...match,relationship:'mention'}]}).success).toBe(false)
    expect(SubmitLearningTurnFeedbackInput.safeParse({...input,matches:[{...match,outcome:'partial',remainingGap:'Response status'}]}).success).toBe(true)
  })
  it('checks exact current human quotes and catalog identity',()=>{
    expect(()=>validateLiveFeedbackMessage(input,'A request is sent by the client')).not.toThrow()
    expect(()=>validateLiveFeedbackMessage(input,'assistant response only')).toThrow()
    expect(()=>validateLiveFeedbackMessage({...input,catalogVersion:'old'},'request')).toThrow()
  })
  it('stores full large prompt instead of silently truncating evidence',()=>{
    expect(BeginLearningFeedbackTurnInput.safeParse({sessionId:'test',turnId,message:'x'.repeat(100000)}).success).toBe(true)
  })
  it('suppresses previous success, narrows partial lessons, and allows a new misconception to reopen',()=>{
    expect(liveFeedbackPolicy([{turnId,matches:[match],taughtConceptIds:[]}]).suppressed.has(conceptId)).toBe(true)
    const partial={...match,outcome:'partial' as const,remainingGap:'Response status'}
    expect(liveFeedbackPolicy([{turnId,matches:[partial],taughtConceptIds:[]}]).gaps).toEqual([{conceptId,remainingGap:'Response status'}])
    const reopened=liveFeedbackPolicy([{turnId,matches:[{...match,relationship:'misconception',outcome:'unclear'}],taughtConceptIds:[]},{turnId,matches:[match],taughtConceptIds:[conceptId]}])
    expect(reopened.suppressed.has(conceptId)).toBe(false)
  })
  it('teaching alone suppresses repetition but does not synthesize learner evidence',()=>{
    const policy=liveFeedbackPolicy([{turnId,matches:[],taughtConceptIds:[conceptId]}])
    expect(policy.suppressed.has(conceptId)).toBe(true)
    expect(policy.gaps).toEqual([])
  })
  it('newer teaching suppresses an older misconception even with current task-context tags',()=>{
    const policy=liveFeedbackPolicy([
      {turnId,matches:[{...match,relationship:'task_context',outcome:'not_assessed'}],taughtConceptIds:[conceptId]},
      {turnId,matches:[{...match,relationship:'misconception',outcome:'unclear'}],taughtConceptIds:[]},
    ])
    expect(policy.suppressed.has(conceptId)).toBe(true)
  })
  it('newer teaching suppresses an older partial gap until new learner evidence',()=>{
    const partial={...match,outcome:'partial' as const,remainingGap:'Response status'}
    const policy=liveFeedbackPolicy([
      {turnId,matches:[],taughtConceptIds:[conceptId]},
      {turnId,matches:[partial],taughtConceptIds:[]},
    ])
    expect(policy.suppressed.has(conceptId)).toBe(true)
    expect(policy.gaps).toEqual([])
    expect(liveFeedbackPolicy([{turnId,matches:[partial],taughtConceptIds:[conceptId]}]).gaps).toHaveLength(1)
  })
})
