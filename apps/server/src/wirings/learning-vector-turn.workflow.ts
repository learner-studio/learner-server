import { defineWorkflow } from '../runtime/define.js'
import { VectorResult, VectorWorkflowInput, VectorConceptJob } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'

export const learningVectorTurnWorkflow=defineWorkflow({title:'dev1: vector+turns consolidation',input:VectorWorkflowInput,output:VectorResult,
  func:async({},data,{workflow})=>{
    const plan=await workflow.do('Select all matching turns and record configuration','prepareLearningVectorExperimentStep',{runId:data.runId},{retries:1,retryDelay:'5s'})
    const jobs=await workflow.do('Enqueue rolling concept jobs','enqueueLearningVectorConceptsStep',{runId:data.runId,plan},{retries:2,retryDelay:'1s'})
    // These waits only observe completion: all jobs were already enqueued and
    // native workers keep refilling independently while the parent observes.
    for(const jobId of jobs.jobIds) {
      await workflow.do('Observe native concept completion','waitLearningVectorJobStep',{jobId},{retries:1,retryDelay:'1s'})
    }
    const finished=await workflow.do('Publish experiment coverage','finishLearningVectorExperimentStep',{runId:data.runId},{retries:2,retryDelay:'1s'})
    return finished
  }})

export const learningVectorConceptWorkflow=defineWorkflow({
  title:'Consolidate one concept sequentially',input:VectorConceptJob,output:VectorResult,
  func:async({},data,{workflow})=>{
    for(const part of data.parts) {
      const prepared=await workflow.do('Prepare original concept evidence','prepareLearningVectorAssessmentStep',{runId:data.runId,conceptId:data.conceptId,part,parentWorkflowId:data.parentWorkflowId},{retries:2,retryDelay:'1s'})
      await workflow.do('Consolidate concept evidence','executeLearningConceptAssessmentStep',prepared,{retries:0})
    }
    return {runId:data.runId,status:'completed'}
  },
})
