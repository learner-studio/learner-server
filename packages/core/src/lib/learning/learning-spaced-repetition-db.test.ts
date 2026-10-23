import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { readReviewHistory } from './learning-spaced-repetition.js'
import { decideTurnInjection } from './learning-intervention-policy.js'

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
