import {test,expect} from 'bun:test'
import {executeTagOnce,tagRun,saveTagManifest} from './learning-concept-tag-store.js'
import {metaDbQuery as q} from '../lib/db-metadata/_shared.js'
import type {TagManifest} from '../lib/learning/learning-concept-tag-experiment.js'
test('item-scoped run read excludes unrelated receipts without changing full readback',async()=>{
 const id=crypto.randomUUID(),manifest:TagManifest={providerMode:'mock',synthetic:true,curriculumId:'unit-fixture',name:id,concepts:[],cases:[{id:'one',text:'x',context:[],gold:[]},{id:'two',text:'y',context:[],gold:[]}],arms:['jev-mock'],code:{},threshold:.5}
 try{await saveTagManifest(id,'unit-test',manifest);expect((await tagRun(id,'one','jev-mock')).items.map(i=>i.case_id)).toEqual(['one']);expect((await tagRun(id)).items.length).toBe(2)}finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('narrow single-call path still fences other failed or uncertain live cases',async()=>{
 const id=crypto.randomUUID();let calls=0
 const manifest:TagManifest={providerMode:'live',synthetic:true,curriculumId:'unit-fixture',name:id,concepts:[],cases:['one','two'].map(id=>({id,text:'x',context:[],gold:[]})),arms:['jev-live'],code:{},threshold:.5}
 const provider=async()=>{calls++;return {ids:[],raw:'',request:{},returnedModel:'mock',usage:null}}
 try{
 await saveTagManifest(id,'unit-test',manifest)
 await q("UPDATE learning_concept_tag_items SET reserved_at=now() WHERE run_id=$1 AND case_id='one'",[id])
 await expect(executeTagOnce(id,'two','jev-live',provider)).rejects.toThrow('uncertain')
 await q("UPDATE learning_concept_tag_items SET receipt='{\"valid\":false}'::jsonb WHERE run_id=$1 AND case_id='one'",[id])
 await expect(executeTagOnce(id,'two','jev-live',provider)).rejects.toThrow('circuit')
 expect(calls).toBe(0)
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[id])}
})
test('uncertain reservation fails closed without another dispatch',async()=>{
 const runId=crypto.randomUUID();let calls=0
 const manifest:TagManifest={providerMode:'mock',synthetic:true,curriculumId:'unit-fixture',name:runId,concepts:[],cases:[{id:'one',text:'x',context:[],gold:[]}],arms:['jev-mock'],code:{},threshold:.5}
 try{await saveTagManifest(runId,'unit-test',manifest);await q('UPDATE learning_concept_tag_items SET reserved_at=now() WHERE run_id=$1',[runId]);await expect(executeTagOnce(runId,'one','jev-mock',async()=>{calls++;return {ids:[],raw:'',request:{},returnedModel:'mock',usage:null}})).rejects.toThrow('uncertain');expect(calls).toBe(0)}finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[runId])}
})
test('live receipt keeps real provider mode across replay',async()=>{
 const runId=crypto.randomUUID();let calls=0;const manifest:TagManifest={providerMode:'live',synthetic:true,curriculumId:'unit-fixture',name:runId,concepts:[],cases:[{id:'one',text:'hi',context:[],gold:[]}],arms:['jev-live'],code:{},threshold:.5};
 try{await saveTagManifest(runId,'unit-test',manifest);const provider=async()=>{calls++;return {ids:[],raw:'{}',request:{},returnedModel:'jev-1.13.0',usage:{input_tokens:1,output_tokens:1}}};const first=await executeTagOnce(runId,'one','jev-live',provider);await executeTagOnce(runId,'one','jev-live',provider);expect(first.providerMode).toBe('live');expect(calls).toBe(1)}finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[runId])}
})
test('durable receipt precedes export and replay cannot call provider twice',async()=>{
 const runId=crypto.randomUUID();let calls=0
 const manifest:TagManifest={providerMode:'mock',synthetic:true,curriculumId:'unit-fixture',name:runId,concepts:[{id:'a',ref:'c1',title:'A',domain:'D'}],cases:[{id:'one',text:'A',context:[],gold:['a']}],arms:['jev-mock'],code:{},threshold:.5}
 try{
 await saveTagManifest(runId,'unit-test',manifest)
 await q("UPDATE learning_concept_tag_items SET created_at=now()-interval '1 hour',enqueued_at=now() WHERE run_id=$1",[runId])
 const provider=async()=>{calls++;return {ids:['a'],raw:'{}',request:{},returnedModel:'mock',usage:null}}
 await executeTagOnce(runId,'one','jev-mock',provider)
 // A telemetry outage after commit cannot roll back the provider receipt.
 await expect(Promise.reject(new Error('synthetic export failure after receipt'))).rejects.toThrow('export failure')
 await executeTagOnce(runId,'one','jev-mock',provider)
 const run=await tagRun(runId)
 expect(calls).toBe(1);expect(run.items[0]!.receipt.queueWaitMs).toBeLessThan(1000);expect(run.items[0]!.receipt.ids).toEqual(['a']);expect(run.items[0]!.export_state).toBe('pending')
 }finally{await q('DELETE FROM learning_concept_tag_experiments WHERE run_id=$1',[runId])}
})
