import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import type { QueryFn } from '../../db/handle.js'
import { feedHealth, GAIN_MIN_POINTS, INDEPENDENT, learningBaseline, masteryNotifications, recordNotificationFeedback } from './mastery-notifications.js'
import { masteryProgress } from './mastery-progress.js'

// These tests pin the rules other than noise: with a grader sd of 0 the gain rule is the GAIN_MIN_POINTS floor.
// The noise-aware threshold has its own tests (mastery-change.integration.test.ts).
/** σ_g = σ_e = 0: the gain rule is its +10 floor alone. */
const FLOOR_ONLY = { graderSd: 0, evidenceSd: 0, replicateCredit: true }

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
  /**
   * Each reading cites one learner message said an hour before it was graded (a fresh, cited reading: what
   * the feed announces). `uncited` leaves `demonstrated` without a source; `said` moves the message.
   */
  type Reading = { pct: number | null; conf: 'insufficient' | 'low' | 'medium' | 'high'; day: number; status?: string; quote?: string; time?: string; uncited?: boolean; said?: string }
  const said = (r: Reading) => r.said ?? new Date(Date.parse(r.time ?? at(r.day)) - 3_600_000).toISOString()
  const receipt = (conceptId: string, r: Reading, messageId: string) => JSON.stringify({ status: r.status ?? 'completed', completedAt: r.time ?? at(r.day),
    // A failed receipt carries no assessment, like the real ones.
    assessment: r.status === 'failed' ? null : { conceptId, understandingPercent: r.pct, confidence: r.conf,
      demonstrated: [{ quote: r.quote ?? 'q', sourceId: r.uncited ? 'not-in-evidence' : messageId, description: 'd' }], gaps: [], nextCheck: 'n', needsReview: true } })
  const run = async (conceptId: string, snapshot: Record<string, unknown>, r: Reading, user = userId, extra: Record<string, unknown> = {}) => {
    const runId = randomUUID()
    const messageId = `msg-${runId}`
    const withEvidence = { ...snapshot, evidence: [{ id: messageId, role: 'user', occurredAt: said(r), text: 't' }] }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at)
      VALUES($1,$2,$1,$3,'v','h',$4::jsonb,$5)`, [runId, user, conceptId, JSON.stringify(withEvidence), at(r.day, 11)])
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)', [runId, JSON.stringify({ ...JSON.parse(receipt(conceptId, r, messageId)), ...extra }), r.time ?? at(r.day)])
    return runId
  }
  const manual = (conceptId: string, r: Reading, user = userId) => run(conceptId, { prompt: 'p' }, r, user)
  /** An 'unchanged' receipt: the grader reused `source`'s assessment for identical evidence. */
  const copy = (conceptId: string, source: string, r: Reading) => run(conceptId, { prompt: 'p' }, { ...r, status: 'unchanged' }, userId, { reusedRunId: source })
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

  test('notifications: a first clear reading and gains of +10 over the MEAN of earlier counted measurements (S11), newest first, never a drop', async () => {
    const a = await concept('a'), b = await concept('b'), d = await concept('d')
    await manual(a, { pct: 30, conf: 'medium', day: 1 })
    await manual(a, { pct: 35, conf: 'low', day: 2 }) // low never counts
    const gainA = await manual(a, { pct: 40, conf: 'medium', day: 3, quote: 'I can predict it' }) // +10 over 30
    await manual(a, { pct: 20, conf: 'medium', day: 4 }) // a drop: never announced
    // +15 over the mean of 30, 40, 20 (= 30). Against the best (40) it was +5: the max made a gain harder
    // to announce the more often a concept was read, and a blind measurement is noisy both ways.
    const gainA2 = await manual(a, { pct: 45, conf: 'medium', day: 5 })
    const clearB = await manual(b, { pct: 60, conf: 'high', day: 2 })
    await manual(b, { pct: 65, conf: 'high', day: 3 }) // a second clear reading is not "first"
    await manual(d, { pct: 50, conf: 'medium', day: 1 })
    await manual(d, { pct: 10, conf: 'medium', day: 2 })
    const gainD = await manual(d, { pct: 55, conf: 'medium', day: 4 }) // +25 over the mean (30) of 50 and 10
    await manual(d, { pct: 90, conf: 'low', day: 5 }) // low never counts, even as a gain
    const got = await masteryNotifications(query, userId, { since: null, limit: 20 }, FLOOR_ONLY)
    expect(got.map((n) => [n.runId, n.kind, n.percent, n.previousPercent, n.delta])).toEqual([
      [gainA2, 'gain', 45, 30, 15],
      [gainD, 'gain', 55, 30, 25],
      [gainA, 'gain', 40, 30, 10],
      [clearB, 'first_clear', 60, null, null],
    ])
    expect(got.find((n) => n.runId === gainA)!.quote).toBe('I can predict it')
    expect(got[0]!.conceptName).toBe('Title a')
    expect(got.every((n) => n.delta === null || n.delta >= 0)).toBe(true)
    expect(GAIN_MIN_POINTS).toBe(10)
    // since is exclusive and limit applies to the newest.
    expect((await masteryNotifications(query, userId, { since: at(2), limit: 20 }, FLOOR_ONLY)).map((n) => n.runId)).toEqual([gainA2, gainD, gainA])
    expect((await masteryNotifications(query, userId, { since: null, limit: 1 }, FLOOR_ONLY)).map((n) => n.runId)).toEqual([gainA2])
    // Another learner's readings are not this learner's notifications.
    expect(await masteryNotifications(query, `other-${userId}`, { since: null, limit: 20 }, FLOOR_ONLY)).toEqual([])
  })

  test('a clear first reading that is below an earlier medium one announces the clear reading with no delta', async () => {
    const c = await concept('dip')
    await manual(c, { pct: 70, conf: 'medium', day: 1 })
    const clear = await manual(c, { pct: 60, conf: 'high', day: 2 })
    const [n] = await masteryNotifications(query, userId, { since: null, limit: 20 }, FLOOR_ONLY)
    expect(n).toMatchObject({ runId: clear, kind: 'first_clear', percent: 60, previousPercent: null, delta: null })
  })

  test('paging: with since, the oldest page after it, never splitting readings that share a completedAt', async () => {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) ids.push(await manual(await concept(`p${i}`), { pct: 60, conf: 'high', day: 1 + i }))
    // Two readings published together (one finished pass): same completedAt.
    const tied = await manual(await concept('t'), { pct: 60, conf: 'high', day: 3 })
    const newest = await masteryNotifications(query, userId, { since: null, limit: 2 }, FLOOR_ONLY)
    expect(newest.map((n) => n.runId)).toEqual([ids[4], ids[3]])
    // A client walking forward from day 1 with limit 2 sees every notification exactly once.
    const seen: string[] = []
    let cursor: string | null = at(1)
    for (let guard = 0; guard < 10; guard++) {
      const page = await masteryNotifications(query, userId, { since: cursor, limit: 2 }, FLOOR_ONLY)
      if (!page.length) break
      expect(page.map((n) => n.completedAt)).toEqual([...page.map((n) => n.completedAt)].sort().reverse())
      seen.push(...page.map((n) => n.runId))
      cursor = page[0]!.completedAt
    }
    expect(seen.sort()).toEqual([ids[1], ids[2], tied, ids[3], ids[4]].sort())
    // The day-3 pair arrives in one page even though it overruns limit 2.
    const p = await masteryNotifications(query, userId, { since: at(1), limit: 2 }, FLOOR_ONLY)
    expect(new Set(p.map((n) => n.runId))).toEqual(new Set([ids[1], ids[2], tied]))
  })

  test('a cursor taken from a sent completedAt (milliseconds) moves past the reading it came from', async () => {
    const c = await concept('micro')
    // A real live time carries microseconds; JSON carries milliseconds.
    await manual(c, { pct: 60, conf: 'high', day: 3, time: '2026-10-03T12:00:05.123456Z' })
    const [n] = await masteryNotifications(query, userId, { since: null, limit: 20 }, FLOOR_ONLY)
    expect(n!.completedAt).toBe('2026-10-03T12:00:05.123Z')
    expect(await masteryNotifications(query, userId, { since: n!.completedAt, limit: 20 }, FLOOR_ONLY)).toEqual([])
  })

  test('readings count once per origin: copies (and copies of copies) of a grading are not new readings', async () => {
    const c = await concept('copy'), lone = await concept('lone')
    const src = await manual(c, { pct: 40, conf: 'medium', day: 1 })
    const c1 = await copy(c, src, { pct: 40, conf: 'medium', day: 2 })
    await copy(c, c1, { pct: 40, conf: 'medium', day: 3 })
    const gone = randomUUID() // a grading that never went live (e.g. a comparison run)
    await copy(lone, gone, { pct: 40, conf: 'medium', day: 1 })
    await copy(lone, gone, { pct: 40, conf: 'medium', day: 2 })
    expect(await learningBaseline(query, userId, new Date(at(5)))).toMatchObject({ have: 0, need: 2 })
    // A second fresh grading of c makes two independent medium readings.
    await manual(c, { pct: 45, conf: 'medium', day: 4 })
    expect(await learningBaseline(query, userId, new Date(at(5)))).toMatchObject({ have: 1, need: 2 })
  })

  test('S8: a chain of copies deeper than 100 still resolves to its fresh grading, and a cycle of copies counts once', async () => {
    const independent = async (conceptId: string) => (await query<{ run_id: string }>(
      `SELECT v.run_id FROM (${INDEPENDENT}) v WHERE v.concept_id = $2`, [userId, conceptId])).rows.map((r) => r.run_id)
    // Dev chains reach depth 128; the old cap of 100 named copy #101 as the origin of the deeper ones.
    const deep = await concept('deep')
    const src = await manual(deep, { pct: 40, conf: 'medium', day: 1 })
    let prev = src
    for (let i = 0; i < 130; i++) prev = await copy(deep, prev, { pct: 40, conf: 'medium', day: 2, time: new Date(Date.parse(at(2)) + i * 60_000).toISOString() })
    expect(await independent(deep)).toEqual([src])
    // Two copies naming each other (and a third copying into the loop): no fresh grading, one origin.
    const loop = await concept('loop')
    const a = randomUUID(), b = randomUUID()
    const runAs = async (runId: string, source: string, day: number) => {
      const messageId = `msg-${runId}`
      await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at)
        VALUES($1,$2,$1,$3,'v','h',$4::jsonb,$5)`, [runId, userId, loop, JSON.stringify({ prompt: 'p', evidence: [{ id: messageId, role: 'user', occurredAt: at(day, 10), text: 't' }] }), at(day, 11)])
      await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)',
        [runId, JSON.stringify({ ...JSON.parse(receipt(loop, { pct: 40, conf: 'medium', day, status: 'unchanged' }, messageId)), reusedRunId: source }), at(day)])
    }
    await runAs(a, b, 1)
    await runAs(b, a, 2)
    await copy(loop, a, { pct: 40, conf: 'medium', day: 3 })
    expect(await independent(loop)).toEqual([a])
  })

  test('S10: feed health reports the recency pass rate and the grading lag over readings that went live in the window', async () => {
    const c = await concept('feed'), e = await concept('feed2')
    await manual(c, { pct: 30, conf: 'medium', day: 20, said: at(18) }) // went live before the window
    await manual(c, { pct: 60, conf: 'high', day: 50, said: at(10) }) // a 40-day backlog: fails the recency rule
    const fresh = await manual(e, { pct: 70, conf: 'high', day: 55, said: at(54) }) // 1 day: news
    await manual(e, { pct: 75, conf: 'medium', day: 56, uncited: true }) // uncited: not a feed candidate
    await manual(e, { pct: 90, conf: 'low', day: 57 }) // low: not counted
    const now = new Date(at(60))
    expect(await feedHealth(query, userId, now)).toEqual({
      windowDays: 14, recencyDays: 7, citedReadings: 2, withinRecency: 1, news: 1, medianLagDays: 20.5, newestEvidenceAt: at(54),
    })
    expect((await masteryNotifications(query, userId, { since: null, limit: 20 }, FLOOR_ONLY)).map((n) => n.runId)).toEqual([fresh])
    // Before anything went live in the window: nothing to report, no lag.
    expect(await feedHealth(query, userId, new Date(at(5)))).toMatchObject({ citedReadings: 0, withinRecency: 0, news: 0, medianLagDays: null, newestEvidenceAt: null })
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

  test('progress strip: curriculum mean of latest counted readings before and now, gains only, low ignored', async () => {
    const a = await concept('pa'), b = await concept('pb'), c = await concept('pc'), d = await concept('pd')
    await manual(a, { pct: 40, conf: 'medium', day: 1 })
    await manual(a, { pct: 60, conf: 'medium', day: 25 }) // +20: a gain inside 7d and 30d, not 24h
    await manual(b, { pct: 80, conf: 'high', day: 29 })   // first clear inside 24h
    await manual(c, { pct: 50, conf: 'medium', day: 2 })
    await manual(c, { pct: 20, conf: 'medium', day: 28 }) // a decline: lowers the mean, never counted as up
    await manual(d, { pct: 90, conf: 'low', day: 29 })    // low never counts
    const p = await masteryProgress(query, userId, [a, b, c, d], new Map(), new Date(at(29, 18)), FLOOR_ONLY)
    const w = Object.fromEntries(p.windows.map((x) => [x.window, x]))
    // now: a 60, b 80, c 20, d 0 → 40. 24h ago: a 60, c 20 → 20. 7d ago: a 40, c 50 → 22.5. 30d ago: nothing → 0.
    expect(w['24h']).toEqual({ window: '24h', beforePercent: 20, nowPercent: 40, up: 1 })
    expect(w['7d']).toEqual({ window: '7d', beforePercent: 22.5, nowPercent: 40, up: 2 })
    expect(w['30d']).toEqual({ window: '30d', beforePercent: 0, nowPercent: 40, up: 2 })
    expect((await masteryProgress(query, userId, [], new Map())).windows.every((x) => x.nowPercent === 0 && x.up === 0)).toBe(true)
  })
})
