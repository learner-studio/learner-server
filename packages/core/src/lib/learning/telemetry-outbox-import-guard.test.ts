import {test,expect} from 'bun:test'
import {execFileSync} from 'node:child_process'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
const root=resolve(import.meta.dir,'../../../../..')
const endpoint=/\/api\/public\/(?:otel\/v1\/traces|scores|ingestion)/
const direct=(source:string)=>endpoint.test(source)&&/\b(?:fetch|axios\.post)\s*\(/.test(source)
test('new direct telemetry HTTP writers cannot bypass the shared outbox',async()=>{
 expect(direct("fetch('/api/public/otel/v1/traces',{method:'POST'})")).toBe(true)
 const files=[...new Set(execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0'))]
 const transports=new Set([
 'packages/llm/src/lib/llm/learning-experiment-langfuse-transport.ts',
 // Legacy network mapper retained for transport-only unit tests; no production caller allowed below.
 'packages/harness/src/langfuse-export.ts',
 // One-off administrative import routes writes through enqueueLangfuseWrite before synchronous setup/read fetch.
 'ops/langfuse/migrate-seed-v1.ts',
 ])
 const violations:string[]=[]
 for(const file of files){
  if(!/\.(?:[cm]?js|tsx?)$/.test(file)||/\.(?:test|spec)\./.test(file)||/(?:^|\/)(?:node_modules|vendor|dist)\//.test(file))continue
  let source:string;try{source=await readFile(resolve(root,file),'utf8')}catch{continue}
  if(direct(source)&&!transports.has(file))violations.push(file)
  if(file!=='packages/harness/src/langfuse-export.ts'&&/\bdeliverLangfuseBatch\b/.test(source))violations.push(`${file}: legacy raw exporter`)
 }
 expect(violations).toEqual([])
})
