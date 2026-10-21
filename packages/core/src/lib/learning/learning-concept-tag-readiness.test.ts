import {test} from 'node:test'
import assert from 'node:assert/strict'
import {tagReadiness} from './learning-concept-tag-readiness.js'
const row=():any=>({run_id:'r',manifest:{cases:[{id:'a'}],arms:['jev-live']},items:[{case_id:'a',arm:'jev-live',receipt:{valid:true,completedAt:'2026-09-26T00:00:00Z'},export_state:'queued'}]})
test('durable result is ready before remote telemetry; queued is not delivered',()=>{
 const r=tagReadiness(row(),[{state:'pending',id:'o'}],['o'])
 assert.equal(r.resultReady,true);assert.equal(r.telemetryState,'queued');assert.equal(r.auditState,'pending')
 assert.equal(tagReadiness(row(),[{state:'delivered',id:'o'}],['o']).telemetryState,'delivered')
})
test('missing exact outbox rows and partial journals cannot claim completion',()=>{
 const r=row();r.items[0].receipt={chunkJournal:true,complete:false}
 assert.equal(tagReadiness(r,[],['missing']).resultReady,false)
 assert.equal(tagReadiness(row(),[],['missing']).telemetryState,'pending')
 assert.equal(tagReadiness(row(),[{id:'o',state:'dead'}],['o']).telemetryState,'failed')
})
test('exact planned membership is required; failed complete results stay inspectable',()=>{
 const r=row();r.items[0].receipt.valid=false
 assert.equal(tagReadiness(r,[],[]).resultReady,true);assert.equal(tagReadiness(r,[],[]).resultState,'ready_with_failures')
 r.items.push({...r.items[0]});assert.equal(tagReadiness(r,[],[]).resultReady,false)
 r.items=[{...r.items[0],case_id:'unplanned'}];assert.equal(tagReadiness(r,[],[]).resultReady,false)
})
test('verified is separate and requires every planned item',()=>{
 const r=row();r.items[0].export_state='verified'
 assert.equal(tagReadiness(r,[],[]).auditState,'verified')
 r.items=[];assert.equal(tagReadiness(r,[],[]).auditState,'pending')
})
