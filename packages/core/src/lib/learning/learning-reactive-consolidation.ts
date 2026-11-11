import { createHash } from 'node:crypto'
import { hindsightDatabaseUrl } from './hindsight-database.js'
import { Pool } from 'pg'
import { z } from 'zod'
import { metaDbQuery as q, metaDbQuery as defaultQuery, type MetaPgQueryFn } from '../db-metadata/_shared.js'
import { createLearningCoalescer } from './learning-archive-coordinator.js'
import { VectorTurnConfig, assessmentPriorMode } from './learning-vector-turn-schemas.js'
import { ASSESSMENT_MODEL,assessmentHash } from './learning-concept-assessment.js'
import { mergeIncrementalAssessment } from './learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from './learning-live-incremental-variant.js'
import { VECTORLESS_WITH_CONTENT_REASON } from './learning-semantic-index.js'
import type { LearningVectorTurnService } from '../../services/learning-vector-turn-service.js'
import type { LearningCurriculumStore } from '../../services/learning-curriculum-store.js'
import { conceptFromGraphs } from '../../services/learning-concept-assessment.js'
import { persistAssessmentCache } from './learning-assessment-persistence.js'
import type { LearningConceptAssessment } from './learning-concept-assessment.js'

export const reactiveCoalescer=createLearningCoalescer('assessment')
export const ReactiveConfig=z.object({enabled:z.boolean(),assessmentEnabled:z.boolean().default(false),conceptIds:z.array(z.string()).min(1).optional(),threshold:z.number().min(0).max(1).default(0.65),latestTurns:z.number().int().min(1).max(50).default(50),concurrency:z.number().int().min(1).max(9).default(9)})
export const ReactiveEmpty=z.object({})
export const ReactiveRoutingResult=z.object({messages:z.number(),concepts:z.number(),held:z.number().default(0),exhausted:z.number().default(0)})
export const ReactiveStatus=z.object({enabled:z.boolean(),assessmentEnabled:z.boolean(),revision:z.string().nullable(),routingError:z.string().nullable(),pendingMessages:z.number(),heldMessages:z.number().default(0),exhaustedMessages:z.number().default(0),
  holds:z.array(z.object({messageId:z.string(),eventId:z.string(),reason:z.string(),missingChunkIds:z.array(z.string()),attempts:z.number(),firstHeldAt:z.string(),nextAttemptAt:z.string().nullable()})).default([]),targets:z.array(z.object({conceptId:z.string(),requested:z.number(),completed:z.number(),state:z.string(),error:z.string().nullable()}))})
