import {test} from 'node:test'
import assert from 'node:assert/strict'
import {enqueueTagPlan} from './learning-concept-tag-dispatch.js'
test('feeds five durable admissions concurrently without waiting for each DB round trip',async()=>{
 const row:any={run_id:'r',manifest:{historical:{budget:{concurrency:5}},cases:Array.from({length:10},(_,i)=>({id:`c${i}`})),arms:['baseline-import','jev-live']}}
 let active=0,peak=0;const started:string[]=[]
 const ids=await enqueueTagPlan(row,async c=>{active++;peak=Math.max(peak,active);started.push(c.arm);await new Promise(r=>setTimeout(r,2));active--;return c.jobKey})
 assert.equal(peak,5);assert.deepEqual(started.slice(0,10),Array(10).fill('jev-live'))
 assert.equal(ids.length,20);assert.equal(new Set(ids).size,20)
})
test('serial frozen tier still admits one at a time and failures stop future admissions',async()=>{
 const row:any={run_id:'r',manifest:{historical:{budget:{concurrency:1}},cases:[{id:'a'},{id:'b'}],arms:['jev-live']}}
 let calls=0;await assert.rejects(enqueueTagPlan(row,async()=>{calls++;throw Error('db down')}),/db down/);assert.equal(calls,1)
})
