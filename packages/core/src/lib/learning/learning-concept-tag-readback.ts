import {learningExperimentApi as api,flushLangfuseWrites} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import {promptAbNativeJson} from './learning-prompt-ab-langfuse.js'
import {tagHash,tagCanonical,scoreTags,summarizeTags} from './learning-concept-tag-experiment.js'
import {tagRun,type TagReceipt} from '../../services/learning-concept-tag-store.js'
import {metaDbQuery as q} from '../db-metadata/_shared.js'
import {tagIds,tagObservation,exportTagItem} from './learning-concept-tag-telemetry.js'
export const tagScoreMatches=(got:any,traceId:string,spanId:string,configId:string,key:string,value:number)=>Boolean(got&&got.subject?.traceId===traceId&&got.subject?.kind==='observation'&&got.subject?.id===spanId&&got.configId===configId&&got.name===`concept_tags_v1.${key}`&&(typeof got.value==='number'||(got.dataType==='BOOLEAN'&&typeof got.value==='boolean'))&&Math.abs(Number(got.value)-value)<1e-8)
export async function verifyTagLangfuse(runId:string){
 const row=await tagRun(runId),handles:any[]=[],arms:Record<string,unknown>={}
 if(row.manifest.historical)return (await import('./learning-concept-tag-historical-telemetry.js')).verifyHistorical(row)
 const pendingIds:string[]=[]
 for(const item of row.items)if(['pending','queued','sent'].includes(item.export_state))pendingIds.push(...(await exportTagItem(runId,item.case_id,item.arm)).outboxIds)
 if(pendingIds.length)await flushLangfuseWrites(pendingIds)
 const allScores:any[]=[],scoreCursors=new Set<string>();let scoreCursor:string|undefined
 do{const response=await api(`/api/public/v3/scores?limit=50&fields=core,details,subject,annotation${scoreCursor?`&cursor=${encodeURIComponent(scoreCursor)}`:''}`);allScores.push(...response.data);scoreCursor=response.meta?.cursor;if(scoreCursor&&scoreCursors.has(scoreCursor))throw new Error('Score cursor loop');if(scoreCursor)scoreCursors.add(scoreCursor)}while(scoreCursor)
 for(const arm of row.manifest.arms){
 const expected=row.items.filter(i=>i.arm===arm),native:any[]=[],seen=new Set<string>();let cursor:string|undefined
 do{const response=await api(`/api/public/experiment-items?fromStartTime=${encodeURIComponent(new Date(row.created_at).toISOString())}&experimentId=${tagIds(runId,'',arm).experimentId}&limit=2&fields=core,dataset,io,metadata${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);native.push(...response.data);cursor=response.meta?.cursor;if(cursor&&seen.has(cursor))throw new Error('Cursor loop');if(cursor)seen.add(cursor)}while(cursor)
 if(native.length!==expected.length)throw new Error(`Native coverage pending ${arm}: ${native.length}/${expected.length}`)
 for(const item of expected){const c=row.manifest.cases.find(c=>c.id===item.case_id)!,r=item.receipt as TagReceipt;if(!r)throw new Error('Missing receipt');const p=tagObservation(row,item.case_id,arm,r),found=native.find(i=>i.experimentItemId===p.ids.datasetItemId)
 if(found?.traceId!==p.ids.traceId||tagCanonical(promptAbNativeJson(found.input))!==tagCanonical(p.input)||tagCanonical(promptAbNativeJson(found.output))!==tagCanonical(p.output))throw new Error('Native input/output mismatch')
 const scores={...scoreTags(c.gold,r.ids,r.valid),service_latency_ms:r.latencyMs,queue_wait_ms:r.queueWaitMs,end_to_end_ms:r.endToEndMs}
 for(const [key,value]of Object.entries(scores)){const id=tagHash([runId,item.case_id,arm,key]).slice(0,32),got=allScores.find(s=>s.id===id);if(!tagScoreMatches(got,p.ids.traceId,p.ids.spanId,row.score_configs[key]!,key,value))throw new Error('Score readback pending/mismatch')}
 await q("UPDATE learning_concept_tag_items SET export_state='verified' WHERE run_id=$1 AND case_id=$2 AND arm=$3",[runId,item.case_id,arm]);handles.push({caseId:item.case_id,arm,...p.ids,output:p.output,scores})
 }
 arms[arm]=summarizeTags(expected.map(i=>({gold:row.manifest.cases.find(c=>c.id===i.case_id)!.gold,predicted:i.receipt.ids,valid:i.receipt.valid,latencyMs:i.receipt.latencyMs})))
 }
 const web='https://dev.biztoolz.app/experiments/project/learning'
 const summary={providerMode:row.manifest.providerMode,synthetic:true,verdict:'PLUMBING_ONLY_NO_REAL_MODEL_CONCLUSIONS',datasetId:row.dataset_id,datasetUrl:`${web}/datasets/${row.dataset_id}`,compareUrl:row.manifest.providerMode==='live'?`${web}/experiments/results?baseline=${tagIds(runId,'','jev-live').experimentId}`:`${web}/experiments/results?baseline=${tagIds(runId,'','jev-mock').experimentId}&c=${tagIds(runId,'','baseline-mock').experimentId}`,scoreConfigs:row.score_configs,handles,arms,verifiedItems:handles.length,conceptCount:row.manifest.concepts.length}
 await q("UPDATE learning_concept_tag_experiments SET summary=$2::jsonb,status=$3,completed_at=now() WHERE run_id=$1",[runId,JSON.stringify(summary),row.items.every(i=>i.receipt?.valid)?'completed':'completed_with_failures'])
 return summary
}
