import {test,expect} from 'bun:test'
import {tagObservation,tagIds} from './learning-concept-tag-telemetry.js'
test('live generation is not simulated and retains actual usage, with synthetic source metadata',()=>{
 const r={ids:[],valid:true,request:{},raw:'{}',returnedModel:'jev-1.13.0',usage:{input_tokens:42,output_tokens:6},providerMode:'live',synthetic:true,startedAt:'2026-09-24T00:00:00Z',completedAt:'2026-09-24T00:00:01Z'};
 const p=tagObservation({run_id:'r',dataset_id:'d',manifest:{name:'live',providerMode:'live',concepts:[],cases:[{id:'1',text:'hi',context:[]}],code:{}}},'1','jev-live',r);
 const spans=p.payload.resourceSpans[0]!.scopeSpans[0]!.spans;expect(spans[1]!.name).not.toContain('SIMULATED');expect(JSON.stringify(p.payload)).toContain('live');expect(JSON.stringify(p.payload)).toContain('input_tokens');expect(JSON.stringify(p.payload)).not.toContain('SYNTHETIC MOCK')
})
test('synthetic native root and actual mock HTTP generation retain full receipt and stable identity',()=>{
 const manifest={name:'synthetic/test',providerMode:'mock',synthetic:true,concepts:[],cases:[{id:'1',text:'hello',context:[],gold:[]}],arms:['jev-mock'],code:{},threshold:.5,curriculumId:'x'} as const
 const receipt={ids:[],valid:true,raw:'{}',request:{state:'full'},returnedModel:'synthetic-jev-v1',usage:null,error:null,startedAt:'2026-09-23T00:00:00Z',completedAt:'2026-09-23T00:00:01Z',latencyMs:1000,queueWaitMs:0,endToEndMs:1000,providerMode:'mock',synthetic:true}
 const p=tagObservation({run_id:'r',dataset_id:'d',manifest},'1','jev-mock',receipt)
 expect(p.ids).toEqual(tagIds('r','1','jev-mock'));expect(p.payload.resourceSpans[0]!.scopeSpans[0]!.spans.length).toBe(2)
 expect(JSON.stringify(p.payload)).toContain('langfuse.experiment.id');expect(JSON.stringify(p.payload)).toContain('synthetic');expect(p.output).toMatchObject({ids:[],valid:true})
})
