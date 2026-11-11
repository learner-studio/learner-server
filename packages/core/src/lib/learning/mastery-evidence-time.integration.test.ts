import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { QueryFn } from '../../db/handle.js'
import { EVIDENCE_HISTORY, masteryNotifications } from './mastery-notifications.js'
import { masteryProgress } from './mastery-progress.js'

// Migration 0018 on learner_test: a reading is dated by its evidence, not by when the grader ran.
// Each test runs inside a transaction that is rolled back.
describe.skipIf(!process.env.TEST_DATABASE_URL)('mastery readings dated by evidence time (learner_test)', () => {
  let client: Client
  let query: QueryFn
  let userId: string
  let tag: string
  /** October 2026, UTC. Day 29 is a Thursday; "today" in these tests is day 29, 18:00. */
  const at = (day: number, hour = 12, month = 9) => new Date(Date.UTC(2026, month, day, hour)).toISOString()
  const NOW = new Date(at(29, 18))

  beforeEach(async () => {
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    await client.query('BEGIN')
    query = (async (text: string, params?: ReadonlyArray<unknown>) => {
      const r = await client.query(text, params ? [...params] : [])
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    }) as QueryFn
    userId = `me-${randomUUID()}`
    tag = randomUUID().slice(0, 8)
  })
  afterEach(async () => { await client.query('ROLLBACK'); await client.end() })

  const concept = async (name: string) => {
    const id = `me-${tag}-${name}`
    await query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind)
      VALUES($1,$2,'s','e','x','d','c',0,0,'user')`, [id, `Title ${name}`])
    return id
  }
  type Evidence = { id: string; role?: 'user' | 'assistant'; at: string }
  type Reading = { pct: number; conf: 'low' | 'medium' | 'high'; graded: string; evidence?: Evidence[]; cites?: string[]; reused?: string }
  /** A manual live reading graded at `graded`, resting on `evidence` (the run snapshot) and citing `cites`. */
  const reading = async (conceptId: string, r: Reading) => {
    const runId = randomUUID()
    const snapshot = { prompt: 'p', ...(r.evidence ? { evidence: r.evidence.map((e) => ({ id: e.id, role: e.role ?? 'user', occurredAt: e.at, text: 't' })) } : {}) }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at)
      VALUES($1,$2,$1,$3,'v','h',$4::jsonb,$5)`, [runId, userId, conceptId, JSON.stringify(snapshot), r.graded])
    const receipt = { status: r.reused ? 'unchanged' : 'completed', completedAt: r.graded, ...(r.reused ? { reusedRunId: r.reused } : {}),
      assessment: { conceptId, understandingPercent: r.pct, confidence: r.conf, demonstrated: (r.cites ?? []).map((sourceId) => ({ quote: 'q', sourceId, description: 'd' })), gaps: [], nextCheck: 'n', needsReview: true } }
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)', [runId, JSON.stringify(receipt), r.graded])
    return runId
  }
  const row = async (runId: string) => (await query<{ evidence_at: Date; completed_at: Date; evidence_dated: boolean; evidence_basis: string }>(
    'SELECT evidence_at, completed_at, evidence_dated, evidence_basis FROM learning_mastery_readings WHERE run_id = $1', [runId])).rows[0]!
  const dated = async (runId: string) => { const r = await row(runId); return [r.evidence_at.toISOString(), r.evidence_dated, r.evidence_basis] }

  test('evidence_at: the newest cited message, else the newest learner message in the evidence set, else the grading time; completed_at is untouched', async () => {
    const c = await concept('view')
    const set: Evidence[] = [{ id: 'old', at: at(1) }, { id: 'mid', at: at(5) }, { id: 'new', at: at(9) }, { id: 'reply', role: 'assistant', at: at(10) }]
    const cited = await reading(c, { pct: 50, conf: 'medium', graded: at(28), evidence: set, cites: ['old', 'mid'] })
    expect(await dated(cited)).toEqual([at(5), true, 'cited'])
    expect((await row(cited)).completed_at.toISOString()).toBe(at(28))
    // No citation: the newest thing the LEARNER said in the set, not the agent's later reply.
    expect(await dated(await reading(c, { pct: 50, conf: 'medium', graded: at(28, 13), evidence: set }))).toEqual([at(9), true, 'evidence_set'])
    // A citation that is not in the run's evidence dates nothing by itself: the set does.
    expect(await dated(await reading(c, { pct: 50, conf: 'medium', graded: at(28, 14), evidence: set, cites: ['elsewhere'] }))).toEqual([at(9), true, 'evidence_set'])
    // Only agent messages: still the run's evidence.
    expect(await dated(await reading(c, { pct: 50, conf: 'medium', graded: at(28, 15), evidence: [{ id: 'a', role: 'assistant', at: at(3) }] }))).toEqual([at(3), true, 'evidence_set'])
    // Epoch zero is a missing time, never a date: the cited message is skipped, then the set.
    const epoch = await reading(c, { pct: 50, conf: 'medium', graded: at(28, 16), evidence: [{ id: 'zero', at: '1970-01-01T00:00:00Z' }, { id: 'real', at: at(4) }], cites: ['zero'] })
    expect(await dated(epoch)).toEqual([at(4), true, 'evidence_set'])
    // Nothing to date it by: the grading time, and the row says so.
    expect(await dated(await reading(c, { pct: 50, conf: 'medium', graded: at(28, 17), evidence: [{ id: 'zero', at: '1970-01-01T00:00:00Z' }] }))).toEqual([at(28, 17), false, 'graded'])
    expect(await dated(await reading(c, { pct: 50, conf: 'medium', graded: at(28, 18) }))).toEqual([at(28, 18), false, 'graded'])
    // A malformed time never fails the grading: the receipt is stored, undated.
    expect(await dated(await reading(c, { pct: 50, conf: 'medium', graded: at(28, 19), evidence: [{ id: 'bad', at: 'not a time' }] }))).toEqual([at(28, 19), false, 'graded'])
  })

  test('an unchanged copy takes its origin\'s evidence time, through a chain of copies', async () => {
    const c = await concept('copy')
    const origin = await reading(c, { pct: 50, conf: 'medium', graded: at(20), evidence: [{ id: 'm', at: at(2) }], cites: ['m'] })
    // The copies carry no evidence of their own here, so the time can only have come from the origin.
    const first = await reading(c, { pct: 50, conf: 'medium', graded: at(25), reused: origin })
    const second = await reading(c, { pct: 50, conf: 'medium', graded: at(28), reused: first })
    expect(await dated(first)).toEqual([at(2), true, 'cited'])
    expect(await dated(second)).toEqual([at(2), true, 'cited'])
    // A copy of a run with no row (never graded here) falls back to its own evidence.
    expect(await dated(await reading(c, { pct: 50, conf: 'medium', graded: at(28, 13), reused: randomUUID(), evidence: [{ id: 'own', at: at(6) }] }))).toEqual([at(6), true, 'evidence_set'])
  })

  test('a backfilled reading lands in its evidence week and is not "up in 24h"', async () => {
    const c = await concept('backfill'), fresh = await concept('fresh')
    // Said on 1 September, graded today (inside the last 24 hours).
    const old = at(1, 12, 8)
    const backfilled = await reading(c, { pct: 80, conf: 'high', graded: at(29, 9), evidence: [{ id: 'sep', at: old }], cites: ['sep'] })
    // Said and graded today.
    await reading(fresh, { pct: 60, conf: 'high', graded: at(29, 10), evidence: [{ id: 'today', at: at(29, 8) }], cites: ['today'] })
    const weeks = (await query<{ concept_id: string; evidence_week: string; grading_week: string }>(
      `WITH h AS (${EVIDENCE_HISTORY})
       SELECT concept_id, to_char(date_trunc('week', evidence_at), 'YYYY-MM-DD') evidence_week, to_char(date_trunc('week', completed_at), 'YYYY-MM-DD') grading_week
       FROM h WHERE run_id = $2`, [userId, backfilled])).rows
    expect(weeks).toEqual([{ concept_id: c, evidence_week: '2026-08-31', grading_week: '2026-10-26' }])

    const p = await masteryProgress(query, userId, [c, fresh], new Map(), NOW)
    const w = Object.fromEntries(p.windows.map((x) => [x.window, x]))
    // now: (80 + 60) / 2. A day, a week and 30 days ago the learner had already said the September thing: 80 / 2.
    expect(w['24h']).toEqual({ window: '24h', beforePercent: 40, nowPercent: 70, up: 1 }) // `fresh` only
    expect(w['7d']).toEqual({ window: '7d', beforePercent: 40, nowPercent: 70, up: 1 })
    expect(w['30d']).toEqual({ window: '30d', beforePercent: 40, nowPercent: 70, up: 1 })
  })

  test('the strip orders by evidence: an old conversation graded last is neither the current value nor a gain', async () => {
    const c = await concept('order')
    // Graded first, said last: 40. Graded today, said three weeks earlier: 70.
    await reading(c, { pct: 40, conf: 'medium', graded: at(20), evidence: [{ id: 'late', at: at(19) }], cites: ['late'] })
    await reading(c, { pct: 70, conf: 'medium', graded: at(29, 9), evidence: [{ id: 'early', at: at(1) }], cites: ['early'] })
    const p = await masteryProgress(query, userId, [c], new Map(), NOW)
    // Where the learner stands is the reading on the newest evidence (40): 70 → 40 is a decline, so nothing is up.
    expect(p.windows.map((x) => [x.window, x.beforePercent, x.nowPercent, x.up])).toEqual([['24h', 40, 40, 0], ['7d', 40, 40, 0], ['30d', 0, 40, 0]])
  })

  test('the feed does not announce a backfilled reading as a gain over a reading whose evidence is newer', async () => {
    const c = await concept('feed')
    const shown = await reading(c, { pct: 40, conf: 'medium', graded: at(20), evidence: [{ id: 'late', at: at(19) }], cites: ['late'] })
    // Old evidence, graded today, 30 points above what was shown: history, not progress.
    const backfilled = await reading(c, { pct: 70, conf: 'medium', graded: at(29, 9), evidence: [{ id: 'early', at: at(1) }], cites: ['early'] })
    // A second grading of the SAME evidence as `shown` that happens to score higher: grader noise, not news.
    const regraded = await reading(c, { pct: 55, conf: 'medium', graded: at(29, 10), evidence: [{ id: 'late', at: at(19) }], cites: ['late'] })
    expect(await masteryNotifications(query, userId, { since: null, limit: 20 })).toEqual([])
    // New evidence, at least +10 over the best already shown (70, the backfilled one): announced, against 70.
    const real = await reading(c, { pct: 85, conf: 'medium', graded: at(29, 11), evidence: [{ id: 'late', at: at(19) }, { id: 'newest', at: at(29, 10) }], cites: ['newest'] })
    const got = await masteryNotifications(query, userId, { since: null, limit: 20 })
    expect(got.map((n) => [n.runId, n.kind, n.previousPercent, n.percent, n.delta])).toEqual([[real, 'gain', 70, 85, 15]])
    // The cursor is still the grading clock, and the shape is the pinned one.
    expect(got[0]!.completedAt).toBe(at(29, 11))
    expect(Object.keys(got[0]!).sort()).toEqual(['completedAt', 'conceptId', 'conceptName', 'confidence', 'delta', 'kind', 'percent', 'previousPercent', 'quote', 'runId'])
    expect(await masteryNotifications(query, userId, { since: at(29, 11), limit: 20 })).toEqual([])
    expect([shown, backfilled, regraded]).not.toContain(got[0]!.runId)
  })

  test('a backfilled first clear reading is not announced once newer evidence has been shown; undated readings behave as before', async () => {
    const c = await concept('clear'), u = await concept('undated')
    await reading(c, { pct: 40, conf: 'medium', graded: at(20), evidence: [{ id: 'late', at: at(19) }], cites: ['late'] })
    await reading(c, { pct: 60, conf: 'high', graded: at(29, 9), evidence: [{ id: 'early', at: at(1) }], cites: ['early'] })
    // No evidence times at all: graded order is all there is, exactly the pre-0018 rule.
    await reading(u, { pct: 30, conf: 'medium', graded: at(20) })
    const gain = await reading(u, { pct: 45, conf: 'medium', graded: at(21) })
    expect((await masteryNotifications(query, userId, { since: null, limit: 20 })).map((n) => [n.runId, n.kind, n.delta])).toEqual([[gain, 'gain', 15]])
  })
})
