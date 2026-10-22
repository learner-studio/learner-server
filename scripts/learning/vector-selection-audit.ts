/** Read-only, no paid calls. Prints only public-safe aggregate proof. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { hindsightDatabaseUrl, hindsightHfHome, hindsightPython } from '@learner/core/lib/learning/hindsight-database.js'
import { openLearnerDatabase, usage } from './_db.js'
const runId=process.argv.slice(2).find((arg)=>!arg.startsWith('-'))
usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/vector-selection-audit.ts EXPERIMENT_RUN_UUID
Independently re-derives one vector-turn experiment's selection: checks every
snapshot message against learning_semantic_index_messages, re-embeds each
concept with the Hindsight venv and re-queries the native vector bank
(LEARNER_HINDSIGHT_DATABASE_URL). Both databases are opened read-only; no paid
calls. Prints an aggregate pass/fail receipt.`,!runId || !/^[a-f0-9-]{36}$/.test(runId))
const db=openLearnerDatabase({readOnly:true})
const native=new Pool({connectionString:hindsightDatabaseUrl(),options:'-c default_transaction_read_only=on'})
try {
  const {snapshot:s,config}= (await db.query('SELECT snapshot,config FROM learning_vector_turn_experiments WHERE run_id=$1',[runId])).rows[0]
  assert(s)
  const canonical=(await db.query<any>('SELECT message_id,source_text,role,raw_version_id,observed_at FROM learning_semantic_index_messages WHERE message_id=ANY($1::text[])',[s.messages.map((m:any)=>m.id)])).rows
  const source=new Map(canonical.map(m=>[m.message_id,m]))
  assert.equal(source.size,s.messages.length)
  const byId=new Map<string,any>(s.messages.map((m:any)=>[m.id,m]))
  for(const m of s.messages){const c=source.get(m.id)!;assert.equal(m.text,c.source_text);assert.equal(m.role,c.role);assert.equal(m.sourceVersion,c.raw_version_id);assert.equal(Date.parse(m.occurredAt),c.observed_at.getTime())}
  let selectedTurns=0,parts=0,maximumPartBytes=0
  for(const selection of s.selections){
    assert.equal(selection.exhaustive,true);assert.equal(selection.turns.length,selection.matchingTurns)
    const seen=new Set<string>()
    for(const turn of selection.turns){
      selectedTurns++
      const messages=turn.messageIds.map((id:string)=>{assert(byId.has(id));assert(!seen.has(id));seen.add(id);return byId.get(id)})
      assert(messages.every((m:any)=>m.conversationId===turn.conversationId))
      if(turn.linkage==='explicit'){assert.equal(messages.filter((m:any)=>m.role==='user').length,1);assert(messages.some((m:any)=>m.role==='assistant'))}
      for(let i=1;i<messages.length;i++)assert(Date.parse(messages[i].occurredAt)>=Date.parse(messages[i-1].occurredAt))
    }
    assert.deepEqual([...seen].sort(),selection.parts.flat().sort())
    for(const part of selection.parts){parts++;maximumPartBytes=Math.max(maximumPartBytes,Buffer.byteLength(JSON.stringify(part.map((id:string)=>byId.get(id)))))}
    for(let i=1;i<selection.turns.length;i++){const a=selection.turns[i-1],b=selection.turns[i];assert(a.conversationId.localeCompare(b.conversationId)<=0);if(a.conversationId===b.conversationId)assert(Date.parse(a.at)<=Date.parse(b.at))}
  }
  for(const wave of s.batches){assert(wave.length<=config.concurrency);assert.equal(new Set(wave.map((w:any)=>w.conceptId)).size,wave.length)}
  const chunks=(await db.query<any>('SELECT chunk_id,message_id FROM learning_semantic_index_chunks WHERE message_id=ANY($1::text[]) AND status=$2',[s.messages.map((m:any)=>m.id),'indexed'])).rows
  const chunkMap=new Map(chunks.map(c=>[c.chunk_id,c.message_id]))
  const child=Bun.spawn([hindsightPython(),'scripts/hindsight/learning-vector-query-embeddings.py'],{
    stdin:new Blob([JSON.stringify(s.selections.map((x:any)=>`${x.concept.title}\n${x.concept.description}`))]),stdout:'pipe',stderr:'pipe',
    env:{...process.env,HF_HOME:hindsightHfHome(),HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',OMP_NUM_THREADS:'8',MKL_NUM_THREADS:'8',TOKENIZERS_PARALLELISM:'false'}})
  const stderr=new Response(child.stderr).text()
  const encoded=await new Response(child.stdout).text();assert.equal(await child.exited,0);await stderr
  const vectors=JSON.parse(encoded)
  let checked=0,totalMatching=0
  for(const [i,selection]of s.selections.entries()){
    const rows=(await native.query<any>('WITH scored AS MATERIALIZED(SELECT document_id,1-(embedding <=> $1::vector) score FROM public.learner_learning_vectors) SELECT document_id FROM scored WHERE score >= $2',[JSON.stringify(vectors[i]),config.threshold])).rows
    const matching=new Set<string>(rows.map(r=>r.document_id).filter(id=>chunkMap.has(id)))
    assert.equal(matching.size,selection.matchingChunks)
    const messages=new Set([...matching].map(id=>chunkMap.get(id)))
    assert.equal(messages.size,selection.matchingMessages)
    const selectedIds=new Set(selection.parts.flat())
    for(const id of messages)assert(selectedIds.has(id))
    for(const turn of selection.turns)assert(turn.messageIds.some((id:string)=>messages.has(id)))
    checked++;totalMatching+=matching.size
  }
  const files=['scripts/learning/vector-selection-audit.ts','scripts/hindsight/learning-vector-query-embeddings.py','packages/core/src/lib/learning/learning-vector-turns.ts','packages/core/src/services/learning-vector-turn-service.ts']
  const checksums=Object.fromEntries(await Promise.all(files.map(async path=>[path,createHash('sha256').update(Buffer.from(await Bun.file(path).arrayBuffer())).digest('hex') ])))
  console.log(JSON.stringify({audit:'independent-vector-selection-v1',date:new Date().toISOString(),experimentRunId:runId,
    inputHash:s.metadata.inputHash,vectorConfigHash:s.metadata.vectorConfigHash,consolidatorConfigHash:s.metadata.consolidatorConfigHash,
    config,checksums,canonicalSourcesChecked:s.messages.length,sourceMismatches:0,checkedConcepts:checked,matchingChunksAcrossConcepts:totalMatching,
    selectedTurnsAcrossConcepts:selectedTurns,parts,maximumPartBytes,counts:s.counts,paidCalls:0,
    verdict:'pass',qualification:'Source fidelity and exhaustive vector-selection audit only; does not certify semantic grading or browser acceptance.'},null,2))
}finally{await db.close();await native.end()}
