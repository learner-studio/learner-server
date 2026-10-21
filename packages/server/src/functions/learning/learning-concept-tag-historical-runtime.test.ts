import {test} from 'node:test'
import assert from 'node:assert/strict'
import {HistoricalTagStart,startLearningHistoricalTagExperiment} from './learning-concept-tag-historical.function.js'
import {prepareHistorical,selectHistoricalCases} from '@learner/core/lib/learning/learning-concept-tag-historical-runtime.js'
import {saveTagManifest} from '@learner/core/services/learning-concept-tag-store.js'
import {metaDbQuery as q} from '@learner/core/lib/db-metadata/_shared.js'
test('explicit subset/full compact request survives schema and freezes replay identity',async()=>{
 const input={runId:crypto.randomUUID(),selection,prepareOnly:true,paidApproved:true,maxPaidCalls:10,questionBatchSize:470,concurrency:5,caseIds:['one','two']}
 assert.equal(HistoricalTagStart.parse(input).concurrency,5)
 assert.deepEqual(HistoricalTagStart.parse(input).caseIds,['one','two'])
 for(const bad of [{concurrency:6},{caseIds:[]},{caseIds:['one','one']}])assert.equal(HistoricalTagStart.safeParse({...input,...bad}).success,false)
 const manifest:any={name:input.runId,providerMode:'live',synthetic:false,curriculumId:'fixture',concepts:[],cases:[],arms:[],threshold:.5,code:{},modelSelection:selection,historical:{selectionCaseIds:['one','two'],budget:historicalBudget()}}
 function historicalBudget(){return {maxPaidCalls:10,questionBatchSize:470,concurrency:5}}
 try{
 await saveTagManifest(input.runId,'unit-test',manifest)
 await prepareHistorical(input.runId,'unit-test',selection,10,470,5,['one','two'])
 await assert.rejects(prepareHistorical(input.runId,'unit-test',selection,10,470,1,['one','two']),/identity conflict/)
 await assert.rejects(prepareHistorical(input.runId,'unit-test',selection,10,470,5,['two','one']),/identity conflict/)
 await assert.rejects(prepareHistorical(input.runId,'unit-test',selection,10,470,5),/identity conflict/)
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[input.runId])}
})
test('start rejects changed frozen config before scheduling any workflow',async()=>{
 const runId=crypto.randomUUID(),manifest:any={name:runId,providerMode:'live',synthetic:false,curriculumId:'fixture',concepts:[],cases:[],arms:[],threshold:.5,code:{},modelSelection:selection,historical:{budget:{maxPaidCalls:100,questionBatchSize:100,concurrency:1}}}
 let starts=0
 try{
 await saveTagManifest(runId,'unit-test',manifest)
 await assert.rejects(startLearningHistoricalTagExperiment.func({typesafeDecision:{assertConfigured(){}},locks:{withLock:async(_a:any,_b:any,fn:any)=>fn()},workflowService:{startWorkflow:async()=>{starts++;return {runId:'unexpected'}}}} as any,{runId,prepareOnly:false,paidApproved:true,selection,maxPaidCalls:100,questionBatchSize:100,concurrency:5},{session:{userId:'unit-test'},rpc:{}} as any),/identity conflict/)
 assert.equal(starts,0)
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[runId])}
})
test('explicit case IDs preserve source identities/order; never infer pairs from arbitrary turns',()=>{
 const source=[{case_id:'human-a',input_snapshot:{current:{role:'user',text:'A'},context:[]}},{case_id:'human-b',input_snapshot:{current:{role:'user',text:'B'},context:[]}}]
 assert.equal(selectHistoricalCases(source),source)
 assert.deepEqual(selectHistoricalCases(source,['human-b','human-a']),[source[1],source[0]])
 for(const ids of [[],['human-a','human-a'],['assistant-not-a-case']])assert.throws(()=>selectHistoricalCases(source,ids),/case selection|Unknown historical case/)
})
const selection={provider:'typesafe' as const,model:'jev-1.13.0'}
test('historical RPC accepts explicit 500-call cap and bounded configurable question batch',()=>{
 const input={runId:crypto.randomUUID(),selection,prepareOnly:true,paidApproved:true,maxPaidCalls:500,questionBatchSize:100}
 assert.equal(HistoricalTagStart.parse(input).questionBatchSize,100)
 for(const size of [0,471,1.1])assert.equal(HistoricalTagStart.safeParse({...input,questionBatchSize:size}).success,false)
})
test('prepare replay preserves legacy frozen manifest and rejects changed new batch budget',async()=>{
 const runId=crypto.randomUUID(),manifest:any={name:runId,providerMode:'live',synthetic:false,curriculumId:'fixture',concepts:[],cases:[],arms:[],threshold:.5,code:{},modelSelection:selection,historical:{budget:{maxPaidCalls:100,questionsPerCall:470,maxAttempts:1,concurrency:1}}}
 try{await saveTagManifest(runId,'unit-test',manifest);await prepareHistorical(runId,'unit-test',selection,100);await assert.rejects(prepareHistorical(runId,'unit-test',selection,500,100),/identity conflict/)}finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[runId])}
})
