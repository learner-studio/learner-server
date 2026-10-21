import type {HistoricalConcept} from './learning-concept-tag-historical.js'
/** New runs only. Legacy frozen manifests keep their original single-call protocol. */
export function historicalBatchPlan(catalog:HistoricalConcept[],caseCount:number,maxPaidCalls:number,questionBatchSize=100,concurrency=1){
 if(!Number.isInteger(questionBatchSize)||questionBatchSize<1||questionBatchSize>470)throw new Error('Question batch size must be an integer from 1 to 470')
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>5)throw new Error('Paid concurrency must be an integer from 1 to 5')
 const chunks:HistoricalConcept[][]=[]
 for(let i=0;i<catalog.length;i+=questionBatchSize)chunks.push(catalog.slice(i,i+questionBatchSize))
 const plannedPaidCalls=caseCount*chunks.length
 if(!Number.isInteger(maxPaidCalls)||maxPaidCalls<plannedPaidCalls)throw new Error('Explicit paid call budget is below frozen batch plan')
 return {chunks,budget:{maxPaidCalls,questionsPerCall:questionBatchSize,questionBatchSize,plannedPaidCalls,chunksPerCase:chunks.length,maxAttempts:1,concurrency}}
}
