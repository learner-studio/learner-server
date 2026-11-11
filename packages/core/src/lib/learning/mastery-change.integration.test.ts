import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import type { QueryFn } from '../../db/handle.js'
import { graderNoise, LIVE_GRADER_MODEL, type GraderNoiseComponents } from './grader-noise.js'
import { HOLDOUT_EXPERIMENT_KEY, isHeldOut } from './learning-concept-holdout.js'
import { saveLearningPolicy } from './learning-policy-settings.js'
import { countedMeasurements, currentHoldoutPhase, holdoutReport, masteryChanges } from './mastery-change.js'
import { isBlindGain, seededRandom, Z_95_ONE_SIDED } from './mastery-change-statistics.js'
import { BLIND_GAIN, GAIN_MIN_POINTS, masteryNotifications } from './mastery-notifications.js'
import { zTimesSd } from './grader-noise.js'

// docs/specs/mastery-change-statistics.md on learner_test (migrations 0022, 0031), each test in a rolled-back transaction.
/** A noise model with a known prior-blind sd (and the anchored one beside it). */
const noiseOf = (blindSd: number): GraderNoiseComponents => ({
  blind: { sd: blindSd, df: 100, groups: 50, source: 'measured' }, anchored: { sd: 2, df: 100, groups: 50, source: 'measured' },
  drift: { gradings: 0, meanMove: null, sdMove: null, equal: null, up: null, down: null },
})
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
  /**
   * A manual live reading resting on one learner message said at `said`, graded at `graded`. Without
   * `prior` the prompt carries no published estimate (a cold, prior-blind grading); with it, the
   * prompt is anchored on that estimate.
   */
  const reading = async (conceptId: string, pct: number, conf: 'low' | 'medium' | 'high', said: string, graded = said, opts: { replicates?: number; mean?: number; model?: string; experimentId?: string; evidenceKey?: string; prior?: number } = {}) => {
    const runId = randomUUID()
    const prompt = opts.prior === undefined ? 'p' : `p\n### CURRENT PUBLISHED ESTIMATE\n${opts.prior}% (medium)\n`
    const snapshot = { prompt, ...(opts.prior === undefined ? {} : { prior: { understandingPercent: opts.prior, confidence: 'medium' } }), promptRevision: 'rev', model: { backend: LIVE_GRADER_MODEL.split('/')[0], model: LIVE_GRADER_MODEL.split('/')[1], effort: LIVE_GRADER_MODEL.split('/')[2] },
      evidence: [{ id: opts.evidenceKey ?? `m-${runId}`, role: 'user', occurredAt: said, text: 't' }], ...(opts.experimentId ? { experimentId: opts.experimentId } : {}) }
    if (opts.model) snapshot.model = { backend: 'x', model: opts.model, effort: 'y' }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at) VALUES($1,$2,$1,$3,'v','h',$4::jsonb,$5)`, [runId, userId, conceptId, JSON.stringify(snapshot), graded])
    if (opts.replicates) await query('INSERT INTO learning_concept_assessment_replicate_plans(run_id,replicates) VALUES($1,$2)', [runId, opts.replicates])
    const receipt = { status: 'completed', completedAt: graded, assessment: { conceptId, understandingPercent: pct, confidence: conf, demonstrated: [{ quote: 'q', sourceId: snapshot.evidence[0]!.id, description: 'd' }], gaps: [], nextCheck: 'n', needsReview: true } }
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)', [runId, JSON.stringify(receipt), graded])
    if (opts.replicates) await query(`INSERT INTO learning_concept_assessment_replicate_summaries(run_id,replicates,mean_percent,display_percent,sd,confidence) VALUES($1,$2,$3,$4,0,$5)`,
      [runId, opts.replicates, opts.mean ?? pct, Math.round((opts.mean ?? pct) / 5) * 5, conf])
    return runId
  }

  test('grader noise: prior-blind and same-prior regrades are separate components, live model only; drift is the anchored move', async () => {
    const before = await graderNoise(query)
    const c = await concept('noise')
    for (let i = 0; i < 40; i++) {
      const exp = randomUUID()
      // Blind pairs of identical evidence differ by 10 → s² = 50.
      await reading(c, 40, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `pair-${tag}-${i}` })
      await reading(c, 50, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `pair-${tag}-${i}` })
      // Another model's disagreement never counts.
      await reading(c, 0, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `pair-${tag}-${i}`, model: 'other' })
      // Anchored pairs on the same prior 40: 40 and 45 → s² = 12.5; both moves from the prior are drift.
      await reading(c, 40, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `anch-${tag}-${i}`, prior: 40 })
      await reading(c, 45, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `anch-${tag}-${i}`, prior: 40 })
    }
    const after = await graderNoise(query)
    const added = (k: 'blind' | 'anchored') => (after[k].sd ** 2 * after[k].df - (before[k].source === 'measured' ? before[k].sd ** 2 * before[k].df : 0)) / (after[k].df - before[k].df)
    expect(after.blind.df - before.blind.df).toBe(40)
    expect(after.anchored.df - before.anchored.df).toBe(40)
    if (before.blind.source === 'measured') expect(added('blind')).toBeCloseTo(50, 6)
    else expect(after.blind.sd).toBeCloseTo(Math.sqrt(50), 9)
    if (before.anchored.source === 'measured') expect(added('anchored')).toBeCloseTo(12.5, 6)
    else expect(after.anchored.sd).toBeCloseTo(Math.sqrt(12.5), 9)
    expect(after.drift.gradings - before.drift.gradings).toBe(80)
    if (before.drift.gradings === 0) expect([after.drift.meanMove, after.drift.equal, after.drift.up, after.drift.down]).toEqual([2.5, 0.5, 0.5, 0])
  })

  test('counted measurements: medium/high only; the blind series holds prior-blind gradings only, the anchored series every live one', async () => {
    const c = await concept('read')
    await reading(c, 30, 'medium', at(5), at(25), { prior: 25 })                  // anchored: live only
    await reading(c, 70, 'low', at(6), at(25))                                     // low: never counted
    await reading(c, 50, 'high', at(2), at(26), { replicates: 3, mean: 51.6667 })  // blind summary of 3
    await reading(c, 45, 'medium', at(9), at(27), { prior: 30, replicates: 2, mean: 41 }) // anchored live grading + 2 blind replicates
    const m = await countedMeasurements(query, userId)
    const day = (x: { at: number }) => new Date(x.at).toISOString()
    expect(m.blind.map((r) => [day(r), r.percent, r.replicates, r.runs])).toEqual([[at(2), 51.6667, 3, 1], [at(9), 41, 2, 1]])
    expect(m.anchored.map((r) => [day(r), r.percent, r.gradings])).toEqual([[at(2), 50, 1], [at(5), 30, 2], [at(9), 45, 4]])
  })

  test('probe answers: a reading within a day after a probe of its concept is marked, others are not', async () => {
    const c = await concept('probed'), other = await concept('unprobed')
    const turnAt = at(10)
    await query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,created_at,probe_concept_id) VALUES($1,'s',$2,'m',false,'v',$3,$4)`, [userId, randomUUID(), turnAt, c])
    await reading(c, 40, 'medium', at(9))                                         // before the probe
    await reading(c, 50, 'medium', new Date(Date.parse(turnAt) + 3_600_000).toISOString()) // an hour after: the answer
    await reading(c, 55, 'medium', at(12))                                        // two days after
    await reading(other, 50, 'medium', new Date(Date.parse(turnAt) + 3_600_000).toISOString()) // another concept
    const rows = (await countedMeasurements(query, userId)).blind
    expect(rows.filter((r) => r.probe).map((r) => [r.conceptId, r.percent])).toEqual([[c, 50]])
  })

  test('getMasteryChanges: signed per-concept change by evidence time, declines included, windowed', async () => {
    const up = await concept('up'), down = await concept('down'), one = await concept('one')
    await reading(up, 20, 'medium', at(1)); await reading(up, 30, 'medium', at(8)); await reading(up, 50, 'medium', at(15))
    // Graded in the opposite order to what was said: evidence time decides.
    await reading(down, 30, 'medium', at(20), at(21)); await reading(down, 60, 'medium', at(3), at(22))
    await reading(one, 40, 'medium', at(4))
    const noise = noiseOf(12)
    const all = await masteryChanges(query, userId, { sinceDays: null }, new Date(at(28)), noise)
    const by = new Map(all.concepts.map((c) => [c.conceptId, c]))
    expect([by.get(up)!.from, by.get(up)!.to, by.get(up)!.delta]).toEqual([20, 50, 30])
    expect([by.get(down)!.from, by.get(down)!.to, by.get(down)!.delta]).toEqual([60, 30, -30])
    expect(by.has(one)).toBe(false)
    expect(by.get(up)!.slopePerWeek).toBeCloseTo(15, 9)
    expect(all.aggregate.meanChange).toBeCloseTo(0, 9)
    expect(all.aggregate.nConcepts).toBe(2)
    expect(all.aggregate.nReadings).toBe(5)
    expect(all.aggregate.changeInterval).toBeNull() // fewer than 20 concepts
    expect(all.aggregate.minimumConcepts).toBe(20)
    expect(all.gainThreshold).toBeCloseTo(Z_95_ONE_SIDED * 12 * Math.SQRT2, 9)
    // Last 14 days from day 28 (since day 14): each concept is anchored on its last reading before the window —
    // up on day 8's 30 (day 1 drops out), down on day 3's 60 — and needs a reading inside it.
    const recent = await masteryChanges(query, userId, { sinceDays: 14 }, new Date(at(28)), noise)
    expect(new Map(recent.concepts.map((c) => [c.conceptId, [c.from, c.to]]))).toEqual(new Map([[up, [30, 50]], [down, [60, 30]]]))
  })

  test('gain notifications: prior-blind only, against the MEAN of earlier blind measurements, beyond σ_b·√(1/k + 1/k_before)', async () => {
    const a = await concept('a'), b = await concept('b'), r = await concept('r'), anch = await concept('anch'), m = await concept('mean')
    await reading(a, 30, 'medium', at(1), at(1)); const small = await reading(a, 45, 'medium', at(2), at(2))
    await reading(b, 30, 'medium', at(1), at(1)); const big = await reading(b, 65, 'medium', at(2), at(2))
    await reading(r, 30, 'medium', at(1), at(1), { replicates: 3 }); const averaged = await reading(r, 50, 'medium', at(2), at(2), { replicates: 3 })
    // A live (anchored) +50 says nothing: the grader ratchets. No blind measurement, no gain.
    await reading(anch, 30, 'medium', at(1), at(1)); const anchored = await reading(anch, 80, 'medium', at(2), at(2), { prior: 30 })
    // S11: against the mean of earlier ones (30, 60 → 45, k 2), +30 clears 1.645·12·√1.5 + 2.5/2 = 25.4; against the max (60) it would not.
    await reading(m, 30, 'medium', at(1), at(1)); await reading(m, 60, 'medium', at(2), at(2)); const overMean = await reading(m, 75, 'medium', at(3), at(3))
    const noise = noiseOf(12)
    const ids = (await masteryNotifications(query, userId, { since: null, limit: 50 }, noise.blind)).map((n) => n.runId)
    // Thresholds (with the grid's continuity correction): single 1.645·12·√2 + 2.5 = 30.4; three-by-three 1.645·12·√(2/3) + 2.5/3 = 16.9.
    expect(ids).not.toContain(small)
    expect(ids).toContain(big)
    expect(ids).toContain(averaged)
    expect(ids).not.toContain(anchored)
    expect(ids).toContain(overMean)
    // At sd 0 the floor rule (≥ +10) is back: the +15 is a gain.
    expect((await masteryNotifications(query, userId, { since: null, limit: 50 }, { ...noise.blind, sd: 0 })).map((n) => n.runId)).toContain(small)
  })

  test('the SQL gain rule (feed and strip) and its pure twin agree on every case', async () => {
    const r = seededRandom(31)
    const cases = Array.from({ length: 400 }, (_, i) => {
      const kNow = 1 + Math.floor(r() * 3), kBefore = 1 + Math.floor(r() * 6)
      const before = Math.round(r() * 20) * 5 / kBefore * kBefore // a mean of gridded gradings
      const mean = Math.round((before + (r() - 0.3) * 40) * kBefore / 5) * 5 / kBefore
      const now = Math.round((mean + r() * 30) * kNow / 5) * 5 / kNow
      return { i, now, kNow, mean, kBefore, sd: [0, 6.74, 12][i % 3]! }
    })
    for (const sd of [0, 6.74, 12]) {
      const mine = cases.filter((c) => c.sd === sd)
      const rows = (await query<{ i: number; g: boolean }>(
        `SELECT x.i, ${BLIND_GAIN('$1', GAIN_MIN_POINTS, 'x')} AS g
         FROM jsonb_to_recordset($2::jsonb) AS x(i int, blind_percent numeric, blind_gradings int, blind_confidence text, blind_sum_before numeric, blind_k_before int)`,
        [zTimesSd(sd), JSON.stringify(mine.map((c) => ({ i: c.i, blind_percent: c.now, blind_gradings: c.kNow, blind_confidence: 'medium', blind_sum_before: c.mean * c.kBefore, blind_k_before: c.kBefore })))])).rows
      const sql = new Map(rows.map((x) => [x.i, x.g]))
      for (const c of mine) expect([c.i, sql.get(c.i)]).toEqual([c.i, isBlindGain({ percent: c.now, gradings: c.kNow }, { mean: c.mean, gradings: c.kBefore }, sd, GAIN_MIN_POINTS)])
      expect(mine.some((c) => sql.get(c.i)) && mine.some((c) => !sql.get(c.i))).toBe(true)
    }
  })

  test('getHoldoutEffect: baseline before the recorded start, follow-up after, arms by the constant share', async () => {
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
    const report = await holdoutReport(query, userId, noiseOf(12))
    expect(report.effect.state).toBe('setting_baseline')
    expect(report.effect.measuredTwice).toEqual({ taught: 1, heldOut: 1 })
    expect(report.effect.baselineOnly).toEqual({ taught: 2, heldOut: 2 })
    expect(report.effect.meanChange).toEqual({ taught: 15, heldOut: 5 })
    expect(report.probe).toBeNull()

    // The share is a constant (owner, 2026-11-11): saving the policy never starts a new phase.
    await saveLearningPolicy({ ...DEFAULT_LEARNING_POLICY }, 'test', query)
    expect(await currentHoldoutPhase(query)).toEqual(phase)
  })
})
