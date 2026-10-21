import {test,expect} from 'bun:test'
import {readFile} from 'node:fs/promises'
import {exportHistorical} from './learning-concept-tag-historical-telemetry.js'
const row=()=>({run_id:'run',dataset_id:'dataset',score_configs:{valid_result:'config'},items:[{case_id:'c',arm:'baseline-import',export_state:'pending',receipt:{ids:['x'],valid:true,raw:'{"matches":[]}',error:null,startedAt:'2026-09-24T00:00:00Z',completedAt:'2026-09-24T00:00:00Z',returnedModel:'old',usage:null}}],manifest:{name:'real',arms:['baseline-import'],code:{},cases:[{id:'c',text:'hello',context:[]}],historical:{sourceRunId:'old',sourceCatalog:[{id:'x',title:'X'}],sourceAudit:{promptHash:'hash'},baselineResults:[{case_id:'c',extraction:{matches:[{conceptId:'x'}]}}]}}})
test('historical export queues receipt without claiming remote delivery',async()=>{
 expect(await readFile(new URL('./learning-concept-tag-historical-telemetry.ts',import.meta.url),'utf8')).not.toContain("export_state='sending'")
 const writes:any[]=[],sql:string[]=[]
 const result=await exportHistorical(row() as any,'c','baseline-import',{api:async(path:string,method:string,body:unknown)=>{writes.push({path,method,body});return {id:`o${writes.length}`,state:'queued'}},q:async(text:string)=>{sql.push(text);return {rows:[{}],rowCount:1}}} as any)
 expect(result.state).toBe('queued')
 expect(result.outboxIds).toEqual(['o1','o2'])
 expect(sql.join('\n')).not.toContain("export_state='sent'")
 expect(sql.join('\n')).not.toContain("export_state='sending'")
})
for(const [file,forbidden] of [
 ['learning-concept-tag-telemetry.ts',"export_state='sending'"],
 ['learning-prompt-ab-langfuse.ts',"SET state='sending'"],
 ['learning-feedback-traces.ts','await exportLangfuseBatch'],
] as const)test(`${file} does not claim delivery during admission`,async()=>{
 const source=await readFile(new URL(file,import.meta.url),'utf8')
 expect(source.includes(forbidden)).toBe(false)
})
test('historical finalizer explicitly flushes and uses manifest cohort size',async()=>{
 const source=await readFile(new URL('./learning-concept-tag-historical-telemetry.ts',import.meta.url),'utf8')
 expect(source.includes('await flushLangfuseWrites(')).toBe(true)
 expect(source.includes('plannedCases:100')).toBe(false)
})
test('legacy sent observations never replay OTLP but can finish stable score exports',async()=>{
 const source=row();source.items[0]!.export_state='sent'
 const paths:string[]=[]
 const result=await exportHistorical(source as any,'c','baseline-import',{api:async(path:string)=>{paths.push(path);return {id:'score-outbox',state:'queued'}},q:async()=>({rows:[],rowCount:0})} as any)
 expect(paths).toEqual(['/api/public/scores'])
 expect(result.outboxIds).toEqual(['score-outbox'])
})
for(const state of ['verified','sending','uncertain'])test(`legacy ${state} exports remain readback-only`,async()=>{
 const source=row();source.items[0]!.export_state=state
 const before=JSON.stringify(source)
 const result=await exportHistorical(source as any,'c','baseline-import',{api:async()=>{throw Error('must not write')},q:async()=>{throw Error('must not update')}} as any)
 expect(result.state).toBe(state)
 expect(result.outboxIds).toEqual([])
 expect(JSON.stringify(source)).toBe(before)
})
