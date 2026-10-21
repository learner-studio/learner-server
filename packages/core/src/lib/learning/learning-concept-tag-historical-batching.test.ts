import {test} from 'node:test'
import assert from 'node:assert/strict'
import {historicalBatchPlan} from './learning-concept-tag-historical-batching.js'
test('new compact full-catalog plan explicitly freezes bounded concurrency',()=>{
 assert.equal(historicalBatchPlan(catalog,10,10,470,5).budget.concurrency,5)
 assert.equal(historicalBatchPlan(catalog,10,10,470,5).budget.plannedPaidCalls,10)
 for(const concurrency of [0,6,1.5,NaN])assert.throws(()=>historicalBatchPlan(catalog,10,50,100,concurrency),/concurrency/)
})
const catalog=Array.from({length:470},(_,i)=>({id:`id-${i}`,ref:`c${i+1}`,title:`Title ${i}`}))
test('default frozen plan splits 470 exact title-only refs into 100/100/100/100/70',()=>{
 const p=historicalBatchPlan(catalog,100,500)
 assert.deepEqual(p.chunks.map(c=>c.length),[100,100,100,100,70])
 assert.deepEqual(p.chunks.flat(),catalog)
 assert.deepEqual(p.budget,{maxPaidCalls:500,questionsPerCall:100,questionBatchSize:100,plannedPaidCalls:500,chunksPerCase:5,maxAttempts:1,concurrency:1})
 assert.equal(historicalBatchPlan(catalog,100,1000,50).budget.plannedPaidCalls,1000)
 for(const n of [0,471,1.5,NaN])assert.throws(()=>historicalBatchPlan(catalog,100,500,n),/batch size/)
 assert.throws(()=>historicalBatchPlan(catalog,100,499),/budget/)
})
