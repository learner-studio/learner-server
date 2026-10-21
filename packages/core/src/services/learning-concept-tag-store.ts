import {TagProviderFailure} from '@learner/llm/services/typesafe-decision-service.js'
import {metaDbQuery as q,metaDbWithClient} from '../lib/db-metadata/_shared.js'
import {tagHash,type TagManifest,type TagArm} from '../lib/learning/learning-concept-tag-experiment.js'
export type TagReceipt={ids:string[];valid:boolean;raw:string;request:unknown;returnedModel:string|null;usage:unknown;error:string|null;startedAt:string;completedAt:string;latencyMs:number;queueWaitMs:number;endToEndMs:number;providerMode:'mock'|'live';synthetic:boolean}
export type TagStoredItem={case_id:string;arm:TagArm;reserved_at:Date|null;receipt:any;export_state:string;created_at:Date;enqueued_at:Date|null;workflow_run_id:string|null}
export type TagStoredRun={run_id:string;user_id:string;manifest:TagManifest;status:string;dataset_id:string|null;score_configs:Record<string,string>;summary:any;created_at:Date;items:TagStoredItem[]}
export async function tagItem(runId:string,caseId:string,arm:TagArm,query=q):Promise<TagStoredItem>{
 const row=(await query('SELECT case_id,arm,reserved_at,receipt::text AS journal,export_state,created_at,enqueued_at,workflow_run_id FROM learning_concept_tag_items WHERE run_id=$1 AND case_id=$2 AND arm=$3',[runId,caseId,arm])).rows[0]
 if(!row)throw new Error('Unknown planned item')
 return {...row,receipt:row.journal?JSON.parse(row.journal):null}
}
export async function tagRun(runId:string,caseId?:string,arm?:TagArm):Promise<TagStoredRun>{
 const row=(await q('SELECT * FROM learning_concept_tag_experiments WHERE run_id=$1',[runId])).rows[0]
 if(!row)throw new Error('Experiment not found')
 return {...row,manifest:row.manifest as TagManifest,items:caseId!==undefined&&arm!==undefined?[await tagItem(runId,caseId,arm)]:(await q('SELECT * FROM learning_concept_tag_items WHERE run_id=$1 ORDER BY case_id,arm',[runId])).rows}
}
export async function saveTagManifest(runId:string,userId:string,manifest:TagManifest){
 await metaDbWithClient(async c=>{await c.query('BEGIN');try{
 await c.query('INSERT INTO learning_concept_tag_experiments(run_id,user_id,manifest) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING',[runId,userId,JSON.stringify(manifest)])
 for(const item of manifest.cases)for(const arm of manifest.arms)await c.query('INSERT INTO learning_concept_tag_items(run_id,case_id,arm) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[runId,item.id,arm])
 await c.query('COMMIT')
 }catch(e){await c.query('ROLLBACK');throw e}})
 const row=await tagRun(runId)
 if(row.user_id!==userId||tagHash(row.manifest)!==tagHash(manifest))throw new Error('Frozen manifest identity conflict')
}
/** A reservation without a receipt is uncertain; no implicit redispatch. */
export async function executeTagOnce(runId:string,caseId:string,arm:TagArm,provider:()=>Promise<{ids:string[];raw:string;request:unknown;returnedModel:string;usage:unknown}>){
 const row=await tagRun(runId,caseId,arm),item=row.items.find(i=>i.case_id===caseId&&i.arm===arm)
 if(!item)throw new Error('Unknown planned item')
 if(item.receipt)return item.receipt as TagReceipt
 if(row.status==='cancelled')throw new Error('Experiment cancelled before dispatch')
 const claim=await metaDbWithClient(async client=>{await client.query('BEGIN');try{
 const run=(await client.query('SELECT status FROM learning_concept_tag_experiments WHERE run_id=$1 FOR UPDATE',[runId])).rows[0]
 if(run?.status==='cancelled')throw new Error('Experiment cancelled before dispatch')
 if(row.manifest.providerMode==='live'){
  const flags=(await client.query("SELECT COALESCE(bool_or(reserved_at IS NOT NULL AND receipt IS NULL),false) AS uncertain,COALESCE(bool_or(receipt->>'valid'='false'),false) AS failed FROM learning_concept_tag_items WHERE run_id=$1 AND arm='jev-live'",[runId])).rows[0]
  if(flags.failed)throw new Error('Live provider circuit open')
  if(flags.uncertain)throw new Error('Provider attempt uncertain; replacement run required')
 }
 const result=await client.query('UPDATE learning_concept_tag_items SET reserved_at=now() WHERE run_id=$1 AND case_id=$2 AND arm=$3 AND reserved_at IS NULL RETURNING created_at',[runId,caseId,arm])
 await client.query('COMMIT');return result
 }catch(e){await client.query('ROLLBACK');throw e}})
 if(!claim.rowCount)throw new Error('Provider attempt uncertain; replacement run required')
 const startedAt=new Date().toISOString(),start=performance.now(),queued=new Date(item.enqueued_at??item.created_at).getTime()
 let value:{ids:string[];raw:string;request:unknown;returnedModel:string|null;usage:unknown}={ids:[],raw:'',request:null,returnedModel:null,usage:null},error:string|null=null
 try{value=await provider()}catch(e){error=e instanceof Error?e.message:'Provider failure';if(e instanceof TagProviderFailure)value={...value,raw:e.raw,request:e.request}}
 const receipt:TagReceipt={...value,error,valid:error===null,startedAt,completedAt:new Date().toISOString(),latencyMs:performance.now()-start,queueWaitMs:Date.parse(startedAt)-queued,endToEndMs:Date.now()-queued,providerMode:row.manifest.providerMode,synthetic:row.manifest.synthetic}
 await q('UPDATE learning_concept_tag_items SET receipt=$4::jsonb WHERE run_id=$1 AND case_id=$2 AND arm=$3 AND receipt IS NULL',[runId,caseId,arm,JSON.stringify(receipt)])
 return receipt
}
