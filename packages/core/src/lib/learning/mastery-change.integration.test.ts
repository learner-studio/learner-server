import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import type { QueryFn } from '../../db/handle.js'
import { graderNoise, LIVE_GRADER_MODEL, type GraderNoiseComponents } from './grader-noise.js'
import { HOLDOUT_EXPERIMENT_KEY, isHeldOut } from './learning-concept-holdout.js'
import { saveLearningPolicy } from './learning-policy-settings.js'
import { countedMeasurements, currentHoldoutPhase, holdoutReport, masteryChanges, blindPromptRevisions } from './mastery-change.js'
import { FALLBACK_EVIDENCE_SD, graderOnlyNoise, isBlindGain, seededRandom, Z_95_ONE_SIDED, type GainMeasurement, type MeasurementNoise } from './mastery-change-statistics.js'
import { holdoutProbeFactSql } from './mastery-holdout-growthbook.js'
import { BLIND_BEFORE, BLIND_GAIN, GAIN_MIN_POINTS, gainParams, masteryNotifications } from './mastery-notifications.js'
import { masteryProgress } from './mastery-progress.js'

// docs/specs/mastery-change-statistics.md on learner_test (migrations 0022, 0031), each test in a rolled-back transaction.
/** A noise model with a known prior-blind sd (and the anchored one beside it). */
const noiseOf = (blindSd: number): GraderNoiseComponents => ({
  blind: { sd: blindSd, df: 100, groups: 50, source: 'measured' }, anchored: { sd: 2, df: 100, groups: 50, source: 'measured' },
  drift: { gradings: 0, meanMove: null, sdMove: null, equal: null, up: null, down: null },
  blindDrift: { perWeek: 0, interval: [-0.1, 0.1], gradings: 100, groups: 40, sxxWeeks2: 1e4 },
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
  const reading = async (conceptId: string, pct: number, conf: 'low' | 'medium' | 'high', said: string, graded = said, opts: { replicates?: number; mean?: number; model?: string; experimentId?: string; evidenceKey?: string; prior?: number; role?: 'user' | 'assistant'; uncited?: boolean; revision?: string } = {}) => {
    const runId = randomUUID()
    const prompt = opts.prior === undefined ? 'p' : `p\n### CURRENT PUBLISHED ESTIMATE\n${opts.prior}% (medium)\n`
    const snapshot = { prompt, ...(opts.prior === undefined ? {} : { prior: { understandingPercent: opts.prior, confidence: 'medium' } }), promptRevision: opts.revision ?? 'rev', model: { backend: LIVE_GRADER_MODEL.split('/')[0], model: LIVE_GRADER_MODEL.split('/')[1], effort: LIVE_GRADER_MODEL.split('/')[2] },
      evidence: [{ id: opts.evidenceKey ?? `m-${runId}`, role: opts.role ?? 'user', occurredAt: said, text: 't' }], ...(opts.experimentId ? { experimentId: opts.experimentId } : {}) }
    if (opts.model) snapshot.model = { backend: 'x', model: opts.model, effort: 'y' }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at) VALUES($1,$2,$1,$3,'v','h',$4::jsonb,$5)`, [runId, userId, conceptId, JSON.stringify(snapshot), graded])
    if (opts.replicates) await query('INSERT INTO learning_concept_assessment_replicate_plans(run_id,replicates) VALUES($1,$2)', [runId, opts.replicates])
    const receipt = { status: 'completed', completedAt: graded, assessment: { conceptId, understandingPercent: pct, confidence: conf, demonstrated: opts.uncited ? [] : [{ quote: 'q', sourceId: snapshot.evidence[0]!.id, description: 'd' }], gaps: [], nextCheck: 'n', needsReview: true } }
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
      // Identical evidence on DIFFERENT priors is no regrade pair: each grade follows its own prior (S4).
      await reading(c, 20, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `diff-${tag}-${i}`, prior: 20 })
      await reading(c, 80, 'medium', at(1), at(2), { experimentId: exp, evidenceKey: `diff-${tag}-${i}`, prior: 80 })
    }
    const after = await graderNoise(query)
    const added = (k: 'blind' | 'anchored') => (after[k].sd ** 2 * after[k].df - (before[k].source === 'measured' ? before[k].sd ** 2 * before[k].df : 0)) / (after[k].df - before[k].df)
    expect(after.blind.df - before.blind.df).toBe(40)
    expect(after.anchored.df - before.anchored.df).toBe(40)
    if (before.blind.source === 'measured') expect(added('blind')).toBeCloseTo(50, 6)
    else expect(after.blind.sd).toBeCloseTo(Math.sqrt(50), 9)
    if (before.anchored.source === 'measured') expect(added('anchored')).toBeCloseTo(12.5, 6)
    else expect(after.anchored.sd).toBeCloseTo(Math.sqrt(12.5), 9)
    expect(after.drift.gradings - before.drift.gradings).toBe(160)
    if (before.drift.gradings === 0) expect([after.drift.meanMove, after.drift.equal, after.drift.up, after.drift.down]).toEqual([1.25, 0.75, 0.25, 0])
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

  /** A live turn of `session` at `when`; `probe` delivers a probe of that concept, `taught` lists the concepts its guidance taught. */
  const turn = (session: string, when: string, opts: { probe?: string; taught?: string[] } = {}) => query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome)
    VALUES($1,$2,$3,'m',false,'v',$4::jsonb,$5,$6,$7)`, [userId, `${tag}-${session}`, randomUUID(), JSON.stringify({ matches: [], taughtConceptIds: opts.taught ?? [] }), when, opts.probe ?? null, opts.probe ? 'delivered' : null])
  const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString()

  test('probe answers (S-A): a cited learner message by two minutes after the next turn began; not later that day, not another clock', async () => {
    const c = await concept('probed'), other = await concept('unprobed')
    const probeAt = at(10), answerTurn = plus(probeAt, 3_600_000)
    await turn('s', probeAt, { probe: c }); await turn('s', answerTurn)
    await reading(c, 40, 'medium', at(9))                              // before the probe
    await reading(c, 50, 'medium', plus(answerTurn, 60_000))           // a minute into the answer turn: the answer
    await reading(c, 55, 'medium', plus(answerTurn, 5 * 60_000))       // inside 24 h, after the two-minute bound
    await reading(c, 56, 'medium', at(12))                             // two days after
    await reading(other, 50, 'medium', plus(answerTurn, 60_000))       // another concept
    // Inside the bound, but not a learner message's clock: an uncited reading's p75 date, a grading
    // time (the only evidence is undated), a cited agent message.
    await reading(c, 61, 'medium', plus(answerTurn, 10_000), plus(answerTurn, 10_000), { uncited: true })
    await reading(c, 62, 'medium', '1970-01-01T00:00:00.000Z', plus(answerTurn, 20_000))
    await reading(c, 63, 'medium', plus(answerTurn, 30_000), plus(answerTurn, 30_000), { role: 'assistant' })
    const rows = (await countedMeasurements(query, userId)).blind
    expect(rows.filter((r) => r.probe).map((r) => [r.conceptId, r.percent])).toEqual([[c, 50]])
    expect(rows.filter((r) => r.conceptId === c).length).toBe(7)
  })

  test('probed → taught → demonstrated (S-A): evidence after a next turn that taught the probed concept answers nothing', async () => {
    const x = await concept('taught-after-probe'), control = await concept('asked-only')
    const probeAt = at(10), nextTurn = plus(probeAt, 3_600_000)
    await turn('taught', probeAt, { probe: x }); await turn('taught', nextTurn, { taught: [x] })
    await turn('asked', probeAt, { probe: control }); await turn('asked', nextTurn)
    await reading(x, 70, 'medium', plus(nextTurn, 60_000))
    await reading(control, 70, 'medium', plus(nextTurn, 60_000))
    const rows = (await countedMeasurements(query, userId)).blind
    expect(rows.map((r) => [r.conceptId, r.probe])).toEqual([[control, true], [x, false]].sort(([a], [b]) => String(a).localeCompare(String(b))))
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
    // σ_e per read-rate group (review round 3, S2): `up` is read weekly (one pair 7 days apart), `down` every
    // 17 days (one pair, sparse). One pair each is too few for an upper bound: the fallback 18, dev's 95 %
    // upper end, and replicates earn no precision (S1).
    expect(all.noise.evidenceStrata.map((st) => [st.stratum, st.concepts, st.pairs, st.sd, st.source])).toEqual([['frequent', 1, 1, 18, 'fallback'], ['sparse', 1, 1, 18, 'fallback']])
    expect([all.noise.evidenceSource, all.noise.evidenceSd, all.noise.replicateCredit, all.noise.evidenceInterval]).toEqual(['fallback', FALLBACK_EVIDENCE_SD, false, null])
    expect(all.gainThresholdGradings).toBe(1)
    expect(all.gainThreshold).toBeCloseTo(Z_95_ONE_SIDED * Math.sqrt(2 * (18 ** 2 + 12 ** 2)) + 2.5, 9)
    // Last 14 days from day 28 (since day 14): each concept is anchored on its last reading before the window —
    // up on day 8's 30 (day 1 drops out), down on day 3's 60 — and needs a reading inside it.
    const recent = await masteryChanges(query, userId, { sinceDays: 14 }, new Date(at(28)), noise)
    expect(new Map(recent.concepts.map((c) => [c.conceptId, [c.from, c.to]]))).toEqual(new Map([[up, [30, 50]], [down, [60, 30]]]))
  })

  test('prompt revisions (review round 3, S5): counted over the readings each change uses; two or more withhold the verdict', async () => {
    const noise = noiseOf(3)
    const cs = await Promise.all(Array.from({ length: 20 }, (_, i) => concept(`rev${i}`)))
    // 20 concepts, each +30 from day 1 to day 15: far beyond noise. Day 1 under 'rev', day 15 under 'rev2'.
    for (const c of cs) { await reading(c, 20, 'medium', at(1)); await reading(c, 50, 'medium', at(15), at(15), { revision: 'rev2' }) }
    // A one-reading concept under a third revision is in no change: not counted.
    await reading(await concept('lone'), 40, 'medium', at(10), at(10), { revision: 'rev3' })
    const all = await masteryChanges(query, userId, { sinceDays: null }, new Date(at(28)), noise)
    expect(all.aggregate.changeInterval![0]).toBeGreaterThan(0)
    expect([all.aggregate.promptRevisions, all.aggregate.withheldForRevision, all.aggregate.conclusive, all.aggregate.slopeConclusive]).toEqual([2, true, false, false])
    // Window from day 20: each concept is anchored on day 15 ('rev2') and needs a later reading.
    for (const c of cs) await reading(c, 80, 'medium', at(22), at(22), { revision: 'rev2' })
    const recent = await masteryChanges(query, userId, { sinceDays: 8 }, new Date(at(28)), noise)
    expect(recent.aggregate.nConcepts).toBe(20)
    expect([recent.aggregate.promptRevisions, recent.aggregate.withheldForRevision]).toEqual([1, false])
    expect(await blindPromptRevisions(query, userId, null, new Date(at(28)))).toBe(2)
    expect(await blindPromptRevisions(query, userId, new Date(at(20)), new Date(at(28)))).toBe(1)
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
    const ids = (await masteryNotifications(query, userId, { since: null, limit: 50 }, graderOnlyNoise(noise.blind.sd))).map((n) => n.runId)
    // Thresholds (with the grid's continuity correction): single 1.645·12·√2 + 2.5 = 30.4; three-by-three 1.645·12·√(2/3) + 2.5/3 = 16.9.
    expect(ids).not.toContain(small)
    expect(ids).toContain(big)
    expect(ids).toContain(averaged)
    expect(ids).not.toContain(anchored)
    expect(ids).toContain(overMean)
    // At sd 0 the floor rule (≥ +10) is back: the +15 is a gain.
    expect((await masteryNotifications(query, userId, { since: null, limit: 50 }, graderOnlyNoise(0))).map((n) => n.runId)).toContain(small)
  })

  test('the strip and the evidence history read a multi-run measurement with its runs (review round 3, N5: R21, R22)', async () => {
    // Two runs of three blind gradings on the same evidence are ONE measurement of k 6 from 2 runs:
    // k_eff = 6 / (1 + 5ρ), not 6. Credit on, σ_e 0, σ_g 12. Find a mean that is a gain at k_eff 6 but
    // not at the correlated k_eff, by the pure twin, for (A) the multi-run measurement now and (B) before.
    const noise: MeasurementNoise = { graderSd: 12, evidenceSd: 0, replicateCredit: true }
    const between = (gainAt: (p: number, runs: number) => boolean) => {
      for (let p = 31; p < 100; p += 0.25) if (gainAt(p, 1) && !gainAt(p, 2)) return p
      throw new Error('no separating mean')
    }
    const pA = between((p, runs) => isBlindGain({ percent: p, gradings: 6, runs }, [{ percent: 30, gradings: 3, runs: 1 }], noise, GAIN_MIN_POINTS))
    const pB = between((p, runs) => isBlindGain({ percent: p, gradings: 3, runs: 1 }, [{ percent: 30, gradings: 6, runs }], noise, GAIN_MIN_POINTS))
    const multi = async (c: string, pct: number, day: number) => {
      await reading(c, Math.round(pct), 'medium', at(day), at(day), { replicates: 3, mean: pct, evidenceKey: `mr-${c}-${day}-a` })
      await reading(c, Math.round(pct), 'medium', at(day), at(day), { replicates: 3, mean: pct, evidenceKey: `mr-${c}-${day}-b` })
    }
    const single = (c: string, pct: number, day: number) => reading(c, Math.round(pct), 'medium', at(day), at(day), { replicates: 3, mean: pct })
    const a = await concept('runs-now'), aPlus = await concept('runs-now-plus'), b = await concept('runs-before'), bPlus = await concept('runs-before-plus')
    await single(a, 30, 1); await multi(a, pA, 5)
    await single(aPlus, 30, 1); await multi(aPlus, pA + 15, 5)       // positive control: a gain either way
    await multi(b, 30, 1); await single(b, pB, 5)
    await multi(bPlus, 30, 1); await single(bPlus, pB + 15, 5)
    const up7 = async (ids: string[]) => (await masteryProgress(query, userId, ids, new Map(), new Date(at(7)), noise)).windows.find((w) => w.window === '7d')!.up
    const measurements = (await countedMeasurements(query, userId)).blind.filter((m) => m.conceptId === a && m.at === Date.parse(at(5)))
    expect(measurements.map((m) => [m.replicates, m.runs])).toEqual([[6, 2]])
    expect([await up7([a]), await up7([aPlus])]).toEqual([0, 1])    // R21: the strip's BLIND_GAIN must get scoped.blind_runs
    expect([await up7([b]), await up7([bPlus])]).toEqual([0, 1])    // R22: EVIDENCE_HISTORY's BLIND_BEFORE must get m.blind_runs
  })

  test('the SQL gain rule (feed and strip) and its pure twin agree on every case, evidence error and runs included (review round 2, NB1/S-c)', async () => {
    const r = seededRandom(31)
    const noises: MeasurementNoise[] = [graderOnlyNoise(0), graderOnlyNoise(6.74), graderOnlyNoise(12),
      { graderSd: 6.74, evidenceSd: 10, replicateCredit: true }, { graderSd: 6.74, evidenceSd: 10, replicateCredit: false }]
    const measurement = (): GainMeasurement => {
      const gradings = 1 + Math.floor(r() * 3), runs = gradings > 1 && r() < 0.4 ? 1 + Math.floor(r() * gradings) : 1
      return { percent: Math.round(r() * 20) * 5, gradings, runs }
    }
    const cases = Array.from({ length: 500 }, (_, i) => {
      const before = Array.from({ length: 1 + Math.floor(r() * 3) }, measurement)
      const now = measurement()
      now.percent = Math.min(100, Math.round((before[0]!.percent + r() * 45) / 5) * 5)
      return { i, before, now, noise: noises[i % noises.length]! }
    })
    for (const noise of noises) {
      const mine = cases.filter((c) => c.noise === noise)
      // The window sums come from BLIND_BEFORE itself, as the feed and the strip compute them.
      const rows = (await query<{ i: number; g: boolean }>(
        `WITH x AS (SELECT * FROM jsonb_to_recordset($4::jsonb) AS v(i int, j int, blind_percent numeric, blind_gradings int, blind_runs int, blind_confidence text)),
         h AS (SELECT v.*, ${BLIND_BEFORE('v', 'v.blind_runs')} FROM x v WINDOW before AS (PARTITION BY v.i ORDER BY v.j ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING))
         SELECT h.i, ${BLIND_GAIN({ e2: '$1', g2: '$2', credit: '$3' }, GAIN_MIN_POINTS, 'h', 'h.blind_runs')} AS g
         FROM h WHERE h.j = (SELECT max(j) FROM x WHERE x.i = h.i)`,
        [...gainParams(noise), JSON.stringify(mine.flatMap((c) => [...c.before, c.now].map((m, j) => ({ i: c.i, j, blind_percent: m.percent, blind_gradings: m.gradings, blind_runs: m.runs, blind_confidence: 'medium' }))))])).rows
      const sql = new Map(rows.map((x) => [x.i, x.g]))
      for (const c of mine) expect([c.i, sql.get(c.i)]).toEqual([c.i, isBlindGain(c.now, c.before, noise, GAIN_MIN_POINTS)])
      expect(mine.some((c) => sql.get(c.i)) && mine.some((c) => !sql.get(c.i))).toBe(true)
    }
  })

  test('probe headline follow-up = the answer to the FIRST delivered probe only (review round 6, S-1): no reading for probe 1 is attrition, never probe 2', async () => {
    const phase = await currentHoldoutPhase(query)
    const start = Date.parse(phase.startedAt)
    const day = (d: number) => new Date(start + d * 86_400_000).toISOString()
    // Three held-out concepts and one taught (a constant share): the fall-through hits the held-out arm, probed most.
    const ids: { held: string[]; taught: string[] } = { held: [], taught: [] }
    for (let i = 0; ids.held.length < 3 || ids.taught.length < 1; i++) {
      const id = `mc-${tag}-p${i}`
      ;(isHeldOut(id) ? ids.held : ids.taught).push(id)
    }
    const [lost, kept] = ids.held as [string, string], taught = ids.taught[0]!
    const unprobed = ids.held[2]!
    for (const id of [lost, kept, taught, unprobed]) {
      await query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind) VALUES($1,'t','s','e','x','d','c',0,0,'user')`, [id])
      await reading(id, 30, 'medium', day(-5))
    }
    await reading(unprobed, 80, 'medium', day(2)) // read after the start, never probed: outside the headline
    // `lost`: probe 1 answered, but the answer produced no reading; probe 2's answer has one.
    await turn('lost-1', day(1), { probe: lost }); await turn('lost-1', plus(day(1), 60_000))
    await turn('lost-2', day(3), { probe: lost }); await turn('lost-2', plus(day(3), 60_000))
    await reading(lost, 90, 'medium', plus(day(3), 90_000))
    // `kept` and `taught`: probe 1 answered with a reading.
    for (const [id, pct] of [[kept, 45], [taught, 50]] as const) {
      await turn(`${id}-1`, day(2), { probe: id }); await turn(`${id}-1`, plus(day(2), 60_000))
      await reading(id, pct, 'medium', plus(day(2), 90_000))
    }
    const rows = (await countedMeasurements(query, userId, { probesSince: phase.startedAt })).blind
    const after = rows.filter((r) => r.at >= start && r.conceptId !== unprobed).map((r) => [r.conceptId, r.probe, r.firstProbe]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    expect(after).toEqual([[lost, true, false], [kept, true, true], [taught, true, true]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))

    const report = await holdoutReport(query, userId, noiseOf(12))
    expect(report.probe!.measuredTwice).toEqual({ taught: 1, heldOut: 1 })
    expect(report.probe!.baselineOnly).toEqual({ taught: 0, heldOut: 1 }) // `lost` is attrition in its arm; `unprobed` is not in the population
    expect(report.probe!.meanChange).toEqual({ taught: 20, heldOut: 15 })   // 45 − 30, never 90 − 30

    // GrowthBook reads the same follow-ups.
    const fact = (await query<{ concept_id: string; timestamp: Date; probe_percent: number }>(holdoutProbeFactSql(userId, phase.startedAt))).rows
    expect(fact.filter((r) => r.timestamp.getTime() >= start).map((r) => [r.concept_id, r.probe_percent]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
      .toEqual([[kept, 45], [taught, 50]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
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
