import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { readReviewHistory } from './learning-spaced-repetition.js'
import { decideTurnInjection, injectionAnalysisSql } from './learning-intervention-policy.js'
import { PROBE_ANALYSIS_SQL, PROBE_LEAK_SQL, PROBE_ROWS_SQL, probeAnswerEvidenceSql, probeDifference } from './learning-blind-probes.js'

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
    // Before the holdout: `old` was taught, `seen` was matched, `wrong` was a misconception, `named` was only mentioned.
    await row('pre', { matches: [match('seen', 'task_context'), match('wrong', 'misconception'), match('named', 'mention')], taughtConceptIds: ['old'] }, null, 200)
    // A probe of `fresh` from before the holdout started is not part of the analysis and does not count towards its probe index.
    await row('early', none, ['fresh', 'taught'], 150); await row('early', none, null, 149)
    // Taught arm, concept `old`: no answer on the answer turn; it is taught after that and demonstrated two turns later. Not a success.
    await row('a', none, ['old', 'taught']); await row('a', none); await row('a', { matches: [], taughtConceptIds: ['old'] }); await row('a', evidence('old', 'demonstrated'))
    // Taught arm, concept `fresh`, probed four times: demonstrated, partial, demonstrated, partial.
    for (const outcome of ['demonstrated', 'partial', 'demonstrated', 'partial']) { const s = `b-${clock}`; await row(s, none, ['fresh', 'taught']); await row(s, evidence('fresh', outcome)) }
    // Taught arm, concept `named`, probed three times, demonstrated each time. A bare mention before the holdout is not "met".
    for (let i = 0; i < 3; i++) { const s = `c-${clock}`; await row(s, none, ['named', 'taught']); await row(s, evidence('named', 'demonstrated')) }
    // Taught arm, concept `leaked`: a teaching target earlier in the same session, then probed.
    await row('g', none, null, clock--, ['leaked']); await row('g', none, ['leaked', 'taught']); await row('g', evidence('leaked', 'demonstrated'))
    // Taught arm, concept `just-told`: the agent's reply right before the probe explained it. That is reported on the probe turn itself.
    await row('j', none, null, 97); await row('j', { matches: [], taughtConceptIds: ['just-told'] }, ['just-told', 'taught'], 96.5); await row('j', evidence('just-told', 'demonstrated'), null, 96)
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
    // Days are over scored probes: a row with none has none, and every other row lies inside the holdout.
    for (const r of rows) expect(r.concepts === 0 ? r.days_since_holdout === null : r.days_since_holdout > 0 && r.days_since_holdout < 100 / 24).toBe(true)
    const key = (r: Record<string, unknown>) => [r.arm, r.met_before, r.probe_index, r.concepts, r.probes, r.no_answer_probes, r.explained_probes, round(r.answered as number | null), round(r.demonstrated as number | null), round(r.sd_demonstrated as number | null)]
    expect(rows.map(key)).toEqual([
      // Not scored, by reason: two with no answer (no next turn; a next turn never submitted), one explained.
      ['held_out', false, '1', 0, 0, 2, 1, null, null, null],
      ['held_out', true, '1', 1, 1, 0, 0, 1, 0, null],
      ['taught', false, '1', 4, 4, 0, 0, 1, 1, 0],
      ['taught', false, '2', 2, 2, 0, 0, 1, 0.5, 0.707],
      // Two concepts, three probes: the mean of the concepts' rates (0.5 and 1), not of the probes (2 of 3).
      ['taught', false, '3+', 2, 3, 0, 0, 1, 0.75, 0.354],
      // Met before: `old` (taught then) and `wrong` (a misconception then). One of the two answered (a misconception is an answer), neither demonstrated.
      ['taught', true, '1', 2, 2, 0, 0, 0.5, 0, 0],
    ])
    // The first probe of a concept comes earlier than its later ones.
    const days = Object.fromEntries(rows.filter((r) => r.arm === 'taught' && !r.met_before).map((r) => [r.probe_index, r.days_since_holdout]))
    expect(days['1'] < days['3+']).toBe(true)

    // Sensitivity: split by whether the agent already had the concept in this session when it asked:
    // `leaked` was an earlier turn's target, `just-told` was explained in the reply right before the probe.
    const leak = (await client.query(PROBE_LEAK_SQL, [userId, holdoutStart])).rows.map((r) => [r.arm, r.seen_in_session, r.concepts, r.probes, r.delivered_probes, round(r.demonstrated)])
    expect(leak).toEqual([
      ['held_out', false, 1, 1, 4, 0],
      ['taught', false, 4, 9, 9, 0.375],
      ['taught', true, 2, 2, 2, 1],
    ])
  })

  test('the rows behind the headline difference: one per delivered probe, with its status, index and the turn\'s candidate count', async () => {
    const turnRow = (session: string, hoursAgo: number, feedback: unknown, probe: [string | null, string] | null = null, turnId: string = randomUUID(), outcome = 'delivered') => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome,probe_arm,probe_held_out_candidates,probe_taught_candidates)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$6,$7,$8,$9,$10)`, [userId, session, turnId, JSON.stringify(feedback), at(hoursAgo), probe?.[0] ?? null, probe ? outcome : null, probe?.[1] ?? null, probe ? 2 : null, probe ? 7 : null])
    const shown = (id: string, outcome: string) => ({ matches: [{ ...match(id, 'learner_evidence'), outcome }], taughtConceptIds: [] })
    await turnRow('a', 50, {}, ['t', 'taught']); await turnRow('a', 49, shown('t', 'demonstrated'))
    await turnRow('b', 40, {}, ['t', 'taught']); await turnRow('b', 39, shown('t', 'partial'))
    await turnRow('c', 30, {}, ['h', 'held_out']); await turnRow('c', 29, shown('h', 'demonstrated'))
    await turnRow('d', 20, {}, ['unanswered', 'held_out'])
    await turnRow('e', 10, {}, ['told', 'held_out']); await turnRow('e', 9, { matches: [], taughtConceptIds: ['told'] })
    // A probe that was drawn but not delivered (the turn was not injected) stores its arm and counts, and is no probe here.
    await turnRow('f', 8, {}, [null, 'held_out'], randomUUID(), 'not_injected'); await turnRow('f', 7, shown('h', 'demonstrated'))
    const read = async () => (await client.query(PROBE_ROWS_SQL, [userId, at(100)])).rows
    const rows = await read()
    expect(rows.map((r) => [r.arm, r.concept_id, r.met_before, r.probe_index, r.status, r.demonstrated, r.candidates, Math.round(r.days_since_holdout * 24)])).toEqual([
      // Each turn had 2 held-out and 7 taught candidates: the pick was one of all 9, whatever the arm.
      ['taught', 't', false, 1, 'scored', true, 9, 50], ['taught', 't', false, 2, 'scored', false, 9, 60],
      ['held_out', 'h', false, 1, 'scored', true, 9, 70], ['held_out', 'unanswered', false, 1, 'no_answer', false, 9, 80], ['held_out', 'told', false, 1, 'explained', false, 9, 90]])
    // The rows are what probeDifference takes: here one scored concept per arm, which is not enough to compare.
    expect(probeDifference(rows, { reading: 'all' })).toMatchObject({ status: 'not_enough_data', deliveredInDroppedStrata: { held_out: 3, taught: 2 } })
    expect(probeDifference(rows)).toMatchObject({ reading: 'first', status: 'not_enough_data', deliveredInDroppedStrata: { held_out: 3, taught: 1 } })

    // Two turns begun at the same instant have one order: by turn id. The answer row is written FIRST and has the later id,
    // and of two probes of one concept at one instant the lower id is the first probe (here the one in the session that sorts last).
    const tie = at(5), early = '00000000-0000-4000-8000-000000000001', late = 'ffffffff-ffff-4fff-8fff-fffffffffff1'
    await turnRow('g', 5, shown('tied', 'demonstrated'), null, late); await turnRow('g', 5, {}, ['tied', 'taught'], early)
    await turnRow('0', 5, {}, ['tied', 'taught'], 'ffffffff-ffff-4fff-8fff-fffffffffff0')
    expect(tie).toBe(at(5))
    expect((await read()).filter((r) => r.concept_id === 'tied').map((r) => [r.probe_index, r.status, r.demonstrated]).sort()).toEqual([[1, 'scored', true], [2, 'no_answer', false]])
  })

  test('a mastery reading answers a probe only when its evidence is the answer: after the probe, by the answer turn, and the probe is scored', async () => {
    const turnRow = (user: string, session: string, hoursAgo: number, feedback: unknown, probed: string | null = null) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$6,$7)`, [user, session, randomUUID(), feedback === null ? null : JSON.stringify(feedback), at(hoursAgo), probed, probed ? 'delivered' : null])
    const hit = async (concept: string, hoursAgo: number, user = userId) => (await client.query(`SELECT ${probeAnswerEvidenceSql('$2::text', '$3::timestamptz')} AS hit`, [user, concept, at(hoursAgo)])).rows[0].hit
    await turnRow(userId, 's1', 60, {}, 'asked'); await turnRow(userId, 's1', 59, { matches: [], taughtConceptIds: [] }); await turnRow(userId, 's1', 58, { matches: [], taughtConceptIds: ['asked'] })
    // The answer is the message that begins the next turn. A minute's slack; nothing after that.
    expect([await hit('asked', 59.5), await hit('asked', 59), await hit('asked', 59 - 1 / 60)]).toEqual([true, true, true])
    // Not before the probe, not later the same day (the concept may have been taught by then), not another concept, not another learner.
    expect([await hit('asked', 61), await hit('asked', 60), await hit('asked', 58.9), await hit('asked', 50), await hit('other', 59.5), await hit('asked', 59.5, 'someone-else')]).toEqual([false, false, false, false, false, false])
    // A probe that is not scored has no answer: no next turn, a next turn never submitted, or explained instead of asked.
    await turnRow(userId, 's2', 40, {}, 'no-next'); await turnRow('someone-else', 's2', 39, { matches: [], taughtConceptIds: [] }) // another learner's turn under the same session id is not its answer turn
    await turnRow(userId, 's3', 40, {}, 'unsubmitted'); await turnRow(userId, 's3', 39, null)
    await turnRow(userId, 's4', 40, {}, 'explained'); await turnRow(userId, 's4', 39, { matches: [], taughtConceptIds: ['explained'] })
    expect([await hit('no-next', 39.5), await hit('unsubmitted', 39.5), await hit('explained', 39.5)]).toEqual([false, false, false])
    // Same order as the analysis: of two turns begun at the same instant the later turn id is the answer turn.
    const insert = (turnId: string, feedback: unknown, probed: string | null) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome)
      VALUES($1,'s5',$2,'m',true,'v',$3::jsonb,$4,$5,$6)`, [userId, turnId, JSON.stringify(feedback), at(30), probed, probed ? 'delivered' : null])
    await insert('ffffffff-ffff-4fff-8fff-fffffffffff2', { matches: [], taughtConceptIds: [] }, null); await insert('00000000-0000-4000-8000-000000000002', {}, 'tied')
    await turnRow(userId, 's5', 20, { matches: [], taughtConceptIds: ['tied'] })
    expect([await hit('tied', 30 - 1 / 60), await hit('tied', 29)]).toEqual([true, false])
  })

  test('the table refuses a probe row whose shape contradicts its outcome', async () => {
    const insert = (columns: string, values: string) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,${columns}) VALUES($1,'shape',$2,'m',true,'v',${values})`, [userId, randomUUID()])
    const refused = async (columns: string, values: string) => {
      await client.query('SAVEPOINT shape')
      const error = await insert(columns, values).then(() => null, (e: Error) => e.message)
      await client.query('ROLLBACK TO SAVEPOINT shape')
      return error
    }
    // The picked concept's distance belongs to a delivered probe only.
    expect(await refused(`probe_outcome,probe_concept_hops`, `'not_injected',2`)).toContain('probe_concept_hops_check')
    expect(await refused(`probe_concept_hops`, `2`)).toContain('probe_concept_hops_check')
    // A failed lookup drew nothing: no arm, no counts.
    expect(await refused(`probe_outcome,probe_arm`, `'fail_open','taught'`)).toContain('probe_fail_open_check')
    expect(await refused(`probe_outcome,probe_taught_candidates`, `'fail_open',3`)).toContain('probe_fail_open_check')
    // The shapes the code writes are accepted.
    expect(await refused(`probe_outcome,probe_arm,probe_concept_id,probe_concept_hops`, `'delivered','taught','c',2`)).toBeNull()
    expect(await refused(`probe_outcome,probe_rate,probe_hops`, `'fail_open',20,2`)).toBeNull()
    expect(await refused(`probe_outcome,probe_arm,probe_held_out_candidates,probe_taught_candidates`, `'not_injected','held_out',1,4`)).toBeNull()
  })

  test('the injection analysis leaves probes out: turns that would deliver one, and evidence that answers one', async () => {
    let clock = 90
    type Row = { eligible?: boolean; injected?: boolean; mode?: string; probe?: string; probed?: string; evidence?: string[]; unassessed?: string[] }
    const row = (session: string, r: Row = {}) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,injection_eligible,injection_mode,injection_rate,probe_outcome,probe_concept_id)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$5,$6,$7,$8,40,$9,$10)`, [userId, session, randomUUID(),
      JSON.stringify({ matches: [...(r.evidence ?? []).map((id) => ({ ...match(id, 'learner_evidence'), outcome: 'demonstrated' })), ...(r.unassessed ?? []).map((id) => ({ ...match(id, 'learner_evidence'), outcome: 'not_assessed' }))], taughtConceptIds: [] }),
      at(clock--), r.injected ?? false, r.eligible ?? false, r.mode ?? 'randomized', r.probe ?? null, r.probed ?? null])
    const e = (r: Row): Row => ({ eligible: true, ...r })
    // i1: injected, no probe possible. Two pieces of evidence in the next two turns.
    await row('i1', e({ injected: true, probe: 'arm_empty' })); await row('i1', { evidence: ['x'], unassessed: ['said-not-shown'] }); await row('i1', { evidence: ['y'] })
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
    // i8: the session's first eligible turn would deliver a probe; a later eligible turn is not injected and one piece follows it.
    await row('i8', e({ injected: true, probe: 'delivered', probed: 'r' })); await row('i8', { evidence: ['r', 's'] }); await row('i8', e({ probe: 'not_drawn' })); await row('i8', { evidence: ['u'] })
    // i9b: injected; its next turn shows z9. Between the two, ANOTHER session (i9a) delivers a probe of z9: that is not this session's probe.
    await row('i9b', e({ injected: true, probe: 'no_target' })); await row('i9a', e({ injected: true, probe: 'delivered', probed: 'z9' })); await row('i9b', { evidence: ['z9'] })
    // i10: the session's first eligible turn was decided by the quota; its second by the coin.
    await row('i10', e({ injected: true, mode: 'quota' })); await row('i10', { evidence: ['x'] }); await row('i10', e({ injected: true })); await row('i10', { evidence: ['v'] })
    const round = (x: number | null) => x === null ? null : Math.round(x * 1000) / 1000
    const read = async (unit: 'turn' | 'session') => (await client.query(injectionAnalysisSql(unit), [userId, 2])).rows.map((r) => [r.injection_rate, r.arm, r.units, r.sessions, round(r.evidence_per_unit), round(r.se_clustered)])
    // Turns. Not injected: i2's first (0), i8's second (1).
    // Injected: i1 (2: evidence said but not assessed is not counted), i2's second (1), i5's first (1: z, not the probe answer q),
    // i7's two (1 and 2), i9b (1: z9 answers no probe of its own session), i10's second (1).
    // The standard error treats i7's two turns as one cluster: 0.158, where seven independent turns would give 0.184.
    expect(await read('turn')).toEqual([[40, false, 2, 2, 0.5, 0.5], [40, true, 7, 6, 1.286, 0.158]])
    // Sessions: the first eligible turn only, and only if the coin decided it and it could not deliver a probe.
    // So i2's, i7's and i10's second turns are not compared, and neither are i8 (a probe turn first) and i10 (a quota turn first).
    expect(await read('session')).toEqual([[40, false, 1, 1, 0, null], [40, true, 4, 4, 1.25, 0.25]])
  })

  test('offered reviews: any session, within 24 hours only', async () => {
    await turn('s1', 2, { matches: [], taughtConceptIds: [] }, 'recent')
    await turn('s2', 23, { matches: [], taughtConceptIds: [] }, 'yesterday')
    await turn('s3', 25, { matches: [], taughtConceptIds: [] }, 'stale')
    const history = await readReviewHistory(query, userId, now)
    expect([...history.offered].sort()).toEqual(['recent', 'yesterday'])
    expect(history.exposures.size).toBe(0)
  })

  test('decideTurnInjection stores the review, the text and the targets once, and none for a turn it does not inject', async () => {
    const session = 'decide'
    const insert = async () => {
      const turnId = randomUUID()
      await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,created_at) VALUES($1,$2,$3,'m',true,'v',clock_timestamp())`, [userId, session, turnId])
      return { userId, sessionId: session, turnId }
    }
    const first = await insert()
    const decided = { injected: true, context: 'first text', conceptIds: ['t'] }
    expect(await decideTurnInjection(query, first, true, 20, 'concept-a', false, null, ['t'], 'first text')).toEqual(decided)
    // A replay with different inputs answers the stored decision, text and targets.
    expect(await decideTurnInjection(query, first, true, 20, 'concept-b', false, null, ['u'], 'second text')).toEqual(decided)
    const second = await insert()
    expect(await decideTurnInjection(query, second, true, 20, 'concept-c', false, null, ['t'], 'text')).toEqual({ injected: false, context: null, conceptIds: [] })
    const rows = (await client.query(`SELECT turn_id, injected, review_concept_id FROM learning_live_feedback_turns WHERE user_id=$1 ORDER BY created_at`, [userId])).rows
    expect(rows.map((row) => [row.injected, row.review_concept_id])).toEqual([[true, 'concept-a'], [false, null]])
  })
})
