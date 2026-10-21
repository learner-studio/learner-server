import {test,expect} from 'bun:test'
import * as transport from './learning-experiment-langfuse-transport.js'
import {learningExperimentApi} from './learning-experiment-langfuse-transport.js'

test('trace admission never invokes slow remote transport and reports queued',async()=>{
 const rows:any[]=[];let network=0
 const start=performance.now()
 const original=globalThis.fetch
 globalThis.fetch=Object.assign(async()=>{network++;await Bun.sleep(250);return Response.json({})},{preconnect:original.preconnect}) as typeof fetch
 let result:any
 try { result=await learningExperimentApi('/api/public/otel/v1/traces','POST',{resourceSpans:[{scopeSpans:[{spans:[{traceId:'a'.repeat(32),spanId:'b'.repeat(16)}]}]}]}, {
  outbox:{enqueue:async(value:any)=>{rows.push(value);return {id:'outbox-1',state:'pending',wakeQueued:true}}},
  fetch:async()=>{network++;await Bun.sleep(250);return Response.json({})},
 } as any) } finally {globalThis.fetch=original}
 expect(network).toBe(0)
 expect(result.state).toBe('queued')
 expect(rows).toHaveLength(1)
 expect(rows[0].destination).toBe('langfuse')
 expect(performance.now()-start).toBeLessThan(200)
})
test('flush deduplicates and bounds all batches to core hundred-ID ceiling',async()=>{
 const chunks:string[][]=[]
 const ids=Array.from({length:120},(_,i)=>String(i))
 const strict={enqueue:async()=>({id:'x',state:'pending'}),flush:async(batch:string[])=>{if(batch.length>100)throw Error('core flush ceiling');chunks.push(batch)}}
 await transport.flushLangfuseWrites([...ids,...ids],strict)
 expect(chunks.map(chunk=>chunk.length)).toEqual([100,20])
 expect(chunks.flat()).toEqual(ids)
 await expect(transport.flushLangfuseWrites(ids,{...strict,flush:async()=>{throw Error('incomplete')}})).rejects.toThrow('incomplete')
})

test('worker destination delivers only allowlisted stable-ID writes and checks partial ingestion',async()=>{
 expect(typeof (transport as any).LangfuseTelemetryDestination).toBe('function')
 const sent:any[]=[]
 const Destination=(transport as any).LangfuseTelemetryDestination
 const destination=new Destination({credentials:async()=>({publicKey:'pk',secretKey:'sk'}),fetch:async(url:string,init:any)=>{sent.push({url,init});return Response.json({partialSuccess:{rejectedSpans:1}})}})
 expect(()=>destination.validate({path:'/evil',body:{id:'s'}})).toThrow()
 const payload={path:'/api/public/otel/v1/traces',body:{resourceSpans:[{scopeSpans:[{spans:[{traceId:'a'.repeat(32),spanId:'b'.repeat(16)}]}]}]}}
 await expect(destination.deliver(payload,{id:'outbox',dedupeKey:'k',signal:AbortSignal.timeout(1000)})).rejects.toThrow('partial')
 expect(sent).toHaveLength(1)
 expect(sent[0].url).toBe('http://127.0.0.1:3100/experiments/api/public/otel/v1/traces')
})
