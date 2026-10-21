import {test,expect} from 'bun:test'
import {LocalVariablesService} from '../runtime/types.js'
import {LearningConceptAssessmentService} from './learning-concept-assessment.js'
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
      else if(sql.startsWith('SELECT 1 FROM learning_concept_assessment_cache'))rows=[]
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
