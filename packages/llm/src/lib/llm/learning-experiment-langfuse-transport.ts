import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
export interface LangfuseOutbox {
 enqueue(input:{destination:string;dedupeKey:string;payload:unknown}):Promise<{id:string;state:string}>
 flush(ids:string[]):Promise<unknown>
}
/** The process's telemetry outbox, registered once by the entry point (apps/server services). */
let registeredOutbox:LangfuseOutbox|undefined
export function registerTelemetryOutbox(outbox:LangfuseOutbox|undefined):void { registeredOutbox=outbox }
export const registeredTelemetryOutbox=():LangfuseOutbox|undefined=>registeredOutbox
export function currentTelemetryOutbox():LangfuseOutbox {
 const outbox=registeredOutbox
 if(!outbox)throw new Error('Telemetry outbox is not configured')
 return outbox
}
export function langfuseWriteKey(path:string,body:any):string {
 const ids=path==='/api/public/otel/v1/traces'
  ? body?.resourceSpans?.flatMap((r:any)=>r.scopeSpans?.flatMap((s:any)=>s.spans?.map((v:any)=>`${v.traceId}:${v.spanId}`)??[])??[])
  : path==='/api/public/ingestion'?body?.batch?.map((e:any)=>e.id):[body?.id]
 if(!ids?.length||ids.some((id:unknown)=>typeof id!=='string'||!id||id.includes('undefined')))throw new Error('Telemetry requires stable provider IDs')
 return createHash('sha256').update(JSON.stringify([path,[...ids].sort()])).digest('hex')
}
export async function enqueueLangfuseWrite(path:string,body:unknown,outbox:LangfuseOutbox=currentTelemetryOutbox()) {
 if(!['/api/public/otel/v1/traces','/api/public/scores','/api/public/ingestion'].includes(path))throw new Error('Unsupported telemetry write')
 if(Buffer.byteLength(JSON.stringify(body))>MAX_BYTES)throw new Error('Langfuse payload exceeds safe export ceiling; original bytes retained locally')
 const result=await outbox.enqueue({destination:'langfuse',dedupeKey:langfuseWriteKey(path,body),payload:{path,body:JSON.parse(JSON.stringify(body))}})
 return {id:result.id,state:result.state==='delivered'?'delivered':'queued'}
}
export async function flushLangfuseWrites(ids:string[],outbox:LangfuseOutbox=currentTelemetryOutbox()) {
 const unique=[...new Set(ids)]
 for(let index=0;index<unique.length;index+=100)await outbox.flush(unique.slice(index,index+100))
}
const BASE='http://127.0.0.1:3100/experiments'
const MAX_BYTES=3_500_000
export class LangfuseTelemetryDestination {
 constructor(private readonly options:{baseUrl?:string;credentials?:()=>Promise<{publicKey:string;secretKey:string}>;fetch?:typeof fetch}={}){}
 validate(payload:unknown):void {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid telemetry envelope')
  const p=payload as {path:string;body:any}
  if(Object.keys(p).some(key=>!['path','body'].includes(key))||!['/api/public/otel/v1/traces','/api/public/scores','/api/public/ingestion'].includes(p.path))throw new Error('Unsupported telemetry write')
  langfuseWriteKey(p.path,p.body)
  if(p.path==='/api/public/otel/v1/traces')for(const resource of p.body.resourceSpans)for(const scope of resource.scopeSpans)for(const span of scope.spans)if(!/^[a-f0-9]{32}$/.test(span.traceId)||!/^[a-f0-9]{16}$/.test(span.spanId))throw new Error('Invalid stable OTLP identity')
  if(p.path==='/api/public/ingestion'&&p.body.batch.some((event:any)=>event.type!=='score-create'))throw new Error('Only score ingestion is supported')
 }
 async deliver(payload:unknown,context:{id:string;dedupeKey:string;signal:AbortSignal}):Promise<void> {
  this.validate(payload)
  const p=payload as {path:string;body:any}
  const credentials=await (this.options.credentials??localLangfuseCredentials)()
  let response:Response
  try {response=await (this.options.fetch??fetch)(`${(this.options.baseUrl??BASE).replace(/\/+$/,'')}${p.path}`,{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${credentials.publicKey}:${credentials.secretKey}`).toString('base64')}`,'content-type':'application/json'},body:JSON.stringify(p.body),signal:context.signal,redirect:'error'})}
  catch {throw new Error('Langfuse telemetry transport unavailable')}
  if(!response.ok)throw new Error(`Langfuse telemetry HTTP ${response.status}`)
  const result=await response.json() as any
  if(Number(result.partialSuccess?.rejectedSpans??0)>0||result.partialSuccess?.errorMessage||result.errors?.length)throw new Error('Langfuse partial telemetry ingestion')
 }
}
async function localLangfuseCredentials() {
 const source=await readFile('/etc/biztools/langfuse.env','utf8')
 const value=(name:string)=>source.match(new RegExp(`^${name}=(.*)$`,'m'))?.[1]?.trim().replace(/^['"]|['"]$/g,'')
 const publicKey=value('LANGFUSE_PUBLIC_KEY'),secretKey=value('LANGFUSE_SECRET_KEY')
 if(!publicKey||!secretKey)throw new Error('Langfuse project credentials unavailable')
 return {publicKey,secretKey}
}
export async function learningExperimentApi(path:string,method='GET',body?:unknown,deps:{outbox?:LangfuseOutbox;fetch?:typeof fetch}={}):Promise<Record<string,any>> {
  if(method==='POST'&&['/api/public/otel/v1/traces','/api/public/scores','/api/public/ingestion'].includes(path))return enqueueLangfuseWrite(path,body,deps.outbox)
  // Read only the configured local project's keys; never echo credentials or response bodies.
  const source=await readFile('/etc/biztools/langfuse.env','utf8')
  const value=(name:string)=>source.match(new RegExp(`^${name}=(.*)$`,'m'))?.[1]?.trim().replace(/^['"]|['"]$/g,'')
  const publicKey=value('LANGFUSE_PUBLIC_KEY'),secretKey=value('LANGFUSE_SECRET_KEY')
  if(!publicKey||!secretKey) throw new Error('Langfuse project credentials unavailable')
  const payload=body===undefined?undefined:JSON.stringify(body)
  if(payload&&Buffer.byteLength(payload)>MAX_BYTES) throw new Error('Langfuse payload exceeds safe export ceiling; original bytes retained locally')
  const response=await fetch(`${BASE}${path}`,{method,headers:{authorization:`Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`,'content-type':'application/json'},...(payload===undefined?{}:{body:payload}),signal:AbortSignal.timeout(15000),redirect:'error'})
  if(!response.ok) throw new Error(`Langfuse ${method} request failed (${response.status})`)
  return response.json() as Promise<Record<string,any>>
}
