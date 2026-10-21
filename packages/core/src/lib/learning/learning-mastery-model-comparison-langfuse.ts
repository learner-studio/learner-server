import {learningExperimentApi as api,flushLangfuseWrites} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import {metaDbQuery as q} from '../db-metadata/_shared.js'
import {promptAbHash,promptAbId} from './learning-prompt-ab.js'
import {promptAbComparable,promptAbNativeJson,promptAbStats} from './learning-prompt-ab-langfuse.js'
import {MASTERY_AB_ARMS,MASTERY_AB_SCORE_TYPES,MASTERY_LEVELS,masteryArmScores,jevBilledUsage,percentToLevel,type MasteryArm,type MasteryDecision} from './learning-mastery-model-comparison.js'

export type MasteryAbItem={conceptId:string;title:string;ordinal:number;sourceRunId:string;inputHash:string;runIds:Record<MasteryArm,string>;trim:{kept:number;dropped:number;estimatedTokens:number;maxEvidenceTokens:number}}
export type MasteryAbManifest={kind:string;name:string;description:string;seed:string;sampleSize:number;code:{gitRevision:string;sourceHash:string;files?:unknown};models:Record<MasteryArm,Record<string,unknown>>;concurrency:Record<MasteryArm,number>;labelStatus:string;items:MasteryAbItem[]}
type Experiment={run_id:string;manifest:MasteryAbManifest;dataset_id:string|null;created_at:Date}
type Receipt={status:string;assessment:{understandingPercent:number|null;confidence:string;demonstrated:unknown[];gaps:unknown[]}|null;decision?:MasteryDecision|null;raw:string;error:string|null;durationMs:number;inputTokens:number|null;outputTokens:number|null;completedAt:string;rateLimitRetries?:number}
type Run={run_id:string;snapshot:{prompt:string;evidence:unknown;context:unknown;model:Record<string,unknown>;promptRevision:string};receipt:Receipt|null;reserved_at:Date|null}

const WEB='https://dev.biztoolz.app/experiments/project/learning'
const PREFIX='mastery_ab.'
const TAGS=['learning','mastery-model-comparison']
const MAX_BYTES=3_500_000

