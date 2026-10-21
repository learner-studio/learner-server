import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import type {TagStoredRun} from './learning-concept-tag-store.js'
import {tagHash,type TagManifest} from '../lib/learning/learning-concept-tag-experiment.js'
import {historicalDecisionRequest} from '../lib/learning/learning-concept-tag-historical.js'
import {executeHistoricalChunks as executeChunks} from './learning-concept-tag-chunks.js'
import {TypeSafeDecisionService} from '@learner/llm/services/typesafe-decision-service.js'
import {historicalBatchPlan} from '../lib/learning/learning-concept-tag-historical-batching.js'
import type {MetaDbPgModule,MetaPgQueryFn} from '../lib/db-metadata/_shared.js'
import {Pool} from 'pg'
import {resolveDatabaseUrl} from '../db.js'
import {readFile} from 'node:fs/promises'
const schema='test_jev_'+crypto.randomUUID().replaceAll('-','')
const pool=new Pool({connectionString:resolveDatabaseUrl(),options:`-c search_path=${schema}`,max:10})
const queries:string[]=[]
const q:MetaPgQueryFn=async(sql,params)=>{queries.push(sql);const r=await pool.query(sql,params as any[]);return {rows:r.rows,rowCount:r.rowCount??0}}
const db:MetaDbPgModule={query:q,withClient:async fn=>{const c=await pool.connect();try{return await fn({query:async(sql,params)=>{queries.push(sql);const r=await c.query(sql,params as any[]);return {rows:r.rows,rowCount:r.rowCount??0}}})}finally{c.release()}}}
// Isolated disposable SQL fixtures only; NEVER applies a migration to app tables.
before(async()=>{
 await pool.query(`CREATE SCHEMA ${schema}`)
 for(const file of ['0179-learning-concept-tag-experiments.sql','0180-learning-concept-tag-enqueue-time.sql','0182-learning-concept-tag-reservations.sql'])await pool.query(await readFile(`db/postgres/${file}`,'utf8'))
})
after(async()=>{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end()})
async function saveTagManifest(id:string,userId:string,manifest:TagManifest){
 await q('INSERT INTO learning_concept_tag_experiments(run_id,user_id,manifest) VALUES($1,$2,$3)',[id,userId,JSON.stringify(manifest)])
 for(const c of manifest.cases)for(const arm of manifest.arms)await q('INSERT INTO learning_concept_tag_items(run_id,case_id,arm) VALUES($1,$2,$3)',[id,c.id,arm])
}
async function tagRun(id:string):Promise<TagStoredRun>{const r=(await q('SELECT * FROM learning_concept_tag_experiments WHERE run_id=$1',[id])).rows[0];return {...r,items:(await q('SELECT * FROM learning_concept_tag_items WHERE run_id=$1 ORDER BY case_id,arm',[id])).rows}}
const executeHistoricalChunks=(row:TagStoredRun,id:string,service:TypeSafeDecisionService)=>executeChunks(row,id,service,db)

