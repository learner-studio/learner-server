import {metaDbQuery,metaDbWithClient,type MetaDbPgModule} from '../lib/db-metadata/_shared.js'
import {tagItem,type TagStoredRun} from './learning-concept-tag-store.js'
import {TagProviderFailure,type TypeSafeDecisionService} from '@learner/llm/services/typesafe-decision-service.js'
import {tagHash} from '../lib/learning/learning-concept-tag-experiment.js'
import {historicalBatchPlan} from '../lib/learning/learning-concept-tag-historical-batching.js'
import {historicalDecisionRequest} from '../lib/learning/learning-concept-tag-historical.js'
const defaultDb:MetaDbPgModule={query:metaDbQuery,withClient:metaDbWithClient}
/** A lease distinguishes live work from uncertainty; expiry NEVER permits redispatch.
 * The 90s fence exceeds the provider's 30s HTTP deadline. Late owners may save results.
 * Claims and settlements lock the run row, serializing budget/cancel/circuit decisions.
 */
export async function executeHistoricalChunks(row:TagStoredRun,caseId:string,service:TypeSafeDecisionService,db:MetaDbPgModule=defaultDb){
 const h=row.manifest.historical,c=row.manifest.cases.find(c=>c.id===caseId)
 if(!c)throw new Error('Unknown historical case')
 const plan=historicalBatchPlan(h.sourceCatalog,row.manifest.cases.length,h.budget.maxPaidCalls,h.budget.questionBatchSize,h.budget.concurrency??1)
 if(tagHash(plan.budget)!==tagHash({...h.budget,concurrency:h.budget.concurrency??1}))throw new Error('Frozen batch budget mismatch')
 const initial=await tagItem(row.run_id,caseId,'jev-live',db.query)
 if(initial.receipt?.complete)return initial.receipt
 for(const [index,concepts]of plan.chunks.entries()){
  const request=historicalDecisionRequest(concepts,c.text,c.context),requestHash=tagHash(request),token=crypto.randomUUID()
  const saved=await db.withClient(async client=>{await client.query('BEGIN');try{
   const run=(await client.query("SELECT status,(manifest->'historical'->'budget')::text AS config FROM learning_concept_tag_experiments WHERE run_id=$1 FOR UPDATE",[row.run_id])).rows[0]
   if(!run||tagHash(JSON.parse(run.config))!==tagHash(h.budget))throw new Error('Frozen batch budget mismatch')
   // One-time legacy adoption. No historical receipt or manifest is updated.
   const exists=(await client.query('SELECT reserved_count AS reserved,failed_count AS failed FROM learning_concept_tag_budgets WHERE run_id=$1',[row.run_id])).rows[0]
   if(!exists){
    await client.query(`INSERT INTO learning_concept_tag_reservations(run_id,case_id,chunk_index,request_hash,reserved_at,state,receipt)
     SELECT i.run_id,i.case_id,(j->>'index')::integer,j->>'requestHash',COALESCE((j->>'reservedAt')::timestamptz,i.reserved_at,now()),
      CASE WHEN j->'receipt' IS NULL OR j->'receipt'='null'::jsonb THEN 'uncertain' WHEN j->'receipt'->>'valid'='true' THEN 'succeeded' ELSE 'failed' END,NULLIF(j->'receipt','null'::jsonb)
     FROM learning_concept_tag_items i CROSS JOIN LATERAL jsonb_array_elements(COALESCE(i.receipt->'chunks','[]'::jsonb)) j
     WHERE i.run_id=$1 AND i.arm='jev-live'`,[row.run_id])
    // A pre-journal reservation is also uncertain, not a free budget slot.
    await client.query(`INSERT INTO learning_concept_tag_reservations(run_id,case_id,chunk_index,reserved_at,state,receipt)
     SELECT run_id,case_id,0,reserved_at,CASE WHEN receipt IS NULL THEN 'uncertain' WHEN receipt->>'valid'='true' THEN 'succeeded' ELSE 'failed' END,receipt
     FROM learning_concept_tag_items WHERE run_id=$1 AND arm='jev-live' AND reserved_at IS NOT NULL AND (receipt IS NULL OR receipt->'chunks' IS NULL) ON CONFLICT DO NOTHING`,[row.run_id])
    await client.query(`INSERT INTO learning_concept_tag_budgets(run_id,reserved_count,failed_count)
     SELECT $1,count(*)::integer,count(*) FILTER(WHERE state='failed')::integer FROM learning_concept_tag_reservations WHERE run_id=$1`,[row.run_id])
   }
   const prior=(await client.query('SELECT request_hash AS hash,state,COALESCE(lease_until<=now(),true) AS stale,receipt::text AS journal FROM learning_concept_tag_reservations WHERE run_id=$1 AND case_id=$2 AND chunk_index=$3',[row.run_id,caseId,index])).rows[0]
   if(prior){
    if(!prior.journal)throw new Error(prior.state==='active'&&!prior.stale?'Provider chunk active leased attempt; uncertain to a duplicate executor; no redispatch':'Provider chunk attempt uncertain; replacement run required')
    if(prior.hash!==requestHash)throw new Error('Frozen chunk identity mismatch')
    await client.query('COMMIT');return JSON.parse(prior.journal)
   }
   if(run.status==='cancelled')throw new Error('Cancelled before chunk dispatch')
   const budget=(await client.query('SELECT reserved_count AS reserved,failed_count AS failed FROM learning_concept_tag_budgets WHERE run_id=$1',[row.run_id])).rows[0]
   const pending=(await client.query(`SELECT count(*)::integer AS active,COALESCE(bool_or(state='uncertain' OR lease_until IS NULL OR lease_until<=now()),false) AS uncertain FROM learning_concept_tag_reservations WHERE run_id=$1 AND state IN ('active','uncertain')`,[row.run_id])).rows[0]
   if(pending.uncertain)throw new Error('Provider chunk attempt uncertain; replacement run required')
   if(budget.failed)throw new Error('Historical provider circuit open')
   if(budget.reserved>=h.budget.maxPaidCalls)throw new Error('Frozen paid budget exhausted')
   if(pending.active>=plan.budget.concurrency)throw new Error('Paid concurrency capacity occupied by active leased work')
   const reservedAt=new Date().toISOString()
   await client.query("INSERT INTO learning_concept_tag_reservations(run_id,case_id,chunk_index,request_hash,owner_token,reserved_at,lease_until,state) VALUES($1,$2,$3,$4,$5,$6,now()+interval '90 seconds','active')",[row.run_id,caseId,index,requestHash,token,reservedAt])
   await client.query('UPDATE learning_concept_tag_budgets SET reserved_count=reserved_count+1 WHERE run_id=$1',[row.run_id])
   const updated=await client.query(`UPDATE learning_concept_tag_items SET reserved_at=COALESCE(reserved_at,now()),receipt=jsonb_set(COALESCE(receipt,'{"chunkJournal":true,"complete":false,"chunks":[]}'::jsonb),'{chunks}',COALESCE(receipt->'chunks','[]'::jsonb)||$3::jsonb)
    WHERE run_id=$1 AND case_id=$2 AND arm='jev-live' AND COALESCE(receipt->>'complete','false')='false' AND jsonb_array_length(COALESCE(receipt->'chunks','[]'::jsonb))=$4 RETURNING case_id`,[row.run_id,caseId,JSON.stringify([{index,requestHash,reservedAt,receipt:null}]),index])
   if(!updated.rowCount)throw new Error('Completed or inconsistent chunk journal')
   await client.query('COMMIT');return null
  }catch(e){await client.query('ROLLBACK');throw e}})
  if(saved){if(!saved.valid)break;continue}
  const startedAt=new Date().toISOString(),start=performance.now()
  let result:any={ids:[],raw:'',request:{...request,model:row.manifest.modelSelection!.model},returnedModel:null,usage:null},error:string|null=null
  try{const response=await service.evaluate(row.manifest.modelSelection,request);result={...response,ids:concepts.filter(c=>response.answers[c.ref].noul>=row.manifest.threshold).map(c=>c.id).sort()}}
  catch(e){error=e instanceof Error?e.message:'Provider failure';if(e instanceof TagProviderFailure)result={...result,request:e.request,raw:e.raw}}
  const receipt={...result,error,valid:error===null,startedAt,completedAt:new Date().toISOString(),latencyMs:performance.now()-start,providerMode:'live',synthetic:false}
  // Result + circuit + compatible journal are one transaction; no telemetry in between.
  await db.withClient(async client=>{await client.query('BEGIN');try{
   await client.query('SELECT run_id FROM learning_concept_tag_experiments WHERE run_id=$1 FOR UPDATE',[row.run_id])
   const written=await client.query("UPDATE learning_concept_tag_reservations SET receipt=$5::jsonb,state=$6 WHERE run_id=$1 AND case_id=$2 AND chunk_index=$3 AND owner_token=$4 AND state='active' AND receipt IS NULL RETURNING receipt::text AS journal",[row.run_id,caseId,index,token,JSON.stringify(receipt),error?'failed':'succeeded'])
   if(written.rowCount!==1||tagHash(JSON.parse(written.rows[0].journal))!==tagHash(receipt))throw new Error('Chunk receipt persistence mismatch; no redispatch')
   const itemWrite=await client.query("UPDATE learning_concept_tag_items SET receipt=jsonb_set(receipt,$3::text[],$4::jsonb) WHERE run_id=$1 AND case_id=$2 AND arm='jev-live' AND receipt#> $3::text[]='null'::jsonb RETURNING case_id",[row.run_id,caseId,['chunks',String(index),'receipt'],JSON.stringify(receipt)])
   if(itemWrite.rowCount!==1)throw new Error('Chunk journal persistence mismatch; no redispatch')
   if(error)await client.query('UPDATE learning_concept_tag_budgets SET failed_count=failed_count+1 WHERE run_id=$1',[row.run_id])
   await client.query('COMMIT')
  }catch(e){await client.query('ROLLBACK');throw e}})
  if(error)break
 }
 const item=await tagItem(row.run_id,caseId,'jev-live',db.query),journal=item.receipt
 if(journal.complete)return journal
 const calls=journal.chunks.map((x:any)=>x.receipt)
 if(calls.some((r:any)=>!r))throw new Error('Provider chunk attempt uncertain')
 const valid=calls.length===plan.chunks.length&&calls.every((r:any)=>r.valid),first=calls[0],last=calls.at(-1),queued=new Date(item.enqueued_at??item.created_at).getTime()
 const aggregate={...journal,complete:true,valid,ids:valid?calls.flatMap((r:any)=>r.ids).sort():[],raw:JSON.stringify({chunkResponses:calls.map((r:any)=>r.raw)}),request:{chunked:true,questionsPerCall:h.budget.questionBatchSize,chunkCount:plan.chunks.length},returnedModel:valid?first.returnedModel:null,usage:calls.every((r:any)=>r.usage)?{input_tokens:calls.reduce((n:number,r:any)=>n+r.usage.input_tokens,0),output_tokens:calls.reduce((n:number,r:any)=>n+r.usage.output_tokens,0)}:null,error:valid?null:calls.find((r:any)=>r.error)?.error??'Incomplete chunk coverage',startedAt:first.startedAt,completedAt:last.completedAt,latencyMs:calls.reduce((n:number,r:any)=>n+r.latencyMs,0),queueWaitMs:Date.parse(first.startedAt)-queued,endToEndMs:Date.parse(last.completedAt)-queued,providerMode:'live',synthetic:false}
 const written=await db.query("UPDATE learning_concept_tag_items SET receipt=$3::jsonb WHERE run_id=$1 AND case_id=$2 AND arm='jev-live' AND receipt->>'complete'='false' RETURNING receipt::text AS journal",[row.run_id,caseId,JSON.stringify(aggregate)])
 if(written.rowCount)return JSON.parse(written.rows[0].journal)
 return (await tagItem(row.run_id,caseId,'jev-live',db.query)).receipt
}
