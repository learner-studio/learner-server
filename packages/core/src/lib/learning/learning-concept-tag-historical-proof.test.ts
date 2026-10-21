import {test} from 'node:test'
import assert from 'node:assert/strict'
import {verifyHistorical,historicalObservation,historicalScores} from './learning-concept-tag-historical-telemetry.js'
import {tagHash} from './learning-concept-tag-experiment.js'
const build=()=>{
 const receipt={ids:['x'],valid:true,raw:'{"matches":[]}',request:{question:'x'},error:null,startedAt:'2026-09-24T00:00:00Z',completedAt:'2026-09-24T00:00:01Z',latencyMs:1000,queueWaitMs:1,endToEndMs:1001,usage:null,returnedModel:'jev-1.13.0'}
 const row:any={run_id:'run',created_at:new Date('2026-09-24'),dataset_id:'dataset',score_configs:{},manifest:{name:'test',arms:['baseline-import','jev-live'],modelSelection:{provider:'typesafe',model:'jev-1.13.0'},code:{},cases:[{id:'c',text:'hello',context:[]}],historical:{sourceRunId:'old',sourceCatalog:[{id:'x',title:'X',ref:'c1'}],sourceAudit:{promptHash:'h'},baselineResults:[{case_id:'c',extraction:{matches:[{conceptId:'x'}]}}]}}}
 row.items=row.manifest.arms.map((arm:string)=>({case_id:'c',arm,receipt,export_state:'verified',reserved_at:arm==='jev-live'?new Date():null}))
 const projections=row.items.map((i:any)=>({item:i,p:historicalObservation(row,i)}))
 for(const {item} of projections)for(const k of Object.keys(historicalScores(row,item)))row.score_configs[k]=`config-${k}`
 const request=async(path:string)=>{
  const u=new URL(path,'http://local'),trace=u.searchParams.get('traceId'),experiment=u.searchParams.get('experimentId')
  const {p,item}=projections.find((x:any)=>trace?x.p.ids.traceId===trace:experiment?x.p.ids.experimentId===experiment:true)!
  if(u.pathname.includes('/dataset-items/'))return {input:p.input,expectedOutput:null}
  if(u.pathname.endsWith('experiment-items'))return {data:[{experimentItemId:p.ids.datasetItemId,traceId:p.ids.traceId,input:p.input,output:p.output}],meta:{}}
  if(u.pathname.endsWith('observations'))return {data:[{id:p.ids.spanId,type:'SPAN',input:p.input,output:p.output},...p.generations.map((g:any)=>({id:g.id,type:'GENERATION',parentObservationId:p.ids.spanId,input:g.receipt.request,output:{raw:g.receipt.raw,error:g.receipt.error}}))],meta:{}}
  return {data:Object.entries(historicalScores(row,item)).map(([k,value])=>({id:tagHash([row.run_id,item.case_id,item.arm,k]).slice(0,32),name:`tag_agree_v1.${k}`,configId:row.score_configs[k],subject:{kind:'observation',id:p.ids.spanId,traceId:p.ids.traceId},dataType:['valid_result','exact_set_agreement'].includes(k)?'BOOLEAN':'NUMERIC',value})),meta:{}}
 }
 return {row,request}
}
test('optimized verifier still proves exact full content and counts without changing historical rows',async()=>{
 const {row,request}=build();const before=tagHash(row)
 const result=await verifyHistorical(row,{readOnly:true,request,query:async()=>{throw Error('must not mutate')}})
 assert.deepEqual([result.counts.nativeItems,result.counts.observations,result.counts.scores],[2,3,10]);assert.equal(tagHash(row),before)
})
for(const corruption of ['score-duplicate','score-value','dataset','root','generation','native-duplicate'])test(`optimized verifier rejects ${corruption}`,async()=>{
 const {row,request}=build()
 await assert.rejects(verifyHistorical(row,{readOnly:true,request:async(path:string)=>{
  const r:any=structuredClone(await request(path))
  if(corruption==='score-duplicate'&&path.includes('/v3/scores'))r.data.push(r.data[0])
  if(corruption==='score-value'&&path.includes('/v3/scores'))r.data[0].value=99
  if(corruption==='dataset'&&path.includes('/dataset-items/'))r.input={wrong:true}
  if(corruption==='root'&&path.includes('/observations'))r.data[0].output={wrong:true}
  if(corruption==='generation'&&path.includes('/observations')&&r.data.length>1)r.data[1].parentObservationId='wrong'
  if(corruption==='native-duplicate'&&path.includes('/experiment-items'))r.data.push(r.data[0])
  return r
 }}),/mismatch/)
})