test('five distinct cases may hold active reservations and replay never duplicates them',async()=>{
 const id=await fixture();let calls=0,release!:()=>void,ready!:()=>void
 const held=new Promise<void>(resolve=>{release=resolve}),started=new Promise<void>(resolve=>{ready=resolve})
 const row=await tagRun(id);row.manifest.cases=Array.from({length:5},(_,i)=>({...row.manifest.cases[0]!,id:`case-${i}`}));row.manifest.historical.budget=historicalBatchPlan(catalog,5,15,100,5).budget
 await q('UPDATE learning_concept_tag_experiments SET manifest=$2::jsonb WHERE run_id=$1',[id,JSON.stringify(row.manifest)])
 for(const c of row.manifest.cases)await q("INSERT INTO learning_concept_tag_items(run_id,case_id,arm) VALUES($1,$2,'jev-live')",[id,c.id])
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{calls++;if(calls===5)ready();await held;const r=JSON.parse(String(init.body));return new Response(JSON.stringify({model:r.model,answers:Object.fromEntries(Object.keys(r.questions).map(k=>[k,{type:'noul',noul:0}])),usage:{input_tokens:1,output_tokens:1}}))})
 try{
 const work=Promise.all(row.manifest.cases.map(c=>executeHistoricalChunks(row,c.id,service)))
 await Promise.race([started,work]);assert.equal(calls,5);release();await work
 assert.equal(calls,15)
 assert.equal((await q('SELECT reserved_count FROM learning_concept_tag_budgets WHERE run_id=$1',[id])).rows[0].reserved_count,15)
 }finally{release();await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('atomic budget admits only the last funded call under a five-way race',async()=>{
 const id=await fixture();let calls=0
 try{
 const row=await multiCase(id,5,5)
 await q('INSERT INTO learning_concept_tag_budgets(run_id,reserved_count) VALUES($1,4)',[id])
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{calls++;return success(init)})
 const results=await Promise.allSettled(row.manifest.cases.map(c=>executeHistoricalChunks(row,c.id,service)))
 assert.equal(calls,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 assert.ok(results.filter(r=>r.status==='rejected').every(r=>/budget exhausted/.test(String(r.reason))))
 assert.equal((await q('SELECT reserved_count FROM learning_concept_tag_budgets WHERE run_id=$1',[id])).rows[0].reserved_count,5)
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('active capacity differs from stale uncertainty, and late owner may settle but never repeat',async()=>{
 const id=await fixture();let calls=0,release!:()=>void,ready!:()=>void
 const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r)
 let first:Promise<any>|undefined
 try{
 const row=await multiCase(id,2,1)
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{calls++;ready();await held;return success(init)})
 first=executeHistoricalChunks(row,'case-0',service);await started
 await assert.rejects(executeHistoricalChunks(row,'case-1',service),/active leased work/)
 await q("UPDATE learning_concept_tag_reservations SET lease_until=now()-interval '1 second' WHERE run_id=$1",[id])
 await assert.rejects(executeHistoricalChunks(row,'case-1',service),/uncertain/)
 await assert.rejects(executeHistoricalChunks(row,'case-0',service),/attempt uncertain; replacement/)
 assert.equal(calls,1);release();await first
 await executeHistoricalChunks(row,'case-1',service);assert.equal(calls,2)
 await executeHistoricalChunks(row,'case-0',service);assert.equal(calls,2)
 }finally{release();await first?.catch(()=>{});await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('failed call opens run circuit; successful already-leased work still persists',async()=>{
 const id=await fixture();let calls=0,release!:()=>void,ready!:()=>void
 const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r)
 try{
 const row=await multiCase(id,3,2)
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{calls++;if(calls===1){ready();await held;return success(init)}return new Response('rejected',{status:400})})
 const first=executeHistoricalChunks(row,'case-0',service);await started
 const failed=await executeHistoricalChunks(row,'case-1',service);assert.equal(failed.valid,false)
 await assert.rejects(executeHistoricalChunks(row,'case-2',service),/circuit open/)
 release();assert.equal((await first).valid,true);assert.equal(calls,2)
 }finally{release();await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('no full run receipt reads or repeated legacy journal scans on chunk hot path',async()=>{
 const id=await fixture()
 try{
 const row=await tagRun(id),begin=queries.length
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>success(init))
 await executeHistoricalChunks(row,'one',service)
 const executed=queries.slice(begin)
 assert.equal(executed.filter(s=>s.includes('jsonb_array_elements')).length,1)
 assert.equal(executed.filter(s=>/^SELECT .*receipt/.test(s)&&s.includes('learning_concept_tag_items')&&!s.includes('case_id=$2')).length,0)
 const done=queries.length;await executeHistoricalChunks(row,'one',service)
 assert.equal(queries.length-done,1)
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
async function multiCase(id:string,count:number,concurrency:number){
 const row=await tagRun(id);row.manifest.cases=Array.from({length:count},(_,i)=>({...row.manifest.cases[0]!,id:`case-${i}`}));row.manifest.historical.budget=historicalBatchPlan(catalog,count,count,470,concurrency).budget
 await q('UPDATE learning_concept_tag_experiments SET manifest=$2::jsonb WHERE run_id=$1',[id,JSON.stringify(row.manifest)])
 for(const c of row.manifest.cases)await q("INSERT INTO learning_concept_tag_items(run_id,case_id,arm) VALUES($1,$2,'jev-live')",[id,c.id])
 return row
}
function success(init:any){const r=JSON.parse(String(init.body));return new Response(JSON.stringify({model:r.model,answers:Object.fromEntries(Object.keys(r.questions).map(k=>[k,{type:'noul',noul:0}])),usage:{input_tokens:1,output_tokens:1}}))}
test('legacy partial journals adopt once without rewriting completed chunks or replaying paid calls',async()=>{
 const id=await fixture();let calls=0
 try{
 const row=await tagRun(id),concepts=catalog.slice(0,100),request=historicalDecisionRequest(concepts,'hello',[]),now=new Date().toISOString()
 const prior={index:0,requestHash:tagHash(request),reservedAt:now,receipt:{ids:[],raw:'legacy exact raw',request,returnedModel:'jev-1.13.0',usage:{input_tokens:7,output_tokens:2},valid:true,error:null,startedAt:now,completedAt:now,latencyMs:1,providerMode:'live',synthetic:false}}
 await q('UPDATE learning_concept_tag_items SET reserved_at=now(),receipt=$2::jsonb WHERE run_id=$1',[id,JSON.stringify({chunkJournal:true,complete:false,chunks:[prior]})])
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{calls++;return success(init)})
 const receipt=await executeHistoricalChunks(row,'one',service)
 assert.equal(calls,2);assert.deepEqual(receipt.chunks[0],prior);assert.equal(receipt.valid,true)
 assert.equal((await q('SELECT reserved_count FROM learning_concept_tag_budgets WHERE run_id=$1',[id])).rows[0].reserved_count,3)
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('cancellation lets already leased calls settle but prevents every next chunk',async()=>{
 const id=await fixture();let calls=0,release!:()=>void,ready!:()=>void,work:Promise<any>[]=[]
 const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r)
 try{
 const row=await multiCase(id,5,5);row.manifest.historical.budget=historicalBatchPlan(catalog,5,15,100,5).budget
 await q('UPDATE learning_concept_tag_experiments SET manifest=$2::jsonb WHERE run_id=$1',[id,JSON.stringify(row.manifest)])
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{calls++;if(calls===5)ready();await held;return success(init)})
 work=row.manifest.cases.map(c=>executeHistoricalChunks(row,c.id,service));const settled=Promise.allSettled(work)
 await Promise.race([started,settled]);assert.equal(calls,5)
 await q("UPDATE learning_concept_tag_experiments SET status='cancelled' WHERE run_id=$1",[id]);release()
 const results=await settled;assert.ok(results.every(r=>r.status==='rejected'&&/Cancelled/.test(String(r.reason))))
 assert.equal(calls,5)
 const receipts=(await q('SELECT state,receipt FROM learning_concept_tag_reservations WHERE run_id=$1',[id])).rows
 assert.equal(receipts.length,5);assert.ok(receipts.every(r=>r.state==='succeeded'&&r.receipt.valid))
 }finally{release();await Promise.allSettled(work);await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
const catalog=Array.from({length:205},(_,i)=>({id:`id-${i}`,ref:`c${i+1}`,title:`Title ${i}`}))
async function fixture(){const id=crypto.randomUUID();await saveTagManifest(id,'unit-test',{name:id,providerMode:'live',synthetic:false,curriculumId:'fixture',concepts:catalog.map(c=>({...c,domain:''})),cases:[{id:'one',text:'hello',context:[],gold:[]}],arms:['jev-live'],threshold:.5,code:{},modelSelection:{provider:'typesafe',model:'jev-1.13.0'},historical:{sourceCatalog:catalog,budget:historicalBatchPlan(catalog,1,3).budget}});return id}
test('chunks persist before next HTTP call and replay cannot repeat paid calls',async()=>{
 const id=await fixture(),requests:any[]=[]
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{const r=JSON.parse(String(init.body));const row=await tagRun(id);assert.equal(row.items[0]!.receipt.chunks.length,requests.length+1);assert.ok(row.items[0]!.receipt.chunks.slice(0,-1).every((c:any)=>c.receipt?.valid));requests.push(r);return new Response(JSON.stringify({model:r.model,answers:Object.fromEntries(Object.keys(r.questions).map(k=>[k,{type:'noul',noul:.75}])),usage:{input_tokens:10,output_tokens:2}}))})
 try{const r=await executeHistoricalChunks(await tagRun(id),'one',service);assert.equal(r.valid,true);assert.equal(r.ids.length,205);assert.deepEqual(requests.map(r=>Object.keys(r.questions).length),[100,100,5]);assert.deepEqual(requests.flatMap(r=>r.state.concepts),catalog);assert.equal(Object.keys(requests[1].questions)[0],'c101');assert.deepEqual(r.usage,{input_tokens:30,output_tokens:6});assert.equal(r.chunks.length,3);await executeHistoricalChunks(await tagRun(id),'one',service);assert.equal(requests.length,3)
 // Model the crash between committing a chunk and completing the whole case.
 await q("UPDATE learning_concept_tag_items SET receipt=receipt - 'ids' || '{\"complete\":false}'::jsonb WHERE run_id=$1",[id]);await executeHistoricalChunks(await tagRun(id),'one',service);assert.equal(requests.length,3)
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('uncertain chunk reservation fences recovery and never redispatches',async()=>{
 const id=await fixture();let calls=0;const service=new TypeSafeDecisionService('test-only',async()=>{calls++;throw new Error('must not dispatch')})
 try{await q('UPDATE learning_concept_tag_items SET reserved_at=now(),receipt=$2::jsonb WHERE run_id=$1',[id,JSON.stringify({chunkJournal:true,complete:false,chunks:[{index:0,reservedAt:new Date().toISOString(),receipt:null}]})]);await assert.rejects(executeHistoricalChunks(await tagRun(id),'one',service),/uncertain/);assert.equal(calls,0)}finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('in-flight journal serializes paid calls and cancellation blocks later chunks',async()=>{
 const id=await fixture();let calls=0
 const service=new TypeSafeDecisionService('test-only',async(_url,init)=>{
  calls++;await assert.rejects(executeHistoricalChunks(await tagRun(id),'one',service),/uncertain/)
  await q("UPDATE learning_concept_tag_experiments SET status='cancelled' WHERE run_id=$1",[id])
  const request=JSON.parse(String(init.body));return new Response(JSON.stringify({model:request.model,answers:Object.fromEntries(Object.keys(request.questions).map(k=>[k,{type:'noul',noul:0}])),usage:{input_tokens:1,output_tokens:1}}))
 })
 try{await assert.rejects(executeHistoricalChunks(await tagRun(id),'one',service),/Cancelled/);assert.equal(calls,1);const r=(await tagRun(id)).items[0]!.receipt;assert.equal(r.chunks.length,1);assert.equal(r.chunks[0].receipt.valid,true);assert.equal(r.complete,false)}finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('first failed chunk stops remaining calls and retains exact failed request/raw',async()=>{
 const id=await fixture();let calls=0;const service=new TypeSafeDecisionService('test-only',async()=>{calls++;return new Response('rejected',{status:400})})
 try{const r=await executeHistoricalChunks(await tagRun(id),'one',service);assert.equal(r.valid,false);assert.equal(calls,1);assert.equal(r.chunks[0].receipt.raw,'rejected');assert.equal(Object.keys(r.chunks[0].receipt.request.questions).length,100);await executeHistoricalChunks(await tagRun(id),'one',service);assert.equal(calls,1)}finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
