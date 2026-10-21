import {enqueueTagPlan} from '@learner/core/lib/learning/learning-concept-tag-dispatch.js'
import {readTagReadiness} from '@learner/core/lib/learning/learning-concept-tag-readiness.js'
import {executeHistoricalItem} from '@learner/core/lib/learning/learning-concept-tag-historical-runtime.js'
import {defineFunction,defineSessionlessFunction} from '../../runtime/define.js'
import {z} from 'zod'
import {appModelSelectionSchema,resolveModelCapability} from '@learner/llm/lib/llm/model-catalog.js'
import {readFile} from 'node:fs/promises'
import {metaDbQuery as q} from '@learner/core/lib/db-metadata/_shared.js'
import {tagHash,type TagManifest} from '@learner/core/lib/learning/learning-concept-tag-experiment.js'
import {syntheticTagCases,syntheticTagProvider,liveTagCases} from '@learner/core/lib/learning/learning-concept-tag-fixture.js'
import {tagRun,saveTagManifest,executeTagOnce} from '@learner/core/services/learning-concept-tag-store.js'
import {setupTagLangfuse,exportTagItem} from '@learner/core/lib/learning/learning-concept-tag-telemetry.js'
import {verifyTagLangfuse} from '@learner/core/lib/learning/learning-concept-tag-readback.js'
export const ConceptTagRun=z.object({runId:z.string().uuid()})
export const ConceptTagStart=ConceptTagRun.extend({curriculumId:z.string().min(1),providerMode:z.enum(['mock','live']),prepareOnly:z.boolean(),paidApproved:z.boolean().default(false),selection:appModelSelectionSchema.optional(),caseLimit:z.number().int().min(1).max(6).optional()})
export const ConceptTagItem=ConceptTagRun.extend({caseId:z.string(),arm:z.enum(['jev-mock','baseline-mock','jev-live','baseline-import']),jobKey:z.string()})
export const ConceptTagAny=z.record(z.string(),z.unknown())
export const ConceptTagJobs=z.object({jobIds:z.array(z.string())})
export const ConceptTagJob=z.object({jobId:z.string()})
export const startLearningConceptTagExperiment=defineFunction({title:'Prepare/start explicitly synthetic concept tagging experiment',expose:true,scopes:['admin'],input:ConceptTagStart,output:ConceptTagAny,
 func:async({learningCurriculumStore,locks,workflowService,typesafeDecision},data,{session,rpc})=>{
 if(data.providerMode==='live')resolveModelCapability(data.selection??typesafeDecision.defaultSelection,'noul')
 if(data.providerMode==='live'){if(!data.paidApproved)throw new Error('Explicit bounded paid approval required');typesafeDecision.assertConfigured()}
 return locks.withLock('concept-tag-start',data.runId,async()=>{
 const exists=(await q('SELECT user_id,manifest,status FROM learning_concept_tag_experiments WHERE run_id=$1',[data.runId])).rows[0]
 if(exists&&(exists.user_id!==session.userId||exists.manifest.curriculumId!==data.curriculumId||exists.manifest.providerMode!==data.providerMode))throw new Error('Experiment identity conflict')
 if(exists&&data.selection&&tagHash(exists.manifest.modelSelection)!==tagHash(data.selection))throw new Error('Frozen model selection conflict')
 if(exists&&data.caseLimit&&exists.manifest.cases.length!==data.caseLimit)throw new Error('Frozen case limit conflict')
 if(exists?.status==='cancelled')throw new Error('Experiment cancelled')
 if(!exists){
 const graphs=await learningCurriculumStore.listGraphsVisibleTo(session.userId),graph=graphs.find(g=>g.curriculum.id===data.curriculumId)
 if(!graph)throw new Error('Selected curriculum unavailable to owner')
 const concepts=[...graph.concepts].sort((a,b)=>a.id.localeCompare(b.id)).map((c,i)=>({id:c.id,ref:`c${i+1}`,title:c.title,domain:c.domain}))
 const paths=['packages/server/src/services.ts','packages/llm/src/lib/llm/model-catalog.ts','packages/core/src/lib/learning/learning-concept-tag-experiment.ts','packages/core/src/lib/learning/learning-concept-tag-fixture.ts','packages/core/src/lib/learning/learning-concept-tag-telemetry.ts','packages/core/src/lib/learning/learning-concept-tag-readback.ts','packages/llm/src/lib/llm/learning-experiment-langfuse-transport.ts','packages/server/src/wiring/queues.ts','packages/core/src/services/learning-concept-tag-store.ts','packages/llm/src/services/typesafe-decision-service.ts','packages/server/src/functions/learning/learning-concept-tag-rpc.function.ts','packages/server/src/wirings/learning-concept-tag-experiment.workflow.ts']
 const source=Object.fromEntries(await Promise.all(paths.map(async p=>[p,tagHash(await readFile(p,'utf8'))])))
 const git=Bun.spawn(['git','rev-parse','HEAD'],{stdout:'pipe',stderr:'ignore'}),revision=(await new Response(git.stdout).text()).trim();if(await git.exited)throw new Error('Cannot freeze code revision')
 const manifest:TagManifest={...(data.providerMode==='live'?{modelSelection:resolveModelCapability(data.selection??typesafeDecision.defaultSelection,'noul').selection}:{}),name:`${data.providerMode}-synthetic-concept-tags-v1/${data.curriculumId}/${data.runId}`,providerMode:data.providerMode,synthetic:true,curriculumId:data.curriculumId,concepts,cases:(data.providerMode==='live'?liveTagCases(concepts):syntheticTagCases(concepts)).slice(0,data.caseLimit??6),arms:data.providerMode==='live'?['jev-live']:['jev-mock','baseline-mock'],threshold:.5,code:{gitRevision:revision,sourceHash:tagHash(source),...source}}
 await saveTagManifest(data.runId,session.userId,manifest)
 }
 if(!data.prepareOnly){
 const prior=(await q("SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningConceptTagExperimentWorkflow' AND input::jsonb->>'runId'=$1",[data.runId])).rows[0]
 if(!prior)await workflowService.startWorkflow('learningConceptTagExperimentWorkflow',{runId:data.runId},{type:'http',userId:session.userId},rpc)
 }
 return {runId:data.runId,status:data.prepareOnly?'prepared':'started'}
 })
 }})
