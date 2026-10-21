import {test,expect} from 'bun:test'
import {enqueueLearningPromptAbAuditStep} from './learning-prompt-ab-audit.function.js'
import {buildConceptAssessmentInput,ASSESSMENT_MODEL} from '@learner/core/lib/learning/learning-concept-assessment.js'
import {withCliTelemetry,getCurrentCliObserver} from '@learner/llm/lib/cli/cli-telemetry.js'
import {LearningConceptAssessmentService} from '@learner/core/services/learning-concept-assessment.js'
import {learningPromptAbItemWorkflow,learningPromptAbWorkflow} from '../../wirings/learning-prompt-ab.workflow.js'
test('item releases its slot after durable audit admission without projecting export',async()=>{
 const calls:string[]=[]
 const data={runId:'r',assessmentRunId:'a',jobKey:'r:a'}
 const result=await learningPromptAbItemWorkflow.func({} as any,data as any,{workflow:{do:async(_name:string,rpc:string)=>{calls.push(rpc);return {auditJobId:'audit',state:'queued'}}}} as any)
 expect(calls).toEqual(['executeLearningConceptAssessmentStep','enqueueLearningPromptAbAuditStep'])
 expect(result).toEqual({auditJobId:'audit',state:'queued'})
})
test('audit admission fails closed then recovers the same identity without provider replay',async()=>{
 const added:any[]=[];let failure=true;let stored:Array<{id:string}>=[]
 const data={runId:'r',assessmentRunId:'a',jobKey:'caller-one'}
 const deps={locks:{withLock:async(_scope:string,_key:string,fn:()=>unknown)=>fn()},queueCancellationService:{findByKey:async()=>stored},queueService:{add:async(queue:string,job:unknown,opts:unknown)=>{if(failure)throw new Error('queue unavailable');added.push({queue,job,opts});stored=[{id:'durable'}];return 'durable'}}}
 await expect(enqueueLearningPromptAbAuditStep.func(deps as any,data,{} as any)).rejects.toThrow('queue unavailable')
 failure=false
 expect(await enqueueLearningPromptAbAuditStep.func(deps as any,data,{} as any)).toEqual({auditJobId:'durable',state:'queued'})
 expect(await enqueueLearningPromptAbAuditStep.func(deps as any,{...data,jobKey:'caller-two'},{} as any)).toEqual({auditJobId:'durable',state:'queued'})
 expect(added).toHaveLength(1)
 expect(added[0].opts).toEqual({jobId:'audit:r:a',attempts:3,backoff:{type:'fixed',delay:1000}})
 stored.push({id:'duplicate'})
 await expect(enqueueLearningPromptAbAuditStep.func(deps as any,data,{} as any)).rejects.toThrow('Duplicate')
})
test('assessment recovery reads a receipt or uncertainty fence before any provider invocation',async()=>{
 let calls=0
 const service=new LearningConceptAssessmentService({} as any,{callLLMWithStructuredOutput:async()=>{calls++;throw new Error('paid forbidden')}} as any)
 const receipt={status:'completed',raw:'existing exact result'}
 const query=async()=>({rows:[{receipt,reserved_at:new Date()}],rowCount:1})
 expect(await service.execute('a',query as any)).toEqual({runId:'a',status:'completed'})
 expect(await service.execute('a',(async()=>({rows:[{receipt:null,reserved_at:new Date()}],rowCount:1})) as any)).toEqual({runId:'a',status:'uncertain'})
 expect(calls).toBe(0)
})
test('whole item replay after audit admission failure reuses the successful assessment receipt',async()=>{
 const built=buildConceptAssessmentInput({conceptId:'test',title:'Test',description:'Test',objectives:[]},[{id:'human',conversationId:'c',role:'user',text:'Human evidence',occurredAt:null}],null)
 const proposal={conceptId:'test',nodeVersion:built.nodeVersion,understandingPercent:null,confidence:'insufficient',demonstrated:[],gaps:[],nextCheck:'Explain.',needsReview:true}
 let calls=0;let receipt:any=null;let reserved=false;let fail=true
 const service=new LearningConceptAssessmentService({} as any,{callLLMWithStructuredOutput:async()=>{calls++;return [proposal]}} as any)
 const query=async(sql:string,params?:readonly unknown[])=>{
  if(sql.startsWith('SELECT r.*'))return {rows:[{user_id:'test',concept_id:'test',input_hash:'hash',receipt,reserved_at:reserved?new Date():null,snapshot:{...built,model:ASSESSMENT_MODEL,evidence:[{role:'user',text:'Human evidence'}]}}],rowCount:1}
  if(sql.startsWith('SELECT 1 FROM learning_concept_assessment_cache'))return {rows:[],rowCount:0}
  if(sql.startsWith('INSERT INTO learning_concept_assessment_attempts')){reserved=true;return {rows:[{}],rowCount:1}}
  if(sql.startsWith('INSERT INTO learning_concept_assessment_receipts')){receipt=JSON.parse(String(params?.[1]));return {rows:[],rowCount:1}}
  throw new Error('Unexpected persistence')
 }
 const wire={workflow:{do:async(_name:string,rpc:string)=>{
  if(rpc==='executeLearningConceptAssessmentStep')return service.execute('a',query as any)
  if(rpc==='enqueueLearningPromptAbAuditStep'){if(fail)throw new Error('admission failed');return {auditJobId:'same',state:'queued'}}
  throw new Error('Export must not hold this slot')
 }}}
 const data={runId:'r',assessmentRunId:'a',jobKey:'r:a'}
 await expect(learningPromptAbItemWorkflow.func({} as any,data,wire as any)).rejects.toThrow('admission failed')
 const saved=JSON.stringify(receipt)
 fail=false
 await learningPromptAbItemWorkflow.func({} as any,data,wire as any)
 expect(calls).toBe(1)
 expect(JSON.stringify(receipt)).toBe(saved)
 expect(receipt.masteryWrites).toBe(0)
})
test('characterization: shared CLI scope still rejects successful work on admission failure; do not silently drop persistence',async()=>{
 let modelCalls=0
 await expect(withCliTelemetry({},async()=>{
  modelCalls++
  getCurrentCliObserver()!({kind:'exit',callId:'c',elapsedMs:1,exitCode:0,signal:null,stdoutBytes:1,stderrBytes:0,timedOut:false})
  return 'successful-result'
 },async()=>{throw new Error('admission down')})).rejects.toThrow('admission down')
 expect(modelCalls).toBe(1)
})
test('parent awaits separate audit jobs before strict native finalization',async()=>{
 const calls:string[]=[]
 await learningPromptAbWorkflow.func({} as any,{runId:'r'},{workflow:{do:async(_name:string,rpc:string)=>{calls.push(rpc);return {jobIds:['item']}}}} as any)
 expect(calls).toEqual(['setupLearningPromptAbStep','enqueueLearningPromptAbStep','waitLearningPromptAbJobStep','waitLearningPromptAbAuditsStep','finalizeLearningPromptAbStep'])
})