export const reactiveIdentity=(...parts:string[])=>{
  const h=createHash('sha256').update(JSON.stringify(parts)).digest('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`
}
type Config=z.infer<typeof ReactiveConfig>
type Settings={user_id:string;config:Config;revision:string;activated_at:Date;enabled:boolean;last_error:string|null}
export async function reactiveSettings(userId:string) {
  return (await q<Settings>('SELECT * FROM learning_reactive_settings WHERE user_id=$1',[userId])).rows[0]
}
export async function configureReactive(userId:string,raw:Config) {
  const config=ReactiveConfig.parse(raw)
  if((await q('SELECT 1 FROM learning_reactive_settings WHERE user_id<>$1 LIMIT 1',[userId])).rowCount)
    throw new Error('Canonical local archive currently supports one reactive learner owner')
  const revision=assessmentHash({threshold:config.threshold,latestTurns:config.latestTurns,conceptIds:config.conceptIds,embedding:'BAAI/bge-small-en-v1.5:384',prompt:LIVE_INCREMENTAL_VARIANT.revision,model:ASSESSMENT_MODEL})
  const existing=await reactiveSettings(userId)
  if(existing && existing.revision!==revision && (await q('SELECT 1 FROM learning_reactive_admission WHERE user_id=$1 AND requested_generation>captured_generation LIMIT 1',[userId])).rowCount)
    throw new Error('Drain or resolve pending concepts before changing retrieval configuration')
  await q(`INSERT INTO learning_reactive_settings(user_id,enabled,config,revision) VALUES($1,$2,$3::jsonb,$4)
    ON CONFLICT(user_id) DO UPDATE SET enabled=EXCLUDED.enabled,config=EXCLUDED.config,revision=EXCLUDED.revision,updated_at=now()`,[userId,config.enabled,JSON.stringify(config),revision])
  return reactiveStatus(userId)
}
export async function reactiveStatus(userId:string) {
  const settings=await reactiveSettings(userId)
  const pending=settings?(await q<{count:string}>(`SELECT count(*) FROM learning_vector_arrivals a WHERE a.created_at >= $2
    AND NOT EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$1 AND r.event_id=a.event_id AND r.revision=$3)`,[userId,settings.activated_at,settings.revision])).rows[0]?.count:'0'
  const rows=(await q<{concept_id:string;requested_generation:string;captured_generation:string;run_id:string|null;attempts:number;last_failure:string|null}>(`SELECT t.concept_id,a.* FROM learning_reactive_targets t JOIN learning_reactive_admission a USING(user_id,session_id) WHERE t.user_id=$1 ORDER BY t.concept_id`,[userId])).rows
  const holds=settings?(await q<{message_id:string;event_id:string;reason:string;missing_chunk_ids:string[];attempts:number;first_held_at:Date;next_attempt_at:Date|null}>(`SELECT message_id,event_id,reason,missing_chunk_ids,attempts,first_held_at,next_attempt_at
    FROM learning_reactive_route_holds WHERE user_id=$1 AND revision=$2 ORDER BY first_held_at`,[userId,settings.revision])).rows:[]
  return {enabled:settings?.enabled??false,assessmentEnabled:settings?.config.assessmentEnabled??false,revision:settings?.revision??null,routingError:settings?.last_error??null,pendingMessages:Number(pending),
    heldMessages:holds.filter(h=>h.next_attempt_at!==null).length,exhaustedMessages:holds.filter(h=>h.next_attempt_at===null).length,
    holds:holds.slice(0,50).map(h=>({messageId:h.message_id,eventId:h.event_id,reason:h.reason,missingChunkIds:h.missing_chunk_ids,attempts:h.attempts,firstHeldAt:h.first_held_at.toISOString(),nextAttemptAt:h.next_attempt_at?.toISOString()??null})),targets:rows.map(r=>({conceptId:r.concept_id,requested:Number(r.requested_generation),completed:Number(r.captured_generation),state:r.run_id?'running':r.attempts===3?'blocked':r.requested_generation===r.captured_generation?'idle':'pending',error:r.last_failure}))}
}

export const ReactiveRetryInput=z.object({conceptId:z.string().min(1)})
/** Release one blocked target after its paid receipts were reviewed; call under the
 * admission lock. Blocked is deliberate (a terminal paid pass is never retried
 * blindly), so this is the only way a target leaves it — an operator's decision. */
export async function retryReactiveTarget(userId:string,conceptId:string) {
  const target=(await q<{session_id:string}>('SELECT session_id FROM learning_reactive_targets WHERE user_id=$1 AND concept_id=$2',[userId,conceptId])).rows[0]
  if(!target) throw new Error('Unknown reactive target')
  await reactiveCoalescer.retryArchiveSession(userId,target.session_id)
}

export const ReactiveReadmitInput=z.object({requestId:z.string().uuid(),conceptIds:z.array(z.string().min(1)).min(1).max(5000).optional()})
export const ReactiveReadmitResult=z.object({concepts:z.number(),targetsCreated:z.number()})
/** Re-admit concepts for a fresh pass (a whole-history cold regrade after a grading change); call under the
 * admission lock. Marks only: the dispatcher does the work, at the configured concurrency, behind the admission
 * pause. Replaying one requestId marks nothing twice, because each mark is a notification receipt. */
export async function readmitReactiveTargets(userId:string,requestId:string,curricula:LearningCurriculumStore,conceptIds?:string[]) {
  const setting=await reactiveSettings(userId)
  if(!setting?.enabled||!setting.config.assessmentEnabled) throw new Error('Reactive paid admission disabled')
  const allIds=new Set((await curricula.listGraphs()).flatMap(g=>g.concepts.map(c=>c.id)))
  const scope=[...new Set(conceptIds??setting.config.conceptIds??allIds)].sort()
  if(scope.some(id=>!allIds.has(id))) throw new Error('Unknown reactive concept ID')
  let targetsCreated=0
  for(const conceptId of scope) {
    const sessionId=reactiveIdentity(userId,conceptId)
    targetsCreated+=(await q('INSERT INTO learning_reactive_targets(user_id,session_id,concept_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[userId,sessionId,conceptId])).rowCount??0
    await reactiveCoalescer.markArchiveDirty(userId,sessionId,reactiveIdentity(userId,'readmit',requestId,conceptId))
  }
  return {concepts:scope.length,targetsCreated}
}

type Hit={document_id:string;concept_id:string;score:number}
/** The read-only Hindsight view routing needs, injectable so tests can stand in for the bank. */
export type ReactiveVectorView={
  present(chunkIds:readonly string[]):Promise<Set<string>>
  hits(concepts:Array<{id:string;vector:number[]}>,chunkIds:readonly string[],threshold:number):Promise<Hit[]>
}
export function hindsightReactiveView():ReactiveVectorView {
  const withPool=async<T>(fn:(pool:Pool)=>Promise<T>)=>{
    if(process.env.LEARNING_VECTOR_TURNS_READ_VIEW_ENABLED!=='true') throw new Error('Vector integration read view disabled')
    const pool=new Pool({connectionString:new URL(hindsightDatabaseUrl()).toString(),max:1,options:'-c default_transaction_read_only=on'})
    try {return await fn(pool)} finally {await pool.end()}
  }
  return {
    present:ids=>ids.length?withPool(async pool=>new Set((await pool.query<{document_id:string}>('SELECT DISTINCT document_id FROM public.learner_learning_vectors WHERE document_id=ANY($1::text[])',[[...ids]])).rows.map(x=>x.document_id))):Promise.resolve(new Set()),
    hits:(concepts,ids,threshold)=>ids.length?withPool(async pool=>(await pool.query<Hit>(`WITH concepts AS (SELECT id,vector::text::vector AS embedding FROM jsonb_to_recordset($1::jsonb) AS c(id text,vector jsonb))
      SELECT v.document_id,c.id AS concept_id,MAX(1-(v.embedding <=> c.embedding)) AS score
      FROM public.learner_learning_vectors v CROSS JOIN concepts c WHERE v.document_id=ANY($2::text[])
      AND 1-(v.embedding <=> c.embedding)>=$3 GROUP BY v.document_id,c.id`,[JSON.stringify(concepts),[...ids],threshold])).rows):Promise.resolve([]),
  }
}

/** Minutes until a held arrival is tried again after attempts 1..5; attempt 6 (REACTIVE_HOLD_ATTEMPTS) exhausts it (next_attempt_at NULL). */
export const REACTIVE_HOLD_BACKOFF_MINUTES=[1,5,30,120,480] as const
export const REACTIVE_HOLD_ATTEMPTS=REACTIVE_HOLD_BACKOFF_MINUTES.length+1
/** Most chunks missing at once is a bank outage, not a stray chunk: fail the step loudly instead of holding everything. */
export const REACTIVE_SYSTEMIC_MISSING={minChunks:10,share:0.5} as const
export const REACTIVE_HOLD_REASON='Indexed chunk has no verified vector in the canonical bank'
type RouteDeps={query?:MetaPgQueryFn;view?:ReactiveVectorView;userId?:string}

/**
 * Bounded, replayable routing; call under routing lock, never admission lock.
 * An arrival whose indexed chunks the bank cannot verify is HELD (reason, missing
 * chunk ids, attempts, next attempt) and the rest of the batch routes. Held
 * arrivals leave the pending window until due, so one bad item never blocks the
 * queue behind it; after REACTIVE_HOLD_BACKOFF_MINUTES they stay exhausted and
 * countable until released.
 */
export async function routeReactive(vectors:LearningVectorTurnService,curricula:LearningCurriculumStore,deps:RouteDeps={}) {
  const q=deps.query??defaultQuery
  const view=deps.view??hindsightReactiveView()
  const settings=(await q<Settings>('SELECT * FROM learning_reactive_settings WHERE enabled AND ($1::text IS NULL OR user_id=$1) ORDER BY user_id',[deps.userId??null])).rows
  let messages=0,concepts=0,held=0,exhausted=0
  for(const setting of settings) {
    const pending=(await q<{message_id:string;event_id:string}>(`SELECT a.message_id,a.event_id FROM learning_vector_arrivals a WHERE a.created_at >= $2
      AND NOT EXISTS(SELECT 1 FROM learning_reactive_routes r WHERE r.user_id=$1 AND r.event_id=a.event_id AND r.revision=$3)
      AND NOT EXISTS(SELECT 1 FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND h.event_id=a.event_id AND h.revision=$3
        AND (h.next_attempt_at IS NULL OR h.next_attempt_at > now()))
      ORDER BY a.created_at,a.event_id LIMIT 100`,[setting.user_id,setting.activated_at,setting.revision])).rows
    if(!pending.length) continue
    const graphs=await curricula.listGraphs()
    const allIds=new Set(graphs.flatMap(g=>g.concepts.map(c=>c.id)))
    if(setting.config.conceptIds?.some(id=>!allIds.has(id))) throw new Error('Configured reactive concept no longer exists')
    const catalog=[...new Set(setting.config.conceptIds??allIds)].map(id=>conceptFromGraphs(graphs,id))
    const embeddingRevision=assessmentHash({catalog,model:'BAAI/bge-small-en-v1.5:384'})
    let encoded=(await q<{concepts:Array<{id:string;vector:number[]}>}>('SELECT concepts FROM learning_reactive_embeddings WHERE revision=$1',[embeddingRevision])).rows[0]?.concepts
    if(!encoded) {
      const values=await vectors.embeddings(catalog.map(c=>`${c.title}\n${c.description}`))
      encoded=catalog.map((c,i)=>({id:c.conceptId,vector:values[i]!}))
      await q('INSERT INTO learning_reactive_embeddings(revision,concepts) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[embeddingRevision,JSON.stringify(encoded)])
    }
    const chunks=(await q<{chunk_id:string;message_id:string}>(`SELECT c.chunk_id,c.message_id FROM learning_semantic_index_chunks c JOIN learning_semantic_index_messages m USING(message_id)
      WHERE c.message_id=ANY($1::text[]) AND c.status='indexed' AND m.status='indexed' AND m.current_canonical
      AND NOT EXISTS(SELECT 1 FROM learning_cli_vector_e2e_runs f WHERE f.mastery_excluded AND f.session_id::text=m.conversation_id)`,[pending.map(m=>m.message_id)])).rows
    const covered=await view.present(chunks.map(c=>c.chunk_id))
    const missing=chunks.filter(c=>!covered.has(c.chunk_id))
    if(missing.length>=REACTIVE_SYSTEMIC_MISSING.minChunks && missing.length>chunks.length*REACTIVE_SYSTEMIC_MISSING.share)
      throw new Error(`${missing.length} of ${chunks.length} indexed chunks have no verified vector; the bank looks unavailable, routing stays pending`)
    const missingByMessage=new Map<string,string[]>()
    for(const c of missing) missingByMessage.set(c.message_id,[...(missingByMessage.get(c.message_id)??[]),c.chunk_id])
    const verified=chunks.filter(c=>covered.has(c.chunk_id))
    const hits=await view.hits(encoded,verified.map(c=>c.chunk_id),setting.config.threshold)
    const owners=new Map(verified.map(c=>[c.chunk_id,c.message_id]))
    for(const message of pending) {
      const unverified=missingByMessage.get(message.message_id)
      if(unverified) {
        const hold=(await q<{next_attempt_at:Date|null}>(`INSERT INTO learning_reactive_route_holds(user_id,event_id,revision,message_id,reason,missing_chunk_ids,next_attempt_at)
          VALUES($1,$2,$3,$4,$5,$6::text[],now()+make_interval(mins=>$7::int))
          ON CONFLICT(user_id,event_id,revision) DO UPDATE SET attempts=learning_reactive_route_holds.attempts+1,reason=EXCLUDED.reason,
            missing_chunk_ids=EXCLUDED.missing_chunk_ids,last_attempt_at=now(),
            next_attempt_at=CASE WHEN learning_reactive_route_holds.attempts+1>=$8 THEN NULL
              ELSE now()+make_interval(mins=>($9::int[])[learning_reactive_route_holds.attempts+1]) END
          RETURNING next_attempt_at`,[setting.user_id,message.event_id,setting.revision,message.message_id,REACTIVE_HOLD_REASON,unverified.sort(),
            REACTIVE_HOLD_BACKOFF_MINUTES[0],REACTIVE_HOLD_ATTEMPTS,[...REACTIVE_HOLD_BACKOFF_MINUTES]])).rows[0]
        held++;if(hold && hold.next_attempt_at===null) exhausted++
        continue
      }
      const matches=[...new Set(hits.filter(h=>owners.get(h.document_id)===message.message_id).map(h=>h.concept_id))]
      for(const conceptId of matches) {
        const sessionId=reactiveIdentity(setting.user_id,conceptId)
        await q('INSERT INTO learning_reactive_targets(user_id,session_id,concept_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[setting.user_id,sessionId,conceptId])
        await reactiveCoalescer.markArchiveDirty(setting.user_id,sessionId,reactiveIdentity(setting.user_id,setting.revision,embeddingRevision,message.event_id,conceptId),q)
      }
      // Routing receipt comes LAST. Replay repeats identical notification IDs;
      // it cannot lose a target or create duplicate dirty generations.
      await q('INSERT INTO learning_reactive_routes(user_id,message_id,revision,matches,event_id) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING',[setting.user_id,message.message_id,setting.revision,JSON.stringify({embeddingRevision,conceptIds:matches}),message.event_id])
      await q('DELETE FROM learning_reactive_route_holds WHERE user_id=$1 AND event_id=$2 AND revision=$3',[setting.user_id,message.event_id,setting.revision])
      messages++;concepts+=matches.length
    }
  }
  return {messages,concepts,held,exhausted}
}

/**
 * Runs one routing pass and records its outcome on every enabled owner's settings. The cause of a failure goes
 * into last_error (shown by health) and the thrown step error, truncated to 300 characters: on 2026-10-30 both
 * said only "routing failed" for twelve days while the reason sat in a log nobody read.
 */
export async function recordRoutingOutcome<T>(route:()=>Promise<T>,onError:(error:unknown)=>void,q:MetaPgQueryFn=defaultQuery):Promise<T> {
  let result:T
  try { result=await route() } catch(error) {
    onError(error)
    const reason=(error instanceof Error?error.message:String(error)).slice(0,300)
    await q('UPDATE learning_reactive_settings SET last_error=$1 WHERE enabled',[`Vector routing failed (${reason}); pending arrivals retained`])
    throw new Error(`Reactive routing failed; pending arrivals retained: ${reason}`)
  }
  await q('UPDATE learning_reactive_settings SET last_error=NULL WHERE enabled')
  return result
}

export const ReactiveHoldRelease=z.object({released:z.number()})
/**
 * A hold with any missing chunk flagged with text (VECTORLESS_WITH_CONTENT_REASON) waits for an operator
 * to accept that chunk: it cannot route until then, so a fresh retry budget would only re-exhaust it ~10.5 h
 * later and re-raise the alarm with nothing fixed (round-2 review N-S2). A mixed hold (one flagged chunk, one
 * missing for another reason) waits too, and the plan names it (round-3 R3-N3). A hold with no missing chunk
 * never waits for an accept. `reason` is the placeholder bound to the reason.
 */
export const holdAwaitsAccept=(reason:string)=>`EXISTS(SELECT 1 FROM unnest(h.missing_chunk_ids) AS m(id) JOIN learning_semantic_index_chunks c
  ON c.chunk_id=m.id AND c.status='indexed' AND c.error=${reason})`
/**
 * Operator release of held arrivals (all, or only exhausted ones): each routes again on the next pass, with a fresh
 * retry budget. `skipAwaitingAccept` (the recovery workflow) leaves holds that only an accept can resolve.
 */
export async function releaseReactiveHolds(userId:string,onlyExhausted=true,q:MetaPgQueryFn=defaultQuery,{skipAwaitingAccept=false}:{skipAwaitingAccept?:boolean}={}) {
  const result=skipAwaitingAccept
    ?await q(`DELETE FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND ($2::boolean=false OR h.next_attempt_at IS NULL) AND NOT ${holdAwaitsAccept('$3')}`,[userId,onlyExhausted,VECTORLESS_WITH_CONTENT_REASON])
    :await q(`DELETE FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND ($2::boolean=false OR h.next_attempt_at IS NULL)`,[userId,onlyExhausted])
  return {released:result.rowCount??0}
}

export async function prepareReactive(input:{userId:string;sessionId:string;dispatchId:string},vectors:LearningVectorTurnService) {
  const setting=await reactiveSettings(input.userId)
  if(!setting) throw new Error('Reactive configuration missing')
  const target=(await q<{concept_id:string}>('SELECT concept_id FROM learning_reactive_targets WHERE user_id=$1 AND session_id=$2',[input.userId,input.sessionId])).rows[0]
  if(!target) throw new Error('Missing reactive concept target')
  // The prior mode is frozen into the run's config, so a replay of this step never changes what the pass does.
  await vectors.create(input.dispatchId,input.userId,VectorTurnConfig.parse({purpose:'live',selection:'all',incremental:true,latestTurns:setting.config.latestTurns,threshold:setting.config.threshold,concurrency:1,conceptIds:[target.concept_id],datasetTag:'live',curriculumRevision:setting.revision,
    priorMode:assessmentPriorMode(process.env.LEARNING_ASSESSMENT_PRIOR_MODE)}))
  return {runId:input.dispatchId,conceptId:target.concept_id}
}

/** Native workflow completion alone is insufficient: verify every model receipt
 * and publish only the last concept part through the existing canonical fence. */
export async function publishReactive(input:{userId:string;sessionId:string;dispatchId:string;runId:string;generation:number},vectors:LearningVectorTurnService) {
  const state=await vectors.inspect(input.dispatchId,input.userId)
  if(state.config.purpose!=='live'||state.items.length!==1) throw new Error('Not an isolated live concept pass')
  if(state.pending||state.failed||!['completed','no_evidence'].includes(state.items[0]!.status)) throw new Error('Assessment receipts are incomplete or failed; generation not settled')
  const item=state.items[0]!
  if(!item.runId) {
    if(item.batches!==0) throw new Error('Missing final assessment identity')
    return {runId:input.dispatchId,status:'no_evidence'}
  }
  const result=(await q<{concept_id:string;node_version:string;input_hash:string;snapshot:{context:{nodeStates:ReturnType<typeof conceptFromGraphs>[]};prior:LearningConceptAssessment['assessment']};receipt:{status:string;assessment:LearningConceptAssessment['assessment'];completedAt:string}}>(`SELECT r.concept_id,r.node_version,r.input_hash,r.snapshot,t.receipt FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_receipts t USING(run_id) WHERE r.run_id=$1 AND r.user_id=$2 AND r.snapshot->>'experimentId'=$3`,[item.runId,input.userId,input.dispatchId])).rows[0]
  if(!result||!['completed','no_evidence','unchanged'].includes(result.receipt.status)) throw new Error('Final paid receipt is not publishable')
  if(result.receipt.assessment) {
    const written=await persistAssessmentCache(q,{userId:input.userId,concept:result.snapshot.context.nodeStates[0]!,nodeVersion:result.node_version,inputHash:result.input_hash,runId:item.runId,assessment:mergeIncrementalAssessment(result.snapshot.prior,result.receipt.assessment),completedAt:result.receipt.completedAt,admission:input})
    if(!written.rowCount) throw new Error('Live publication lost concept version, run ordering, or admission fence')
  }
  return {runId:input.dispatchId,status:result.receipt.status}
}
