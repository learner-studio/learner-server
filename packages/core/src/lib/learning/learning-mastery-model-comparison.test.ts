import {describe,test,expect} from 'bun:test'
import {decisionRequestSchema} from '@learner/llm/services/typesafe-decision-service.js'
import {percentToLevel,jevMasteryRequest,jevEvidenceBudget,masteryRubricInstructions,masteryArmScores,decisionFromAnswer,jevBilledUsage,MASTERY_LEVELS,MASTERY_AB_SCORE_TYPES} from './learning-mastery-model-comparison.js'

const concept={conceptId:'c',title:'Retry budgets',description:'Bounding retries.\nWhy unbounded retries amplify load.',objectives:['Explain retry amplification']}
const done=(level:number|null,percent:number|null=null,extra={})=>({status:'completed',level,percent,durationMs:100,...extra})

describe('mastery model comparison',()=>{
  test('production percent bands map onto the six score levels, null to insufficient',()=>{
    expect([null,0,5,20,25,45,50,70,75,90,95,100].map(percentToLevel)).toEqual([0,1,1,1,2,2,3,3,4,4,5,5])
    expect(()=>percentToLevel(33)).toThrow()
    expect(()=>percentToLevel(105)).toThrow()
  })
  test('Jev request is one valid 6-level score question carrying the production rubric verbatim',()=>{
    const request=jevMasteryRequest(concept,[{id:'m',conversationId:'s',role:'user',text:'hi',occurredAt:null}])
    expect(decisionRequestSchema.parse(request)).toBeTruthy()
    expect(request.questions.mastery.criteria).toHaveLength(6)
    const rubric=masteryRubricInstructions()
    expect(rubric).toContain('5–20 limited but identifiable understanding')
    expect(rubric).toContain('Missing evidence is NOT 0% understanding')
    expect(rubric).not.toContain('byte-exact quote')
    expect(rubric).not.toContain('Return only the structured JSON')
  })
  test('evidence budget leaves room for the fixed request under the catalogued Jev cap',()=>{
    const budget=jevEvidenceBudget(concept)
    expect(budget.limitTokens).toBe(32000)
    expect(budget.maxEvidenceTokens).toBe(budget.limitTokens-budget.fixedTokens-budget.marginTokens)
    expect(budget.maxEvidenceTokens).toBeGreaterThan(20000)
  })
  test('scores: exact, near, evidence decision and failure-as-wrong',()=>{
    expect(masteryArmScores(done(3,55),done(3,65),'flash')).toMatchObject({level_exact:true,level_abs_error:0,percent_abs_error:10,evidence_decision_agrees:true})
    expect(masteryArmScores(done(3),done(0),'flash')).toMatchObject({level_exact:false,level_within_one:false,evidence_decision_agrees:false,level_abs_error:3})
    expect(masteryArmScores(done(2),{status:'failed',level:null,percent:null,durationMs:5},'jev')).toMatchObject({level_exact:false,level_abs_error:5,evidence_decision_agrees:false})
    expect(masteryArmScores({status:'failed',level:null,percent:null,durationMs:1},done(2),'jev')).toEqual({call_latency_ms:100})
  })
  test('Jev probability scores read the reference level and the expected level',()=>{
    const decision=decisionFromAnswer({score:2,probabilities:{0:0,1:.2,2:.6,3:.2,4:0,5:0},confidence:.7,legend:Object.fromEntries(MASTERY_LEVELS.map((l,i)=>[String(i),l]))},'jev-1.13.0',null)
    const scores=masteryArmScores(done(3),done(2,null,{decision}),'jev')
    expect(scores.ref_level_probability).toBe(.2)
    expect(scores.expected_level).toBeCloseTo(2)
    expect(scores.confidence).toBe(.7)
    expect(()=>decisionFromAnswer({score:6},'jev-1.13.0',null)).toThrow()
  })
  test('the Jev level is the most probable level; its score is only the expected value',()=>{
    const legend=Object.fromEntries(MASTERY_LEVELS.map((l,i)=>[String(i),l]))
    const live=decisionFromAnswer({score:1.37,probabilities:{0:.39,1:.2,2:.17,3:.17,4:.05,5:.02},confidence:.08,legend},'jev-1.13.0',null)
    expect(live).toMatchObject({level:0,expectedScore:1.37})
    expect(decisionFromAnswer({score:2.5,probabilities:{0:0,1:0,2:.4,3:.4,4:.2,5:0},confidence:.1,legend},'jev-1.13.0',null).level).toBe(2)
    expect(()=>decisionFromAnswer({score:1,probabilities:{0:1},confidence:1,legend},'jev-1.13.0',null)).toThrow()
  })
  test('every score config name fits the Langfuse 35-character limit',()=>{
    expect(Object.keys(MASTERY_AB_SCORE_TYPES).map(k=>'mastery_ab.'+k).filter(n=>n.length>35)).toEqual([])
  })
})

describe('Jev billing per receipt',()=>{
  const legend=Object.fromEntries(MASTERY_LEVELS.map((l,i)=>[String(i),l]))
  test('a completed call bills its decision usage and carries the model Langfuse prices',()=>{
    const decision=decisionFromAnswer({score:1,probabilities:{0:0,1:1,2:0,3:0,4:0,5:0},confidence:.9,legend},'jev-1.13.0',{input_tokens:1_000_000,output_tokens:18})
    expect(jevBilledUsage({decision,raw:''})).toEqual({billed:true,model:'jev-1.13.0',inputTokens:1_000_000,outputTokens:18,reason:null})
  })
  test('a call our validator rejected is still billed from the preserved provider body',()=>{
    const raw=JSON.stringify({model:'jev-1.13.0',answers:{},usage:{input_tokens:28823,output_tokens:18}})
    expect(jevBilledUsage({decision:null,raw})).toEqual({billed:true,model:'jev-1.13.0',inputTokens:28823,outputTokens:18,reason:null})
  })
  test('a provider refusal with no usage is unbilled; an unreadable failure is unknown',()=>{
    expect(jevBilledUsage({decision:null,raw:'{"detail":{"error_type":"max_tokens_exceeded"}}'})).toEqual({billed:false,model:null,inputTokens:0,outputTokens:0,reason:'max_tokens_exceeded'})
    expect(jevBilledUsage({decision:null,raw:''})).toBeNull()
    expect(jevBilledUsage({decision:null,raw:JSON.stringify({usage:{input_tokens:5}})})).toBeNull()
    expect(jevBilledUsage({decision:null,raw:JSON.stringify({model:'jev-1.13.0',usage:{input_tokens:1.5}})})).toBeNull()
  })
})