export const getLearningConceptTagExperiment=defineFunction({expose:true,readonly:true,scopes:['admin'],input:ConceptTagRun,output:ConceptTagAny,func:async({},data,{session})=>{
 const row=await tagRun(data.runId);if(row.user_id!==session.userId)throw new Error('Not experiment owner')
 const workflows=(await q("SELECT workflow_run_id,workflow,status,error FROM learner_workflow_runs WHERE input::jsonb->>'runId'=$1 ORDER BY created_at",[data.runId])).rows
 return {...await readTagReadiness(row),runId:data.runId,status:row.status,manifest:row.manifest,conceptCount:row.manifest.concepts.length,summary:row.summary,items:row.items,workflows}
}})
export const cancelLearningConceptTagExperiment=defineFunction({expose:true,scopes:['admin'],input:ConceptTagRun,output:ConceptTagAny,func:async({},data,{session})=>{
 const row=await tagRun(data.runId);if(row.user_id!==session.userId)throw new Error('Not experiment owner');await q("UPDATE learning_concept_tag_experiments SET status='cancelled' WHERE run_id=$1",[data.runId]);return {status:'cancelled'}
}})
export const setupLearningConceptTagStep=defineSessionlessFunction({input:ConceptTagRun,output:ConceptTagAny,func:async({},data)=>setupTagLangfuse(data.runId)})
export const executeLearningConceptTagStep=defineSessionlessFunction({input:ConceptTagItem,output:ConceptTagAny,func:async({typesafeDecision},data)=>{
 const row=await tagRun(data.runId,data.caseId,data.arm),c=row.manifest.cases.find(c=>c.id===data.caseId);if(!c)throw new Error('Unknown case')
 if(row.manifest.historical)return executeHistoricalItem(row,data.caseId,data.arm,typesafeDecision)
 if(row.manifest.providerMode==='live'){
 if(data.arm!=='jev-live'||row.manifest.arms.length!==1||row.manifest.cases.length>6)throw new Error('Live budget/arm mismatch')
 if(row.items.some(i=>i.receipt&&!i.receipt.valid))throw new Error('Live probe failed; stop future paid dispatch')
 return executeTagOnce(data.runId,data.caseId,data.arm,()=>typesafeDecision.classify({concepts:row.manifest.concepts,text:c.text,context:c.context},row.manifest.threshold,row.manifest.modelSelection))
 }
 return executeTagOnce(data.runId,data.caseId,data.arm,()=>syntheticTagProvider(row.manifest.concepts,c,data.arm))
}})
export const exportLearningConceptTagStep=defineSessionlessFunction({input:ConceptTagItem,output:ConceptTagAny,func:async({},data)=>exportTagItem(data.runId,data.caseId,data.arm)})
export const finalizeLearningConceptTagStep=defineSessionlessFunction({input:ConceptTagRun,output:ConceptTagAny,func:async({},data)=>verifyTagLangfuse(data.runId)})
export const recoverLearningConceptTagExperiment=defineFunction({expose:true,scopes:['admin'],input:ConceptTagRun,output:ConceptTagAny,func:async({},data,{session})=>{
 const before=await tagRun(data.runId);if(before.user_id!==session.userId)throw new Error('Not experiment owner')
 for(const i of before.items)await exportTagItem(data.runId,i.case_id,i.arm)
 await verifyTagLangfuse(data.runId)
 const after=await tagRun(data.runId)
 return {reservationsBefore:before.items.reduce((n,i)=>n+(i.receipt?.chunkJournal?i.receipt.chunks.length:Number(Boolean(i.reserved_at))),0),reservationsAfter:after.items.reduce((n,i)=>n+(i.receipt?.chunkJournal?i.receipt.chunks.length:Number(Boolean(i.reserved_at))),0),receiptHashBefore:tagHash(before.items.map(i=>i.receipt)),receiptHashAfter:tagHash(after.items.map(i=>i.receipt))}
}})
export const enqueueLearningConceptTagStep=defineSessionlessFunction({input:ConceptTagRun,output:ConceptTagJobs,func:async({queueService,queueCancellationService,locks},data)=>{
 const row=await tagRun(data.runId)
 if(row.status==='cancelled')throw new Error('Cancelled')
 const jobIds=await enqueueTagPlan(row,job=>locks.withLock('concept-tag-enqueue',job.jobKey,async()=>{
 const old=await queueCancellationService.findByKey('learning.concept-tag',job.jobKey);if(old.length>1)throw new Error('Duplicate experiment job');if(!old.length)await q('UPDATE learning_concept_tag_items SET enqueued_at=COALESCE(enqueued_at,now()) WHERE run_id=$1 AND case_id=$2 AND arm=$3',[data.runId,job.caseId,job.arm]);return old[0]?.id??queueService.add('learning.concept-tag',job,{jobId:job.jobKey,attempts:1,group:{id:data.runId,tier:String(row.manifest.historical?.budget.concurrency??1)}})
 }))
 await q("UPDATE learning_concept_tag_experiments SET status='running' WHERE run_id=$1 AND status='prepared'",[data.runId]);return {jobIds}
}})
export const waitLearningConceptTagJobStep=defineSessionlessFunction({input:ConceptTagJob,output:ConceptTagAny,func:async({queueService},data)=>{
 const job=await queueService.getJob('learning.concept-tag',data.jobId);if(!job?.waitForCompletion)throw new Error('Native observer unavailable');await job.waitForCompletion(300000);return {status:'completed'}
}})
export const learningConceptTagQueue=defineSessionlessFunction({input:ConceptTagItem,output:ConceptTagAny,func:async({workflowService,locks},data,{rpc})=>locks.withLock('concept-tag-child',data.jobKey,async()=>{
 const prior=(await q("SELECT workflow_run_id,status FROM learner_workflow_runs WHERE workflow='learningConceptTagExperimentItemWorkflow' AND input::jsonb->>'jobKey'=$1 ORDER BY created_at LIMIT 1",[data.jobKey])).rows[0]
 let id:string
 if(prior){id=prior.workflow_run_id;if(prior.status!=='completed')await workflowService.runWorkflowJob(id,rpc)}else id=(await workflowService.startWorkflow('learningConceptTagExperimentItemWorkflow',data,{type:'internal'},rpc,{inline:true})).runId
 await q('UPDATE learning_concept_tag_items SET workflow_run_id=$4 WHERE run_id=$1 AND case_id=$2 AND arm=$3',[data.runId,data.caseId,data.arm,id])
 if((await workflowService.getRun(id))?.status!=='completed')throw new Error('Child incomplete; inspect receipt without redispatch')
 return {workflowRunId:id,status:'completed'}
})})
