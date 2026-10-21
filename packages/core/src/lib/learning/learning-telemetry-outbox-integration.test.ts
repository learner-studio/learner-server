import {test,expect} from 'bun:test'
import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {TelemetryOutboxService} from '../../services/telemetry-outbox-service.js'
import {LangfuseTelemetryDestination,learningExperimentApi,flushLangfuseWrites} from '@learner/llm/lib/llm/learning-experiment-langfuse-transport.js'
const require=createRequire(import.meta.url)
const {PGlite}=createRequire(require.resolve('@electric-sql/pglite-age'))('@electric-sql/pglite')
test('120 durable writes survive producer replacement and flush in bounded batches without any model calls',async()=>{
 const db=new PGlite();const exitCode=process.exitCode
 await db.waitReady;if(process.exitCode===99)process.exitCode=exitCode??0
 try {
  await db.exec(await readFile(new URL('../../../test/fixtures/source-migrations/0181-telemetry-outbox.sql',import.meta.url),'utf8'))
  const query:any=async(sql:string,params?:unknown[])=>{const r=await db.query(sql,params??[]);return {rows:r.rows,rowCount:r.affectedRows??r.rows.length}}
  let delivered=0
  const destination=new LangfuseTelemetryDestination({credentials:async()=>({publicKey:'test',secretKey:'test'}),fetch:(async()=>{delivered++;await new Promise(resolve=>setTimeout(resolve,2));return Response.json({})}) as unknown as typeof fetch})
  const producer=new TelemetryOutboxService(query,{langfuse:destination})
  const ids:string[]=[],started=performance.now()
  for(let index=0;index<120;index++)ids.push((await learningExperimentApi('/api/public/scores','POST',{id:`score-${index}`,traceId:'a'.repeat(32),name:'test',value:1,dataType:'NUMERIC'},{outbox:producer})).id)
  const admissionMs=performance.now()-started
  expect(delivered).toBe(0)
  expect((await producer.status(ids)).every(row=>row.state==='pending')).toBe(true)
  const restarted=new TelemetryOutboxService(query,{langfuse:destination})
  const drainStart=performance.now();await flushLangfuseWrites([...ids,...ids],restarted)
  const deliveryMs=performance.now()-drainStart
  expect(delivered).toBe(120)
  expect((await restarted.status(ids)).every(row=>row.state==='delivered')).toBe(true)
  await flushLangfuseWrites(ids,restarted);expect(delivered).toBe(120)
  console.log(JSON.stringify({measurement:'fake-transport-120',admissionMs,deliveryMs,remoteDelayMs:2,modelCalls:0,delivered}))
 } finally {await db.close()}
},30000)
