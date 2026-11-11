import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { readReviewHistory } from './learning-spaced-repetition.js'
import { decideTurnInjection } from './learning-intervention-policy.js'
import { PROBE_ANALYSIS_SQL } from './learning-blind-probes.js'

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

  test('a blind probe\'s answer is not an exposure: neither the live match nor the message the assessment cites', async () => {
    const probe = (session: string, hoursAgo: number, conceptId: string) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,probe_concept_id,probe_outcome)
      VALUES($1,$2,$3,'m',true,'v','{"matches":[],"taughtConceptIds":[]}'::jsonb,$4,$4,true,$5,'delivered')`, [userId, session, randomUUID(), at(hoursAgo), conceptId])
    // Probed 30 hours ago in s1; the answer came an hour later, as a live match and as a cited archive message.
    await probe('s1', 30, 'probed')
    await turn('s1', 29, { matches: [match('probed', 'learner_evidence'), match('beside', 'learner_evidence')], taughtConceptIds: [] })
    await client.query(`INSERT INTO learning_semantic_index_messages VALUES('answer',$1),('before',$2),('later',$3)`, [at(29), at(31), at(5)])
    const cites = (id: string) => JSON.stringify({ demonstrated: [{ sourceId: id }], gaps: [] })
    await client.query(`INSERT INTO learning_concept_assessment_cache VALUES($1,'probed',$2::jsonb),($1,'beside',$2::jsonb)`, [userId, cites('answer')])
    const hours = async () => Object.fromEntries([...(await readReviewHistory(query, userId, now)).exposures].map(([id, d]) => [id, (now.getTime() - d.getTime()) / 3_600_000]))
    // The concept beside it, answered in the same turn and citing the same message, is exposed; the probed one is not.
    expect(await hours()).toEqual({ beside: 29 })
    // A message from before the probe, or from more than 24 hours after it, is an exposure as usual.
    await client.query(`UPDATE learning_concept_assessment_cache SET assessment=$2::jsonb WHERE user_id=$1 AND concept_id='probed'`, [userId, cites('before')])
    expect(await hours()).toEqual({ beside: 29, probed: 31 })
    await client.query(`UPDATE learning_concept_assessment_cache SET assessment=$2::jsonb WHERE user_id=$1 AND concept_id='probed'`, [userId, cites('later')])
    expect(await hours()).toEqual({ beside: 29, probed: 5 })
    // Another session's match for the probed concept is evidence the probe did not ask for: it counts.
    await turn('s2', 28, { matches: [match('probed', 'learner_evidence')], taughtConceptIds: [] })
    expect((await hours()).probed).toBe(5)
    await client.query(`UPDATE learning_concept_assessment_cache SET assessment=$2::jsonb WHERE user_id=$1 AND concept_id='probed'`, [userId, cites('answer')])
    expect(await hours()).toEqual({ beside: 29, probed: 28 })
  })

  test('the probe analysis scores the answer turn only, by concept, split by what was met before the holdout', async () => {
    const holdoutStart = at(100)
    let clock = 90
    const row = async (session: string, feedback: unknown, probe: [string, 'held_out' | 'taught'] | null = null, hoursAgo = clock--) => client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,submitted_at,injected,probe_concept_id,probe_outcome,probe_arm)
      VALUES($1,$2,$3,'m',true,'v',$4::jsonb,$5,$5,true,$6,$7,$8)`, [userId, session, randomUUID(), JSON.stringify(feedback), at(hoursAgo), probe?.[0] ?? null, probe ? 'delivered' : null, probe?.[1] ?? null])
    const none = { matches: [], taughtConceptIds: [] }
    const evidence = (conceptId: string, outcome: string) => ({ matches: [{ ...match(conceptId, 'learner_evidence'), outcome }], taughtConceptIds: [] })
    // Before the holdout: `old` was taught, `seen` was matched, `named` was only mentioned.
    await row('pre', { matches: [match('seen', 'task_context'), match('named', 'mention')], taughtConceptIds: ['old'] }, null, 200)
    // Taught arm, concept `old`: no answer on the answer turn; it is taught after that and demonstrated two turns later. Not a success.
    await row('a', none, ['old', 'taught']); await row('a', none); await row('a', { matches: [], taughtConceptIds: ['old'] }); await row('a', evidence('old', 'demonstrated'))
    // Taught arm, concept `fresh`, probed three times: demonstrated, partial, demonstrated. One concept, rate 2/3.
    for (const outcome of ['demonstrated', 'partial', 'demonstrated']) { const s = `b-${outcome}-${clock}`; await row(s, none, ['fresh', 'taught']); await row(s, evidence('fresh', outcome)) }
    // Taught arm, concept `named`: demonstrated on the answer turn. A bare mention before the holdout is not "met".
    await row('c', none, ['named', 'taught']); await row('c', evidence('named', 'demonstrated'))
    // Held-out arm: `seen` answered but not demonstrated; `quiet` has no next turn; `told` was explained instead of asked.
    await row('d', none, ['seen', 'held_out']); await row('d', evidence('seen', 'partial'))
    await row('e', none, ['quiet', 'held_out'])
    await row('f', none, ['told', 'held_out']); await row('f', { ...evidence('told', 'demonstrated'), taughtConceptIds: ['told'] })
    // Another learner's probes are not this learner's.
    await client.query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome,probe_arm) VALUES('someone-else','x',$1,'m',true,'v','{}'::jsonb,$2,'fresh','delivered','taught')`, [randomUUID(), at(50)])
    const round = (x: number | null) => x === null ? null : Math.round(x * 1000) / 1000
    const rows = (await client.query(PROBE_ANALYSIS_SQL, [userId, holdoutStart])).rows.map((r) => ({ ...r, demonstrated: round(r.demonstrated), sd_demonstrated: round(r.sd_demonstrated) }))
    expect(rows).toEqual([
      { arm: 'held_out', met_before: false, concepts: 0, probes: 0, unscored_probes: 2, answered: null, demonstrated: null, sd_demonstrated: null },
      { arm: 'held_out', met_before: true, concepts: 1, probes: 1, unscored_probes: 0, answered: 1, demonstrated: 0, sd_demonstrated: null },
      { arm: 'taught', met_before: false, concepts: 2, probes: 4, unscored_probes: 0, answered: 1, demonstrated: 0.833, sd_demonstrated: 0.236 },
      { arm: 'taught', met_before: true, concepts: 1, probes: 1, unscored_probes: 0, answered: 0, demonstrated: 0, sd_demonstrated: null },
    ])
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
