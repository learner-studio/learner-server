import {test} from 'node:test'
import assert from 'node:assert/strict'
import {historicalObservation} from './learning-concept-tag-historical-telemetry.js'
import {tagObservation} from './learning-concept-tag-telemetry.js'
const receipt={ids:[],valid:true,raw:'{}',request:{model:'jev-1.13.0'},returnedModel:'jev-1.13.0',usage:{input_tokens:1000000,output_tokens:884200},startedAt:'2026-09-24T00:00:00Z',completedAt:'2026-09-24T00:00:01Z',providerMode:'live',error:null}
const row:any={run_id:'run',dataset_id:'ds',manifest:{name:'cost-test',providerMode:'live',cases:[{id:'c',text:'test',context:[]}],concepts:[],code:{},modelSelection:{provider:'typesafe',model:'jev-1.13.0'},historical:{sourceRunId:'old',sourceAudit:{promptHash:'p'},sourceCatalog:[]}}}
const spans=(p:any)=>p.payload.resourceSpans[0].scopeSpans[0].spans
const attribute=(s:any,key:string)=>{const v=s.attributes.find((a:any)=>a.key===key)?.value;return v?.stringValue?JSON.parse(v.stringValue):v?.doubleValue}
test('real generations send usage and the model once per chunk, and no cost: Langfuse prices them',()=>{
 const s=spans(historicalObservation(row,{case_id:'c',arm:'jev-live',receipt:{...receipt,chunkJournal:true,complete:true,chunks:[{index:0,receipt},{index:1,receipt:{...receipt,usage:{input_tokens:2e6,output_tokens:123}}}]}}))
 assert.deepEqual(attribute(s[1],'langfuse.observation.usage_details'),{input:1000000,output:884200})
 assert.deepEqual(attribute(s[2],'langfuse.observation.usage_details'),{input:2e6,output:123})
 assert.equal(s[1].attributes.find((a:any)=>a.key==='langfuse.observation.model.name')?.value.stringValue,'jev-1.13.0')
 for(const span of s)assert.equal(attribute(span,'langfuse.observation.cost_details'),undefined)
})
test('synthetic-source calls send no cost, live or mock',()=>{
 assert.equal(attribute(spans(tagObservation(row,'c','jev-live',receipt))[1],'langfuse.observation.cost_details'),undefined)
 assert.equal(attribute(spans(tagObservation({...row,manifest:{...row.manifest,providerMode:'mock'}},'c','jev-mock',receipt))[1],'langfuse.observation.cost_details'),undefined)
})
