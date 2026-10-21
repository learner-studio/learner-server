import {learningExperimentApi as api} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import {mapWithConcurrency} from '../map-with-concurrency.js'
import {tagIds} from './learning-concept-tag-telemetry.js'
import type {TagStoredRun} from '../../services/learning-concept-tag-store.js'
type Page={data:any[];pages:number}
/** One global four-read pool; pagination within a task is sequential. No paid work. */
export async function readHistoricalNative(row:TagStoredRun,request:typeof api=api){
 const pages=async(path:string):Promise<Page>=>{
  const data:any[]=[],seen=new Set<string>();let cursor:string|undefined,count=0
  do{const r=await request(path+(cursor?`&cursor=${encodeURIComponent(cursor)}`:''));data.push(...r.data);count++;cursor=r.meta?.cursor;if(cursor&&seen.has(cursor))throw new Error('Cursor loop');if(cursor)seen.add(cursor)}while(cursor)
  return {data,pages:count}
 }
 const native=new Map<string,Page>(),datasets=new Map<string,any>(),items=new Map<string,{observations:Page;scores:Page}>()
 const work:Array<()=>Promise<void>>=[]
 for(const arm of row.manifest.arms)work.push(async()=>{native.set(arm,await pages(`/api/public/experiment-items?fromStartTime=${encodeURIComponent(new Date(row.created_at).toISOString())}&experimentId=${tagIds(row.run_id,'',arm).experimentId}&limit=100&fields=core,dataset,io,metadata`))})
 for(const caseId of new Set(row.items.map(i=>i.case_id)))work.push(async()=>{const id=tagIds(row.run_id,caseId,'').datasetItemId;datasets.set(id,await request(`/api/public/dataset-items/${id}`))})
 for(const item of row.items)work.push(async()=>{
  const {traceId}=tagIds(row.run_id,item.case_id,item.arm)
  const observations=await pages(`/api/public/v2/observations?traceId=${traceId}&limit=100&fields=core,io,metadata,model,usage`)
  const scores=await pages(`/api/public/v3/scores?traceId=${traceId}&limit=100&fields=core,details,subject,annotation`)
  items.set(traceId,{observations,scores})
 })
 await mapWithConcurrency(work,4,task=>task())
 return {native,datasets,items}
}
