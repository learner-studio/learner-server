import { defineWorkflow } from '../runtime/define.js'
import { ArchiveDispatchInput } from '@learner/core/lib/learning/learning-archive-coordinator.js'
import { VectorRunInput,VectorResult } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'

export const learningReactiveRoutingWorkflow=defineWorkflow({title:'Route indexed arrivals then admit affected concepts',input:VectorRunInput,output:VectorResult,
  func:async({},data,{workflow})=>{
    await workflow.do('Route pending indexed messages','routeLearningReactiveArrivalsStep',{}, {retries:2,retryDelay:'5s'})
    await workflow.do('Admit affected concepts','dispatchLearningReactiveConceptsStep',{}, {retries:2,retryDelay:'1s'})
    return {runId:data.runId,status:'completed'}
  },
})
export const learningReactiveConceptWorkflow=defineWorkflow({title:'Refresh one related concept from top-50 reconstructed turns',input:ArchiveDispatchInput,output:VectorResult,
  func:async({},data,{workflow})=>{
    await workflow.sleep('Coalesce related arrivals','2s')
    const pass=await workflow.do('Claim only the current dirty generation','claimLearningReactivePassStep',{...data,runId:workflow.runId},{retries:2,retryDelay:'1s'})
    const target=await workflow.do('Initialize immutable live vector run','prepareLearningReactivePassStep',data,{retries:2,retryDelay:'1s'})
    const plan=await workflow.do('Reuse top-50 original turn selection','prepareLearningVectorExperimentStep',{runId:target.runId},{retries:2,retryDelay:'5s'})
    let prepared:{runId:string}
    for(const batch of plan.batches) {
        prepared=await workflow.do('Reuse source-backed concept preparation','prepareLearningVectorAssessmentStep',{runId:target.runId,conceptId:target.conceptId,part:batch[0]!.part,parentWorkflowId:workflow.runId},{retries:2,retryDelay:'1s'})
        await workflow.do('Reuse original assessment and paid-attempt fence','executeLearningConceptAssessmentStep',prepared,{retries:0})
    }
    await workflow.do('Record full receipt coverage','finishLearningVectorExperimentStep',{runId:target.runId},{retries:2,retryDelay:'1s'})
    const published=await workflow.do('Publish only validated final node estimate','publishLearningReactivePassStep',pass,{retries:2,retryDelay:'1s'})
    await workflow.do('Acknowledge only the assessed generation','settleLearningReactivePassStep',pass,{retries:2,retryDelay:'1s'})
    await workflow.do('Immediately refill rolling concept slots','dispatchLearningReactiveConceptsStep',{}, {retries:2,retryDelay:'1s'})
    return published
  },
})
