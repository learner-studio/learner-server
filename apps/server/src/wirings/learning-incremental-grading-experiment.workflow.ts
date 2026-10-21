import {defineWorkflow} from '../runtime/define.js'
import {IncGradingRun,IncGradingAny} from '../functions/learning/learning-incremental-grading-experiment.function.js'

export const learningIncrementalGradingWorkflow=defineWorkflow({title:'Incremental grading optimization — v5 baseline, Opus golden review, v6 replay arms, Opus feedback',input:IncGradingRun,output:IncGradingAny,
  func:async({},data,{workflow})=>{
    const frozen=await workflow.do('Freeze sample, arms and per-concept history','freezeIncGradingStep',data,{retries:1,retryDelay:'10s'})
    await workflow.do('Create or reuse the sample Langfuse dataset and score configs','setupIncGradingStep',data,{retries:1,retryDelay:'5s'})
    await workflow.do('Run the v5 full-history baseline','runIncGradingBaselineStep',data,{retries:1,retryDelay:'5s'})
    const reviews=await workflow.do('Enqueue Opus golden reviews of the baseline','enqueueIncGradingReviewsStep',data,{retries:2,retryDelay:'1s'})
    for(const increment of frozen.increments)await workflow.do('Run one increment wave across every arm','runIncGradingWaveStep',{...data,increment},{retries:1,retryDelay:'5s'})
    await workflow.do('Observe the golden reviews','waitIncGradingReviewsStep',{...data,jobIds:reviews.jobIds},{retries:1,retryDelay:'5s'})
    await workflow.do('Freeze golden labels once and write them as expected outputs','labelIncGradingGoldenStep',data,{retries:2,retryDelay:'5s'})
    await workflow.do('Export, verify native read-back and score every arm','finalizeIncGradingStep',data,{retries:3,retryDelay:'10s'})
    await workflow.do('Ask Opus for a revised prompt and context allowance','runIncGradingFeedbackStep',data,{retries:1,retryDelay:'5s'})
    return await workflow.do('Record the candidate for operator approval','recordIncGradingCandidateStep',data,{retries:2,retryDelay:'5s'})
  },
})
