import type {TagStoredRun} from '../../services/learning-concept-tag-store.js'
import {metaDbQuery as q} from '../db-metadata/_shared.js'
import {tagObservation} from './learning-concept-tag-telemetry.js'
import {tagHash,scoreTags} from './learning-concept-tag-experiment.js'
import {langfuseWriteKey} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'

/** Readiness never equates receipt persistence or outbox admission with a remote audit. */
export function tagReadiness(row:TagStoredRun,outbox:Array<{id:string;state:string}>,expected:string[]){
 const planned=new Set(row.manifest.cases.flatMap(c=>row.manifest.arms.map(a=>`${c.id}:${a}`)))
 const actual=row.items.map(i=>`${i.case_id}:${i.arm}`)
 const exact=planned.size>0&&actual.length===planned.size&&new Set(actual).size===planned.size&&actual.every(id=>planned.has(id))
 const resultReady=exact&&row.items.every(i=>i.receipt&&(!i.receipt.chunkJournal||i.receipt.complete===true))
 const verified=resultReady&&row.items.every(i=>i.export_state==='verified')
 const matched=expected.map(id=>outbox.find(o=>o.id===id))
 const telemetryState=verified?'verified':!resultReady?'pending':matched.some(o=>o?.state==='dead')?'failed':expected.length>0&&matched.every(o=>o?.state==='delivered')?'delivered':expected.length>0&&matched.every(Boolean)?'queued':'pending'
 return {resultReady,resultState:resultReady?(row.items.every(i=>i.receipt.valid)?'ready':'ready_with_failures'):'pending',telemetryState,auditState:verified?'verified':'pending',latestProviderCompletedAt:resultReady?row.items.map(i=>i.receipt.completedAt).sort().at(-1):null}
}
/** Exact stable IDs survive payload compaction; no broad JSON scan or optimistic queued->delivered projection. */
export async function readTagReadiness(row:TagStoredRun){
 const keys:string[]=[]
 for(const item of row.items){
  // The write key is based on span identities, so use the actual frozen projection for chunk journals.
  if(!item.receipt||item.receipt.chunkJournal&&!item.receipt.complete)continue
  const {historicalObservation,historicalScores}=await import('./learning-concept-tag-historical-telemetry.js')
  const p=row.manifest.historical?historicalObservation(row,item):tagObservation(row,item.case_id,item.arm,item.receipt)
  const r=item.receipt,c=row.manifest.cases.find(c=>c.id===item.case_id)!
  const values=row.manifest.historical?historicalScores(row,item):{...scoreTags(c.gold,r.ids,r.valid),service_latency_ms:r.latencyMs,queue_wait_ms:r.queueWaitMs,end_to_end_ms:r.endToEndMs}
  keys.push(langfuseWriteKey('/api/public/otel/v1/traces',p.payload))
  for(const key of Object.keys(values))keys.push(langfuseWriteKey('/api/public/scores',{id:tagHash([row.run_id,item.case_id,item.arm,key]).slice(0,32)}))
 }
 const rows=keys.length?(await q('SELECT dedupe_key AS id,state FROM telemetry_outbox WHERE destination=$1 AND dedupe_key=ANY($2::text[])',['langfuse',keys])).rows:[]
 return tagReadiness(row,rows,keys)
}