export const masteryAbIds=(runId:string,conceptId:string,arm:MasteryArm)=>({
  datasetItemId:promptAbId('mastery-ab-dataset-item',runId,conceptId),
  experimentId:promptAbId('mastery-ab-arm',runId,arm).replaceAll('-','').slice(0,16),
  traceId:promptAbId('mastery-ab-trace',runId,arm,conceptId).replaceAll('-',''),
  spanId:promptAbId('mastery-ab-observation',runId,arm,conceptId).replaceAll('-','').slice(0,16),
})
export async function masteryAbExperiment(runId:string):Promise<Experiment> {
  const row=(await q<Experiment>('SELECT run_id,manifest,dataset_id,created_at FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[runId])).rows[0]
  if(!row||row.manifest.kind!=='mastery-model-comparison'||row.manifest.items.length!==row.manifest.sampleSize) throw new Error('Expected immutable mastery comparison manifest')
  return row
}
async function run(runId:string):Promise<Run> {
  const row=(await q<Run>(`SELECT r.run_id,r.snapshot,t.receipt,a.reserved_at FROM learning_concept_assessment_runs r
    LEFT JOIN learning_concept_assessment_receipts t USING(run_id) LEFT JOIN learning_concept_assessment_attempts a USING(run_id) WHERE r.run_id=$1`,[runId])).rows[0]
  if(!row) throw new Error('Frozen assessment not found')
  return row
}
/** Uniform view of an arm's answer: percent arms map through the production bands. */
export function masteryOutcome(receipt:Receipt) {
  const percent=receipt.assessment?.understandingPercent??null
  const level=receipt.status!=='completed'?null:receipt.decision?receipt.decision.level:receipt.assessment?percentToLevel(percent):null
  return {status:receipt.status,level,percent,durationMs:receipt.durationMs,decision:receipt.decision??null}
}
const code=(m:MasteryAbManifest)=>({gitRevision:m.code.gitRevision,sourceHash:m.code.sourceHash})
const links=(row:Experiment)=>{
  const first=row.manifest.items[0]!,id=(arm:MasteryArm)=>masteryAbIds(row.run_id,first.conceptId,arm).experimentId
  return {datasetId:row.dataset_id,datasetUrl:row.dataset_id?`${WEB}/datasets/${encodeURIComponent(row.dataset_id)}`:null,compareUrl:`${WEB}/experiments/results?baseline=${id('flash')}&c=${id('jev')}&c=${id('reference')}`}
}
const datasetInput=(snapshot:Run['snapshot'],item:MasteryAbItem)=>({context:snapshot.context,evidence:snapshot.evidence,trim:item.trim,inputHash:item.inputHash})

async function scoreConfigs() {
  const all:any[]=[]
  for(let page=1;;page++){const r=await api(`/api/public/score-configs?limit=100&page=${page}`);all.push(...r.data);if(page>=r.meta.totalPages)break}
  const ids:Record<string,string>={}
  for(const [key,type] of Object.entries(MASTERY_AB_SCORE_TYPES)){
    const name=PREFIX+key
    let config=all.find(c=>c.name===name&&!c.isArchived)
    if(!config)config=await api('/api/public/score-configs','POST',{name,dataType:type.dataType,...(type.dataType==='NUMERIC'?{minValue:0,...(type.maxValue===undefined?{}:{maxValue:type.maxValue})}:{}),description:'Mastery model comparison. Accuracy scores measure agreement with Claude Opus 5.5 agent reference labels, NOT human gold. call_latency_ms is the durable receipt call duration.'})
    const got=await api(`/api/public/score-configs/${config.id}`)
    if(got.name!==name||got.dataType!==type.dataType)throw new Error('Mastery score config mismatch')
    ids[key]=got.id
  }
  return ids
}

/** Dataset + item inputs; expected outputs are written only after the reference arm finishes. */
export async function setupMasteryAbDataset(runId:string) {
  const row=await masteryAbExperiment(runId)
  const manifestHash=promptAbHash(row.manifest)
  let dataset:Record<string,any>
  try {dataset=await api(`/api/public/v2/datasets/${encodeURIComponent(row.manifest.name)}`)}
  catch(error) {
    if(!(error instanceof Error)||!error.message.endsWith('(404)')) throw error
    dataset=await api('/api/public/v2/datasets','POST',{name:row.manifest.name,description:row.manifest.description,metadata:{kind:row.manifest.kind,runId,manifestHash,seed:row.manifest.seed,sampleSize:row.manifest.sampleSize,labelStatus:row.manifest.labelStatus,models:row.manifest.models,concurrency:row.manifest.concurrency,code:code(row.manifest),tags:[...TAGS,runId],privacy:'owner-only'}})
  }
  if(dataset.metadata?.manifestHash!==manifestHash||typeof dataset.id!=='string') throw new Error('Existing Langfuse dataset does not match frozen experiment')
  if(row.dataset_id&&row.dataset_id!==dataset.id) throw new Error('Langfuse dataset identity changed')
  await q('UPDATE learning_consolidator_prompt_experiments SET dataset_id=$2 WHERE run_id=$1 AND (dataset_id IS NULL OR dataset_id=$2)',[runId,dataset.id])
  for(const item of row.manifest.items)await upsertItem(row,item,(await run(item.runIds.reference)).snapshot,undefined)
  return {...links({...row,dataset_id:dataset.id}),scoreConfigs:await scoreConfigs()}
}
async function upsertItem(row:Experiment,item:MasteryAbItem,snapshot:Run['snapshot'],expectedOutput:unknown) {
  await api('/api/public/dataset-items','POST',{id:masteryAbIds(row.run_id,item.conceptId,'reference').datasetItemId,datasetName:row.manifest.name,input:datasetInput(snapshot,item),
    ...(expectedOutput===undefined?{}:{expectedOutput}),metadata:{runId:row.run_id,conceptId:item.conceptId,title:item.title,ordinal:item.ordinal,sourceRunId:item.sourceRunId,inputHash:item.inputHash,runIds:item.runIds,code:code(row.manifest),expectedOutputStatus:expectedOutput===undefined?'pending-reference':row.manifest.labelStatus}})
}
export function referenceLabel(receipt:Receipt,referenceRunId:string) {
  const outcome=masteryOutcome(receipt)
  if(outcome.level===null)return {status:receipt.status,level:null,referenceRunId,error:receipt.error}
  return {status:'completed',level:outcome.level,levelLabel:MASTERY_LEVELS[outcome.level],understandingPercent:outcome.percent,confidence:receipt.assessment!.confidence,demonstrated:receipt.assessment!.demonstrated,gaps:receipt.assessment!.gaps,referenceRunId}
}
/** Phase-1 barrier output: every reference receipt becomes its dataset item's expected output. */
export async function labelMasteryAbReference(runId:string) {
  const row=await masteryAbExperiment(runId)
  if(!row.dataset_id)throw new Error('Dataset has not been set up')
  const levels:Record<string,number>={},failed:string[]=[]
  for(const item of row.manifest.items){
    const reference=await run(item.runIds.reference)
    if(!reference.receipt)throw new Error('Reference arm has an unfinished item; label after all receipts are terminal')
    const label=referenceLabel(reference.receipt,item.runIds.reference)
    if(label.level===null)failed.push(item.conceptId);else levels[String(label.level)]=(levels[String(label.level)]??0)+1
    await upsertItem(row,item,reference.snapshot,label)
  }
  await q("UPDATE learning_consolidator_prompt_experiments SET status='reference_labelled' WHERE run_id=$1",[runId])
  return {labelled:row.manifest.items.length-failed.length,failedReference:failed,levels}
}

function attr(key:string,value:unknown) {
  return {key,value:typeof value==='number'?{doubleValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:typeof value==='string'?value:JSON.stringify(value)}}
}
export function masteryAbObservation(row:Experiment,item:MasteryAbItem,arm:MasteryArm,r:Run) {
  if(!r.receipt||!row.dataset_id) throw new Error('Dataset and terminal receipt required before export')
  const receipt=r.receipt,ids=masteryAbIds(row.run_id,item.conceptId,arm),ended=Date.parse(receipt.completedAt)
  if(!Number.isFinite(ended)||!Number.isFinite(receipt.durationMs)||receipt.durationMs<0) throw new Error('Invalid native assessment timing')
  const paid=r.reserved_at!==null
  const input=arm==='jev'?{request:JSON.parse(r.snapshot.prompt)}:{prompt:r.snapshot.prompt}
  const outcome=masteryOutcome(receipt)
  const output={status:receipt.status,level:outcome.level,levelLabel:outcome.level===null?null:MASTERY_LEVELS[outcome.level],understandingPercent:outcome.percent,assessment:receipt.assessment,decision:receipt.decision??null,error:receipt.error}
  const bill=arm==='jev'?jevBilledUsage(receipt):null
  const metadata={runId:row.run_id,assessmentRunId:r.run_id,conceptId:item.conceptId,ordinal:item.ordinal,arm,role:arm==='reference'?'agent-reference-label':'candidate',promptRevision:r.snapshot.promptRevision,inputHash:item.inputHash,trim:item.trim,concurrencyCap:row.manifest.concurrency[arm],rateLimitRetries:receipt.rateLimitRetries??0,reservedAttempt:paid,timingQuality:'durable receipt call duration',code:code(row.manifest),labelStatus:row.manifest.labelStatus,...(arm==='jev'?{costBasis:bill?(bill.billed?'billed usage, priced by Langfuse':`unbilled: ${bill.reason}`):'unknown'}:{costBasis:'subscription CLI, not priced'}),privacy:'owner-only'}
  const usage=bill?.billed?{input:bill.inputTokens,output:bill.outputTokens}:{...(receipt.inputTokens===null?{}:{input:receipt.inputTokens}),...(receipt.outputTokens===null?{}:{output:receipt.outputTokens})}
  const name=`${row.manifest.name} · ${arm}`
  const attributes=[attr('langfuse.observation.type',paid?'generation':'span'),attr('langfuse.trace.name',`${name} · ${item.title}`),attr('langfuse.trace.tags',[...TAGS,row.run_id,arm,r.snapshot.promptRevision]),attr('langfuse.environment','learning-dev'),attr('session.id',row.run_id),attr('langfuse.observation.input',input),attr('langfuse.observation.output',output),attr('langfuse.observation.metadata',metadata),attr('langfuse.experiment.id',ids.experimentId),attr('langfuse.experiment.name',name),attr('langfuse.experiment.description',`${row.manifest.description} Arm: ${arm} (${r.snapshot.model.backend}/${r.snapshot.model.model}).`),attr('langfuse.experiment.dataset.id',row.dataset_id),attr('langfuse.experiment.item.id',ids.datasetItemId),attr('langfuse.experiment.item.root_observation_id',ids.spanId)]
  if(paid) attributes.push(attr('langfuse.observation.model.name',bill?.model??receipt.decision?.returnedModel??String(r.snapshot.model.model)),attr('langfuse.observation.model.parameters',r.snapshot.model),attr('langfuse.observation.usage_details',usage))
  return {ids,input,output,payload:{resourceSpans:[{resource:{attributes:[attr('service.name','biztools-learning-mastery-ab')]},scopeSpans:[{scope:{name:'biztools-learning-mastery-ab',version:'1'},spans:[{traceId:ids.traceId,spanId:ids.spanId,name:`${arm}: ${item.title}`,kind:1,startTimeUnixNano:String(BigInt(ended-Math.round(receipt.durationMs))*1000000n),endTimeUnixNano:String(BigInt(ended)*1000000n),attributes,status:{code:receipt.status==='completed'?1:2}}]}]}]}}
}

async function exportItem(row:Experiment,item:MasteryAbItem,arm:MasteryArm) {
  const r=await run(item.runIds[arm]),prepared=masteryAbObservation(row,item,arm,r)
  if(Buffer.byteLength(JSON.stringify(prepared.payload))>MAX_BYTES) throw new Error('Observation exceeds Langfuse safe size ceiling')
  await q('INSERT INTO learning_consolidator_prompt_exports(assessment_run_id,experiment_id,trace_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[r.run_id,row.run_id,prepared.ids.traceId])
  const state=(await q<{state:string}>('SELECT state FROM learning_consolidator_prompt_exports WHERE assessment_run_id=$1 AND experiment_id=$2',[r.run_id,row.run_id])).rows[0]?.state
  if(state==='exported')return []
  if(!state||!['pending','queued'].includes(state))throw new Error('Langfuse observation send already claimed or uncertain; reconcile before replay')
  const admitted=await api('/api/public/otel/v1/traces','POST',prepared.payload)
  await q("UPDATE learning_consolidator_prompt_exports SET state='queued',updated_at=now() WHERE assessment_run_id=$1 AND state IN ('pending','queued')",[r.run_id])
  return [admitted.id as string]
}
async function pages(path:string) {
  const out:any[]=[]
  let cursor:string|undefined
  for(let i=0;i<50;i++){const r=await api(`${path}${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);out.push(...(r.data??[]));cursor=r.meta?.cursor;if(!cursor)break}
  return out
}

/** Export all arms, verify exact native read-back, then write the pre-registered scores. */
export async function finalizeMasteryAb(runId:string) {
  const row=await masteryAbExperiment(runId)
  if(!row.dataset_id) throw new Error('Dataset has not been set up')
  const outbox:string[]=[]
  for(const item of row.manifest.items)for(const arm of MASTERY_AB_ARMS)outbox.push(...await exportItem(row,item,arm))
  if(outbox.length)await flushLangfuseWrites(outbox)
  const datasetItems=await pages(`/api/public/dataset-items?datasetName=${encodeURIComponent(row.manifest.name)}&limit=100`)
  const expected=new Set(row.manifest.items.map(i=>masteryAbIds(runId,i.conceptId,'reference').datasetItemId))
  if(datasetItems.length!==expected.size||datasetItems.some((i:{id:string;expectedOutput?:unknown})=>!expected.has(i.id)||i.expectedOutput==null)) throw new Error('Native dataset membership or reference labels read-back mismatch')
  const scoreIds:string[]=[]
  const perArm:Record<MasteryArm,Array<{conceptId:string;status:string;level:number|null;percent:number|null;durationMs:number;inputTokens:number|null;rateLimitRetries:number;scores:Record<string,number|boolean>;bill:{billed:boolean;inputTokens:number;usd:number|null}|null}>>={reference:[],flash:[],jev:[]}
  for(const arm of MASTERY_AB_ARMS){
    const native=await pages(`/api/public/experiment-items?fromStartTime=${encodeURIComponent(row.created_at.toISOString())}&experimentId=${masteryAbIds(runId,row.manifest.items[0]!.conceptId,arm).experimentId}&limit=100&fields=core,dataset,io,metadata`)
    if(native.length!==row.manifest.items.length||new Set(native.map((i:any)=>i.experimentItemId)).size!==native.length) throw new Error(`Native ${arm} item coverage incomplete; read-back may be retried`)
    for(const item of row.manifest.items){
      const r=await run(item.runIds[arm]),wanted=masteryAbObservation(row,item,arm,r)
      const found=native.find((i:any)=>i.experimentItemId===wanted.ids.datasetItemId)
      if(found?.traceId!==wanted.ids.traceId||promptAbComparable(promptAbNativeJson(found.input))!==promptAbComparable(wanted.input)||promptAbComparable(promptAbNativeJson(found.output))!==promptAbComparable(wanted.output)) throw new Error(`Native ${arm} input/output provenance mismatch`)
      const reference=masteryOutcome((await run(item.runIds.reference)).receipt!),outcome=masteryOutcome(r.receipt!)
      const scores=masteryArmScores(reference,outcome,arm)
      for(const [key,value] of Object.entries(scores))scoreIds.push((await api('/api/public/scores','POST',{id:promptAbId('mastery-ab-score',runId,r.run_id,key),traceId:wanted.ids.traceId,observationId:wanted.ids.spanId,name:PREFIX+key,value:typeof value==='boolean'?(value?1:0):value,dataType:MASTERY_AB_SCORE_TYPES[key]!.dataType,comment:key==='call_latency_ms'?'Durable receipt call duration.':'Against Claude Opus 5.5 agent reference label, not human gold. A failed candidate counts as wrong.',environment:'learning-dev'})).id)
      // Langfuse prices the billed usage from its model definitions; a refusal billed nothing.
      const bill=arm==='jev'?jevBilledUsage(r.receipt!):null
      const usd=!bill?.billed?0:(await api(`/api/public/v2/observations?traceId=${wanted.ids.traceId}&limit=100&fields=core,usage,model`)).data?.find((o:any)=>o.id===wanted.ids.spanId)?.totalCost
      perArm[arm].push({conceptId:item.conceptId,status:outcome.status,level:outcome.level,percent:outcome.percent,durationMs:outcome.durationMs,inputTokens:r.receipt!.inputTokens,rateLimitRetries:r.receipt!.rateLimitRetries??0,scores,bill:bill?{billed:bill.billed,inputTokens:bill.inputTokens,usd:typeof usd==='number'?usd:null}:null})
    }
  }
  if(scoreIds.length)await flushLangfuseWrites(scoreIds)
  await q("UPDATE learning_consolidator_prompt_exports SET state='exported',updated_at=now() WHERE experiment_id=$1 AND state='queued'",[runId])
  const summary=summarizeMasteryAb(row,perArm)
  await q("UPDATE learning_consolidator_prompt_experiments SET status=$2,summary=$3::jsonb,completed_at=now() WHERE run_id=$1",[runId,summary.failures?'completed_with_failures':'completed',JSON.stringify(summary)])
  return summary
}

type ArmRows=Parameters<typeof summarizeMasteryAb>[1]
/** Jev arm spend as Langfuse priced it. `complete` is false when any call's billing was unreadable or Langfuse left it unpriced. */
export function jevArmCost(rows:ArmRows[MasteryArm]) {
  const known=rows.flatMap(r=>r.bill?[r.bill]:[]),unpricedCalls=known.filter(b=>b.usd===null).length
  return {usd:known.reduce((n,b)=>n+(b.usd??0),0),billedCalls:known.filter(b=>b.billed).length,unbilledRejections:known.filter(b=>!b.billed).length,unknownCalls:rows.length-known.length,unpricedCalls,billedInputTokens:known.reduce((n,b)=>n+b.inputTokens,0),complete:known.length===rows.length&&!unpricedCalls,costSource:'langfuse model definitions'}
}
export function summarizeMasteryAb(row:Pick<Experiment,'run_id'|'manifest'|'dataset_id'|'created_at'>,perArm:Record<MasteryArm,Array<{conceptId:string;status:string;level:number|null;percent:number|null;durationMs:number;inputTokens:number|null;rateLimitRetries:number;scores:Record<string,number|boolean>;bill:{billed:boolean;inputTokens:number;usd:number|null}|null}>>) {
  const rate=(rows:ArmRows[MasteryArm],key:string)=>{const v=rows.flatMap(r=>key in r.scores?[r.scores[key]]:[]);return v.length?v.filter(Boolean).length/v.length:null}
  const mean=(rows:ArmRows[MasteryArm],key:string)=>promptAbStats(rows.flatMap(r=>typeof r.scores[key]==='number'?[r.scores[key] as number]:[])).mean
  const scored=perArm.reference.filter(r=>r.level!==null).length
  const arm=(name:MasteryArm)=>{
    const rows=perArm[name]
    return {model:row.manifest.models[name],concurrencyCap:row.manifest.concurrency[name],items:rows.length,statuses:Object.fromEntries([...new Set(rows.map(r=>r.status))].map(s=>[s,rows.filter(r=>r.status===s).length])),
      latencyMs:promptAbStats(rows.filter(r=>r.status==='completed').map(r=>r.durationMs)),levels:Object.fromEntries(MASTERY_LEVELS.map((_,i)=>[String(i),rows.filter(r=>r.level===i).length])),
      ...(name==='reference'?{}:{accuracy:{scoredItems:scored,levelExact:rate(rows,'level_exact'),levelWithinOne:rate(rows,'level_within_one'),evidenceDecisionAgrees:rate(rows,'evidence_decision_agrees'),meanLevelAbsError:mean(rows,'level_abs_error'),...(name==='flash'?{meanPercentAbsError:mean(rows,'percent_abs_error')}:{}),...(name==='jev'?{meanReferenceLevelProbability:mean(rows,'ref_level_probability'),meanConfidence:mean(rows,'confidence')}:{})}}),
      inputTokens:promptAbStats(rows.flatMap(r=>r.inputTokens===null?[]:[r.inputTokens])),rateLimitRetries:rows.reduce((n,r)=>n+r.rateLimitRetries,0),
      ...(name==='jev'?{cost:jevArmCost(rows)}:{})}
  }
  const arms={reference:arm('reference'),flash:arm('flash'),jev:arm('jev')}
  const failures=MASTERY_AB_ARMS.reduce((n,a)=>n+perArm[a].filter(r=>r.status!=='completed').length,0)
  return {...links(row as Experiment),runId:row.run_id,labelStatus:row.manifest.labelStatus,arms,items:row.manifest.items.map(i=>({conceptId:i.conceptId,title:i.title,trim:i.trim,...Object.fromEntries(MASTERY_AB_ARMS.map(a=>[a,perArm[a].find(r=>r.conceptId===i.conceptId)?.level??null]))})),failures,
    verdictScope:'Agreement with Claude Opus 5.5 agent reference labels on newest-first trimmed evidence; not human-gold accuracy. Latency is per-call durable receipt duration under each arm\'s concurrency cap.',elapsedMs:Date.now()-new Date(row.created_at).getTime(),code:code(row.manifest)}
}
