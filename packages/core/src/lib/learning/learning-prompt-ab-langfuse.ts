import {learningExperimentApi as api,flushLangfuseWrites} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
import {metaDbQuery as q} from '../db-metadata/_shared.js'
import {promptAbHash,promptAbId,PROMPT_AB_REVISION} from './learning-prompt-ab.js'
import {validateGradualAssessment,type GradualAssessmentContext,type GradualAssessmentProposal} from './learning-gradual-assessment.js'

type Item={conceptId:string;title:string;ordinal:number;sourceRunId:string;inputHash:string;breadcrumbs:string[][];baselineRunId:string;treatmentRunId:string}
type Manifest={name:string;description:string;seed:string;code:{gitRevision:string;sourceHash:string;files:unknown};items:Item[];model:Record<string,unknown>}
type Experiment={run_id:string;manifest:Manifest;dataset_id:string|null;created_at:Date}
type Receipt={status:string;assessment:unknown;raw:string;error:string|null;durationMs:number;inputTokens:number|null;outputTokens:number|null;completedAt:string}
type Snapshot={prompt:string;schema:unknown;evidence:unknown;prior:unknown;context:unknown;model:Record<string,unknown>;promptRevision:string}
type Assessment={run_id:string;snapshot:Snapshot;receipt:Receipt|null;reserved_at:Date|null}
type NativeItem={experimentId:string;experimentItemId:string;traceId:string;input?:unknown;output?:unknown}
const WEB='https://dev.biztoolz.app/experiments/project/learning'
const MAX_BYTES=3_500_000
const codeMetadata=(manifest:Manifest)=>({gitRevision:manifest.code.gitRevision,sourceHash:manifest.code.sourceHash})
export function promptAbComparable(value:unknown):string {
  const normalize=(v:unknown):unknown=>Array.isArray(v)?v.map(normalize):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,normalize(item)])):v
  return JSON.stringify(normalize(value))
}
// v4 experiment-items exposes the stored OTLP JSON string, while dataset-items
// exposes decoded JSON. Decode this one transport envelope, not nested prompts.
export const promptAbNativeJson=(value:unknown):unknown=>typeof value==='string'?JSON.parse(value):value
export const promptAbNativeIds=(runId:string,item:Item,arm:'baseline'|'treatment')=>({
  datasetItemId:promptAbId('prompt-ab-dataset-item',runId,item.conceptId),
  experimentId:promptAbId('prompt-ab-arm',runId,arm).replaceAll('-','').slice(0,16),
  traceId:promptAbId('prompt-ab-trace',runId,arm,item.conceptId).replaceAll('-',''),
  spanId:promptAbId('prompt-ab-observation',runId,arm,item.conceptId).replaceAll('-','').slice(0,16),
})
async function experiment(runId:string):Promise<Experiment> {
  const row=(await q<Experiment>('SELECT run_id,manifest,dataset_id,created_at FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[runId])).rows[0]
  if(!row||row.manifest.items.length!==50||new Set(row.manifest.items.map(i=>i.conceptId)).size!==50) throw new Error('Expected immutable 50-concept A/B manifest')
  return row
}
async function assessment(runId:string):Promise<Assessment> {
  const row=(await q<Assessment>(`SELECT r.run_id,r.snapshot,t.receipt,a.reserved_at FROM learning_concept_assessment_runs r
    LEFT JOIN learning_concept_assessment_receipts t USING(run_id) LEFT JOIN learning_concept_assessment_attempts a USING(run_id) WHERE r.run_id=$1`,[runId])).rows[0]
  if(!row) throw new Error('Frozen assessment not found')
  return row
}
export const promptAbDatasetInput=(snapshot:Snapshot,item:Item)=>({context:snapshot.context,evidence:snapshot.evidence,prior:snapshot.prior,schema:snapshot.schema,breadcrumbs:item.breadcrumbs})
const links=(runId:string,datasetId:string,first:Item)=>({datasetId,datasetUrl:`${WEB}/datasets/${encodeURIComponent(datasetId)}`,compareUrl:`${WEB}/experiments/results?baseline=${promptAbNativeIds(runId,first,'baseline').experimentId}&c=${promptAbNativeIds(runId,first,'treatment').experimentId}`})

/** Dataset creation/item upserts are replayable, unlike append-only OTLP observations. */
export async function setupPromptAbDataset(runId:string) {
  const row=await experiment(runId)
  const manifestHash=promptAbHash(row.manifest)
  let dataset:Record<string,any>
  try {dataset=await api(`/api/public/v2/datasets/${encodeURIComponent(row.manifest.name)}`)}
  catch(error) {
    if(!(error instanceof Error)||!error.message.endsWith('(404)')) throw error
    dataset=await api('/api/public/v2/datasets','POST',{name:row.manifest.name,description:row.manifest.description,metadata:{runId,manifestHash,seed:row.manifest.seed,code:codeMetadata(row.manifest),tags:['learning','consolidator-v2','prompt-ab',runId],privacy:'owner-only',sampleSize:50}})
  }
  if(dataset.metadata?.manifestHash!==manifestHash||typeof dataset.id!=='string') throw new Error('Existing Langfuse dataset does not match frozen experiment')
  if(row.dataset_id&&row.dataset_id!==dataset.id) throw new Error('Langfuse dataset identity changed')
  await q('UPDATE learning_consolidator_prompt_experiments SET dataset_id=$2 WHERE run_id=$1 AND (dataset_id IS NULL OR dataset_id=$2)',[runId,dataset.id])
  for(const item of row.manifest.items) {
    const source=await assessment(item.baselineRunId)
    await api('/api/public/dataset-items','POST',{id:promptAbNativeIds(runId,item,'baseline').datasetItemId,datasetName:row.manifest.name,input:promptAbDatasetInput(source.snapshot,item),metadata:{runId,conceptId:item.conceptId,ordinal:item.ordinal,sourceRunId:item.sourceRunId,inputHash:item.inputHash,breadcrumbs:item.breadcrumbs,baselineRunId:item.baselineRunId,treatmentRunId:item.treatmentRunId,code:codeMetadata(row.manifest),expectedOutputStatus:'not-human-labelled'}})
  }
  return links(runId,dataset.id,row.manifest.items[0]!)
}

function attr(key:string,value:unknown) {
  return {key,value:typeof value==='number'?{doubleValue:value}:typeof value==='boolean'?{boolValue:value}:{stringValue:typeof value==='string'?value:JSON.stringify(value)}}
}
export function promptAbReceiptMetrics(run:Assessment) {
  if(!run.receipt) throw new Error('Terminal assessment receipt required')
  const receipt=run.receipt
  let structurallyGrounded:boolean|null=null
  let proposal:GradualAssessmentProposal|null=null
  if(receipt.assessment) {
    try {proposal=validateGradualAssessment({proposals:[receipt.assessment]},run.snapshot.context as GradualAssessmentContext)[0]!;structurallyGrounded=true}
    catch {structurallyGrounded=false}
  }
  return {runId:run.run_id,status:receipt.status,reservedAttempt:run.reserved_at!==null,durationMs:receipt.durationMs,inputTokens:receipt.inputTokens,outputTokens:receipt.outputTokens,structurallyGrounded,
    understandingPercent:proposal?.understandingPercent??null,demonstrations:proposal?.demonstrated.length??0,observedDifficulties:proposal?.gaps.filter(g=>g.kind==='observed_difficulty').length??0,untestedGaps:proposal?.gaps.filter(g=>g.kind==='untested').length??0,
    nonNullEstimateWithoutDemonstration:proposal?.understandingPercent!=null&&proposal.demonstrated.length===0}
}
export function promptAbStats(values:number[]) {
  const sorted=[...values].sort((a,b)=>a-b)
  const percentile=(p:number)=>sorted.length?sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]!:null
  return {count:sorted.length,sum:sorted.reduce((a,b)=>a+b,0),mean:sorted.length?sorted.reduce((a,b)=>a+b,0)/sorted.length:null,p50:percentile(.5),p95:percentile(.95),min:sorted[0]??null,max:sorted.at(-1)??null}
}
/** One native observation per arm/concept. Only a recorded attempt is a generation;
 * receipt token values stay unknown when not observed, never invented as zero. */
export function promptAbObservation(row:Experiment,item:Item,arm:'baseline'|'treatment',run:Assessment) {
  if(!run.receipt||!row.dataset_id) throw new Error('Dataset and terminal receipt required before export')
  const receipt=run.receipt,ids=promptAbNativeIds(row.run_id,item,arm)
  const ended=Date.parse(receipt.completedAt)
  if(!Number.isFinite(ended)||!Number.isFinite(receipt.durationMs)||receipt.durationMs<0) throw new Error('Invalid native assessment timing')
  const paid=run.reserved_at!==null
  const promptRevision=arm==='treatment'?PROMPT_AB_REVISION:run.snapshot.promptRevision
  const input={prompt:run.snapshot.prompt,schema:run.snapshot.schema,evidence:run.snapshot.evidence,prior:run.snapshot.prior,context:run.snapshot.context}
  const output={status:receipt.status,assessment:receipt.assessment,raw:receipt.raw,error:receipt.error}
  const metadata={runId:row.run_id,assessmentRunId:run.run_id,conceptId:item.conceptId,ordinal:item.ordinal,arm,promptRevision,code:codeMetadata(row.manifest),inputHash:item.inputHash,promptHash:promptAbHash(run.snapshot.prompt),reservedAttempt:paid,providerAttemptCount:'not-observed',usageSource:'durable assessment receipt',timingQuality:'adapter',privacy:'owner-only'}
  const usage={...(receipt.inputTokens===null?{}:{input:receipt.inputTokens}),...(receipt.outputTokens===null?{}:{output:receipt.outputTokens})}
  const attributes=[attr('langfuse.observation.type',paid?'generation':'span'),attr('langfuse.trace.name',`${row.manifest.name} · ${arm} · ${item.title}`),attr('langfuse.trace.tags',['learning','consolidator-v2','prompt-ab',row.run_id,arm,promptRevision,row.manifest.code.sourceHash]),attr('langfuse.environment','learning-dev'),attr('session.id',row.run_id),attr('langfuse.observation.input',input),attr('langfuse.observation.output',output),attr('langfuse.observation.metadata',metadata),attr('langfuse.experiment.id',ids.experimentId),attr('langfuse.experiment.name',`${row.manifest.name} · ${arm}`),attr('langfuse.experiment.description',row.manifest.description),attr('langfuse.experiment.dataset.id',row.dataset_id),attr('langfuse.experiment.metadata',{runId:row.run_id,arm,seed:row.manifest.seed,code:codeMetadata(row.manifest),promptRevision,model:row.manifest.model}),attr('langfuse.experiment.item.id',ids.datasetItemId),attr('langfuse.experiment.item.root_observation_id',ids.spanId),attr('langfuse.experiment.item.metadata',{conceptId:item.conceptId,ordinal:item.ordinal,inputHash:item.inputHash})]
  if(paid) attributes.push(attr('langfuse.observation.model.name',run.snapshot.model.model),attr('langfuse.observation.model.parameters',run.snapshot.model),attr('langfuse.observation.usage_details',usage))
  return {ids,input,output,payload:{resourceSpans:[{resource:{attributes:[attr('service.name','biztools-learning-prompt-ab')]},scopeSpans:[{scope:{name:'biztools-learning-prompt-ab',version:'1'},spans:[{traceId:ids.traceId,spanId:ids.spanId,name:`${arm}: ${item.title}`,kind:1,startTimeUnixNano:String(BigInt(ended-Math.round(receipt.durationMs))*1000000n),endTimeUnixNano:String(BigInt(ended)*1000000n),attributes,status:{code:['completed','no_evidence','unchanged'].includes(receipt.status)?1:2}}]}]}]}}
}

export async function exportPromptAbItem(runId:string,assessmentRunId:string) {
  const row=await experiment(runId)
  const item=row.manifest.items.find(i=>i.baselineRunId===assessmentRunId||i.treatmentRunId===assessmentRunId)
  if(!item) throw new Error('Assessment does not belong to frozen A/B manifest')
  const arm=item.baselineRunId===assessmentRunId?'baseline':'treatment'
  const prepared=promptAbObservation(row,item,arm,await assessment(assessmentRunId))
  // Complete local preparation before consuming the once-only send claim.
  if(Buffer.byteLength(JSON.stringify(prepared.payload))>MAX_BYTES) throw new Error('Observation exceeds Langfuse safe size ceiling')
  await q('INSERT INTO learning_consolidator_prompt_exports(assessment_run_id,experiment_id,trace_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[assessmentRunId,runId,prepared.ids.traceId])
  const state=(await q<{state:string}>('SELECT state FROM learning_consolidator_prompt_exports WHERE assessment_run_id=$1 AND experiment_id=$2',[assessmentRunId,runId])).rows[0]?.state
  if(state==='exported')return {assessmentRunId,state,outboxIds:[] as string[]}
  if(!state||!['pending','queued'].includes(state))throw new Error('Langfuse observation send already claimed or uncertain; reconcile before replay')
  const admitted=await api('/api/public/otel/v1/traces','POST',prepared.payload)
  await q("UPDATE learning_consolidator_prompt_exports SET state='queued',updated_at=now() WHERE assessment_run_id=$1 AND state IN ('pending','queued')",[assessmentRunId])
  return {assessmentRunId,state:'queued',outboxIds:[admitted.id as string]}
}

/** Read-back is its own safely retryable workflow step; never re-send on read lag. */
export async function finalizePromptAbLangfuse(runId:string) {
  const row=await experiment(runId)
  if(!row.dataset_id) throw new Error('Dataset has not been set up')
  const exports=(await q<{assessment_run_id:string;state:string}>('SELECT assessment_run_id,state FROM learning_consolidator_prompt_exports WHERE experiment_id=$1',[runId])).rows
  if(exports.length!==100||exports.some(e=>!['exported','pending','queued'].includes(e.state))) throw new Error('Native export coverage is incomplete or uncertain')
  const observationIds:string[]=[],scoreIds:string[]=[]
  for(const item of exports)if(item.state!=='exported')observationIds.push(...(await exportPromptAbItem(runId,item.assessment_run_id)).outboxIds)
  if(observationIds.length)await flushLangfuseWrites(observationIds)
  const datasetItems=await api(`/api/public/dataset-items?datasetName=${encodeURIComponent(row.manifest.name)}&limit=100`)
  const expected=new Set(row.manifest.items.map(i=>promptAbNativeIds(runId,i,'baseline').datasetItemId))
  if(datasetItems.data?.length!==50||datasetItems.data.some((i:{id:string})=>!expected.has(i.id))) throw new Error('Native dataset membership read-back mismatch')
  const metrics:{baseline:ReturnType<typeof promptAbReceiptMetrics>[];treatment:ReturnType<typeof promptAbReceiptMetrics>[]}={baseline:[],treatment:[]}
  for(const arm of ['baseline','treatment'] as const) {
    const id=promptAbNativeIds(runId,row.manifest.items[0]!,arm).experimentId
    const response=await api(`/api/public/experiment-items?fromStartTime=${encodeURIComponent(row.created_at.toISOString())}&experimentId=${id}&limit=100&fields=core,dataset,io,metadata`)
    const native=response.data as NativeItem[]|undefined
    if(native?.length!==50||response.meta?.cursor||new Set(native.map(i=>i.experimentItemId)).size!==50) throw new Error(`Native ${arm} item coverage incomplete; read-back may be retried`)
    for(const item of row.manifest.items) {
      const run=await assessment(arm==='baseline'?item.baselineRunId:item.treatmentRunId)
      const wanted=promptAbObservation(row,item,arm,run)
      const found=native.find(i=>i.experimentItemId===wanted.ids.datasetItemId)
      if(found?.traceId!==wanted.ids.traceId||promptAbComparable(promptAbNativeJson(found.input))!==promptAbComparable(wanted.input)||promptAbComparable(promptAbNativeJson(found.output))!==promptAbComparable(wanted.output)) throw new Error(`Native ${arm} input/output provenance mismatch`)
      const metric=promptAbReceiptMetrics(run)
      metrics[arm].push(metric)
      // Score writes are server-upserted by stable ID and safe to retry separately
      // from observations. These checks are structural, never semantic grades.
      if(metric.structurallyGrounded!==null) scoreIds.push((await api('/api/public/scores','POST',{id:promptAbId('prompt-ab-source-score',runId,run.run_id),traceId:wanted.ids.traceId,observationId:wanted.ids.spanId,name:'schema_and_exact_human_source_valid',value:metric.structurallyGrounded?1:0,dataType:'BOOLEAN',comment:'Deterministic schema, node identity and exact human-envelope quote validation; pasted authorship and semantic relevance not judged.',environment:'learning-dev'})).id)
    }
  }
  if(scoreIds.length)await flushLangfuseWrites(scoreIds)
  await q("UPDATE learning_consolidator_prompt_exports SET state='exported',updated_at=now() WHERE experiment_id=$1 AND state='queued'",[runId])
  const aggregate=(items:ReturnType<typeof promptAbReceiptMetrics>[])=>({items:items.length,reservedAttempts:items.filter(i=>i.reservedAttempt).length,statuses:Object.fromEntries([...new Set(items.map(i=>i.status))].map(status=>[status,items.filter(i=>i.status===status).length])),durationMs:promptAbStats(items.filter(i=>i.reservedAttempt).map(i=>i.durationMs)),inputTokens:promptAbStats(items.flatMap(i=>i.inputTokens===null?[]:[i.inputTokens])),outputTokens:promptAbStats(items.flatMap(i=>i.outputTokens===null?[]:[i.outputTokens])),unknownUsage:items.filter(i=>i.reservedAttempt&&(i.inputTokens===null||i.outputTokens===null)).length,sourceValidationFailures:items.filter(i=>i.structurallyGrounded===false).length,unknownEstimates:items.filter(i=>i.understandingPercent===null).length,understandingPercent:promptAbStats(items.flatMap(i=>i.understandingPercent===null?[]:[i.understandingPercent])),demonstrations:items.reduce((sum,i)=>sum+i.demonstrations,0),observedDifficulties:items.reduce((sum,i)=>sum+i.observedDifficulties,0),nonNullEstimateWithoutDemonstration:items.filter(i=>i.nonNullEstimateWithoutDemonstration).length})
  const pairs=row.manifest.items.map((item,index)=>{const baseline=metrics.baseline[index]!,treatment=metrics.treatment[index]!;return {conceptId:item.conceptId,title:item.title,ordinal:item.ordinal,baseline,treatment,percentageDelta:baseline.understandingPercent===null||treatment.understandingPercent===null?null:treatment.understandingPercent-baseline.understandingPercent,outputTokenDelta:baseline.outputTokens===null||treatment.outputTokens===null?null:treatment.outputTokens-baseline.outputTokens,durationDeltaMs:treatment.durationMs-baseline.durationMs}})
  const failed=Object.values(metrics).flat().some(item=>!['completed','no_evidence','unchanged'].includes(item.status)||item.structurallyGrounded===false)
  const summary={...links(runId,row.dataset_id,row.manifest.items[0]!),verifiedItems:50,verifiedArmItems:100,arms:{baseline:aggregate(metrics.baseline),treatment:aggregate(metrics.treatment)},pairs,pairedPercentageDelta:promptAbStats(pairs.flatMap(p=>p.percentageDelta===null?[]:[p.percentageDelta])),elapsedMs:Date.now()-row.created_at.getTime(),timing:'elapsed includes setup, queueing, model calls and export read-back; arm latencies use receipt duration',providerAttemptCount:'not-observed; reservedAttempts are application attempts, not an assertion of exactly 100 provider calls',semanticReview:'pending',code:codeMetadata(row.manifest)}
  await q(`UPDATE learning_consolidator_prompt_experiments SET status=$2,
    summary=$3::jsonb || CASE WHEN jsonb_typeof(summary->'semanticReview')='object' THEN jsonb_build_object('semanticReview',summary->'semanticReview') ELSE '{}'::jsonb END,
    completed_at=now() WHERE run_id=$1`,[runId,failed?'completed_with_failures':'completed',JSON.stringify(summary)])
  return summary
}

/** Explicit reviewer action, not an automatic model judge. All scores are stable
 * upserts; this never re-exports observations or invokes an assessment model. */
export async function recordPromptAbSemanticReview(runId:string,review:{reviewer:string;scope:string;notes:Record<string,string>;verdicts?:Record<string,string>}) {
  const row=await experiment(runId)
  let pairedScores=0,attributionScores=0
  const scoreIds:string[]=[]
  for(const item of row.manifest.items) for(const arm of ['baseline','treatment'] as const) {
    const run=await assessment(arm==='baseline'?item.baselineRunId:item.treatmentRunId)
    if(!run.receipt) throw new Error('Cannot review an unfinished assessment')
    if(!run.reserved_at) continue
    const identity=promptAbNativeIds(runId,item,arm)
    scoreIds.push((await api('/api/public/scores','POST',{id:promptAbId('prompt-ab-paired-review',runId,run.run_id),traceId:identity.traceId,observationId:identity.spanId,name:'paired_output_review',value:review.verdicts?.[item.conceptId]??'no_material_mastery_difference',dataType:'CATEGORICAL',comment:`${review.reviewer}: ${review.scope}${review.notes[item.conceptId]?` Specific review: ${review.notes[item.conceptId]}`:''}`,environment:'learning-dev'})).id)
    pairedScores++
    const note=review.notes[item.conceptId]
    if(note) {
      scoreIds.push((await api('/api/public/scores','POST',{id:promptAbId('prompt-ab-attribution-review',runId,run.run_id),traceId:identity.traceId,observationId:identity.spanId,name:'attribution_review',value:'needs_review',dataType:'CATEGORICAL',comment:`${review.reviewer}: ${note}`,environment:'learning-dev'})).id)
      attributionScores++
    }
  }
  if(scoreIds.length)await flushLangfuseWrites(scoreIds)
  const result={...review,status:'reviewed',pairedConcepts:row.manifest.items.length,pairedScores,attributionScores,reviewedAt:new Date().toISOString(),limitations:'Output-level paired review with cited-source excerpts, not an exhaustive audit of every retrieved message for missed evidence; no human-labelled accuracy estimate.'}
  await q("UPDATE learning_consolidator_prompt_experiments SET summary=jsonb_set(COALESCE(summary,'{}'::jsonb),'{semanticReview}',$2::jsonb) WHERE run_id=$1",[runId,JSON.stringify(result)])
  return result
}
