import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { metaDbQuery as defaultQuery, type MetaPgQueryFn } from '../db-metadata/_shared.js'

export const ArchiveDispatchInput=z.object({userId:z.string(),sessionId:z.string().uuid(),dispatchId:z.string().uuid()})
export const ArchiveClaimInput=ArchiveDispatchInput.extend({runId:z.string().uuid()})
export const ArchivePass=ArchiveClaimInput.extend({generation:z.number().int().positive()})
export const ArchiveSessionInput=z.object({sessionId:z.string().uuid()})
export const ArchiveEmpty=z.object({})
export const ArchiveDispatchOutput=z.object({started:z.number().int()})
export const ArchiveStatus=z.object({sessionId:z.string(),requestedGeneration:z.number(),capturedGeneration:z.number(),runId:z.string().nullable(),lastRunId:z.string().nullable(),
  state:z.enum(['idle','pending','running','stalled','blocked']),attempts:z.number(),lastNotifiedAt:z.string().nullable(),lastFinishedAt:z.string().nullable(),lastFailure:z.string().nullable()})
type Dispatch=z.infer<typeof ArchiveDispatchInput>
type Row={user_id:string;session_id:string;requested_generation:string;captured_generation:string;dispatch_id:string|null;run_id:string|null;attempts:number;last_notified_at:Date;last_finished_at:Date|null;last_run_id:string|null;last_failure:string|null}
type Lock={withLock<T>(site:string,key:string,fn:()=>Promise<T>):Promise<T>}
type Start=(input:Dispatch)=>Promise<string>
const TERMINAL=['completed','failed','cancelled','canceled']
export const ARCHIVE_CAPTURE_CONCURRENCY=3
/** A live run untouched this long — run row and every step row — has lost its
 * timer or orchestrator job (e360d173 sat six days on a one-second sleep after
 * a restart replaced its definition). Healthy captures finish in seconds. */
export const ARCHIVE_RECLAIM_IDLE_MS=10*60_000
type Cancel=(runId:string)=>Promise<void>
/** Freshness is the newest of the run row and its steps: a step retrying every
 * second touches step rows while the run row stays put. Status and reclaim read
 * the same instant so they can never disagree about whether a run is stuck. */
async function runLastTouched(runId:string,q:MetaPgQueryFn) {
  return (await q<{updated_at:Date}>(`SELECT GREATEST(r.updated_at,COALESCE(MAX(s.updated_at),r.updated_at)) AS updated_at
    FROM learner_workflow_runs r LEFT JOIN learner_workflow_steps s USING(workflow_run_id) WHERE r.workflow_run_id=$1 GROUP BY r.updated_at`,[runId])).rows[0]?.updated_at??null
}
// Only short admission/read/write operations hold this lock. Never hold it
// while reading transcripts, waiting for a workflow, embedding, or calling LLMs.
export const archiveAdmission=<T>(lock:Lock,fn:()=>Promise<T>)=>lock.withLock('learning-archive-coalescing','admission',fn)

