import {test,expect} from 'bun:test'
import {LocalVariablesService} from '../runtime/types.js'
import {IDENTICAL_EVIDENCE_FAILED,isProviderFailure,LearningConceptAssessmentService} from './learning-concept-assessment.js'
import {LearningCurriculumStore} from './learning-curriculum-store.js'
import {LLMService} from '@learner/llm/services/llm-service.js'
import {ASSESSMENT_MODEL,buildConceptAssessmentInput} from '../lib/learning/learning-concept-assessment.js'
import type {MetaPgQueryFn} from '../lib/db-metadata/_shared.js'

test('execute dispatches each immutable model arm and records its result without live writes',async()=>{
  const built=buildConceptAssessmentInput({conceptId:'test-concept',title:'Test',description:'Test model dispatch',objectives:[]},[{id:'human',conversationId:'session',role:'user',text:'Human evidence',occurredAt:null}],null)
  const proposal={conceptId:'test-concept',nodeVersion:built.nodeVersion,understandingPercent:null,confidence:'insufficient',demonstrated:[],gaps:[],nextCheck:'Explain the concept.',needsReview:true}
  class Capture extends LLMService{
    calls:Array<Parameters<LLMService['callLLMWithStructuredOutput']>[0]>=[]
    override async callLLMWithStructuredOutput(input:Parameters<LLMService['callLLMWithStructuredOutput']>[0]){
      this.calls.push(input)
      return [proposal]
    }
  }
  const llm=new Capture(new LocalVariablesService())
  // No curriculum methods are used by execution; this real prototype has no DB.
  const curricula:LearningCurriculumStore=Object.create(LearningCurriculumStore.prototype)
  const service=new LearningConceptAssessmentService(curricula,llm)
  for(const [model,effort]of [['gemini-3.7-flash','high'],['gemini-3.8-flash','medium']] as const){
    const receipts:unknown[]=[]
    const frozen={...ASSESSMENT_MODEL,model,effort,maxParseRetries:0,maxAttempts:1}
    const query:MetaPgQueryFn=async<R>(sql:string,params?:ReadonlyArray<unknown>)=>{
      let rows:unknown[]=[]
      if(sql.startsWith('SELECT r.*'))rows=[{run_id:model,user_id:'test',concept_id:'test-concept',input_hash:model,reserved_at:null,receipt:null,snapshot:{...built,model:frozen,evidence:[{id:'human',role:'user',text:'Human evidence'}]}}]
      else if(sql.startsWith('SELECT c.run_id,t.receipt FROM learning_concept_assessment_cache'))rows=[]
      else if(sql.startsWith('INSERT INTO learning_concept_assessment_attempts'))rows=[{run_id:model}]
      else if(sql.startsWith('INSERT INTO learning_concept_assessment_receipts'))receipts.push(JSON.parse(String(params?.[1])))
      else throw new Error(`Unexpected persistence side effect: ${sql}`)
      return {rows:rows as R[],rowCount:rows.length}
    }
    expect(await service.execute(model,query)).toEqual({runId:model,status:'completed'})
    expect(llm.calls.at(-1).callOptions.model).toBe(model)
    expect(llm.calls.at(-1).callOptions.effort).toBe(effort)
    expect(llm.calls.at(-1).callOptions.maxAttempts).toBe(1)
    expect(llm.calls.at(-1).maxParseRetries).toBe(0)
    expect(receipts).toHaveLength(1)
    expect(receipts[0]).toMatchObject({masteryWrites:0,status:'completed',assessment:proposal})
  }
  expect(llm.calls).toHaveLength(2)
})

test('execute retries once with the validator error when the model cites an unknown source',async()=>{
  const built=buildConceptAssessmentInput({conceptId:'test-concept',title:'Test',description:'Test retry',objectives:[]},[{id:'human',conversationId:'session',role:'user',text:'Human evidence',occurredAt:null}],null)
  const proposal={conceptId:'test-concept',nodeVersion:built.nodeVersion,understandingPercent:null,confidence:'insufficient',demonstrated:[],gaps:[],nextCheck:'Explain the concept.',needsReview:true}
  class Flaky extends LLMService{
    prompts:string[]=[]
    override async callLLMWithStructuredOutput(input:Parameters<LLMService['callLLMWithStructuredOutput']>[0]){
      this.prompts.push(input.prompt)
      input.callOptions?.onUsage?.({inputTokens:10,outputTokens:2})
      if(this.prompts.length===1)throw new Error('Unknown human source: not-in-evidence')
      return [proposal]
    }
  }
  const llm=new Flaky(new LocalVariablesService())
  const service=new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype),llm)
  const receipts:Array<Record<string,unknown>>=[]
  const query:MetaPgQueryFn=async<R>(sql:string,params?:ReadonlyArray<unknown>)=>{
    let rows:unknown[]=[]
    if(sql.startsWith('SELECT r.*'))rows=[{run_id:'r',user_id:'test',concept_id:'test-concept',input_hash:'h',reserved_at:null,receipt:null,snapshot:{...built,model:{...ASSESSMENT_MODEL,maxParseRetries:0,maxAttempts:1},evidence:[{id:'human',role:'user',text:'Human evidence'}]}}]
    else if(sql.startsWith('INSERT INTO learning_concept_assessment_attempts'))rows=[{run_id:'r'}]
    else if(sql.startsWith('INSERT INTO learning_concept_assessment_receipts'))receipts.push(JSON.parse(String(params?.[1])))
    return {rows:rows as R[],rowCount:rows.length}
  }
  expect(await service.execute('r',query)).toEqual({runId:'r',status:'completed'})
  expect(llm.prompts).toHaveLength(2)
  expect(llm.prompts[1]).toContain('Unknown human source: not-in-evidence')
  expect(receipts[0]).toMatchObject({status:'completed',inputTokens:20,outputTokens:4,validatorRetry:{kind:'quote',recovered:true}})
})

