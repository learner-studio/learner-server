import {learningExperimentApi as api} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import {promptAbNativeJson} from './learning-prompt-ab-langfuse.js'
import {tagHash,tagCanonical,scoreTags,summarizeTags,type TagArm} from './learning-concept-tag-experiment.js'
import {tagRun,type TagReceipt} from '../../services/learning-concept-tag-store.js'
import {metaDbQuery as q} from '../db-metadata/_shared.js'
export const tagIds=(run:string,item:string,arm:string)=>({datasetItemId:tagHash([run,item,'dataset']).slice(0,32),experimentId:tagHash([run,arm,'experiment']).slice(0,16),traceId:tagHash([run,item,arm,'trace']).slice(0,32),spanId:tagHash([run,item,arm,'root']).slice(0,16),generationId:tagHash([run,item,arm,'generation']).slice(0,16)})
const attr=(key:string,value:unknown)=>({key,value:typeof value==='boolean'?{boolValue:value}:typeof value==='number'?{doubleValue:value}:{stringValue:typeof value==='string'?value:JSON.stringify(value)}})
export const tagInput=(manifest:any,item:any)=>({concepts:manifest.concepts,text:item.text,context:item.context})
export function tagObservation(row:any,caseId:string,arm:string,r:any){
 const c=row.manifest.cases.find((x:any)=>x.id===caseId),ids=tagIds(row.run_id,caseId,arm),input=tagInput(row.manifest,c),output={ids:r.ids,valid:r.valid,error:r.error}
 const metadata={runId:row.run_id,caseId,arm,providerMode:row.manifest.providerMode,synthetic:true,usage:r.usage,requestedModel:r.request?.model??null,returnedModel:r.returnedModel,modelSelection:row.manifest.modelSelection??null,labelProvenance:'synthetic fixture, not human-reviewed real-message gold',code:row.manifest.code,receiptHash:tagHash(r)}
 const attributes=[attr('langfuse.observation.type','span'),attr('langfuse.trace.name',`${row.manifest.name}/${arm}/${caseId}`),attr('langfuse.trace.tags',['synthetic-source',row.manifest.providerMode,'concept-tags-v1']),attr('langfuse.environment','learning-dev'),attr('langfuse.observation.input',input),attr('langfuse.observation.output',output),attr('langfuse.observation.metadata',metadata),attr('langfuse.experiment.id',ids.experimentId),attr('langfuse.experiment.name',`${row.manifest.name}/${arm}`),attr('langfuse.experiment.description',row.manifest.providerMode==='live'?'LIVE Jev on SYNTHETIC messages. E2E only; no benchmark conclusions.':'SYNTHETIC MOCK plumbing and scoring verification. No real Jev performance conclusions.'),attr('langfuse.experiment.dataset.id',row.dataset_id),attr('langfuse.experiment.metadata',metadata),attr('langfuse.experiment.item.id',ids.datasetItemId),attr('langfuse.experiment.item.root_observation_id',ids.spanId),attr('langfuse.experiment.item.metadata',metadata)]
 const base={traceId:ids.traceId,kind:1,startTimeUnixNano:String(BigInt(Date.parse(r.startedAt))*1000000n),endTimeUnixNano:String(BigInt(Date.parse(r.completedAt))*1000000n),status:{code:r.valid?1:2}}
 return {ids,input,output,payload:{resourceSpans:[{resource:{attributes:[attr('service.name','biztools-synthetic-concept-tags')]},scopeSpans:[{scope:{name:'concept-tags-v1',version:'1'},spans:[{...base,spanId:ids.spanId,name:`synthetic ${arm} ${caseId}`,attributes},{...base,spanId:ids.generationId,parentSpanId:ids.spanId,name:row.manifest.providerMode==='live'?'TypeSafe Jev official HTTP call':'SIMULATED provider boundary — not real inference',attributes:[attr('langfuse.observation.type','generation'),attr('langfuse.observation.input',r.request),attr('langfuse.observation.output',{raw:r.raw,error:r.error}),attr('langfuse.observation.model.name',r.returnedModel??'provider-failure'),...(r.usage&&row.manifest.providerMode==='live'?[attr('langfuse.observation.usage_details',{input:r.usage.input_tokens,output:r.usage.output_tokens})]:[]),attr('langfuse.observation.metadata',metadata),attr('langfuse.environment','learning-dev')]}]}]}]}}
}
const definitions=[['message_f1','NUMERIC',1],['exact_match','BOOLEAN',1],['valid_result','BOOLEAN',1],['no_match_spurious','BOOLEAN',1],['tp','NUMERIC',undefined],['fp','NUMERIC',undefined],['fn','NUMERIC',undefined],['service_latency_ms','NUMERIC',undefined],['queue_wait_ms','NUMERIC',undefined],['end_to_end_ms','NUMERIC',undefined]] as const
export async function setupTagLangfuse(runId:string){
 const row=await tagRun(runId),m=row.manifest
 if(m.historical)return (await import('./learning-concept-tag-historical-telemetry.js')).setupHistorical(row)
 let dataset
 try{dataset=await api(`/api/public/v2/datasets/${encodeURIComponent(m.name)}`)}catch(e){if(!(e instanceof Error)||!e.message.endsWith('(404)'))throw e;dataset=await api('/api/public/v2/datasets','POST',{name:m.name,description:m.providerMode==='live'?'Real pinned Jev on synthetic messages. E2E only, no comparison.':'Synthetic messages and mock endpoint responses. No real provider benchmark.',metadata:{providerMode:m.providerMode,synthetic:true,manifestHash:tagHash(m)}})}
 if(dataset.metadata?.manifestHash!==tagHash(m))throw new Error('Dataset manifest mismatch')
 await q('UPDATE learning_concept_tag_experiments SET dataset_id=$2 WHERE run_id=$1',[runId,dataset.id])
 const configs:Record<string,string>={}
 for(const [key,dataType,maxValue]of definitions){
 const name=`concept_tags_v1.${key}`
 let page=1,found:any
 do{const response=await api(`/api/public/score-configs?limit=100&page=${page}`);found=response.data.find((c:any)=>c.name===name&&!c.isArchived);if(found||page>=response.meta.totalPages)break;page++}while(page<100)
 if(!found)found=await api('/api/public/score-configs','POST',{name,dataType,...(dataType==='NUMERIC'?{minValue:0,...(maxValue===undefined?{}:{maxValue})}:{}),description:'Synthetic mock experiment deterministic scoring; not real-model accuracy.'})
 const exact=await api(`/api/public/score-configs/${found.id}`)
 if(exact.name!==name||exact.dataType!==dataType)throw new Error('Score config mismatch')
 configs[key]=found.id
 }
 await q('UPDATE learning_concept_tag_experiments SET score_configs=$2::jsonb WHERE run_id=$1',[runId,JSON.stringify(configs)])
 for(const c of m.cases){const id=tagIds(runId,c.id,m.arms[0]!).datasetItemId,input=tagInput(m,c),expectedOutput={ids:[...c.gold].sort()};await api('/api/public/dataset-items','POST',{id,datasetName:m.name,input,expectedOutput,metadata:{synthetic:true,providerMode:m.providerMode,goldRevision:'synthetic-v1',caseId:c.id,manifestHash:tagHash(m)}});const got=await api(`/api/public/dataset-items/${id}`);if(tagCanonical(got.input)!==tagCanonical(input)||tagCanonical(got.expectedOutput)!==tagCanonical(expectedOutput))throw new Error('Dataset readback differs')}
 return {datasetId:dataset.id,scoreConfigs:configs}
}
export async function exportTagItem(runId:string,caseId:string,arm:TagArm){
 const row=await tagRun(runId,caseId,arm),item=row.items.find(i=>i.case_id===caseId&&i.arm===arm)
 if(!item?.receipt||!row.dataset_id)throw new Error('Receipt and dataset required before telemetry')
 if(row.manifest.historical)return (await import('./learning-concept-tag-historical-telemetry.js')).exportHistorical(row,caseId,arm)
 const p=tagObservation(row,caseId,arm,item.receipt),outboxIds:string[]=[]
 if(!['pending','queued','sent'].includes(item.export_state))return {traceId:p.ids.traceId,state:item.export_state,outboxIds}
 if(item.export_state!=='sent')outboxIds.push((await api('/api/public/otel/v1/traces','POST',p.payload)).id)
 const c=row.manifest.cases.find(c=>c.id===caseId)!,r=item.receipt as TagReceipt
 const scores={...scoreTags(c.gold,r.ids,r.valid),service_latency_ms:r.latencyMs,queue_wait_ms:r.queueWaitMs,end_to_end_ms:r.endToEndMs}
 for(const [key,value]of Object.entries(scores))outboxIds.push((await api('/api/public/scores','POST',{id:tagHash([runId,caseId,arm,key]).slice(0,32),traceId:p.ids.traceId,observationId:p.ids.spanId,name:`concept_tags_v1.${key}`,value,dataType:definitions.find(d=>d[0]===key)![1],configId:row.score_configs[key],environment:'learning-dev',comment:row.manifest.providerMode==='live'?'Synthetic source, real Jev HTTP service latency. Not a benchmark.':'Synthetic fixture result. Measured mock-boundary latency, not model latency.'})).id)
 await q("UPDATE learning_concept_tag_items SET export_state='queued' WHERE run_id=$1 AND case_id=$2 AND arm=$3 AND export_state IN ('pending','queued')",[runId,caseId,arm])
 return {traceId:p.ids.traceId,state:'queued',outboxIds}
}