// Fixed identifiers only: callers cannot inject SQL table or workflow names.
export function createLearningCoalescer(lane:'archive'|'index'|'assessment') {
  const stateTable=lane==='assessment'?'learning_reactive_admission':lane==='archive'?'learning_active_archive_sessions':'learning_index_admission'
  const receiptTable=lane==='assessment'?'learning_reactive_notifications':lane==='archive'?'learning_active_archive_notifications':'learning_index_notifications'
  const workflowName=lane==='assessment'?'learningReactiveConceptWorkflow':lane==='archive'?'learningCoalescedArchiveWorkflow':'learningSemanticIndexWorkflow'
  const concurrency=lane==='index'?1:lane==='assessment'?9:ARCHIVE_CAPTURE_CONCURRENCY
async function markArchiveDirty(userId:string,sessionId:string,invocationId:string,q:MetaPgQueryFn=defaultQuery) {
  const prior=(await q<{user_id:string;session_id:string}>(`SELECT user_id,session_id FROM ${receiptTable} WHERE invocation_id=$1`,[invocationId])).rows[0]
  if(prior) {
    if(prior.user_id!==userId||prior.session_id!==sessionId) throw new Error('Archive invocation identity conflict')
    return
  }
  // Notification receipt and dirty watermark commit together. A crash can never
  // acknowledge a notification without making the session eligible for capture.
  await q(`WITH fresh AS (
    INSERT INTO ${receiptTable}(invocation_id,user_id,session_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id,session_id
  ) INSERT INTO ${stateTable}(user_id,session_id,requested_generation)
    SELECT user_id,session_id,1 FROM fresh
    ON CONFLICT(user_id,session_id) DO UPDATE SET requested_generation=${stateTable}.requested_generation+1,last_notified_at=now()`,[invocationId,userId,sessionId])
  const accepted=(await q<{user_id:string;session_id:string}>(`SELECT user_id,session_id FROM ${receiptTable} WHERE invocation_id=$1`,[invocationId])).rows[0]
  if(!accepted || accepted.user_id!==userId || accepted.session_id!==sessionId) throw new Error('Archive invocation identity conflict')
}

/** Called under the shared admission lock. Adopt dispatch-before-checkpoint
 * crashes by dispatchId; never steal a live run merely because it is slow. A
 * dispatcher handed `cancel` may reclaim a run idle past ARCHIVE_RECLAIM_IDLE_MS
 * — that write is fenced by updateRunStatus, which refuses to leave `completed`,
 * so a run finishing between the read and the cancel keeps its result. */
async function dispatchArchiveSessions(start:Start,q:MetaPgQueryFn=defaultQuery,maxActive=concurrency,{cancel}:{cancel?:Cancel}={}) {
  if(!Number.isInteger(maxActive)||maxActive<1||maxActive>concurrency) throw new Error('Invalid coalescer concurrency')
  const rows=(await q<Row>(`SELECT * FROM ${stateTable} WHERE requested_generation>captured_generation ORDER BY last_notified_at`)).rows
  let active=0
  const ready:Row[]=[]
  for(const row of rows) {
    if(row.dispatch_id) {
      const run=(await q<{workflow_run_id:string;status:string}>(`SELECT workflow_run_id,status FROM learner_workflow_runs
        WHERE workflow='${workflowName}' AND input::jsonb->>'dispatchId'=$1 ORDER BY created_at LIMIT 1`,[row.dispatch_id])).rows[0]
      let ended=run?`ended ${run.status}`:''
      if(run && !TERMINAL.includes(run.status)) {
        const touched=cancel?await runLastTouched(run.workflow_run_id,q):null
        const idle=touched?Date.now()-touched.getTime():0
        if(!cancel || idle<ARCHIVE_RECLAIM_IDLE_MS) {
          await q(`UPDATE ${stateTable} SET run_id=$3 WHERE user_id=$1 AND session_id=$2 AND dispatch_id=$4`,[row.user_id,row.session_id,run.workflow_run_id,row.dispatch_id])
          active++;continue
        }
        await cancel(run.workflow_run_id)
        run.status='cancelled';ended=`stalled ${Math.round(idle/1000)}s with no run or step update and was cancelled`
      }
      if(run) {
        // A terminal assessment may have spent tokens without a receipt. Unlike
        // repeatable capture, never invent a new dispatch and retry it blindly.
        if(lane==='assessment') {
          await q(`UPDATE ${stateTable} SET attempts=3,last_run_id=$5,run_id=NULL,dispatch_id=NULL,active_slot=NULL,last_failure=$3 WHERE user_id=$1 AND session_id=$2 AND dispatch_id=$4`,[row.user_id,row.session_id,`Assessment workflow ${ended} before settlement; review original paid receipts`,row.dispatch_id,run.workflow_run_id])
          continue
        }
        // A failed/cancelled pass never advances captured_generation. New events
        // do not reset this budget, so a bad source cannot create a retry storm.
        const cleared=await q(`UPDATE ${stateTable} SET dispatch_id=NULL,run_id=NULL,active_slot=NULL,last_failure=$3 WHERE user_id=$1 AND session_id=$2 AND dispatch_id=$4`,[row.user_id,row.session_id,`Capture workflow ${ended} before settlement`,row.dispatch_id])
        if(!cleared.rowCount) continue
        row.dispatch_id=null;row.run_id=null
      }
      // No run: start never durably committed. Reuse the reserved dispatchId.
    }
    if(row.attempts<3 || row.dispatch_id) ready.push(row)
  }
  let started=0
  for(const row of ready.slice(0,Math.max(0,maxActive-active))) {
    const dispatchId=row.dispatch_id??randomUUID()
    if(!row.dispatch_id) {
      // CAS + UNIQUE slot is the final fence even if the advisory-lock connection
      // is lost. A stale dispatcher cannot overwrite another reservation, and
      // more than three captures cannot acquire a database admission slot.
      const reserved=await q(`UPDATE ${stateTable} SET dispatch_id=$3,attempts=attempts+1,
        active_slot=(SELECT n FROM generate_series(1,${concurrency}) n WHERE NOT EXISTS(SELECT 1 FROM ${stateTable} occupied WHERE occupied.active_slot=n) ORDER BY n LIMIT 1)
        WHERE user_id=$1 AND session_id=$2 AND dispatch_id IS NULL AND attempts<3
        AND EXISTS(SELECT 1 FROM generate_series(1,${concurrency}) n WHERE NOT EXISTS(SELECT 1 FROM ${stateTable} occupied WHERE occupied.active_slot=n)) RETURNING dispatch_id`,[row.user_id,row.session_id,dispatchId])
      if(!reserved.rowCount) continue
    }
    const runId=await start({userId:row.user_id,sessionId:row.session_id,dispatchId})
    await q(`UPDATE ${stateTable} SET run_id=$3 WHERE user_id=$1 AND session_id=$2 AND dispatch_id=$4`,[row.user_id,row.session_id,runId,dispatchId])
    started++
  }
  return {started}
}

async function claimArchivePass(input:z.infer<typeof ArchiveClaimInput>,q:MetaPgQueryFn=defaultQuery) {
  const row=(await q<Row>(`SELECT * FROM ${stateTable} WHERE user_id=$1 AND session_id=$2`,[input.userId,input.sessionId])).rows[0]
  if(!row || row.dispatch_id!==input.dispatchId || row.run_id!==input.runId) throw new Error('Archive pass lost admission fence')
  return {...input,generation:Number(row.requested_generation)}
}

async function settleArchivePass(input:z.infer<typeof ArchivePass>,q:MetaPgQueryFn=defaultQuery) {
  await q(`UPDATE ${stateTable} SET captured_generation=GREATEST(captured_generation,$5),dispatch_id=NULL,run_id=NULL,active_slot=NULL,
    attempts=0,last_finished_at=now(),last_run_id=$4,last_failure=NULL WHERE user_id=$1 AND session_id=$2 AND dispatch_id=$3 AND run_id=$4`,
    [input.userId,input.sessionId,input.dispatchId,input.runId,input.generation])
  // Stale completion is a no-op; it cannot clear or acknowledge a newer pass.
  return {started:0}
}

/** Explicit operator action after fixing a blocked source. Never reset a live
 * capture, and retain an unacknowledged start's dispatch identity for adoption. */
async function retryArchiveSession(userId:string,sessionId:string,q:MetaPgQueryFn=defaultQuery) {
  const row=(await q<Row>(`SELECT * FROM ${stateTable} WHERE user_id=$1 AND session_id=$2`,[userId,sessionId])).rows[0]
  if(!row || row.attempts<3) throw new Error('Only an exhausted archive session may be retried')
  const run=row.dispatch_id?(await q<{status:string}>(`SELECT status FROM learner_workflow_runs WHERE workflow='${workflowName}' AND input::jsonb->>'dispatchId'=$1`,[row.dispatch_id])).rows[0]:null
  if(run && !TERMINAL.includes(run.status)) throw new Error('Cannot retry a live archive workflow')
  if(run) await q(`UPDATE ${stateTable} SET dispatch_id=NULL,run_id=NULL,active_slot=NULL WHERE user_id=$1 AND session_id=$2 AND dispatch_id=$3`,[userId,sessionId,row.dispatch_id])
  await q(`UPDATE ${stateTable} SET attempts=0,last_failure=NULL WHERE user_id=$1 AND session_id=$2`,[userId,sessionId])
}

async function archiveSessionStatus(userId:string,sessionId:string,q:MetaPgQueryFn=defaultQuery) {
  const row=(await q<Row>(`SELECT * FROM ${stateTable} WHERE user_id=$1 AND session_id=$2`,[userId,sessionId])).rows[0]
  const requested=Number(row?.requested_generation??0),captured=Number(row?.captured_generation??0)
  const touched=row?.run_id?await runLastTouched(row.run_id,q):null
  return ArchiveStatus.parse({sessionId,requestedGeneration:requested,capturedGeneration:captured,runId:row?.run_id??null,lastRunId:row?.last_run_id??null,
    state:requested===captured?'idle':row?.run_id?(touched && Date.now()-touched.getTime()>30000?'stalled':'running'):row?.attempts===3?'blocked':'pending',
    attempts:row?.attempts??0,lastNotifiedAt:row?.last_notified_at.toISOString()??null,lastFinishedAt:row?.last_finished_at?.toISOString()??null,lastFailure:row?.last_failure??null})
}

  return {lane,maxConcurrency:concurrency,markArchiveDirty,dispatchArchiveSessions,claimArchivePass,settleArchivePass,retryArchiveSession,archiveSessionStatus}
}
export const {markArchiveDirty,dispatchArchiveSessions,claimArchivePass,settleArchivePass,retryArchiveSession,archiveSessionStatus}=createLearningCoalescer('archive')
export const semanticIndexCoalescer=createLearningCoalescer('index')
