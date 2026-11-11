import { beforeAll,afterAll,beforeEach,describe,test,expect } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { markArchiveDirty,dispatchArchiveSessions,claimArchivePass,settleArchivePass,archiveSessionStatus,retryArchiveSession,ARCHIVE_CAPTURE_CONCURRENCY,UNPAID_FAILURE_MARKER,UNPAID_RETRY_BACKOFF_MINUTES } from './learning-archive-coordinator.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { semanticIndexCoalescer as index } from './learning-archive-coordinator.js'
import { createLearningCoalescer } from './learning-archive-coordinator.js'

// Real PostgreSQL semantics in connection-local TEMP tables. Never mutate the
// application's coordination rows, workflow runs, archive bytes, or learners.
// Falls back to learner_test so these run in the normal suite; every table they write is TEMP.
const coordinatorDb=process.env.LEARNING_ARCHIVE_COORDINATOR_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL
const suite=coordinatorDb?describe:describe.skip
suite('archive admission durability and race boundaries',()=>{
  const client=new Client({connectionString:coordinatorDb})
  const q:MetaPgQueryFn=async(text,params)=>{const r=await client.query(text,params?[...params]:[]);return {rows:r.rows,rowCount:r.rowCount??0}}
  const user='isolated-archive-test'
  const session=randomUUID()
  const start=async(data:{userId:string;sessionId:string;dispatchId:string})=>{
    const runId=randomUUID()
    await q('INSERT INTO learner_workflow_runs(workflow_run_id,workflow,input,status) VALUES($1,$2,$3,$4)',[runId,'learningCoalescedArchiveWorkflow',JSON.stringify(data),'running'])
    return runId
  }
  const pass=async()=>{
    const row=(await q('SELECT * FROM learning_active_archive_sessions WHERE user_id=$1 AND session_id=$2',[user,session])).rows[0]
    return claimArchivePass({userId:user,sessionId:session,dispatchId:row.dispatch_id,runId:row.run_id},q)
  }
  beforeAll(async()=>{
    await client.connect()
    await q('CREATE TEMP TABLE learner_workflow_runs(workflow_run_id uuid PRIMARY KEY,workflow text,input text,status text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now())')
    await q('CREATE TEMP TABLE learner_workflow_steps(workflow_run_id uuid,updated_at timestamptz DEFAULT now())')
    const migration=await Bun.file(new URL('../../../test/fixtures/source-migrations/0166-learning-active-archive-coalescing.sql',import.meta.url)).text()
    await client.query(migration.replaceAll('CREATE TABLE','CREATE TEMP TABLE'))
    const indexMigration=await Bun.file(new URL('../../../test/fixtures/source-migrations/0167-learning-index-admission.sql',import.meta.url)).text()
    await client.query(indexMigration.replaceAll('CREATE TABLE','CREATE TEMP TABLE'))
    await q('CREATE TEMP TABLE learning_reactive_admission (LIKE learning_active_archive_sessions INCLUDING ALL)')
    await q('CREATE TEMP TABLE learning_reactive_notifications (LIKE learning_active_archive_notifications INCLUDING ALL)')
    await client.query(await Bun.file(new URL('../../../test/fixtures/source-migrations/0173-learning-reactive-nine-slots.sql',import.meta.url)).text())
    await q('ALTER TABLE pg_temp.learning_reactive_admission ADD COLUMN last_failed_at timestamptz') // migration 0024
    await q('ALTER TABLE pg_temp.learning_reactive_admission ADD COLUMN waiting_since timestamptz, ADD COLUMN unpaid_failures integer NOT NULL DEFAULT 0') // migration 0029
    // Shadows of the paid-call fence: a row pair here means a pass reserved a model call.
    await q('CREATE TEMP TABLE learning_vector_turn_assessments(experiment_id uuid NOT NULL,run_id uuid NOT NULL)')
    await q('CREATE TEMP TABLE learning_concept_assessment_attempts(run_id uuid NOT NULL)')
  })
  afterAll(async()=>{await client.end()})
  beforeEach(async()=>{await q('TRUNCATE pg_temp.learning_reactive_admission,pg_temp.learning_reactive_notifications,pg_temp.learning_index_admission,pg_temp.learning_index_notifications,pg_temp.learning_active_archive_sessions,pg_temp.learning_active_archive_notifications,pg_temp.learner_workflow_runs,pg_temp.learner_workflow_steps,pg_temp.learning_vector_turn_assessments,pg_temp.learning_concept_assessment_attempts')})
  test('assessment reuses generation fences and never blindly retries a terminal paid pass',async()=>{
    const reactive=createLearningCoalescer('assessment')
    const begin=async(data:{userId:string;sessionId:string;dispatchId:string})=>{
      const id=randomUUID();await q('INSERT INTO learner_workflow_runs(workflow_run_id,workflow,input,status) VALUES($1,$2,$3,$4)',[id,'learningReactiveConceptWorkflow',JSON.stringify(data),'running']);return id
    }
    const id=randomUUID()
    await reactive.markArchiveDirty(user,session,id,q)
    await reactive.markArchiveDirty(user,session,id,q)
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(1)
    const row=(await q('SELECT * FROM learning_reactive_admission')).rows[0]
    const pass=await reactive.claimArchivePass({userId:user,sessionId:session,dispatchId:row.dispatch_id,runId:row.run_id},q)
    expect(pass.generation).toBe(1)
    await reactive.markArchiveDirty(user,session,randomUUID(),q)
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(0)
    await reactive.settleArchivePass(pass,q)
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(1)
    const next=await reactive.archiveSessionStatus(user,session,q)
    await reactive.settleArchivePass(pass,q)
    expect((await reactive.archiveSessionStatus(user,session,q)).runId).toBe(next.runId)
    // This pass reserved a paid model call before failing.
    const paidRun=randomUUID(),paidDispatch=(await q('SELECT dispatch_id FROM learning_reactive_admission')).rows[0].dispatch_id
    await q('INSERT INTO learning_vector_turn_assessments VALUES($1,$2)',[paidDispatch,paidRun])
    await q('INSERT INTO learning_concept_assessment_attempts VALUES($1)',[paidRun])
    await q("UPDATE learner_workflow_runs SET status='failed' WHERE workflow_run_id=$1",[next.runId])
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(0)
    await reactive.markArchiveDirty(user,session,randomUUID(),q)
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(0)
    const blocked=await reactive.archiveSessionStatus(user,session,q)
    expect(blocked.state).toBe('blocked')
    expect(blocked.capturedGeneration).toBe(1)
    expect(blocked.lastRunId).toBe(next.runId)
    expect((await q('SELECT * FROM learner_workflow_runs')).rowCount).toBe(2)
    // The operator's retry of a reviewed paid failure restarts the wait: the old waiting_since would read as
    // days-old waiting work before the first pass settles (round-3 R3-N2).
    await q("UPDATE learning_reactive_admission SET attempts=3,waiting_since=now()-interval '30 hours'")
    await reactive.retryArchiveSession(user,session,q)
    const retried=(await q("SELECT attempts,extract(epoch FROM now()-waiting_since) AS age FROM learning_reactive_admission")).rows[0]
    expect(retried.attempts).toBe(0)
    expect(Number(retried.age)).toBeLessThan(60)
  })
  test('a pass that failed before any paid call never spends the breaker: it retries on a capped backoff for as long as it fails, and never touches a sibling',async()=>{
    // 2026-10-30: a coverage guard refused 246 passes before any model call and each went straight to the breaker.
    // Review S4: an outage longer than a fixed retry budget must not strand them either; such a failure costs nothing.
    const reactive=createLearningCoalescer('assessment')
    const begin=async(data:{userId:string;sessionId:string;dispatchId:string})=>{
      const id=randomUUID();await q('INSERT INTO learner_workflow_runs(workflow_run_id,workflow,input,status) VALUES($1,$2,$3,$4)',[id,'learningReactiveConceptWorkflow',JSON.stringify(data),'running']);return id
    }
    const failing=randomUUID(),sibling=randomUUID()
    await reactive.markArchiveDirty(user,failing,randomUUID(),q)
    await reactive.markArchiveDirty(user,sibling,randomUUID(),q)
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(2)
    const siblingRun=(await reactive.archiveSessionStatus(user,sibling,q)).runId
    const waits=[5,30,60,60,60]
    expect(UNPAID_RETRY_BACKOFF_MINUTES.slice(1)).toEqual([5,30,60])
    for(const [i,wait] of waits.entries()) {
      const failure=i+1
      const state=await reactive.archiveSessionStatus(user,failing,q)
      expect(state.attempts).toBe(1)
      await q("UPDATE learner_workflow_runs SET status='failed' WHERE workflow_run_id=$1",[state.runId])
      expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(0)
      const failed=(await q('SELECT * FROM learning_reactive_admission WHERE session_id=$1',[failing])).rows[0]
      expect(failed.last_failure).toBe(`Assessment workflow ended failed ${UNPAID_FAILURE_MARKER} (failure ${failure}; retried after ${wait} min)`)
      expect(failed).toMatchObject({dispatch_id:null,attempts:0,unpaid_failures:failure})
      expect(failed.last_failed_at).not.toBeNull()
      // One minute short of its backoff: not restarted. One minute past it: restarted, never blocked.
      await q(`UPDATE learning_reactive_admission SET last_failed_at=now()-make_interval(mins=>$2::int) WHERE session_id=$1`,[failing,wait-1])
      expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(0)
      await q(`UPDATE learning_reactive_admission SET last_failed_at=now()-make_interval(mins=>$2::int) WHERE session_id=$1`,[failing,wait+1])
      expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(1)
    }
    expect((await reactive.archiveSessionStatus(user,failing,q)).state).not.toBe('blocked')
    // A settled pass resets the unpaid count, so the next failure waits 5 minutes again.
    const live=(await q('SELECT * FROM learning_reactive_admission WHERE session_id=$1',[failing])).rows[0]
    const pass=await reactive.claimArchivePass({userId:user,sessionId:failing,dispatchId:live.dispatch_id,runId:live.run_id},q)
    await reactive.settleArchivePass(pass,q)
    expect((await q('SELECT unpaid_failures,last_failed_at FROM learning_reactive_admission WHERE session_id=$1',[failing])).rows[0]).toEqual({unpaid_failures:0,last_failed_at:null})
    // The sibling kept its one live run and its own budget throughout.
    const after=await reactive.archiveSessionStatus(user,sibling,q)
    expect(after.runId).toBe(siblingRun)
    expect(after.attempts).toBe(1)
    expect(after.lastFailure).toBeNull()
    expect((await q("SELECT count(*)::int n FROM learner_workflow_runs WHERE input::jsonb->>'sessionId'=$1",[sibling])).rows[0].n).toBe(1)
  })
  test('waiting_since is when a concept FIRST became waiting: later arrivals keep it, a settled pass restarts or clears it (review S7)',async()=>{
    const reactive=createLearningCoalescer('assessment')
    const begin=async(data:{userId:string;sessionId:string;dispatchId:string})=>{
      const id=randomUUID();await q('INSERT INTO learner_workflow_runs(workflow_run_id,workflow,input,status) VALUES($1,$2,$3,$4)',[id,'learningReactiveConceptWorkflow',JSON.stringify(data),'running']);return id
    }
    const concept=randomUUID()
    const row=async()=>(await q('SELECT * FROM learning_reactive_admission WHERE session_id=$1',[concept])).rows[0]
    await reactive.markArchiveDirty(user,concept,randomUUID(),q)
    expect((await row()).waiting_since).not.toBeNull()
    await q("UPDATE learning_reactive_admission SET waiting_since=now()-interval '3 days' WHERE session_id=$1",[concept])
    const first=(await row()).waiting_since.getTime()
    await reactive.markArchiveDirty(user,concept,randomUUID(),q)
    expect((await row()).waiting_since.getTime()).toBe(first)
    expect((await row()).last_notified_at.getTime()).toBeGreaterThan(first)
    // A pass captures generation 2; a third arrival during it leaves the concept waiting, from the settle on.
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(1)
    const live=await row()
    const pass=await reactive.claimArchivePass({userId:user,sessionId:concept,dispatchId:live.dispatch_id,runId:live.run_id},q)
    await reactive.markArchiveDirty(user,concept,randomUUID(),q)
    await reactive.settleArchivePass(pass,q)
    const restarted=await row()
    expect(restarted.waiting_since.getTime()).toBeGreaterThan(first)
    // Fully captured: not waiting at all.
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(1)
    const next=await row()
    await reactive.settleArchivePass(await reactive.claimArchivePass({userId:user,sessionId:concept,dispatchId:next.dispatch_id,runId:next.run_id},q),q)
    expect((await row()).waiting_since).toBeNull()
  })
  test('assessment concurrency is bounded and parameterized without changing archive slots',async()=>{
    const reactive=createLearningCoalescer('assessment')
    const begin=async(data:{userId:string;sessionId:string;dispatchId:string})=>{
      const id=randomUUID();await q('INSERT INTO learner_workflow_runs(workflow_run_id,workflow,input,status) VALUES($1,$2,$3,$4)',[id,'learningReactiveConceptWorkflow',JSON.stringify(data),'running']);return id
    }
    for(let i=0;i<12;i++) await reactive.markArchiveDirty(user,randomUUID(),randomUUID(),q)
    expect((await reactive.dispatchArchiveSessions(begin,q,2)).started).toBe(2)
    expect((await reactive.dispatchArchiveSessions(begin,q,2)).started).toBe(0)
    expect((await reactive.dispatchArchiveSessions(begin,q,3)).started).toBe(1)
    expect((await reactive.dispatchArchiveSessions(begin,q,9)).started).toBe(6)
    expect((await reactive.dispatchArchiveSessions(begin,q,9)).started).toBe(0)
    expect((await q('SELECT * FROM learning_reactive_admission WHERE active_slot IS NOT NULL')).rowCount).toBe(9)
    const row=(await q('SELECT * FROM learning_reactive_admission WHERE active_slot=1')).rows[0]
    const pass=await reactive.claimArchivePass({userId:user,sessionId:row.session_id,dispatchId:row.dispatch_id,runId:row.run_id},q)
    await q('UPDATE learner_workflow_runs SET status=$2 WHERE workflow_run_id=$1',[row.run_id,'completed'])
    await reactive.settleArchivePass(pass,q)
    expect((await reactive.dispatchArchiveSessions(begin,q,9)).started).toBe(1)
    expect((await q('SELECT * FROM learning_active_archive_sessions')).rowCount).toBe(0)
    await expect(reactive.dispatchArchiveSessions(begin,q,10)).rejects.toThrow()
  })
  test('index lane reuses coalescing with one slot and a fenced follow-up',async()=>{
    const begin=async(data:{userId:string;sessionId:string;dispatchId:string})=>{
      const id=randomUUID();await q('INSERT INTO learner_workflow_runs(workflow_run_id,workflow,input,status) VALUES($1,$2,$3,$4)',[id,'learningSemanticIndexWorkflow',JSON.stringify(data),'running']);return id
    }
    const notification=randomUUID()
    await index.markArchiveDirty(user,session,notification,q)
    await index.markArchiveDirty(user,session,notification,q)
    await index.dispatchArchiveSessions(begin,q)
    const row=(await q('SELECT * FROM learning_index_admission')).rows[0]
    const first=await index.claimArchivePass({userId:user,sessionId:session,dispatchId:row.dispatch_id,runId:row.run_id},q)
    expect(first.generation).toBe(1)
    for(let i=0;i<20;i++) await index.markArchiveDirty(user,session,randomUUID(),q)
    expect((await index.dispatchArchiveSessions(begin,q)).started).toBe(0)
    await index.settleArchivePass(first,q)
    expect((await index.dispatchArchiveSessions(begin,q)).started).toBe(1)
    const next=await index.archiveSessionStatus(user,session,q)
    await index.settleArchivePass(first,q)
    expect((await index.archiveSessionStatus(user,session,q)).runId).toBe(next.runId)
    expect(next.requestedGeneration).toBe(21)
    expect(next.capturedGeneration).toBe(1)
    expect((await q('SELECT * FROM learning_active_archive_sessions')).rowCount).toBe(0)
  })
  test('100 unique notifications create one capture; duplicate retry does not increment',async()=>{
    const id=randomUUID()
    await markArchiveDirty(user,session,id,q)
    await markArchiveDirty(user,session,id,q)
    for(let i=1;i<100;i++) await markArchiveDirty(user,session,randomUUID(),q)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(1)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
    expect((await archiveSessionStatus(user,session,q)).requestedGeneration).toBe(100)
    expect((await pass()).generation).toBe(100)
    expect((await q('SELECT * FROM learner_workflow_runs')).rowCount).toBe(1)
  })
  test('notifications during capture require one follow-up and old settlement cannot clear it',async()=>{
    await markArchiveDirty(user,session,randomUUID(),q);await dispatchArchiveSessions(start,q)
    const first=await pass()
    for(let i=0;i<20;i++) await markArchiveDirty(user,session,randomUUID(),q)
    await settleArchivePass(first,q)
    expect((await archiveSessionStatus(user,session,q)).capturedGeneration).toBe(1)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(1)
    const next=await pass()
    await settleArchivePass(first,q)
    expect((await archiveSessionStatus(user,session,q)).runId).toBe(next.runId)
    await settleArchivePass(next,q)
    expect((await archiveSessionStatus(user,session,q)).state).toBe('idle')
    expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
  })
  test('notification arriving after settlement is not lost',async()=>{
    await markArchiveDirty(user,session,randomUUID(),q);await dispatchArchiveSessions(start,q)
    await settleArchivePass(await pass(),q)
    await markArchiveDirty(user,session,randomUUID(),q)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(1)
  })
  test('global admission starts only three sessions and leaves others durable',async()=>{
    for(let i=0;i<7;i++) await markArchiveDirty(user,randomUUID(),randomUUID(),q)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(ARCHIVE_CAPTURE_CONCURRENCY)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
    expect((await q('SELECT * FROM learning_active_archive_sessions WHERE run_id IS NULL')).rowCount).toBe(4)
  })
  test('adopts start-before-pointer crash; never duplicates the live workflow',async()=>{
    await markArchiveDirty(user,session,randomUUID(),q)
    await expect(dispatchArchiveSessions(async data=>{await start(data);throw new Error('lost response')},q)).rejects.toThrow('lost response')
    expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
    expect((await q('SELECT * FROM learner_workflow_runs')).rowCount).toBe(1)
    expect((await archiveSessionStatus(user,session,q)).runId).not.toBeNull()
  })
  test('reuses reserved identity when start failed before committing',async()=>{
    await markArchiveDirty(user,session,randomUUID(),q)
    await expect(dispatchArchiveSessions(async()=>{throw new Error('offline')},q)).rejects.toThrow()
    const reserved=(await q('SELECT dispatch_id FROM learning_active_archive_sessions')).rows[0].dispatch_id
    expect((await dispatchArchiveSessions(start,q)).started).toBe(1)
    expect((await pass()).dispatchId).toBe(reserved)
    expect((await archiveSessionStatus(user,session,q)).attempts).toBe(1)
  })
  test('terminal failures exhaust a bounded budget without acknowledging data',async()=>{
    await markArchiveDirty(user,session,randomUUID(),q)
    for(let i=0;i<3;i++) {
      await dispatchArchiveSessions(start,q)
      await q("UPDATE learner_workflow_runs SET status='failed'")
    }
    await markArchiveDirty(user,session,randomUUID(),q)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
    const state=await archiveSessionStatus(user,session,q)
    expect(state.state).toBe('blocked');expect(state.capturedGeneration).toBe(0)
    await retryArchiveSession(user,session,q)
    expect((await dispatchArchiveSessions(start,q)).started).toBe(1)
  })
  test('slow run is reported but never stolen; identities are owner/session fenced',async()=>{
    const notification=randomUUID()
    await markArchiveDirty(user,session,notification,q);await dispatchArchiveSessions(start,q)
    await q("UPDATE learner_workflow_runs SET updated_at=now()-interval '1 hour'")
    expect((await archiveSessionStatus(user,session,q)).state).toBe('stalled')
    expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
    await expect(markArchiveDirty('other',session,notification,q)).rejects.toThrow('identity conflict')
    await expect(claimArchivePass({...await pass(),runId:randomUUID()},q)).rejects.toThrow('fence')
    expect((await archiveSessionStatus('other',session,q)).requestedGeneration).toBe(0)
    await q('INSERT INTO learner_workflow_steps(workflow_run_id) VALUES($1)',[(await pass()).runId])
    expect((await archiveSessionStatus(user,session,q)).state).toBe('running')
  })
  test('a run idle past the reclaim bound is cancelled and re-dispatched, but only by a dispatcher that CAN cancel',async()=>{
    // Run e360d173 (2026-09-07) sat `running` for six days on a one-second
    // sleep step after a restart lost its timer job; the dispatcher read it as
    // live and this session's archive never captured again. The status view
    // already called it `stalled` — reporting and reclaiming disagreed.
    const cancelled:string[]=[]
    const cancel=async(runId:string)=>{cancelled.push(runId);await q("UPDATE learner_workflow_runs SET status='cancelled' WHERE workflow_run_id=$1",[runId])}
    await markArchiveDirty(user,session,randomUUID(),q);await dispatchArchiveSessions(start,q)
    const wedged=(await pass()).runId
    // Two minutes idle: `stalled` for display (30s), but well inside anything a
    // live capture has ever taken (p99 26s, max step 23s) — NOT reclaimed.
    await q("UPDATE learner_workflow_runs SET updated_at=now()-interval '2 minutes'")
    expect((await archiveSessionStatus(user,session,q)).state).toBe('stalled')
    expect((await dispatchArchiveSessions(start,q,ARCHIVE_CAPTURE_CONCURRENCY,{cancel})).started).toBe(0)
    expect(cancelled).toEqual([])
    // A step touched recently keeps a run live even when the run row is old:
    // freshness is the newest of run and step, the same reading status uses.
    await q("UPDATE learner_workflow_runs SET updated_at=now()-interval '1 hour'")
    await q("INSERT INTO learner_workflow_steps(workflow_run_id,updated_at) VALUES($1,now()-interval '1 minute')",[wedged])
    expect((await dispatchArchiveSessions(start,q,ARCHIVE_CAPTURE_CONCURRENCY,{cancel})).started).toBe(0)
    expect(cancelled).toEqual([])
    // Past the bound with nothing fresher: cancelled, then the ordinary
    // terminal path clears the dispatch and starts a new capture in one pass.
    await q('DELETE FROM learner_workflow_steps')
    expect((await dispatchArchiveSessions(start,q,ARCHIVE_CAPTURE_CONCURRENCY,{cancel})).started).toBe(1)
    expect(cancelled).toEqual([wedged])
    const after=await pass()
    expect(after.runId).not.toBe(wedged)
    expect((await q("SELECT status FROM learner_workflow_runs WHERE workflow_run_id=$1",[wedged])).rows[0].status).toBe('cancelled')
    const row=(await q('SELECT last_failure,attempts FROM learning_active_archive_sessions')).rows[0]
    expect(row.last_failure).toContain('stalled')
    expect(row.attempts).toBe(2)
  })
  test('without a cancel capability a wedged run is still never stolen (the invariant test 176 pins)',async()=>{
    await markArchiveDirty(user,session,randomUUID(),q);await dispatchArchiveSessions(start,q)
    await q("UPDATE learner_workflow_runs SET updated_at=now()-interval '7 days'")
    expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
    expect((await archiveSessionStatus(user,session,q)).state).toBe('stalled')
  })
  test('suspended and unknown runtime states retain their slot and fence',async()=>{
    await markArchiveDirty(user,session,randomUUID(),q);await dispatchArchiveSessions(start,q)
    const current=await pass()
    for(const status of ['suspended','future-nonterminal-state']) {
      await q('UPDATE learner_workflow_runs SET status=$1',[status])
      expect((await dispatchArchiveSessions(start,q)).started).toBe(0)
      expect((await pass()).dispatchId).toBe(current.dispatchId)
    }
  })
  test('database uniquely fences late concurrent starts for the same dispatch',async()=>{
    const data={userId:user,sessionId:session,dispatchId:randomUUID()}
    await start(data)
    await expect(start(data)).rejects.toThrow('duplicate key')
    expect((await q('SELECT * FROM learner_workflow_runs')).rowCount).toBe(1)
  })
  test('interleaved dispatchers without the advisory lock cannot exceed database slots',async()=>{
    for(let i=0;i<8;i++) await markArchiveDirty(user,randomUUID(),randomUUID(),q)
    await Promise.allSettled(Array.from({length:8},()=>dispatchArchiveSessions(start,q)))
    await dispatchArchiveSessions(start,q)
    expect((await q('SELECT * FROM learning_active_archive_sessions WHERE active_slot IS NOT NULL')).rowCount).toBe(3)
    expect((await q('SELECT * FROM learner_workflow_runs')).rowCount).toBe(3)
  })
})
