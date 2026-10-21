import {test} from 'node:test'
import assert from 'node:assert/strict'
import {historicalObservation,historicalScores} from './learning-concept-tag-historical-telemetry.js'
test('imported baseline is a span without fabricated usage or latency',()=>{
 const receipt={ids:['x'],valid:true,raw:'{"matches":[]}',error:null,startedAt:'2026-09-24T00:00:00Z',completedAt:'2026-09-24T00:00:00Z',returnedModel:'gemini-3.7-flash',usage:null}
 const row:any={run_id:'run',dataset_id:'dataset',manifest:{name:'real',modelSelection:{provider:'typesafe',model:'jev-1.13.0'},code:{},cases:[{id:'c',text:'hello',context:[]}],historical:{sourceRunId:'old',sourceCatalog:[{id:'x',ref:'c1',title:'X'}],sourceAudit:{promptHash:'hash'},baselineResults:[{case_id:'c',extraction:{matches:[{conceptId:'x'}]}}]}}},item={case_id:'c',arm:'baseline-import',workflow_run_id:'wf',receipt}
 const p=historicalObservation(row,item),spans=p.payload.resourceSpans[0]!.scopeSpans[0]!.spans
 assert.equal(spans.length,1)
 assert.ok(!JSON.stringify(p.payload).includes('usage_details'))
 assert.deepEqual(historicalScores(row,item),{valid_result:1})
 assert.equal(p.output.classification.matches.length,0)
 const live={...item,arm:'jev-live',receipt:{...receipt,latencyMs:10,queueWaitMs:2,endToEndMs:12,request:{model:'jev-1.13.0'},usage:{input_tokens:3,output_tokens:4}}}
 assert.equal(historicalObservation(row,live).payload.resourceSpans[0]!.scopeSpans[0]!.spans.length,2)
 assert.equal(historicalScores(row,live).set_f1_agreement,1)
 const chunked={...live,receipt:{...live.receipt,chunkJournal:true,complete:true,chunks:[0,1,2].map(index=>({index,receipt:{...live.receipt,request:{chunk:index},raw:`raw-${index}`}}))}}
 const spans2=historicalObservation(row,chunked).payload.resourceSpans[0]!.scopeSpans[0]!.spans
 assert.equal(spans2.length,4,'one root plus one generation per real chunk, never aggregate generation')
 assert.equal(new Set(spans2.map((s:any)=>s.spanId)).size,4)
 for(const [index,s]of spans2.slice(1).entries()){
 assert.equal(s.parentSpanId,spans2[0].spanId)
 assert.deepEqual(JSON.parse(s.attributes.find((a:any)=>a.key==='langfuse.observation.input').value.stringValue),{chunk:index})
 assert.equal(JSON.parse(s.attributes.find((a:any)=>a.key==='langfuse.observation.output').value.stringValue).raw,`raw-${index}`)
 }
 assert.throws(()=>historicalObservation(row,{...chunked,receipt:{...chunked.receipt,complete:false}}),/incomplete/)
})
