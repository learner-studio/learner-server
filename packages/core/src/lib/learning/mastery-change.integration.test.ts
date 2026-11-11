import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import type { QueryFn } from '../../db/handle.js'
import { graderNoise, LIVE_GRADER_MODEL } from './grader-noise.js'
import { HOLDOUT_EXPERIMENT_KEY, isHeldOut } from './learning-concept-holdout.js'
import { saveLearningPolicy } from './learning-policy-settings.js'
import { countedReadings, currentHoldoutPhase, holdoutReport, masteryChanges } from './mastery-change.js'
import { Z_95_ONE_SIDED } from './mastery-change-statistics.js'
import { masteryNotifications } from './mastery-notifications.js'

// docs/specs/mastery-change-statistics.md on learner_test (migration 0022), each test in a rolled-back transaction.
describe.skipIf(!process.env.TEST_DATABASE_URL)('mastery change statistics (learner_test)', () => {
  let client: Client
  let query: QueryFn
  let userId: string
  let tag: string
  const at = (day: number, month = 9) => new Date(Date.UTC(2026, month, day, 12)).toISOString()

  beforeEach(async () => {
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    await client.query('BEGIN')
    query = (async (text: string, params?: ReadonlyArray<unknown>) => {
      const r = await client.query(text, params ? [...params] : [])
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    }) as QueryFn
    userId = `mc-${randomUUID()}`
    tag = randomUUID().slice(0, 8)
  })
  afterEach(async () => { await client.query('ROLLBACK'); await client.end() })

  const concept = async (name: string) => {
    const id = `mc-${tag}-${name}`
    await query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind) VALUES($1,$2,'s','e','x','d','c',0,0,'user')`, [id, `Title ${name}`])
    return id
  }
  /** A manual live reading resting on one learner message said at `said`, graded at `graded`. */
  const reading = async (conceptId: string, pct: number, conf: 'low' | 'medium' | 'high', said: string, graded = said, opts: { replicates?: number; mean?: number; model?: string; experimentId?: string; evidenceKey?: string } = {}) => {
    const runId = randomUUID()
    const snapshot = { prompt: 'p', promptRevision: 'rev', model: { backend: LIVE_GRADER_MODEL.split('/')[0], model: LIVE_GRADER_MODEL.split('/')[1], effort: LIVE_GRADER_MODEL.split('/')[2] },
      evidence: [{ id: opts.evidenceKey ?? `m-${runId}`, role: 'user', occurredAt: said, text: 't' }], ...(opts.experimentId ? { experimentId: opts.experimentId } : {}) }
    if (opts.model) snapshot.model = { backend: 'x', model: opts.model, effort: 'y' }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at) VALUES($1,$2,$1,$3,'v','h',$4::jsonb,$5)`, [runId, userId, conceptId, JSON.stringify(snapshot), graded])
    if (opts.replicates) await query('INSERT INTO learning_concept_assessment_replicate_plans(run_id,replicates) VALUES($1,$2)', [runId, opts.replicates])
    const receipt = { status: 'completed', completedAt: graded, assessment: { conceptId, understandingPercent: pct, confidence: conf, demonstrated: [], gaps: [], nextCheck: 'n', needsReview: true } }
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)', [runId, JSON.stringify(receipt), graded])
    if (opts.replicates) await query(`INSERT INTO learning_concept_assessment_replicate_summaries(run_id,replicates,mean_percent,display_percent,sd,confidence) VALUES($1,$2,$3,$4,0,$5)`,
      [runId, opts.replicates, opts.mean ?? pct, Math.round((opts.mean ?? pct) / 5) * 5, conf])
    return runId
  }

  test('grader noise pools identical-evidence regrades of the live model only, and replicate spreads', async () => {
    const before = await graderNoise(query)
    const c = await concept('noise')
    // 40 extra pairs of comparison gradings (an experimentId that is no live pass): each pair differs by 10 → s² = 50.
    for (let i = 0; i < 40; i++) {
      const exp = randomUUID()
      await reading(c, 40, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `pair-${tag}-${i}` })
      await reading(c, 50, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `pair-${tag}-${i}` })
      // Another model's disagreement never counts.
      await reading(c, 0, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `pair-${tag}-${i}`, model: 'other' })
    }
    const after = await graderNoise(query)
    expect(after.df - before.df).toBe(40)
    const ss = (after.sd ** 2) * after.df - (before.source === 'measured' ? (before.sd ** 2) * before.df : 0)
    if (before.df === 0) expect(after.sd).toBeCloseTo(Math.sqrt(50), 9)
    else expect(ss / 40).toBeGreaterThan(0)
    expect(after.source).toBe('measured')
  })

  test('counted readings: medium/high only, one per origin, by evidence time, with replicates', async () => {
    const c = await concept('read')
    await reading(c, 30, 'medium', at(5), at(25))
    await reading(c, 70, 'low', at(6), at(25))
    await reading(c, 50, 'high', at(2), at(26), { replicates: 3, mean: 51.6667 })
    const rows = await countedReadings(query, userId)
    expect(rows.map((r) => [new Date(r.at).toISOString(), r.percent, r.replicates])).toEqual([[at(2), 51.6667, 3], [at(5), 30, 1]])
  })

  test('probe answers: a reading within a day after a probe of its concept is marked, others are not', async () => {
    const c = await concept('probed'), other = await concept('unprobed')
    const turnAt = at(10)
    await query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,created_at,probe_concept_id) VALUES($1,'s',$2,'m',false,'v',$3,$4)`, [userId, randomUUID(), turnAt, c])
    await reading(c, 40, 'medium', at(9))                                         // before the probe
    await reading(c, 50, 'medium', new Date(Date.parse(turnAt) + 3_600_000).toISOString()) // an hour after: the answer
    await reading(c, 55, 'medium', at(12))                                        // two days after
    await reading(other, 50, 'medium', new Date(Date.parse(turnAt) + 3_600_000).toISOString()) // another concept
    const rows = await countedReadings(query, userId)
    expect(rows.filter((r) => r.probe).map((r) => [r.conceptId, r.percent])).toEqual([[c, 50]])
  })

  test('getMasteryChanges: signed per-concept change by evidence time, declines included, windowed', async () => {
    const up = await concept('up'), down = await concept('down'), one = await concept('one')
    await reading(up, 20, 'medium', at(1)); await reading(up, 30, 'medium', at(8)); await reading(up, 50, 'medium', at(15))
    // Graded in the opposite order to what was said: evidence time decides.
    await reading(down, 30, 'medium', at(20), at(21)); await reading(down, 60, 'medium', at(3), at(22))
    await reading(one, 40, 'medium', at(4))
    const noise = { sd: 12, df: 100, groups: 50, source: 'measured' as const }
    const all = await masteryChanges(query, userId, { sinceDays: null }, new Date(at(28)), noise)
    const by = new Map(all.concepts.map((c) => [c.conceptId, c]))
    expect([by.get(up)!.from, by.get(up)!.to, by.get(up)!.delta]).toEqual([20, 50, 30])
    expect([by.get(down)!.from, by.get(down)!.to, by.get(down)!.delta]).toEqual([60, 30, -30])
    expect(by.has(one)).toBe(false)
    expect(by.get(up)!.slopePerWeek).toBeCloseTo(15, 9)
    expect(all.aggregate.meanChange).toBeCloseTo(0, 9)
    expect(all.aggregate.nConcepts).toBe(2)
    expect(all.aggregate.nReadings).toBe(5)
    expect(all.aggregate.changeInterval).toBeNull() // fewer than 5 concepts
    expect(all.gainThreshold).toBeCloseTo(Z_95_ONE_SIDED * 12 * Math.SQRT2, 9)
    // Last 14 days from day 28 (since day 14): each concept is anchored on its last reading before the window —
    // up on day 8's 30 (day 1 drops out), down on day 3's 60 — and needs a reading inside it.
    const recent = await masteryChanges(query, userId, { sinceDays: 14 }, new Date(at(28)), noise)
    expect(new Map(recent.concepts.map((c) => [c.conceptId, [c.from, c.to]]))).toEqual(new Map([[up, [30, 50]], [down, [60, 30]]]))
  })

  test('noise-aware gain notifications: +15 is noise at sd 12, +30 is not; averaged readings need less', async () => {
    const a = await concept('a'), b = await concept('b'), r = await concept('r')
    await reading(a, 30, 'medium', at(1), at(1)); const small = await reading(a, 45, 'medium', at(2), at(2))
    await reading(b, 30, 'medium', at(1), at(1)); const big = await reading(b, 60, 'medium', at(2), at(2))
    await reading(r, 30, 'medium', at(1), at(1), { replicates: 3 }); const averaged = await reading(r, 50, 'medium', at(2), at(2), { replicates: 3 })
    const noise = { sd: 12, df: 100, groups: 50, source: 'measured' as const }
    const ids = (await masteryNotifications(query, userId, { since: null, limit: 20 }, noise)).map((n) => n.runId)
    // Thresholds: single 1.645·12·√2 = 27.9; three-by-three 1.645·12·√(2/3) = 16.1.
    expect(ids).not.toContain(small)
    expect(ids).toContain(big)
    expect(ids).toContain(averaged)
    // At sd 0 the floor rule (≥ +10) is back: the +15 is a gain.
    expect((await masteryNotifications(query, userId, { since: null, limit: 20 }, { ...noise, sd: 0 })).map((n) => n.runId)).toContain(small)
  })

  test('getHoldoutEffect: baseline before the phase start, follow-up after, arms by the phase share; a setting change is a new phase', async () => {
    const phase = await currentHoldoutPhase(query)
    expect(phase).toMatchObject({ experimentKey: HOLDOUT_EXPERIMENT_KEY, buckets: 5 })
    const start = Date.parse(phase.startedAt)
    const before = new Date(start - 5 * 86_400_000).toISOString(), after = new Date(start + 2 * 86_400_000).toISOString()
    // Find concept ids in each arm under the default share.
    const ids: { held: string[]; taught: string[] } = { held: [], taught: [] }
    for (let i = 0; ids.held.length < 3 || ids.taught.length < 3; i++) {
      const id = `mc-${tag}-h${i}`
      ;(isHeldOut(id) ? ids.held : ids.taught).push(id)
    }
    for (const id of [...ids.held.slice(0, 3), ...ids.taught.slice(0, 3)]) {
      await query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind) VALUES($1,'t','s','e','x','d','c',0,0,'user')`, [id])
      await reading(id, 30, 'medium', before)
    }
    await reading(ids.taught[0]!, 45, 'medium', after)
    await reading(ids.held[0]!, 35, 'medium', after)
    const report = await holdoutReport(query, userId, { sd: 12, df: 100, groups: 50, source: 'measured' })
    expect(report.effect.state).toBe('setting_baseline')
    expect(report.effect.measuredTwice).toEqual({ taught: 1, heldOut: 1 })
    expect(report.effect.baselineOnly).toEqual({ taught: 2, heldOut: 2 })
    expect(report.effect.meanChange).toEqual({ taught: 15, heldOut: 5 })
    expect(report.probe).toBeNull()

    // Saving the same share keeps the phase; a new share starts phase n+1 now, and the share filters the arms.
    await saveLearningPolicy({ ...DEFAULT_LEARNING_POLICY }, 'test', query)
    expect((await currentHoldoutPhase(query)).phase).toBe(phase.phase)
    await saveLearningPolicy({ ...DEFAULT_LEARNING_POLICY, holdoutBuckets: 10 }, 'test', query)
    const next = await currentHoldoutPhase(query)
    expect(next).toMatchObject({ phase: phase.phase + 1, buckets: 10 })
    expect(Date.parse(next.startedAt)).toBeGreaterThan(start)
    // Every reading is now before the new phase: all baselines, no follow-ups.
    const fresh = await holdoutReport(query, userId, { sd: 12, df: 100, groups: 50, source: 'measured' })
    expect(fresh.effect.measuredTwice).toEqual({ taught: 0, heldOut: 0 })
  })
})
