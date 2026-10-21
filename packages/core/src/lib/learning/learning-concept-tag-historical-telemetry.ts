import {readHistoricalNative} from './learning-concept-tag-historical-readback.js'
import {createHash} from 'node:crypto'
import {learningExperimentApi as api,flushLangfuseWrites} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import {promptAbNativeJson as decode} from './learning-prompt-ab-langfuse.js'
import {tagHash,tagCanonical} from './learning-concept-tag-experiment.js'
import {tagIds} from './learning-concept-tag-telemetry.js'
import {agreementScores} from './learning-concept-tag-historical.js'
import {metaDbQuery as q} from '../db-metadata/_shared.js'
import type {TagStoredRun} from '../../services/learning-concept-tag-store.js'
const PREFIX='tag_agree_v1.'
const defs:Record<string,'NUMERIC'|'BOOLEAN'>={set_f1_agreement:'NUMERIC',exact_set_agreement:'BOOLEAN',valid_result:'BOOLEAN',shared_tags:'NUMERIC',jev_only_tags:'NUMERIC',baseline_only_tags:'NUMERIC',service_latency_ms:'NUMERIC',queue_wait_ms:'NUMERIC',end_to_end_ms:'NUMERIC'}
const attr=(key:string,value:any)=>({key,value:typeof value==='boolean'?{boolValue:value}:typeof value==='number'?{doubleValue:value}:{stringValue:typeof value==='string'?value:JSON.stringify(value)}})
const sourceHex=(bytes:number,...parts:string[])=>createHash('sha256').update(parts.join('\0')).digest('hex').slice(0,bytes*2)
export function historicalScores(row:any,item:any):Record<string,number>{
 const r=item.receipt
 if(item.arm==='baseline-import')return {valid_result:Number(r.valid)}
 const b=row.manifest.historical.baselineResults.find((b:any)=>b.case_id===item.case_id)
 return {...agreementScores(b.extraction.matches.map((m:any)=>m.conceptId),r.ids,r.valid),service_latency_ms:r.latencyMs,queue_wait_ms:r.queueWaitMs,end_to_end_ms:r.endToEndMs}
}
export function historicalObservation(row:any,item:any){
 const m=row.manifest,h=m.historical,r=item.receipt,c=m.cases.find((c:any)=>c.id===item.case_id),live=item.arm==='jev-live',ids=tagIds(row.run_id,item.case_id,item.arm)
 if(r.chunkJournal&&!r.complete)throw new Error('Historical chunk journal incomplete')
 const input={concepts:h.sourceCatalog,text:c.text,context:c.context},output={ids:r.ids,valid:r.valid,error:r.error,...(!live?{classification:JSON.parse(r.raw)}:{})}
 const metadata={runId:row.run_id,caseId:item.case_id,arm:item.arm,synthetic:false,providerMode:live?'live':'imported',sourceRunId:h.sourceRunId,sourcePromptHash:h.sourceAudit.promptHash,sourceTraceId:sourceHex(16,'trace',h.sourceRunId,item.case_id),sourceBatchTraceId:sourceHex(16,'batch-cost-trace-v3',h.sourceRunId),labelProvenance:'No gold. Existing baseline is a prediction.',latencyComparable:false,timingMeaning:live?(r.chunkJournal?'Sum of sequential chunk HTTP+validation latencies; not pure inference':'Actual HTTP+validation service latency'):'Import projection only; not model latency',requestedModel:live?m.modelSelection.model:null,returnedModel:r.returnedModel,modelSelection:live?m.modelSelection:null,receiptHash:tagHash(r),sourceCodeHash:m.code.sourceHash,workflowRunId:item.workflow_run_id}
 const base={traceId:ids.traceId,kind:1,startTimeUnixNano:String(BigInt(Date.parse(r.startedAt))*1000000n),endTimeUnixNano:String(BigInt(Date.parse(r.completedAt))*1000000n),status:{code:r.valid?1:2}}
 const attributes=[attr('langfuse.observation.type','span'),attr('langfuse.trace.name',`${live?'Jev live':'Existing Flash imported'} ${item.case_id}`),attr('langfuse.trace.tags',['real-source','historical-470','agreement-not-accuracy']),attr('langfuse.environment','learning-dev'),attr('langfuse.observation.input',input),attr('langfuse.observation.output',output),attr('langfuse.observation.metadata',metadata),attr('langfuse.experiment.id',ids.experimentId),attr('langfuse.experiment.name',`${m.name}/${live?'Jev 1.13.0':'Existing Flash 3.7 High imported'}`),attr('langfuse.experiment.description',`${m.cases.length} real frozen Seed V1 human messages, identical historical ${h.sourceCatalog.length}-title catalog. Agreement only, no gold; historical baseline batched with evidence/reasons, latency NOT equivalent.`),attr('langfuse.experiment.dataset.id',row.dataset_id),attr('langfuse.experiment.metadata',metadata),attr('langfuse.experiment.item.id',ids.datasetItemId),attr('langfuse.experiment.item.root_observation_id',ids.spanId),attr('langfuse.experiment.item.metadata',metadata)]
 const spans:any[]=[{...base,spanId:ids.spanId,name:live?'Real Jev case':'Imported historical prediction (not a call)',attributes}]
 const generations=live?(r.chunkJournal?r.chunks.map((chunk:any)=>({id:sourceHex(8,'historical-chunk',row.run_id,item.case_id,String(chunk.index)),receipt:chunk.receipt,index:chunk.index})):[{id:ids.generationId,receipt:r,index:null}]):[]
 for(const g of generations){const call=g.receipt;spans.push({...base,startTimeUnixNano:String(BigInt(Date.parse(call.startedAt))*1000000n),endTimeUnixNano:String(BigInt(Date.parse(call.completedAt))*1000000n),status:{code:call.valid?1:2},spanId:g.id,parentSpanId:ids.spanId,name:'TypeSafe Jev official HTTP call',attributes:[attr('langfuse.observation.type','generation'),attr('langfuse.observation.input',call.request),attr('langfuse.observation.output',{raw:call.raw,error:call.error}),attr('langfuse.observation.model.name',call.returnedModel??'provider-failure'),...(call.usage?[attr('langfuse.observation.usage_details',{input:call.usage.input_tokens,output:call.usage.output_tokens})]:[]),attr('langfuse.observation.metadata',{...metadata,chunkIndex:g.index,receiptHash:tagHash(call)}),attr('langfuse.environment','learning-dev')]})}
 return {ids,input,output,metadata,generations,payload:{resourceSpans:[{resource:{attributes:[attr('service.name','biztools-real-concept-tag-comparison')]},scopeSpans:[{scope:{name:'historical-tag-agreement-v1',version:'1'},spans}]}]}}
}
export async function setupHistorical(row:TagStoredRun){
 const m=row.manifest;let dataset:any
 try{dataset=await api(`/api/public/v2/datasets/${encodeURIComponent(m.name)}`)}catch(e){if(!(e instanceof Error)||!e.message.endsWith('(404)'))throw e;dataset=await api('/api/public/v2/datasets','POST',{name:m.name,description:`${m.cases.length} real Seed V1 human messages. Frozen historical ${m.historical.sourceCatalog.length}-title catalog. Existing Flash predictions reused; no gold labels. Agreement only, latency not equivalent.`,metadata:{synthetic:false,manifestHash:tagHash(m),sourceRunId:m.historical.sourceRunId,sourceDatasetId:m.historical.sourceDatasetId,goldStatus:'absent',latencyComparable:false}})}
 dataset=await api(`/api/public/v2/datasets/${encodeURIComponent(m.name)}`);if(dataset.metadata.manifestHash!==tagHash(m))throw new Error('Historical dataset identity mismatch')
 const configs:Record<string,string>={};const all:any[]=[]
 for(let page=1;;page++){const r=await api(`/api/public/score-configs?limit=100&page=${page}`);all.push(...r.data);if(page>=r.meta.totalPages)break}
 for(const [key,dataType]of Object.entries(defs)){const name=PREFIX+key;let config=all.find(c=>c.name===name&&!c.isArchived);if(!config)config=await api('/api/public/score-configs','POST',{name,dataType,...(dataType==='NUMERIC'?{minValue:0,...(key==='set_f1_agreement'?{maxValue:1}:{})}:{}),description:'Deterministic tag-set agreement with existing model prediction, NOT semantic accuracy. Timing only for actual Jev calls.'});const got=await api(`/api/public/score-configs/${config.id}`);if(got.name!==name||got.dataType!==dataType)throw new Error('Historical score config mismatch');configs[key]=got.id}
 for(const c of m.cases){const id=tagIds(row.run_id,c.id,'jev-live').datasetItemId,input={concepts:m.historical.sourceCatalog,text:c.text,context:c.context};await api('/api/public/dataset-items','POST',{id,datasetName:m.name,input,expectedOutput:null,metadata:{caseId:c.id,synthetic:false,goldStatus:'absent',sourceRunId:m.historical.sourceRunId,sourceDatasetItemId:m.historical.sourceSnapshots.find((s:any)=>s.caseId===c.id).datasetItemId,manifestHash:tagHash(m)}});const got=await api(`/api/public/dataset-items/${id}`);if(tagCanonical(got.input)!==tagCanonical(input)||got.expectedOutput!==null)throw new Error('Historical dataset input/gold readback mismatch')}
 await q('UPDATE learning_concept_tag_experiments SET dataset_id=$2,score_configs=$3::jsonb WHERE run_id=$1',[row.run_id,dataset.id,JSON.stringify(configs)])
 return {datasetId:dataset.id,scoreConfigs:configs}
}
export async function exportHistorical(row:TagStoredRun,caseId:string,arm:string,deps:{api:typeof api;q:typeof q}={api,q}){
 const item=row.items.find(i=>i.case_id===caseId&&i.arm===arm)!;if(!item.receipt||!row.dataset_id)throw new Error('Historical receipt/dataset required')
 const p=historicalObservation(row,item),outboxIds:string[]=[]
 // Legacy delivered/ambiguous observations are readback-only, never re-admitted.
 if(!['pending','queued','sent'].includes(item.export_state))return {traceId:p.ids.traceId,state:item.export_state,outboxIds}
 if(item.export_state!=='sent')outboxIds.push((await deps.api('/api/public/otel/v1/traces','POST',p.payload)).id)
 for(const [key,value]of Object.entries(historicalScores(row,item)))outboxIds.push((await deps.api('/api/public/scores','POST',{id:tagHash([row.run_id,caseId,arm,key]).slice(0,32),traceId:p.ids.traceId,observationId:p.ids.spanId,name:PREFIX+key,value,dataType:defs[key],configId:row.score_configs[key],environment:'learning-dev',comment:'Agreement with reused historical prediction, NOT accuracy. Baseline spans are imports; no baseline per-message latency.'})).id)
 await deps.q("UPDATE learning_concept_tag_items SET export_state='queued' WHERE run_id=$1 AND case_id=$2 AND arm=$3 AND export_state IN ('pending','queued')",[row.run_id,caseId,arm])
 return {traceId:p.ids.traceId,state:'queued',outboxIds}
}
export async function verifyHistorical(row:TagStoredRun,options:{readOnly?:boolean;request?:typeof api;query?:typeof q}={}){
 const request=options.request??api,query=options.query??q
 const pendingIds:string[]=[]
 for(const item of row.items)if(!options.readOnly&&['pending','queued','sent'].includes(item.export_state))pendingIds.push(...(await exportHistorical(row,item.case_id,item.arm)).outboxIds)
 if(pendingIds.length)await flushLangfuseWrites(pendingIds)
 const handles:any[]=[],snapshot=await readHistoricalNative(row,request);let nativePages=0,observationPages=0,scorePages=0,scoreCount=0,observationCount=0,costUsd=0,unpricedCalls=0
 if(row.items.length!==row.manifest.cases.length*row.manifest.arms.length||row.items.some(i=>!i.receipt))throw new Error('Real planned receipt coverage incomplete')
 for(const arm of row.manifest.arms){const expected=row.items.filter(i=>i.arm===arm),native=snapshot.native.get(arm)!;nativePages+=native.pages
 if(native.data.length!==expected.length||new Set(native.data.map(i=>i.experimentItemId)).size!==expected.length)throw new Error('Real native membership pending/mismatch')
 for(const item of expected){const p=historicalObservation(row,item),n=native.data.find(n=>n.experimentItemId===p.ids.datasetItemId)
 if(n?.traceId!==p.ids.traceId||tagCanonical(decode(n.input))!==tagCanonical(p.input)||tagCanonical(decode(n.output))!==tagCanonical(p.output))throw new Error('Real native input/output pending/mismatch')
 const ds=snapshot.datasets.get(p.ids.datasetItemId);if(tagCanonical(ds.input)!==tagCanonical(p.input)||ds.expectedOutput!==null)throw new Error('Real dataset mismatch')
 const {observations:obs,scores}=snapshot.items.get(p.ids.traceId)!;observationPages+=obs.pages;scorePages+=scores.pages
 const scoreMap=new Map(scores.data.map(s=>[s.id,s]));if(scores.data.length!==Object.keys(historicalScores(row,item)).length||scoreMap.size!==scores.data.length)throw new Error('Real score membership pending/mismatch')
 const live=arm==='jev-live';observationCount+=obs.data.length;if(obs.data.length!==1+p.generations.length||new Set(obs.data.map(o=>o.id)).size!==obs.data.length)throw new Error('Real observation membership pending/mismatch')
 const root=obs.data.find(o=>o.id===p.ids.spanId);if(!root||root.type!=='SPAN'||tagCanonical(decode(root.input))!==tagCanonical(p.input)||tagCanonical(decode(root.output))!==tagCanonical(p.output))throw new Error('Real root observation mismatch')
 if(live){for(const generation of p.generations){const g=obs.data.find(o=>o.id===generation.id),r=generation.receipt;if(!g||g.type!=='GENERATION'||g.parentObservationId!==p.ids.spanId||tagCanonical(decode(g.input))!==tagCanonical(r.request)||tagCanonical(decode(g.output))!==tagCanonical({raw:r.raw,error:r.error}))throw new Error('Real generation request/response mismatch');if(r.usage&&(g.usageDetails?.input!==r.usage.input_tokens||g.usageDetails?.output!==r.usage.output_tokens))throw new Error('Real usage mismatch');if(r.usage){if(typeof g.totalCost==='number')costUsd+=g.totalCost;else unpricedCalls++}}}
 else if(obs.data.some(o=>o.type==='GENERATION'))throw new Error('Imported baseline fabricated generation')
 const values=historicalScores(row,item)
 for(const [key,value]of Object.entries(values)){const s=scoreMap.get(tagHash([row.run_id,item.case_id,arm,key]).slice(0,32));if(!s||s.name!==PREFIX+key||s.configId!==row.score_configs[key]||s.subject?.kind!=='observation'||s.subject.id!==p.ids.spanId||s.subject.traceId!==p.ids.traceId||s.dataType!==defs[key]||Math.abs(Number(s.value)-value)>1e-8)throw new Error('Real score mismatch');scoreCount++}
 handles.push({caseId:item.case_id,arm,...p.ids,output:p.output,scores:values,workflowRunId:item.workflow_run_id})
 }}
 const jev=row.items.filter(i=>i.arm==='jev-live'),times=jev.map(i=>i.receipt.latencyMs).sort((a,b)=>a-b),mean=(k:string)=>jev.reduce((n,i)=>n+historicalScores(row,i)[k]!,0)/jev.length
 const summary={verdict:'AGREEMENT_ONLY_NO_GOLD_LATENCY_NON_EQUIVALENT',synthetic:false,sourceRunId:row.manifest.historical.sourceRunId,datasetId:row.dataset_id,compareUrl:`https://dev.biztoolz.app/experiments/project/learning/experiments/results?baseline=${tagIds(row.run_id,'','baseline-import').experimentId}&c=${tagIds(row.run_id,'','jev-live').experimentId}`,scoreConfigs:row.score_configs,handles,verifiedItems:handles.length,counts:{plannedCases:row.manifest.cases.length,uniqueCases:new Set(jev.map(i=>i.case_id)).size,paidCalls:jev.reduce((n,i)=>n+(i.receipt.chunkJournal?i.receipt.chunks.length:Number(Boolean(i.reserved_at))),0),newBaselineCalls:0,baselineImports:row.items.filter(i=>i.arm==='baseline-import').length,nativeItems:handles.length,observations:observationCount,scores:scoreCount,nativePages,observationPages,scorePages},agreement:{meanSetF1:mean('set_f1_agreement'),exactSetRate:mean('exact_set_agreement'),sharedTags:mean('shared_tags')*jev.length,jevOnlyTags:mean('jev_only_tags')*jev.length,baselineOnlyTags:mean('baseline_only_tags')*jev.length},failureRate:jev.filter(i=>!i.receipt.valid).length/jev.length,jevServiceLatencyMs:{p50:times[Math.ceil(times.length*.5)-1],p95:times[Math.ceil(times.length*.95)-1],scope:'Sum of sequential HTTP plus validation latencies per case, not pure inference; no equivalent baseline per-message latency'},usage:{input_tokens:jev.reduce((n,i)=>n+(i.receipt.usage?.input_tokens??0),0),output_tokens:jev.reduce((n,i)=>n+(i.receipt.usage?.output_tokens??0),0)},costUsd:unpricedCalls?null:costUsd,unpricedCalls,costSource:'langfuse model definitions',auditSeed:row.manifest.historical.auditSeed,auditSelectedIds:row.manifest.historical.auditSelectedIds}
 if(!options.readOnly)await query("UPDATE learning_concept_tag_items SET export_state='verified' WHERE run_id=$1",[row.run_id])
 if(!options.readOnly)await query('UPDATE learning_concept_tag_experiments SET summary=$2::jsonb,status=$3,completed_at=COALESCE(completed_at,now()) WHERE run_id=$1',[row.run_id,JSON.stringify(summary),summary.failureRate?'completed_with_failures':'completed'])
 return summary
}
