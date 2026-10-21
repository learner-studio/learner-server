import {defineWorkflow} from '../runtime/define.js'
import {PromptAbRun,PromptAbItem,PromptAbAny} from '../functions/learning/learning-prompt-ab.function.js'

export const learningPromptAbWorkflow=defineWorkflow({title:'Consolidator v2 — paired 50-concept prompt experiment',input:PromptAbRun,output:PromptAbAny,
  func:async({},data,{workflow})=>{
    await workflow.do('Populate reusable frozen Langfuse dataset','setupLearningPromptAbStep',data,{retries:1,retryDelay:'5s'})
    const jobs=await workflow.do('Enqueue both arms under nine rolling slots','enqueueLearningPromptAbStep',data,{retries:2,retryDelay:'1s'})
    for(const jobId of jobs.jobIds){await workflow.do('Observe paired item completion','waitLearningPromptAbJobStep',{jobId},{retries:1,retryDelay:'1s'})}
    await workflow.do('Observe separate receipt-only audit jobs','waitLearningPromptAbAuditsStep',data,{retries:2,retryDelay:'1s'})
    return await workflow.do('Verify native experiment items and persist comparison','finalizeLearningPromptAbStep',data,{retries:2,retryDelay:'10s'})
  },
})
export const learningPromptAbItemWorkflow=defineWorkflow({title:'One experiment-only concept assessment and Langfuse projection',input:PromptAbItem,output:PromptAbAny,
  func:async({},data,{workflow})=>{
    await workflow.do('Execute existing structured assessment without mastery publication','executeLearningConceptAssessmentStep',{runId:data.assessmentRunId},{retries:0})
    return await workflow.do('Admit receipt-only audit without holding an assessment slot','enqueueLearningPromptAbAuditStep',data,{retries:2,retryDelay:'1s'})
  },
})
