import {test,expect} from 'bun:test'
import {LearningConceptAssessmentService} from './learning-concept-assessment.js'
import {TagProviderFailure} from '@learner/llm/services/typesafe-decision-service.js'
import {jevMasteryRequest,MASTERY_AB_MODELS,MASTERY_LEVELS} from '../lib/learning/learning-mastery-model-comparison.js'
import type {MetaPgQueryFn} from '../lib/db-metadata/_shared.js'

const concept={conceptId:'c',title:'Retry budgets',description:'d',objectives:[]}
const evidence=[{id:'human',conversationId:'s',role:'user',text:'Cap retries at three because each retry multiplies load.',occurredAt:null}]
const answer={type:'score',score:3,probabilities:{0:0,1:.05,2:.15,3:.6,4:.2,5:0},confidence:.8,legend:Object.fromEntries(MASTERY_LEVELS.map((l,i)=>[String(i),l]))}

function harness(evaluate:(selection:unknown,input:unknown)=>Promise<any>) {
  const receipts:any[]=[],llmCalls:unknown[]=[]
  const service=new LearningConceptAssessmentService({} as any,{callLLMWithStructuredOutput:async(i:unknown)=>{llmCalls.push(i);throw new Error('generative path forbidden')}} as any,{evaluate:evaluate as any})
  const query:MetaPgQueryFn=async<R>(sql:string,params?:ReadonlyArray<unknown>)=>{
    let rows:unknown[]=[]
    if(sql.startsWith('SELECT r.*'))rows=[{run_id:'r',user_id:'u',concept_id:'c',input_hash:'h',reserved_at:null,receipt:null,snapshot:{prompt:JSON.stringify(jevMasteryRequest(concept,evidence)),model:MASTERY_AB_MODELS.jev,evidence,experimentId:'e'}}]
    else if(sql.startsWith('SELECT c.run_id,t.receipt FROM learning_concept_assessment_cache'))rows=[]
    else if(sql.startsWith('INSERT INTO learning_concept_assessment_attempts'))rows=[{run_id:'r'}]
    else if(sql.startsWith('INSERT INTO learning_concept_assessment_receipts'))receipts.push(JSON.parse(String(params?.[1])))
    else throw new Error(`Unexpected persistence side effect: ${sql}`)
    return {rows:rows as R[],rowCount:rows.length}
  }
  return {service,query,receipts,llmCalls}
}

test('typed-decision arm sends the frozen request to Jev and records the level, never a mastery write',async()=>{
  const sent:unknown[]=[]
  const h=harness(async(selection,input)=>{sent.push([selection,input]);return {answers:{mastery:answer},raw:'{"raw":true}',request:input,returnedModel:'jev-1.13.0',usage:{input_tokens:1234,output_tokens:0}}})
  expect(await h.service.execute('r',h.query)).toEqual({runId:'r',status:'completed'})
  expect(h.llmCalls).toHaveLength(0)
  expect(sent).toEqual([[{provider:'typesafe',model:'jev-1.13.0'},jevMasteryRequest(concept,evidence)]])
  expect(h.receipts).toHaveLength(1)
  expect(h.receipts[0]).toMatchObject({status:'completed',assessment:null,masteryWrites:0,inputTokens:1234,rateLimitRetries:0,decision:{level:3,confidence:.8,returnedModel:'jev-1.13.0'}})
})

test('only HTTP 429 is retried; any other provider failure is one final failed receipt',async()=>{
  let calls=0
  const limited=harness(async(_s,input)=>{if(++calls===1)throw new TagProviderFailure('Provider HTTP 429','',input);return {answers:{mastery:answer},raw:'',request:input,returnedModel:'jev-1.13.0',usage:null}})
  expect((await limited.service.execute('r',limited.query)).status).toBe('completed')
  expect(calls).toBe(2)
  expect(limited.receipts[0].rateLimitRetries).toBe(1)
  let failures=0
  const broken=harness(async(_s,input)=>{failures++;throw new TagProviderFailure('Provider HTTP 400','{"error":"max_tokens_exceeded"}',input)})
  expect((await broken.service.execute('r',broken.query)).status).toBe('failed')
  expect(failures).toBe(1)
  expect(broken.receipts[0]).toMatchObject({status:'failed',raw:'{"error":"max_tokens_exceeded"}',decision:null})
})

test('a response our validator rejects still records the tokens Jev billed',async()=>{
  const raw=JSON.stringify({model:'jev-1.13.0',answers:{},usage:{input_tokens:28823,output_tokens:18}})
  const h=harness(async(_s,input)=>{throw new TagProviderFailure('Invalid probability distribution',raw,input)})
  expect((await h.service.execute('r',h.query)).status).toBe('failed')
  expect(h.receipts[0]).toMatchObject({status:'failed',raw,inputTokens:28823,outputTokens:18,decision:null})
})
