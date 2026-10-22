/** Native Langfuse summary, stable score upserts, no model or observation replay.
 * Langfuse: LEARNER_LANGFUSE_URL (default http://127.0.0.1:3100/experiments),
 * keys from LEARNER_LANGFUSE_ENV_FILE (default /etc/learner/langfuse.env), and
 * LEARNER_LANGFUSE_PUBLIC_URL for the dashboard link written to the summary. */
import {readFileSync} from 'node:fs'
import {metaDbQuery as q} from '@learner/core/lib/db-metadata/_shared.js'
import {promptAbHash,promptAbId} from '@learner/core/lib/learning/learning-prompt-ab.js'
import {promptAbNativeIds} from '@learner/core/lib/learning/learning-prompt-ab-langfuse.js'
import {openLearnerDatabase,usage} from './_db.js'
const run=process.argv.slice(2).find(arg=>!arg.startsWith('-'))!
usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/prompt-ab-dashboard.ts EXPERIMENT_UUID
For a finalized consolidator prompt A/B experiment, upserts deterministic
categorical/numeric scores and a KPI dashboard in Langfuse, then WRITES the
dashboard URL and paired outcomes into the experiment's summary row.`,!run)
const langfuseUrl=(process.env.LEARNER_LANGFUSE_URL??'http://127.0.0.1:3100/experiments').replace(/\/+$/,'')
const publicUrl=(process.env.LEARNER_LANGFUSE_PUBLIC_URL??langfuseUrl).replace(/\/+$/,'')
const handle=openLearnerDatabase({readOnly:false})
const row=(await q('SELECT * FROM learning_consolidator_prompt_experiments WHERE run_id=$1',[run])).rows[0]
if(!row?.status.startsWith('completed'))throw new Error('Experiment must be finalized')
const source=readFileSync(process.env.LEARNER_LANGFUSE_ENV_FILE??'/etc/learner/langfuse.env','utf8')
const env=(name:string)=>source.match(new RegExp(`^${name}=(.*)$`,'m'))?.[1]?.trim().replace(/^['"]|['"]$/g,'')
async function api(path:string,method='GET',body?:unknown){
  const response=await fetch(`${langfuseUrl}/api/public/${path}`,{method,headers:{authorization:'Basic '+Buffer.from(`${env('LANGFUSE_PUBLIC_KEY')}:${env('LANGFUSE_SECRET_KEY')}`).toString('base64'),'content-type':'application/json'},body:body?JSON.stringify(body):undefined})
  if(!response.ok)throw new Error(`Langfuse API failed ${response.status}`)
  return response.json()
}
let unequal=0,equal=0,bothUnknown=0,skips=0
const changed:Array<{concept:string;old:unknown;new:unknown}>=[]
for(const item of row.manifest.items){
  const records=(await q('SELECT a.run_id,r.receipt FROM learning_concept_assessment_runs a JOIN learning_concept_assessment_receipts r USING(run_id) WHERE a.run_id=ANY($1::text[])',[[item.baselineRunId,item.treatmentRunId]])).rows
  const old=records.find(r=>r.run_id===item.baselineRunId)!.receipt
  const fresh=records.find(r=>r.run_id===item.treatmentRunId)!.receipt
  const a=old.assessment?.understandingPercent??null,b=fresh.assessment?.understandingPercent??null
  const skipped=old.status==='no_evidence'&&fresh.status==='no_evidence'
  const category=skipped?'both skipped':a===null&&b===null?'both unknown':a===b?'same estimate':'different estimate or known status'
  if(skipped)skips++;else if(a===null&&b===null)bothUnknown++;else if(a===b)equal++;else{unequal++;changed.push({concept:item.title,old:a,new:b})}
  for(const arm of ['baseline','treatment'] as const){
    const ids=promptAbNativeIds(run,item,arm)
    const receipt=arm==='baseline'?old:fresh
    const value=receipt.status==='completed'?(receipt.assessment?.understandingPercent===null?'unknown':'estimated'):receipt.status==='no_evidence'?'no evidence skip':'error'
    for(const [name,score]of [['assessment_outcome',value],['paired_estimate_comparison',category]])await api('scores','POST',{id:promptAbId(run,item.conceptId,arm,name!),traceId:ids.traceId,observationId:ids.spanId,name,value:score,dataType:'CATEGORICAL',comment:'Deterministic output status comparison, not a human accuracy score. Null is unknown, not zero mastery.',environment:'learning-dev'})
    if(receipt.assessment?.understandingPercent!=null)await api('scores','POST',{id:promptAbId(run,item.conceptId,arm,'estimated_mastery'),traceId:ids.traceId,observationId:ids.spanId,name:'estimated_mastery',value:receipt.assessment.understandingPercent,dataType:'NUMERIC',comment:'Provisional model estimate, not validated human mastery.',environment:'learning-dev'})
  }
}
const summary=row.summary
const name=`${row.manifest.priorBlind?'Consolidator v2 PRIOR-BLIND':'Consolidator v2'} — KPI summary · ${run.slice(0,8)}`
const known=(arm:string)=>summary.arms[arm].understandingPercent.count
const description=`PRIMARY RESULTS: ${unequal}/50 paired estimate/status differences; old ${known('baseline')} estimated, new ${known('treatment')} estimated; ${bothUnknown} both unknown; ${skips} both skipped. ${equal} identical numeric estimates. Assessment errors: old ${summary.arms.baseline.statuses.failed??0}, new ${summary.arms.treatment.statuses.failed??0}. Higher estimates are NOT a quality win. Same frozen evidence, 50 paired concepts, prior assessments hidden from both prompts and validators, Flash High, nine shared rolling slots. No human-labelled accuracy or exhaustive retrieval recall audit. No live mastery writes. ORCHESTRATION CAVEAT: original parent finalizer used stale cached code and failed; corrected native readback completed separately without repeating models or observations. Latency includes shared CLI queue contention, not pure inference time. Comparison: ${summary.compareUrl} | Dataset: ${summary.datasetUrl}`
const existing=(await api('unstable/dashboards?limit=100')).data.find((d:{name:string})=>d.name===name)
const dashboard=existing??await api('unstable/dashboards','POST',{name,description,filters:[]})
const allWidgets=(await api('unstable/dashboard-widgets?limit=100')).data
const placements:Array<Record<string,unknown>>=[]
for(const [index,arm]of ['baseline','treatment'].entries()){
  const label=arm==='baseline'?'A · Old prompt':'B · Breadcrumb prompt'
  const scores=[{type:'arrayOptions',column:'tags',operator:'all of',value:[run,arm]}]
  const obs=[{type:'string',column:'sessionId',operator:'=',value:run},{type:'arrayOptions',column:'tags',operator:'all of',value:[arm]},{type:'string',column:'type',operator:'=',value:'GENERATION'}]
  const definitions=[
    {name:`${label} — PRIMARY: estimates, unknowns, errors`,description:`${known(arm)} estimates · ${summary.arms[arm].statuses.completed-known(arm)} unknown · ${summary.arms[arm].statuses.no_evidence??0} skips · ${summary.arms[arm].statuses.failed??0} model failures. Estimated is not validated mastery.`,view:'scores-categorical',dimensions:[{field:'stringValue'}],metrics:[{measure:'count',agg:'count'}],filters:[...scores,{type:'string',column:'name',operator:'=',value:'assessment_outcome'}]},
    {name:`${label} — PRIMARY: paired changes`,description:`${unequal} changed · ${equal} same numeric estimate · ${bothUnknown} both unknown · ${skips} both skipped. Changes are not automatically improvements.`,view:'scores-categorical',dimensions:[{field:'stringValue'}],metrics:[{measure:'count',agg:'count'}],filters:[...scores,{type:'string',column:'name',operator:'=',value:'paired_estimate_comparison'}]},
    {name:`${label} — PRIMARY: reviewer verdicts`,description:'Output-level paired review with source excerpts, not exhaustive recall or human-labelled accuracy. Open scores for explanations.',view:'scores-categorical',dimensions:[{field:'stringValue'}],metrics:[{measure:'count',agg:'count'}],filters:[...scores,{type:'string',column:'name',operator:'=',value:'paired_output_review'}]},
    {name:`${label} — performance: call latency`,description:'Paid-call receipt latency in seconds. No-evidence skips excluded; concurrent background load is not isolated.',view:'observations',dimensions:[],metrics:[{measure:'latency',agg:'p50'},{measure:'latency',agg:'p95'},{measure:'latency',agg:'avg'}],filters:obs},
    {name:`${label} — performance: tokens`,description:'Actual provider-reported tokens; output accounting can include reasoning. Not visible character counts.',view:'observations',dimensions:[],metrics:[{measure:'inputTokens',agg:'sum'},{measure:'outputTokens',agg:'sum'}],filters:obs},
    {name:`${label} — secondary: source/schema validation`,description:'Exact schema and human-envelope quote match only; not independent authorship or semantic correctness.',view:'scores-boolean',dimensions:[{field:'name'}],metrics:[{measure:'count',agg:'count'},{measure:'value',agg:'avg'}],filters:scores},
  ]
  for(const [position,definition]of definitions.entries()){
    const title=`${definition.name} · ${run.slice(0,8)}`
    const prior=allWidgets.find((w:{name:string})=>w.name===title)
    const body={...definition,name:title,chartType:'PIVOT_TABLE',chartConfig:{type:'PIVOT_TABLE',row_limit:20}}
    const widget=await api('unstable/dashboard-widgets'+(prior?'/'+prior.id:''),prior?'PATCH':'POST',body)
    placements.push({type:'widget',id:promptAbHash([run,arm,position]).slice(0,16),widgetId:widget.id,x:index*6,y:position*3,width:6,height:3})
  }
}
await api('unstable/dashboards/'+dashboard.id,'PATCH',{description,definition:{widgets:placements}})
const from=new Date(row.created_at);from.setUTCHours(0,0,0,0)
const url=`${publicUrl}/project/learning/dashboards/${dashboard.id}?dateRange=${from.getTime()}-${from.getTime()+86400000}`
await q("UPDATE learning_consolidator_prompt_experiments SET summary=summary||$2::jsonb WHERE run_id=$1",[run,JSON.stringify({dashboardUrl:url,pairedOutcomes:{unequal,equal,bothUnknown,skips,changed}})])
console.log(JSON.stringify({url,unequal,equal,bothUnknown,skips,changed}))
await handle.close()
