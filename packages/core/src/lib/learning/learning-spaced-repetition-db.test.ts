import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { readReviewHistory } from './learning-spaced-repetition.js'
import { decideTurnInjection, injectionAnalysisSql } from './learning-intervention-policy.js'
import { PROBE_ANALYSIS_SQL, PROBE_CONCEPTS_SQL, PROBE_LEAK_SQL, probeAnswerEvidenceSql } from './learning-blind-probes.js'

/** learner_test, one transaction per test, rolled back. The assessment cache and the semantic index are
 * shadowed by temp tables so archive citations can be written without the archive's FK chain. */
const url = process.env.TEST_DATABASE_URL
describe.skipIf(!url)('review history and stored reviews (learner_test, rolled back)', () => {
  let client: Client
  const query = (text: string, params: ReadonlyArray<unknown> = []) => client.query(text, [...params]) as never
  const userId = `sr-db-test-${randomUUID()}`
  const now = new Date('2026-10-23T00:00:00Z')
  const at = (hoursAgo: number) => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString()
  const turn = async (session: string, hoursAgo: number, feedback: unknown, review: string | null = null) => {
    const turnId = randomUUID()
    await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,review_concept_id)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$5,$6,$7)`, [userId, session, turnId, feedback === null ? null : JSON.stringify(feedback), at(hoursAgo), review !== null, review])
    return turnId
  }
  const match = (conceptId: string, relationship: string) => ({ conceptId, relationship, quote: 'm', outcome: 'not_assessed', reason: 'r' })

  beforeEach(async () => {
    client = new Client({ connectionString: url })
    await client.connect()
    await client.query('BEGIN')
    await client.query('CREATE TEMP TABLE learning_semantic_index_messages(message_id text PRIMARY KEY, observed_at timestamptz NOT NULL) ON COMMIT DROP')
    await client.query('CREATE TEMP TABLE learning_concept_assessment_cache(user_id text, concept_id text, assessment jsonb) ON COMMIT DROP')
  })
  afterEach(async () => { await client.query('ROLLBACK'); await client.end() })

  test('both sources; latest wins; mentions, other users and the future do not count', async () => {
    await turn('s1', 100, { matches: [match('taught-old', 'task_context')], taughtConceptIds: ['taught'] })
    await turn('s2', 10, { matches: [match('taught', 'learner_evidence'), match('misc', 'misconception'), match('named', 'mention')], taughtConceptIds: [] })
    await turn('s2', -5, { matches: [match('future', 'task_context')], taughtConceptIds: [] })
    await turn('s3', 1, null)
    await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at) VALUES('someone-else','s',$1,'m',true,'v',$2::jsonb,$3)`,
      [randomUUID(), JSON.stringify({ matches: [match('other', 'task_context')], taughtConceptIds: ['other'] }), at(1)])
    await client.query(`INSERT INTO learning_semantic_index_messages VALUES('msg-old',$1),('msg-new',$2)`, [at(500), at(50)])
    await client.query(`INSERT INTO learning_concept_assessment_cache VALUES($1,'archived',$2::jsonb),($1,'taught-old',$3::jsonb),($1,'malformed','{"demonstrated":null}'::jsonb)`, [userId,
      JSON.stringify({ demonstrated: [{ sourceId: 'msg-old' }], gaps: [{ sourceId: 'msg-new' }, { sourceId: null }] }),
      JSON.stringify({ demonstrated: [{ sourceId: 'msg-new' }], gaps: [] })])
    const history = await readReviewHistory(query, userId, now)
    const hours = Object.fromEntries([...history.exposures].map(([id, d]) => [id, (now.getTime() - d.getTime()) / 3_600_000]))
    expect(hours).toEqual({ taught: 10, 'taught-old': 50, misc: 10, archived: 50 })
    expect(history.offered.size).toBe(0)
  })

  test('a blind probe\'s answer is not an exposure, and only the answer: the next turn\'s match and the message said then', async () => {
    const probe = (session: string, hoursAgo: number, conceptId: string) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,probe_concept_id,probe_outcome)
      VALUES($1,$2,$3,'m',true,'v','{"matches":[],"taughtConceptIds":[]}'::jsonb,$4,$4,true,$5,'delivered')`, [userId, session, randomUUID(), at(hoursAgo), conceptId])
    // Probed 60 hours ago in s1; the answer came an hour later, as a live match and as a cited archive message.
    await probe('s1', 60, 'probed')
    await turn('s1', 59, { matches: [match('probed', 'learner_evidence'), match('beside', 'learner_evidence')], taughtConceptIds: [] })
    await client.query(`INSERT INTO learning_semantic_index_messages VALUES('answer',$1),('before',$2),('same-day',$3),('later',$4)`, [at(59), at(61), at(50), at(5)])
    const cites = (id: string) => JSON.stringify({ demonstrated: [{ sourceId: id }], gaps: [] })
    const cite = (id: string) => client.query(`UPDATE learning_concept_assessment_cache SET assessment=$2::jsonb WHERE user_id=$1 AND concept_id='probed'`, [userId, cites(id)])
    await client.query(`INSERT INTO learning_concept_assessment_cache VALUES($1,'probed',$2::jsonb),($1,'beside',$2::jsonb)`, [userId, cites('answer')])
    const hours = async () => Object.fromEntries([...(await readReviewHistory(query, userId, now)).exposures].map(([id, d]) => [id, (now.getTime() - d.getTime()) / 3_600_000]))
    // The concept beside it, answered in the same turn and citing the same message, is exposed; the probed one is not.
    expect(await hours()).toEqual({ beside: 59 })
    // A message from before the probe, or after the answer turn (even the same day), is an exposure as usual.
    await cite('before'); expect(await hours()).toEqual({ beside: 59, probed: 61 })
    await cite('same-day'); expect(await hours()).toEqual({ beside: 59, probed: 50 })
    await cite('later'); expect(await hours()).toEqual({ beside: 59, probed: 5 })
    await cite('answer')
    // A later turn of the same session about the concept is ordinary evidence, not the answer.
    await turn('s1', 58, { matches: [match('probed', 'task_context')], taughtConceptIds: [] })
    expect(await hours()).toEqual({ beside: 59, probed: 58 })
    // So is another session's turn, even when it is the next thing that happened.
    await turn('s2', 57, { matches: [match('probed', 'learner_evidence')], taughtConceptIds: [] })
    expect(await hours()).toEqual({ beside: 59, probed: 57 })
    // A probe with no next turn has no answer: nothing is hidden by it.
    await probe('s3', 40, 'unanswered')
    await client.query(`INSERT INTO learning_semantic_index_messages VALUES('elsewhere',$1)`, [at(39)])
    await client.query(`INSERT INTO learning_concept_assessment_cache VALUES($1,'unanswered',$2::jsonb)`, [userId, cites('elsewhere')])
    expect((await hours()).unanswered).toBe(39)
  })

  test('a probed concept counts as offered for 24 hours: it is not re-exposed as a review on the next turn', async () => {
    await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,injected,probe_concept_id,probe_outcome)
      VALUES($1,'s1',$2,'m',true,'v','{}'::jsonb,$3,true,'asked','delivered'),($1,'s1',$4,'m',true,'v','{}'::jsonb,$5,true,'asked-long-ago','delivered')`, [userId, randomUUID(), at(3), randomUUID(), at(30)])
    await turn('s2', 2, { matches: [], taughtConceptIds: [] }, 'reviewed')
    expect([...(await readReviewHistory(query, userId, now)).offered].sort()).toEqual(['asked', 'reviewed'])
  })

  test('the probe analysis scores the answer turn only, by concept, split by what was met before the holdout and by probe index', async () => {
    const holdoutStart = at(100)
    let clock = 90
    const row = async (session: string, feedback: unknown, probe: [string, 'held_out' | 'taught'] | null = null, hoursAgo = clock--, targets: string[] = []) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,probe_concept_id,probe_outcome,probe_arm,guidance_concept_ids)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$5,true,$6,$7,$8,$9)`, [userId, session, randomUUID(), feedback === null ? null : JSON.stringify(feedback), at(hoursAgo), probe?.[0] ?? null, probe ? 'delivered' : null, probe?.[1] ?? null, targets])
    const none = { matches: [], taughtConceptIds: [] }
    const evidence = (conceptId: string, outcome: string) => ({ matches: [{ ...match(conceptId, 'learner_evidence'), outcome }], taughtConceptIds: [] })
    // Before the holdout: `old` was taught, `seen` was matched, `named` was only mentioned.
    await row('pre', { matches: [match('seen', 'task_context'), match('named', 'mention')], taughtConceptIds: ['old'] }, null, 200)
    // Taught arm, concept `old`: no answer on the answer turn; it is taught after that and demonstrated two turns later. Not a success.
    await row('a', none, ['old', 'taught']); await row('a', none); await row('a', { matches: [], taughtConceptIds: ['old'] }); await row('a', evidence('old', 'demonstrated'))
    // Taught arm, concept `fresh`, probed four times: demonstrated, partial, demonstrated, partial.
    for (const outcome of ['demonstrated', 'partial', 'demonstrated', 'partial']) { const s = `b-${clock}`; await row(s, none, ['fresh', 'taught']); await row(s, evidence('fresh', outcome)) }
    // Taught arm, concept `named`, probed three times, demonstrated each time. A bare mention before the holdout is not "met".
    for (let i = 0; i < 3; i++) { const s = `c-${clock}`; await row(s, none, ['named', 'taught']); await row(s, evidence('named', 'demonstrated')) }
    // Taught arm, concept `leaked`: a teaching target earlier in the same session, then probed.
    await row('g', none, null, clock--, ['leaked']); await row('g', none, ['leaked', 'taught']); await row('g', evidence('leaked', 'demonstrated'))
    // Taught arm, concept `wrong`: the answer shows a misconception. Answered, not demonstrated.
    await row('h', none, ['wrong', 'taught'], 95); await row('h', { matches: [{ ...match('wrong', 'misconception'), outcome: 'not_assessed' }], taughtConceptIds: [] }, null, 94)
    // `fresh` was taught to ANOTHER learner before the holdout, and to this one at the instant it started. Neither is "met before".
    await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at) VALUES('someone-else','y',$1,'m',true,'v','{"matches":[],"taughtConceptIds":["fresh"]}'::jsonb,$2)`, [randomUUID(), at(200)])
    await row('at-start', { matches: [], taughtConceptIds: ['fresh'] }, null, 100)
    // Held-out arm: `seen` answered but not demonstrated; `quiet` has no next turn; `begun` has one that was never submitted; `told` was explained instead of asked.
    await row('i', none, ['begun', 'held_out']); await row('i', null)
    await row('d', none, ['seen', 'held_out']); await row('d', evidence('seen', 'partial'))
    await row('e', none, ['quiet', 'held_out'])
    await row('f', none, ['told', 'held_out']); await row('f', { ...evidence('told', 'demonstrated'), taughtConceptIds: ['told'] })
    // Another learner's probes are not this learner's.
    await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome,probe_arm) VALUES('someone-else','x',$1,'m',true,'v','{}'::jsonb,$2,'fresh','delivered','taught')`, [randomUUID(), at(50)])
    const round = (x: number | null) => x === null ? null : Math.round(x * 1000) / 1000
    const rows = (await client.query(PROBE_ANALYSIS_SQL, [userId, holdoutStart])).rows
    for (const r of rows) expect(r.days_since_holdout === null ? r.concepts === 0 : r.days_since_holdout > 0 && r.days_since_holdout < 100 / 24).toBe(true)
    const key = (r: Record<string, unknown>) => [r.arm, r.met_before, r.probe_index, r.concepts, r.probes, r.no_answer_probes, r.explained_probes, round(r.answered as number | null), round(r.demonstrated as number | null), round(r.sd_demonstrated as number | null)]
    expect(rows.map(key)).toEqual([
      // Not scored, by reason: two with no answer (no next turn; a next turn never submitted), one explained.
      ['held_out', false, '1', 0, 0, 2, 1, null, null, null],
      ['held_out', true, '1', 1, 1, 0, 0, 1, 0, null],
      // Four concepts, all answered (a misconception is an answer), three demonstrated.
      ['taught', false, '1', 4, 4, 0, 0, 1, 0.75, 0.5],
      ['taught', false, '2', 2, 2, 0, 0, 1, 0.5, 0.707],
      // Two concepts, three probes: the mean of the concepts' rates (0.5 and 1), not of the probes (2 of 3).
      ['taught', false, '3+', 2, 3, 0, 0, 1, 0.75, 0.354],
      ['taught', true, '1', 1, 1, 0, 0, 0, 0, null],
    ])
    // The first probe of a concept comes earlier than its later ones.
    const days = Object.fromEntries(rows.filter((r) => r.arm === 'taught' && !r.met_before).map((r) => [r.probe_index, r.days_since_holdout]))
    expect(days['1'] < days['3+']).toBe(true)

    // Sensitivity: split by whether the agent had the concept in this session before the probe.
    const leak = (await client.query(PROBE_LEAK_SQL, [userId])).rows.map((r) => [r.arm, r.seen_in_session, r.concepts, r.probes, r.delivered_probes, round(r.demonstrated)])
    expect(leak).toEqual([
      ['held_out', false, 1, 1, 4, 0],
      ['taught', false, 4, 9, 9, 0.375],
      ['taught', true, 1, 1, 1, 1],
    ])
  })

  test('the rows behind the combined difference: one per arm, concept and probe index with a scored probe', async () => {
    const turnRow = (session: string, hoursAgo: number, feedback: unknown, probe: [string, string] | null = null) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome,probe_arm)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$6,$7,$8)`, [userId, session, randomUUID(), JSON.stringify(feedback), at(hoursAgo), probe?.[0] ?? null, probe ? 'delivered' : null, probe?.[1] ?? null])
    const shown = (id: string, outcome: string) => ({ matches: [{ ...match(id, 'learner_evidence'), outcome }], taughtConceptIds: [] })
    await turnRow('a', 50, {}, ['t', 'taught']); await turnRow('a', 49, shown('t', 'demonstrated'))
    await turnRow('b', 40, {}, ['t', 'taught']); await turnRow('b', 39, shown('t', 'partial'))
    await turnRow('c', 30, {}, ['h', 'held_out']); await turnRow('c', 29, shown('h', 'demonstrated'))
    await turnRow('d', 20, {}, ['unanswered', 'held_out'])
    const rows = (await client.query(PROBE_CONCEPTS_SQL, [userId, at(100)])).rows
    expect(rows.map((r) => [r.arm, r.concept_id, r.met_before, r.probe_index, r.demonstrated, Math.round(r.days_since_holdout * 24)])).toEqual([
      ['held_out', 'h', false, '1', 1, 70], ['taught', 't', false, '1', 1, 50], ['taught', 't', false, '2', 0, 60]])
  })

  test('a mastery reading answers a probe only when its evidence is the answer: after the probe, by the answer turn, and the probe is scored', async () => {
    const turnRow = (user: string, session: string, hoursAgo: number, feedback: unknown, probed: string | null = null) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$6,$7)`, [user, session, randomUUID(), feedback === null ? null : JSON.stringify(feedback), at(hoursAgo), probed, probed ? 'delivered' : null])
    const hit = async (concept: string, hoursAgo: number, user = userId) => (await client.query(`SELECT ${probeAnswerEvidenceSql('$2::text', '$3::timestamptz')} AS hit`, [user, concept, at(hoursAgo)])).rows[0].hit
    await turnRow(userId, 's1', 60, {}, 'asked'); await turnRow(userId, 's1', 59, { matches: [], taughtConceptIds: [] }); await turnRow(userId, 's1', 58, { matches: [], taughtConceptIds: ['asked'] })
    // The answer is the message that begins the next turn. A minute's slack; nothing after that.
    expect([await hit('asked', 59.5), await hit('asked', 59), await hit('asked', 59 - 1 / 60)]).toEqual([true, true, true])
    // Not before the probe, not later the same day (the concept may have been taught by then), not another concept, not another learner.
    expect([await hit('asked', 61), await hit('asked', 58.9), await hit('asked', 50), await hit('other', 59.5), await hit('asked', 59.5, 'someone-else')]).toEqual([false, false, false, false, false])
    // A probe that is not scored has no answer: no next turn, a next turn never submitted, or explained instead of asked.
    await turnRow(userId, 's2', 40, {}, 'no-next')
    await turnRow(userId, 's3', 40, {}, 'unsubmitted'); await turnRow(userId, 's3', 39, null)
    await turnRow(userId, 's4', 40, {}, 'explained'); await turnRow(userId, 's4', 39, { matches: [], taughtConceptIds: ['explained'] })
    expect([await hit('no-next', 39.5), await hit('unsubmitted', 39.5), await hit('explained', 39.5)]).toEqual([false, false, false])
  })

  test('the injection analysis leaves probes out: turns that would deliver one, and evidence that answers one', async () => {
    let clock = 90
    type Row = { eligible?: boolean; injected?: boolean; mode?: string; probe?: string; probed?: string; evidence?: string[] }
    const row = (session: string, r: Row = {}) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,injection_eligible,injection_mode,injection_rate,probe_outcome,probe_concept_id)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$5,$6,$7,$8,40,$9,$10)`, [userId, session, randomUUID(),
      JSON.stringify({ matches: (r.evidence ?? []).map((id) => ({ ...match(id, 'learner_evidence'), outcome: 'demonstrated' })), taughtConceptIds: [] }),
      at(clock--), r.injected ?? false, r.eligible ?? false, r.mode ?? 'randomized', r.probe ?? null, r.probed ?? null])
    const e = (r: Row): Row => ({ eligible: true, ...r })
    // i1: injected, no probe possible. Two pieces of evidence in the next two turns.
    await row('i1', e({ injected: true, probe: 'arm_empty' })); await row('i1', { evidence: ['x'] }); await row('i1', { evidence: ['y'] })
    // i2: not injected; nothing follows. Later in the session a second eligible turn is injected and one piece follows it.
    await row('i2', e({ probe: 'not_drawn' })); await row('i2'); await row('i2', e({ injected: true, probe: 'not_drawn' })); await row('i2', { evidence: ['w'] })
    // i3 and i4: the turn would deliver a probe if injected. Compared in neither arm, whatever the coin said.
    await row('i3', e({ injected: true, probe: 'delivered', probed: 'p' })); await row('i3', { evidence: ['p', 'other'] })
    await row('i4', e({ probe: 'not_injected' })); await row('i4', { evidence: ['z'] })
    // i5: injected, no probe; the NEXT turn delivers a probe of q, and the turn after that answers it and shows z.
    await row('i5', e({ injected: true, probe: 'no_target' })); await row('i5', e({ injected: true, probe: 'delivered', probed: 'q' })); await row('i5', { evidence: ['q', 'z'] })
    // i6: decided by the quota. Not part of the experiment.
    await row('i6', e({ injected: true, mode: 'quota' })); await row('i6', { evidence: ['x'] })
    // i7: two injected eligible turns in one session. The first is followed by one piece, the second by two.
    await row('i7', e({ injected: true })); await row('i7', { evidence: ['a'] }); await row('i7', e({ injected: true })); await row('i7', { evidence: ['b', 'c'] })
    const round = (x: number | null) => x === null ? null : Math.round(x * 1000) / 1000
    const read = async (unit: 'turn' | 'session') => (await client.query(injectionAnalysisSql(unit), [userId, 2])).rows.map((r) => [r.injection_rate, r.arm, r.units, r.sessions, round(r.evidence_per_unit), round(r.se_clustered)])
    // Turns: not injected = i2's first (0). Injected = i1 (2), i2's second (1), i5's first (1: z, not the probe answer q), i7's two (1 and 2).
    // The standard error treats i7's two turns as one cluster: 0.196, where five independent turns would give 0.245.
    expect(await read('turn')).toEqual([[40, false, 1, 1, 0, null], [40, true, 5, 4, 1.4, 0.196]])
    // Sessions: the first eligible turn only, so i2's and i7's second turns are not compared.
    expect(await read('session')).toEqual([[40, false, 1, 1, 0, null], [40, true, 3, 3, 1.333, 0.333]])
  })

  test('offered reviews: any session, within 24 hours only', async () => {
    await turn('s1', 2, { matches: [], taughtConceptIds: [] }, 'recent')
    await turn('s2', 23, { matches: [], taughtConceptIds: [] }, 'yesterday')
    await turn('s3', 25, { matches: [], taughtConceptIds: [] }, 'stale')
    const history = await readReviewHistory(query, userId, now)
    expect([...history.offered].sort()).toEqual(['recent', 'yesterday'])
    expect(history.exposures.size).toBe(0)
  })

  test('decideTurnInjection stores the review once, and none for a turn it does not inject', async () => {
    const session = 'decide'
    const insert = async () => {
      const turnId = randomUUID()
      await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,created_at) VALUES($1,$2,$3,'m',true,'v',clock_timestamp())`, [userId, session, turnId])
      return { userId, sessionId: session, turnId }
    }
    const first = await insert()
    expect(await decideTurnInjection(query, first, true, 20, 'concept-a')).toBe(true)
    expect(await decideTurnInjection(query, first, true, 20, 'concept-b')).toBe(true)
    const second = await insert()
    expect(await decideTurnInjection(query, second, true, 20, 'concept-c')).toBe(false)
    const rows = (await client.query(`SELECT turn_id, injected, review_concept_id FROM learning_live_feedback_turns WHERE user_id=$1 ORDER BY created_at`, [userId])).rows
    expect(rows.map((row) => [row.injected, row.review_concept_id])).toEqual([[true, 'concept-a'], [false, null]])
  })
})
