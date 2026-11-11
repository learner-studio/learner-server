import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import type { LearningVectorTurnService } from '../../services/learning-vector-turn-service.js'
import type { LearningCurriculumStore } from '../../services/learning-curriculum-store.js'
import { REACTIVE_HOLD_ATTEMPTS, REACTIVE_HOLD_BACKOFF_MINUTES, REACTIVE_HOLD_REASON, REACTIVE_SYSTEMIC_MISSING, reactiveIdentity, recordRoutingOutcome, releaseReactiveHolds, routeReactive, type ReactiveVectorView } from './learning-reactive-consolidation.js'

/**
 * 2026-10-30..11-11: one indexed chunk with no vector failed the whole batch of 100
 * arrivals every minute (49,881 times), so nothing behind it routed and no concept
 * was admitted. Routing now HOLDS only the unverifiable arrival, with its reason,
 * on a bounded retry schedule, and routes the rest.
 *
 * Real PostgreSQL semantics in connection-local TEMP tables that shadow the
 * public ones (pg_temp is first on the search path); no shared row is touched.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('reactive routing isolates an arrival it cannot verify', () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  const q: MetaPgQueryFn = async (text, params) => { const r = await client.query(text, params ? [...params] : []); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }
  const user = `routing-holds-${randomUUID()}`
  const concept = 'routing-holds-concept'
  const curricula = { listGraphs: async () => [{ concepts: [{ id: concept, title: 'T', summary: 'S', explanation: 'E' }], curriculum: { modules: [] } }] } as unknown as LearningCurriculumStore
  let embedCalls = 0
  const vectors = { embeddings: async (texts: string[]) => { embedCalls++; return texts.map(() => [1, 0]) } } as unknown as LearningVectorTurnService
  /** The bank: every chunk has a vector except those named in `absent`. */
  let absent = new Set<string>()
  const view: ReactiveVectorView = {
    present: async ids => new Set(ids.filter(id => !absent.has(id))),
    hits: async (_concepts, ids) => ids.map(id => ({ document_id: id, concept_id: concept, score: 0.9 })),
  }
  const route = () => routeReactive(vectors, curricula, { query: q, view, userId: user })
  const message = async (id: string, chunkIds: string[]) => {
    await q("INSERT INTO learning_semantic_index_messages VALUES($1,'conversation',true,'indexed')", [id])
    for (const chunk of chunkIds) await q("INSERT INTO learning_semantic_index_chunks VALUES($1,$2,'indexed')", [chunk, id])
    return (await q<{ event_id: string }>('INSERT INTO learning_vector_arrivals(message_id) VALUES($1) RETURNING event_id', [id])).rows[0]!.event_id
  }
  const routed = async () => (await q<{ message_id: string }>('SELECT message_id FROM learning_reactive_routes ORDER BY message_id')).rows.map(r => r.message_id)
  const holds = async () => (await q('SELECT * FROM learning_reactive_route_holds')).rows
  beforeAll(async () => {
    await client.connect()
    for (const table of ['learning_reactive_settings', 'learning_vector_arrivals', 'learning_reactive_routes', 'learning_reactive_route_holds', 'learning_reactive_embeddings',
      'learning_reactive_targets', 'learning_reactive_admission', 'learning_reactive_notifications'])
      await q(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`)
    await q('CREATE TEMP TABLE learning_semantic_index_messages(message_id text PRIMARY KEY,conversation_id text NOT NULL,current_canonical boolean NOT NULL,status text NOT NULL)')
    await q('CREATE TEMP TABLE learning_semantic_index_chunks(chunk_id text PRIMARY KEY,message_id text NOT NULL,status text NOT NULL)')
    await q('CREATE TEMP TABLE learning_cli_vector_e2e_runs(session_id uuid,mastery_excluded boolean)')
  })
  afterAll(async () => { await client.end() })
  beforeEach(async () => {
    await q(`TRUNCATE pg_temp.learning_reactive_settings,pg_temp.learning_vector_arrivals,pg_temp.learning_reactive_routes,pg_temp.learning_reactive_route_holds,pg_temp.learning_reactive_embeddings,
      pg_temp.learning_reactive_targets,pg_temp.learning_reactive_admission,pg_temp.learning_reactive_notifications,pg_temp.learning_semantic_index_messages,pg_temp.learning_semantic_index_chunks`)
    await q(`INSERT INTO learning_reactive_settings(user_id,enabled,activated_at,config,revision) VALUES($1,true,now()-interval '1 hour',$2::jsonb,'rev-1')`,
      [user, JSON.stringify({ enabled: true, conceptIds: [concept], threshold: 0.5 })])
    absent = new Set()
  })

  test('one poisoned arrival is held with its reason and chunk ids; the arrivals around it route', async () => {
    await message('m1', ['m1-a'])
    const poisoned = await message('m2', ['m2-a', 'm2-b'])
    await message('m3', ['m3-a'])
    absent = new Set(['m2-a'])
    expect(await route()).toEqual({ messages: 2, concepts: 2, held: 1, exhausted: 0 })
    expect(await routed()).toEqual(['m1', 'm3'])
    const [hold] = await holds()
    expect(hold).toMatchObject({ user_id: user, event_id: poisoned, message_id: 'm2', reason: REACTIVE_HOLD_REASON, missing_chunk_ids: ['m2-a'], attempts: 1 })
    expect(hold.next_attempt_at.getTime()).toBeGreaterThan(Date.now())
    // The concept the routed arrivals matched was admitted: two distinct arrivals, two dirty generations.
    const admission = (await q('SELECT * FROM learning_reactive_admission')).rows
    expect(admission.map(a => [a.session_id, Number(a.requested_generation)])).toEqual([[reactiveIdentity(user, concept), 2]])
  })

  test('replaying the same pass routes nothing twice and does not re-hold before the retry is due', async () => {
    await message('m1', ['m1-a']); await message('m2', ['m2-a'])
    absent = new Set(['m2-a'])
    await route()
    const before = { routes: await routed(), holds: await holds(), admission: (await q('SELECT requested_generation FROM learning_reactive_admission')).rows }
    expect(await route()).toEqual({ messages: 0, concepts: 0, held: 0, exhausted: 0 })
    expect(await routed()).toEqual(before.routes)
    expect(await holds()).toEqual(before.holds)
    expect((await q('SELECT requested_generation FROM learning_reactive_admission')).rows).toEqual(before.admission)
    expect((await q('SELECT count(*)::int n FROM learning_reactive_notifications')).rows[0].n).toBe(1)
  })

  test('a held arrival is retried on the bounded schedule, then marked exhausted, and routes once released after its vector appears', async () => {
    await message('m2', ['m2-a'])
    absent = new Set(['m2-a'])
    // Every backoff entry is used once, then the next attempt exhausts it (review N1: no unreachable entry).
    expect(REACTIVE_HOLD_ATTEMPTS).toBe(REACTIVE_HOLD_BACKOFF_MINUTES.length + 1)
    for (let attempt = 1; attempt <= REACTIVE_HOLD_ATTEMPTS; attempt++) {
      const result = await route()
      expect(result.held).toBe(1)
      const [hold] = await holds()
      expect(hold.attempts).toBe(attempt)
      if (attempt < REACTIVE_HOLD_ATTEMPTS) {
        expect(result.exhausted).toBe(0)
        const minutes = (hold.next_attempt_at.getTime() - hold.last_attempt_at.getTime()) / 60_000
        expect(Math.round(minutes)).toBe(REACTIVE_HOLD_BACKOFF_MINUTES[attempt - 1]!)
        await q("UPDATE learning_reactive_route_holds SET next_attempt_at=now()-interval '1 second'")
      } else {
        expect(result.exhausted).toBe(1)
        expect(hold.next_attempt_at).toBeNull()
      }
    }
    // Exhausted: no longer retried on its own.
    expect(await route()).toEqual({ messages: 0, concepts: 0, held: 0, exhausted: 0 })
    absent = new Set()
    expect(await releaseReactiveHolds(user, true, q)).toEqual({ released: 1 })
    expect((await route()).messages).toBe(1)
    expect(await routed()).toEqual(['m2'])
    expect(await holds()).toEqual([])
  })

  test('a bank missing most vectors is systemic: the batch stays pending and nothing is held', async () => {
    for (let i = 0; i < 12; i++) await message(`m${i}`, [`m${i}-a`])
    absent = new Set(Array.from({ length: 11 }, (_, i) => `m${i}-a`))
    await expect(route()).rejects.toThrow('the bank looks unavailable')
    expect(await holds()).toEqual([])
    expect(await routed()).toEqual([])
  })

  test('a held arrival whose vector appears routes on its next due retry, and its hold is deleted (review S10 m7b)', async () => {
    await message('m1', ['m1-a'])
    absent = new Set(['m1-a'])
    await route()
    expect(await holds()).toHaveLength(1)
    absent = new Set()
    await q("UPDATE learning_reactive_route_holds SET next_attempt_at=now()-interval '1 second'")
    expect(await route()).toEqual({ messages: 1, concepts: 1, held: 0, exhausted: 0 })
    expect(await routed()).toEqual(['m1'])
    expect(await holds()).toEqual([])
  })

  // The systemic rule is "at least 10 missing AND more than half of the batch": both edges are pinned with
  // literal counts, so a changed threshold fails here (review S10 m6, m6b).
  const batch = async (total: number, missing: number) => {
    for (let i = 0; i < total; i++) await message(`b${i}`, [`b${i}-a`])
    absent = new Set(Array.from({ length: missing }, (_, i) => `b${i}-a`))
    return route()
  }
  test('10 missing out of 11 is systemic', async () => {
    expect(REACTIVE_SYSTEMIC_MISSING).toEqual({ minChunks: 10, share: 0.5 })
    await expect(batch(11, 10)).rejects.toThrow('the bank looks unavailable')
  })
  test('9 missing out of 10 is held, not systemic', async () => {
    expect((await batch(10, 9)).held).toBe(9)
  })
  test('exactly half of the batch missing (20 of 40) is held, not systemic', async () => {
    expect((await batch(40, 20)).held).toBe(20)
  })
  test('one more than half (21 of 40) is systemic', async () => {
    await expect(batch(40, 21)).rejects.toThrow('the bank looks unavailable')
  })
  test('a routing failure records its cause in last_error and the step error; a later success clears it', async () => {
    const logged: unknown[] = []
    const failure = new Error(`${'x'.repeat(290)} bank timeout tail beyond 300`)
    await expect(recordRoutingOutcome(async () => { throw failure }, error => logged.push(error), q))
      .rejects.toThrow(`Reactive routing failed; pending arrivals retained: ${failure.message.slice(0, 300)}`)
    expect(logged).toEqual([failure])
    const error = async () => (await q<{ last_error: string | null }>('SELECT last_error FROM learning_reactive_settings WHERE user_id=$1', [user])).rows[0]!.last_error
    expect(await error()).toBe(`Vector routing failed (${failure.message.slice(0, 300)}); pending arrivals retained`)
    expect(await error()).not.toContain('beyond 300')
    expect(await recordRoutingOutcome(async () => 7, () => undefined, q)).toBe(7)
    expect(await error()).toBeNull()
  })
})
