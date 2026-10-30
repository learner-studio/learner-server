import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { QueryFn } from '../../db/handle.js'
import { GAIN_MIN_POINTS, learningBaseline, masteryNotifications, recordNotificationFeedback } from './mastery-notifications.js'

// The live-readings view (migration 0015) and the S2–S4 reads on learner_test, each test inside a
// transaction that is rolled back.
describe.skipIf(!process.env.TEST_DATABASE_URL)('mastery notifications (learner_test)', () => {
  let client: Client
  let query: QueryFn
  let userId: string
  let tag: string
  const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 9, day, hour)).toISOString()

  beforeEach(async () => {
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    await client.query('BEGIN')
    query = (async (text: string, params?: ReadonlyArray<unknown>) => {
      const r = await client.query(text, params ? [...params] : [])
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    }) as QueryFn
    userId = `mn-${randomUUID()}`
    tag = randomUUID().slice(0, 8)
  })
  afterEach(async () => { await client.query('ROLLBACK'); await client.end() })

  const concept = async (name: string) => {
    const id = `mn-${tag}-${name}`
    await query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind)
      VALUES($1,$2,'s','e','x','d','c',0,0,'user')`, [id, `Title ${name}`])
    return id
  }
  type Reading = { pct: number | null; conf: 'insufficient' | 'low' | 'medium' | 'high'; day: number; status?: string; quote?: string }
  const receipt = (conceptId: string, r: Reading) => JSON.stringify({ status: r.status ?? 'completed', completedAt: at(r.day),
    // A failed receipt carries no assessment, like the real ones.
    assessment: r.status === 'failed' ? null : { conceptId, understandingPercent: r.pct, confidence: r.conf, demonstrated: r.quote ? [{ quote: r.quote, sourceId: 's', description: 'd' }] : [], gaps: [], nextCheck: 'n', needsReview: true } })
  const run = async (conceptId: string, snapshot: Record<string, unknown>, r: Reading, user = userId) => {
    const runId = randomUUID()
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at)
      VALUES($1,$2,$1,$3,'v','h',$4::jsonb,$5)`, [runId, user, conceptId, JSON.stringify(snapshot), at(r.day, 11)])
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)', [runId, receipt(conceptId, r), at(r.day)])
    return runId
  }
  const manual = (conceptId: string, r: Reading, user = userId) => run(conceptId, { prompt: 'p' }, r, user)
  /** A vector-turn pass of one or more parts; `status` is the pass's own. */
  const pass = async (conceptId: string, parts: Reading[], status = 'completed', purpose = 'live') => {
    const passId = randomUUID()
    await query(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,config,status) VALUES($1,$2,$3::jsonb,$4)`, [passId, userId, JSON.stringify({ purpose }), status])
    const ids: string[] = []
    for (const [part, r] of parts.entries()) {
      const id = await run(conceptId, { experimentId: passId }, r)
      await query('INSERT INTO learning_vector_turn_assessments(experiment_id,concept_id,part,run_id) VALUES($1,$2,$3,$4)', [passId, conceptId, part, id])
      ids.push(id)
    }
    return ids
  }
  const readings = async (conceptId: string) => (await query<{ run_id: string; understanding_percent: string | null }>(
    'SELECT run_id, understanding_percent FROM learning_mastery_readings WHERE concept_id = $1 ORDER BY completed_at', [conceptId])).rows

  test('the view keeps live readings only: manual runs and the last assessed part of a finished live pass', async () => {
    const c = await concept('view')
    const m = await manual(c, { pct: 40, conf: 'medium', day: 1 })
    const [, last] = await pass(c, [{ pct: 45, conf: 'medium', day: 2 }, { pct: 50, conf: 'medium', day: 2 }])
    // The final part failed (its receipt carries no assessment): the earlier part is what published.
    const [kept, failedPart] = await pass(c, [{ pct: 55, conf: 'medium', day: 3 }, { pct: null, conf: 'insufficient', day: 3, status: 'failed' }])
    // Unfinished and non-live passes never published.
    await pass(c, [{ pct: 90, conf: 'high', day: 4 }], 'running')
    await pass(c, [{ pct: 95, conf: 'high', day: 4 }], 'completed', 'comparison')
    await run(c, { experimentId: randomUUID() }, { pct: 99, conf: 'high', day: 4 })
    const rows = await readings(c)
    expect(rows.map((r) => r.run_id)).toEqual([m, last!, kept!])
    expect(rows.map((r) => r.run_id)).not.toContain(failedPart)
  })

  test('notifications: a first clear reading and gains of +10 over the best earlier counted reading, newest first, never a drop', async () => {
    const a = await concept('a'), b = await concept('b'), d = await concept('d')
    await manual(a, { pct: 30, conf: 'medium', day: 1 })
    await manual(a, { pct: 35, conf: 'low', day: 2 }) // low never counts
    const gainA = await manual(a, { pct: 40, conf: 'medium', day: 3, quote: 'I can predict it' }) // +10 over 30
    await manual(a, { pct: 20, conf: 'medium', day: 4 }) // a drop: never announced
    await manual(a, { pct: 45, conf: 'medium', day: 5 }) // +5 over the best (40): not a gain
    const clearB = await manual(b, { pct: 60, conf: 'high', day: 2 })
    await manual(b, { pct: 65, conf: 'high', day: 3 }) // a second clear reading is not "first"
    await manual(d, { pct: 50, conf: 'medium', day: 1 })
    await manual(d, { pct: 10, conf: 'medium', day: 2 })
    await manual(d, { pct: 55, conf: 'medium', day: 3 }) // recovery after a dip: +5 over 50, not +45
    await manual(d, { pct: 90, conf: 'low', day: 4 }) // low never counts, even as a gain
    const got = await masteryNotifications(query, userId, { since: '-infinity', limit: 20 })
    expect(got.map((n) => [n.runId, n.kind, n.percent, n.previousPercent, n.delta])).toEqual([
      [gainA, 'gain', 40, 30, 10],
      [clearB, 'first_clear', 60, null, null],
    ])
    expect(got[0]!.quote).toBe('I can predict it')
    expect(got[0]!.conceptName).toBe('Title a')
    expect(got.every((n) => n.delta === null || n.delta >= 0)).toBe(true)
    expect(GAIN_MIN_POINTS).toBe(10)
    // since is exclusive and limit applies to the newest.
    expect((await masteryNotifications(query, userId, { since: at(2), limit: 20 })).map((n) => n.runId)).toEqual([gainA])
    expect((await masteryNotifications(query, userId, { since: '-infinity', limit: 1 })).map((n) => n.runId)).toEqual([gainA])
    // Another learner's readings are not this learner's notifications.
    expect(await masteryNotifications(query, `other-${userId}`, { since: '-infinity', limit: 20 })).toEqual([])
  })

  test('a clear first reading that is below an earlier medium one announces the clear reading with no delta', async () => {
    const c = await concept('dip')
    await manual(c, { pct: 70, conf: 'medium', day: 1 })
    const clear = await manual(c, { pct: 60, conf: 'high', day: 2 })
    const [n] = await masteryNotifications(query, userId, { since: '-infinity', limit: 20 })
    expect(n).toMatchObject({ runId: clear, kind: 'first_clear', percent: 60, previousPercent: 70, delta: null })
  })

  test('feedback is idempotent per (run, action) and refuses another learner\'s run', async () => {
    const c = await concept('fb')
    const mine = await manual(c, { pct: 60, conf: 'high', day: 1 })
    const theirs = await manual(c, { pct: 60, conf: 'high', day: 1 }, `other-${userId}`)
    const first = await recordNotificationFeedback(query, userId, { runId: mine, action: 'nice' })
    const again = await recordNotificationFeedback(query, userId, { runId: mine, action: 'nice' })
    expect(first.recorded && again.recorded).toBe(true)
    expect(again.at).toBe(first.at)
    await recordNotificationFeedback(query, userId, { runId: mine, action: 'opened' })
    expect((await query('SELECT action FROM learning_notification_feedback WHERE run_id = $1 ORDER BY action', [mine])).rows.map((r) => r.action)).toEqual(['nice', 'opened'])
    expect((await recordNotificationFeedback(query, userId, { runId: theirs, action: 'nice' })).recorded).toBe(false)
    expect((await recordNotificationFeedback(query, userId, { runId: randomUUID(), action: 'ignored' })).recorded).toBe(false)
    expect((await query('SELECT 1 FROM learning_notification_feedback WHERE run_id = $1', [theirs])).rowCount).toBe(0)
  })

  test('baseline: one high or two medium readings track a concept; low never counts; daysLeft waits for 3 days of data', async () => {
    const high = await concept('high'), two = await concept('two'), one = await concept('one'), low = await concept('low')
    await manual(high, { pct: 70, conf: 'high', day: 20 })
    await manual(two, { pct: 40, conf: 'medium', day: 20 })
    await manual(two, { pct: 45, conf: 'medium', day: 21 })
    await manual(one, { pct: 40, conf: 'medium', day: 21 })
    await manual(low, { pct: 40, conf: 'low', day: 20 })
    await manual(low, { pct: 40, conf: 'low', day: 21 })
    await manual(low, { pct: 40, conf: 'low', day: 21 })
    const early = await learningBaseline(query, userId, new Date(at(21, 18)))
    expect(early).toMatchObject({ have: 2, need: 4, daysOfData: 1, daysLeft: null })
    const later = await learningBaseline(query, userId, new Date(at(25)))
    expect(later.daysOfData).toBe(5)
    // 2 concepts started tracking in 5 days of data: 0.4 a day, 2 to go.
    expect(later.pacePerDay).toBeCloseTo(0.4)
    expect(later.daysLeft).toBe(5)
  })
})
