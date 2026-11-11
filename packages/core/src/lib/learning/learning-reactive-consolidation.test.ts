import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {Client} from 'pg'
import {reactiveIdentity,ReactiveConfig,publishReactive,isKnownFailedPart} from './learning-reactive-consolidation.js'
import {IDENTICAL_EVIDENCE_FAILED,IDENTICAL_EVIDENCE_UNKNOWN} from '../../services/learning-concept-assessment.js'
import type {MetaPgQueryFn} from '../db-metadata/_shared.js'

describe('reactive identity and admission configuration',()=>{
  test('routing IDs survive replay but separate concept, owner and arrival',()=>{
    const id=reactiveIdentity('owner','revision','event','http')
    expect(id).toBe(reactiveIdentity('owner','revision','event','http'))
    expect(id).not.toBe(reactiveIdentity('owner','revision','event','css'))
    expect(id).not.toBe(reactiveIdentity('other','revision','event','http'))
    expect(id).not.toBe(reactiveIdentity('owner','revision','event2','http'))
    expect(id).toMatch(/^[a-f0-9-]{36}$/)
  })
  test('routing can be enabled without paid assessment and concurrency remains bounded',()=>{
    expect(ReactiveConfig.parse({enabled:true}).assessmentEnabled).toBe(false)
    expect(ReactiveConfig.parse({enabled:true}).latestTurns).toBe(50)
    expect(ReactiveConfig.parse({enabled:true}).concurrency).toBe(9)
    expect(ReactiveConfig.safeParse({enabled:true,concurrency:9}).success).toBe(true)
    expect(ReactiveConfig.safeParse({enabled:true,concurrency:10}).success).toBe(false)
  })
})
describe('a pass whose evidence already failed a paid grading settles instead of looping (round 7)',()=>{
  // Before: such a part was 'uncertain', the pass threw before any paid call, and the unpaid backoff retried
  // it every 5/30/60 min for ever while the alarm sat at warning. Now the pass settles with no reading.
  const known={status:'failed',error:`${IDENTICAL_EVIDENCE_FAILED} (run earlier, failed); not paid again.`}
  const paidFailure={status:'failed',error:'Model output failed validation'}
  const unknown={status:'uncertain',error:`${IDENTICAL_EVIDENCE_UNKNOWN}.`}
  const ok={status:'completed',error:null}
  const input={userId:'u',sessionId:'s',dispatchId:'d',runId:'r',generation:1}
  const vectors=(status:string,pending=0)=>({inspect:async()=>({config:{purpose:'live'},pending,failed:status==='failed'?1:0,
    items:[{status,runId:'last',batches:2}]})}) as never
  const store=(parts:ReadonlyArray<{status:string|null;error:string|null}>)=>{
    const sqls:string[]=[]
    const query:MetaPgQueryFn=async<R>(sql:string)=>{
      sqls.push(sql)
      if(sql.includes('FROM learning_vector_turn_assessments a'))return {rows:parts as R[],rowCount:parts.length}
      throw new Error(`publication reached: ${sql.slice(0,40)}`)
    }
    return {query,sqls}
  }
  test('only a failed part carrying the identical-evidence marker is a known failure',()=>{
    expect(isKnownFailedPart(known)).toBe(true)
    expect(isKnownFailedPart(paidFailure)).toBe(false)
    expect(isKnownFailedPart(unknown)).toBe(false)
    expect(isKnownFailedPart({status:'uncertain',error:known.error})).toBe(false)
    expect(isKnownFailedPart({status:'failed',error:null})).toBe(false)
  })
  for(const [name,parts,expected] of [
    ['last part known-failed: settles, no reading',[ok,known],'failed'],
    ['middle part known-failed, last completed: settles, no reading (incomplete chain)',[known,ok],'failed'],
    ['only part known-failed',[known],'failed'],
    ['a paid failure still throws (breaker reviews it)',[ok,paidFailure],'throw'],
    ['an unknown holder still throws (breaker reviews it)',[known,unknown],'throw'],
    ['a missing receipt still throws',[known,{status:null,error:null}],'throw'],
    ['no parts at all throws',[],'throw'],
  ] as const){
    test(name,async()=>{
      const {query,sqls}=store([...parts])
      const run=publishReactive(input,vectors('failed'),query)
      if(expected==='throw')await expect(run).rejects.toThrow('generation not settled')
      else expect(await run).toEqual({runId:'d',status:expected})
      expect(sqls.length).toBe(1)
    })
  }
  test('pending receipts throw before reading parts',async()=>{
    const {query,sqls}=store([known])
    await expect(publishReactive(input,vectors('failed',1),query)).rejects.toThrow('generation not settled')
    expect(sqls.length).toBe(0)
  })
  test('a completed item never reads the part receipts and goes on to publish',async()=>{
    const {query,sqls}=store([known])
    await expect(publishReactive(input,vectors('completed'),query)).rejects.toThrow('publication reached')
    expect(sqls.some(s=>s.includes('FROM learning_vector_turn_assessments a'))).toBe(false)
  })
})
const suite=process.env.LEARNING_ARCHIVE_COORDINATOR_TEST_DATABASE_URL?describe:describe.skip
suite('reactive transactional arrivals on real PostgreSQL',()=>{
  const client=new Client({connectionString:process.env.LEARNING_ARCHIVE_COORDINATOR_TEST_DATABASE_URL})
  beforeAll(async()=>{
    await client.connect()
    await client.query('CREATE TEMP TABLE learning_semantic_index_messages(message_id text PRIMARY KEY,current_canonical boolean NOT NULL,status text NOT NULL)')
    await client.query('CREATE TEMP TABLE learner_workflow_runs(workflow text,input jsonb)')
    await client.query('CREATE TEMP TABLE learning_active_archive_sessions (LIKE public.learning_active_archive_sessions INCLUDING ALL)')
    await client.query('CREATE TEMP TABLE learning_active_archive_notifications (LIKE public.learning_active_archive_notifications INCLUDING ALL)')
    for(const file of ['0171-learning-reactive-consolidation.sql','0172-learning-reactive-arrival-identity.sql']) {
      const source=await Bun.file(new URL(`../../../test/fixtures/source-migrations/${file}`,import.meta.url)).text()
      await client.query(source.replaceAll('CREATE TABLE','CREATE TEMP TABLE').replaceAll('FUNCTION learning_record_vector_arrival','FUNCTION pg_temp.learning_record_vector_arrival'))
    }
  })
  afterAll(async()=>{await client.end()})
  test('unchanged canonical sweep emits nothing; only successful transitions emit arrivals',async()=>{
    await client.query("INSERT INTO learning_semantic_index_messages VALUES('one',true,'pending')")
    expect((await client.query('SELECT * FROM learning_vector_arrivals')).rowCount).toBe(0)
    await client.query("UPDATE learning_semantic_index_messages SET status='indexed' WHERE message_id='one'")
    expect((await client.query('SELECT * FROM learning_vector_arrivals')).rowCount).toBe(1)
    await client.query('UPDATE learning_semantic_index_messages SET current_canonical=true')
    await client.query("UPDATE learning_semantic_index_messages SET status='indexed'")
    expect((await client.query('SELECT * FROM learning_vector_arrivals')).rowCount).toBe(1)
    await client.query("UPDATE learning_semantic_index_messages SET status='error'")
    await client.query("UPDATE learning_semantic_index_messages SET status='indexed'")
    const events=(await client.query('SELECT event_id FROM learning_vector_arrivals')).rows
    expect(events.length).toBe(2)
    expect(events[0].event_id).not.toBe(events[1].event_id)
  })
  test('rollback cannot leave an acknowledged arrival without its indexed source',async()=>{
    await client.query('BEGIN')
    await client.query("INSERT INTO learning_semantic_index_messages VALUES('rolled-back',true,'indexed')")
    await client.query('ROLLBACK')
    expect((await client.query("SELECT * FROM learning_vector_arrivals WHERE message_id='rolled-back'")).rowCount).toBe(0)
    expect((await client.query("SELECT * FROM learning_semantic_index_messages WHERE message_id='rolled-back'")).rowCount).toBe(0)
  })
})
