import { defineWorkflow } from '../runtime/define.js'
import { ArchiveDispatchInput } from '@learner/core/lib/learning/learning-archive-coordinator.js'
import { VectorRunInput,VectorResult } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'

export const learningReactiveRoutingWorkflow=defineWorkflow({title:'Admit routed concepts, route indexed arrivals, then admit affected concepts',input:VectorRunInput,output:VectorResult,
  func:async({},data,{workflow})=>{
    // Admission first: a routing failure must never stop concepts that are already routed.
    await workflow.do('Admit already-routed concepts','dispatchLearningReactiveConceptsStep',{}, {retries:2,retryDelay:'1s'})
    // Per-arrival problems are held inside this step; it fails only when the bank itself is unavailable.
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
    // gradingReplicates (docs/specs/mastery-change-statistics.md): only the LAST part publishes, so only it is
    // graded k times and published as the mean, before the pass finishes (until then none of it is a reading).
    // At k = 1 the plan is empty and nothing else runs.
    // A pass with no batches (no evidence) has no assessment run: `prepared` is unset, and planning on it failed
    // input validation every time ("requires runId"), so such a concept could never settle.
    let replicas:{runId:string;replicates:number[]}={runId:target.runId,replicates:[]}
    if(plan.batches.length) {
        replicas=await workflow.do('Plan independent replicate gradings','planLearningAssessmentReplicatesStep',prepared!,{retries:2,retryDelay:'1s'})
    }
    for(const replicate of replicas.replicates) {
        await workflow.do('Grade one independent replicate','executeLearningAssessmentReplicateStep',{runId:replicas.runId,replicate},{retries:0})
    }
    if(replicas.replicates.length) await workflow.do('Publish the mean of the replicate gradings','combineLearningAssessmentReplicatesStep',prepared!,{retries:2,retryDelay:'1s'})
    await workflow.do('Record full receipt coverage','finishLearningVectorExperimentStep',{runId:target.runId},{retries:2,retryDelay:'1s'})
    const published=await workflow.do('Publish only validated final node estimate','publishLearningReactivePassStep',pass,{retries:2,retryDelay:'1s'})
    await workflow.do('Acknowledge only the assessed generation','settleLearningReactivePassStep',pass,{retries:2,retryDelay:'1s'})
    await workflow.do('Immediately refill rolling concept slots','dispatchLearningReactiveConceptsStep',{}, {retries:2,retryDelay:'1s'})
    return published
  },
})
