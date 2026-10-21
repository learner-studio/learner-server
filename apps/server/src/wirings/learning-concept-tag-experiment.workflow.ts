import {defineWorkflow} from '../runtime/define.js'
import {ConceptTagRun,ConceptTagItem,ConceptTagAny} from '../functions/learning/learning-concept-tag-rpc.function.js'
export const learningConceptTagExperimentWorkflow=defineWorkflow({title:'SYNTHETIC concept tags: full curriculum mock experiment',input:ConceptTagRun,output:ConceptTagAny,func:async({},data,{workflow})=>{
 await workflow.do('Prepare and read back native synthetic dataset and score configs','setupLearningConceptTagStep',data,{retries:1,retryDelay:'2s'})
 const jobs=await workflow.do('Interleave mock arms with one shared queue slot','enqueueLearningConceptTagStep',data,{retries:1,retryDelay:'1s'})
 for(const jobId of jobs.jobIds){await workflow.do('Observe real durable item completion','waitLearningConceptTagJobStep',{jobId},{retries:0})}
 return await workflow.do('Verify exact native experiment outputs and all scores','finalizeLearningConceptTagStep',data,{retries:8,retryDelay:'5s'})
}})
export const learningConceptTagExperimentItemWorkflow=defineWorkflow({title:'SYNTHETIC one concept-tag result and telemetry projection',input:ConceptTagItem,output:ConceptTagAny,func:async({},data,{workflow})=>{
 await workflow.do('Claim provider attempt and persist receipt before telemetry','executeLearningConceptTagStep',data,{retries:0})
 return await workflow.do('Durably queue audit independently of result readiness','enqueueLearningConceptTagAuditStep',data,{retries:1,retryDelay:'1s'})
}})
