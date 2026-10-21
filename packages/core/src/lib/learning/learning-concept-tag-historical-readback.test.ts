import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readHistoricalNative} from './learning-concept-tag-historical-readback.js'
import {tagIds} from './learning-concept-tag-telemetry.js'

test('native reads are scoped, use useful pages, bounded rolling parallelism and share dataset reads',async()=>{
 const row:any={run_id:'run',created_at:new Date(),manifest:{arms:['baseline-import','jev-live']},items:Array.from({length:8},(_,i)=>({case_id:`c${Math.floor(i/2)}`,arm:i%2?'jev-live':'baseline-import'}))}
 let active=0,peak=0;const paths:string[]=[]
 const request=async(path:string)=>{paths.push(path);active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;const u=new URL(path,'http://local');assert.ok(!u.searchParams.has('limit')||u.searchParams.get('limit')==='100');if(u.pathname.endsWith('scores'))assert.ok(u.searchParams.get('traceId'));return u.pathname.includes('/dataset-items/')?{id:u.pathname.split('/').pop()}:{data:[],meta:{}}}
 const result=await readHistoricalNative(row,request)
 assert.ok(peak>1&&peak<=4,`read concurrency ${peak}`)
 assert.equal(paths.filter(p=>p.includes('/dataset-items/')).length,4)
 assert.equal(result.items.size,8)
 assert.equal(result.items.get(tagIds('run','c0','jev-live').traceId)?.scores.pages,1)
})
test('cursor pagination continues and refuses repeated cursors without losing duplicates',async()=>{
 const row:any={run_id:'run',created_at:new Date(),manifest:{arms:['jev-live']},items:[{case_id:'c',arm:'jev-live'}]}
 await assert.rejects(readHistoricalNative(row,async(path:string)=>path.includes('/dataset-items/')?{}:{data:[{id:'duplicate'},{id:'duplicate'}],meta:{cursor:'same'}}),/Cursor loop/)
 const result=await readHistoricalNative(row,async(path:string)=>path.includes('/dataset-items/')?{}:{data:[{id:'duplicate'},{id:'duplicate'}],meta:{}})
 assert.equal([...result.items.values()][0]!.scores.data.length,2,'must not deduplicate physical duplicate evidence')
})
