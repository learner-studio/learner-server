import {beforeAll,afterAll,describe,test,expect} from 'bun:test'
import {Client} from 'pg'
import {reactiveIdentity,ReactiveConfig} from './learning-reactive-consolidation.js'

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