test('identical evidence: a completed holder is reused; a provider failure gets ONE fresh paid attempt; a rejected or retried failure is a zero-cost known failure; anything else is uncertain (R7-S2, R7-N3)',async()=>{
  const built=buildConceptAssessmentInput({conceptId:'test-concept',title:'Test',description:'Test reuse',objectives:[]},[{id:'human',conversationId:'session',role:'user',text:'Human evidence',occurredAt:null}],null)
  const proposal={conceptId:'test-concept',nodeVersion:built.nodeVersion,understandingPercent:40,confidence:'low',demonstrated:[],gaps:[],nextCheck:'Explain the concept.',needsReview:false}
  class Paid extends LLMService{
    calls=0
    override async callLLMWithStructuredOutput():Promise<never>{this.calls++;throw new Error('fresh paid call')}
  }
  const provider={status:'failed',assessment:null,error:'Provider call or source validation failed: LLM_ERROR: codex CLI exited 1. No further retry.'}
  const rejected={status:'failed',assessment:null,error:'Provider call or source validation failed: Unknown human source: x. No further retry.'}
  type Holder={run_id:string;receipt:Record<string,unknown>|null}|null
  // [first holder, retry holder (undefined: the retry key is free), expected receipt, paid calls]
  const rows:Array<[string,Holder,Holder|undefined,Record<string,unknown>,number]>=[
    ['completed holder → reused',{run_id:'earlier',receipt:{status:'completed',assessment:proposal}},undefined,{status:'unchanged',assessment:proposal,reusedRunId:'earlier',inputTokens:null,error:null},0],
    ['validator rejection → known failure',{run_id:'earlier',receipt:rejected},undefined,{status:'failed',assessment:null,reusedRunId:'earlier',inputTokens:0,outputTokens:0},0],
    ['provider failure, retry free → one fresh paid attempt',{run_id:'earlier',receipt:provider},undefined,{status:'failed',error:expect.stringContaining('fresh paid call')},1],
    ['provider failure, retry completed → reuses the retry',{run_id:'earlier',receipt:provider},{run_id:'again',receipt:{status:'completed',assessment:proposal}},{status:'unchanged',assessment:proposal,reusedRunId:'again'},0],
    ['provider failure, retry failed too → known failure, never a third',{run_id:'earlier',receipt:provider},{run_id:'again',receipt:provider},{status:'failed',reusedRunId:'again',inputTokens:0},0],
    ['provider failure, retry has no receipt → uncertain',{run_id:'earlier',receipt:provider},{run_id:'again',receipt:null},{status:'uncertain',assessment:null},0],
    ['no receipt → uncertain',{run_id:'earlier',receipt:null},undefined,{status:'uncertain',assessment:null},0],
    ['an uncertain holder → uncertain, never a known failure',{run_id:'earlier',receipt:{status:'uncertain',assessment:null,error:null}},undefined,{status:'uncertain'},0],
    ['completed without an estimate (a typed decision) → uncertain, never "already failed"',{run_id:'earlier',receipt:{status:'completed',assessment:null,error:null}},undefined,{status:'uncertain'},0],
  ]
  for(const [name,first,retry,expected,paid] of rows){
    const llm=new Paid(new LocalVariablesService())
    const service=new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype),llm)
    const receipts:Array<Record<string,unknown>>=[], reservedKeys:string[]=[]
    const query:MetaPgQueryFn=async<R>(sql:string,params?:ReadonlyArray<unknown>)=>{
      let rows:unknown[]=[]
      const key=String(params?.[1]??params?.[0]??'')
      if(sql.startsWith('SELECT r.*'))rows=[{run_id:'r',user_id:'test',concept_id:'test-concept',input_hash:'h',reserved_at:null,receipt:null,snapshot:{...built,model:ASSESSMENT_MODEL,evidence:[{id:'human',role:'user',text:'Human evidence'}]}}]
      else if(sql.startsWith('SELECT c.run_id,t.receipt FROM learning_concept_assessment_cache'))rows=[]
      // The first key is always held; the ':retry' key is held only when the row names a retry holder.
      else if(sql.startsWith('INSERT INTO learning_concept_assessment_attempts')){reservedKeys.push(key);rows=key.endsWith(':retry')&&retry===undefined?[{run_id:'r'}]:[]}
      else if(sql.startsWith('SELECT a.run_id,t.receipt FROM learning_concept_assessment_attempts'))rows=[String(params?.[0]).endsWith(':retry')?retry:first].filter(Boolean)
      else if(sql.startsWith('INSERT INTO learning_concept_assessment_receipts'))receipts.push(JSON.parse(String(params?.[1])))
      else throw new Error(`Unexpected persistence side effect: ${sql}`)
      return {rows:rows as R[],rowCount:rows.length}
    }
    const result=await service.execute('r',query)
    expect({name,status:result.status,receipts:receipts.length,paid:llm.calls}).toEqual({name,status:expected.status as string,receipts:1,paid})
    expect(receipts[0]).toMatchObject(expected)
    // Only a provider failure ever reserves the retry key, and then exactly once.
    expect({name,retried:reservedKeys.filter(k=>k.endsWith(':retry')).length}).toEqual({name,retried:first?.receipt===provider?1:0})
    expect({name,known:String(receipts[0]!.error).startsWith(IDENTICAL_EVIDENCE_FAILED)}).toEqual({name,known:expected.status==='failed'&&paid===0})
  }
})

