import {defineFunction,defineSessionlessFunction} from '../../runtime/define.js'
import {z} from 'zod'
import {appModelSelectionSchema,resolveModelCapability} from '@learner/llm/lib/llm/model-catalog.js'
import {ConceptTagAny} from './learning-concept-tag-rpc.function.js'
import {metaDbQuery as q} from '@learner/core/lib/db-metadata/_shared.js'
import {prepareHistorical,assertHistoricalIdentity} from '@learner/core/lib/learning/learning-concept-tag-historical-runtime.js'
export const HistoricalTagStart=z.object({runId:z.string().uuid(),prepareOnly:z.boolean(),paidApproved:z.literal(true),selection:appModelSelectionSchema,maxPaidCalls:z.number().int().min(1),questionBatchSize:z.number().int().min(1).max(470).optional(),concurrency:z.number().int().min(1).max(5).optional(),caseIds:z.array(z.string().min(1)).min(1).max(100).refine(ids=>new Set(ids).size===ids.length,"Duplicate case IDs").optional()})
export const HistoricalTagPrepare=HistoricalTagStart.extend({userId:z.string()})
export const startLearningHistoricalTagExperiment=defineFunction({title:'Compare frozen real Seed V1 cases with existing Flash predictions',expose:true,scopes:['admin'],input:HistoricalTagStart,output:ConceptTagAny,func:async({workflowService,locks,typesafeDecision},data,{session,rpc})=>{
 resolveModelCapability(data.selection,'noul');typesafeDecision.assertConfigured()
 return locks.withLock('historical-tag-start',data.runId,async()=>{
 const old=(await q('SELECT user_id,manifest,status FROM learning_concept_tag_experiments WHERE run_id=$1',[data.runId])).rows[0];if(old&&old.user_id!==session.userId)throw new Error('Not experiment owner')
 if(old){assertHistoricalIdentity(old.manifest,resolveModelCapability(data.selection,'noul').selection,data.maxPaidCalls,data.questionBatchSize,data.concurrency,data.caseIds);if(old.status==='cancelled')throw new Error('Experiment cancelled')}
 const prior=(await q("SELECT workflow_run_id,status FROM learner_workflow_runs WHERE workflow='learningHistoricalTagExperimentWorkflow' AND input::jsonb->>'runId'=$1 AND input::jsonb->>'prepareOnly'=$2",[data.runId,String(data.prepareOnly)])).rows[0]
 if(prior)return {runId:data.runId,workflowRunId:prior.workflow_run_id,status:prior.status}
 const started=await workflowService.startWorkflow('learningHistoricalTagExperimentWorkflow',{...data,userId:session.userId},{type:'http',userId:session.userId},rpc)
 return {runId:data.runId,workflowRunId:started.runId,status:'started'}
 })
}})
export const prepareLearningHistoricalTagStep=defineSessionlessFunction({input:HistoricalTagPrepare,output:ConceptTagAny,func:async({},data)=>prepareHistorical(data.runId,data.userId,data.selection,data.maxPaidCalls,data.questionBatchSize,data.concurrency,data.caseIds)})
