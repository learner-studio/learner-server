import { beforeAll,afterAll,beforeEach,describe,test,expect } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import { markArchiveDirty,dispatchArchiveSessions,claimArchivePass,settleArchivePass,archiveSessionStatus,retryArchiveSession,ARCHIVE_CAPTURE_CONCURRENCY } from './learning-archive-coordinator.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { semanticIndexCoalescer as index } from './learning-archive-coordinator.js'
import { createLearningCoalescer } from './learning-archive-coordinator.js'

// Real PostgreSQL semantics in connection-local TEMP tables. Never mutate the
// application's coordination rows, workflow runs, archive bytes, or learners.
const suite=process.env.LEARNING_ARCHIVE_COORDINATOR_TEST_DATABASE_URL?describe:describe.skip
suite('archive admission durability and race boundaries',()=>{
  const client=new Client({connectionString:process.env.LEARNING_ARCHIVE_COORDINATOR_TEST_DATABASE_URL})
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
  })
  afterAll(async()=>{await client.end()})
  beforeEach(async()=>{await q('TRUNCATE pg_temp.learning_reactive_admission,pg_temp.learning_reactive_notifications,pg_temp.learning_index_admission,pg_temp.learning_index_notifications,pg_temp.learning_active_archive_sessions,pg_temp.learning_active_archive_notifications,pg_temp.learner_workflow_runs,pg_temp.learner_workflow_steps')})
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
    await q("UPDATE learner_workflow_runs SET status='failed' WHERE workflow_run_id=$1",[next.runId])
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(0)
    await reactive.markArchiveDirty(user,session,randomUUID(),q)
    expect((await reactive.dispatchArchiveSessions(begin,q)).started).toBe(0)
    const blocked=await reactive.archiveSessionStatus(user,session,q)
    expect(blocked.state).toBe('blocked')
    expect(blocked.capturedGeneration).toBe(1)
    expect(blocked.lastRunId).toBe(next.runId)
    expect((await q('SELECT * FROM learner_workflow_runs')).rowCount).toBe(2)
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