test('a provider failure is told from a rejection by its error, and only a failed receipt is one',()=>{
  for(const [error,provider] of [
    ['Provider call or source validation failed: LLM_ERROR: codex CLI exited 1.',true],
    ['Provider call or source validation failed; consult shared LLM telemetry.',true],
    ['Provider call or source validation failed: LLM_PARSE_ERROR: bad json',true],
    ['Typed-decision call or validation failed: Provider HTTP 503.',true],
    ['Typed-decision call or validation failed: Provider HTTP 429.',true],
    ['Provider call or source validation failed: request timed out',true],
    ['Typed-decision call or validation failed: Provider HTTP 400.',false],
    ['Provider call or source validation failed: Non-exact human quote',false],
    ['Provider call or source validation failed: Unknown concept or nodeVersion',false],
    ['',false],
  ] as const) expect({error,provider:isProviderFailure({status:'failed',error})}).toEqual({error,provider})
  expect(isProviderFailure({status:'uncertain',error:'LLM_ERROR'})).toBe(false)
  expect(isProviderFailure(null)).toBe(false)
})

test('a cache hit carries the raw estimate of the run that produced the cached result, so a chain continues from it',async()=>{
  const built=buildConceptAssessmentInput({conceptId:'test-concept',title:'Test',description:'Test cache hit',objectives:[]},[{id:'human',conversationId:'session',role:'user',text:'Human evidence',occurredAt:null}],null)
  const raw={conceptId:'test-concept',nodeVersion:built.nodeVersion,understandingPercent:55,confidence:'medium',demonstrated:[],gaps:[],nextCheck:'Explain the concept.',needsReview:false}
  class Never extends LLMService{
    override async callLLMWithStructuredOutput():Promise<never>{throw new Error('a cached outcome must not be paid for again')}
  }
  const service=new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype),new Never(new LocalVariablesService()))
  const receipts:Array<Record<string,unknown>>=[]
  const query:MetaPgQueryFn=async<R>(sql:string,params?:ReadonlyArray<unknown>)=>{
    let rows:unknown[]=[]
    if(sql.startsWith('SELECT r.*'))rows=[{run_id:'r',user_id:'test',concept_id:'test-concept',input_hash:'h',reserved_at:null,receipt:null,snapshot:{...built,model:ASSESSMENT_MODEL,evidence:[{id:'human',role:'user',text:'Human evidence'}]}}]
    else if(sql.startsWith('SELECT c.run_id,t.receipt FROM learning_concept_assessment_cache'))rows=[{run_id:'cached',receipt:{status:'completed',assessment:raw}}]
    else if(sql.startsWith('INSERT INTO learning_concept_assessment_receipts'))receipts.push(JSON.parse(String(params?.[1])))
    else throw new Error(`Unexpected persistence side effect: ${sql}`)
    return {rows:rows as R[],rowCount:rows.length}
  }
  expect(await service.execute('r',query)).toEqual({runId:'r',status:'unchanged'})
  expect(receipts).toEqual([expect.objectContaining({status:'unchanged',assessment:raw,reusedRunId:'cached'})])
})
