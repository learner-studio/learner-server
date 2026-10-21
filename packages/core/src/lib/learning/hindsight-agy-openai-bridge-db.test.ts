import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { healthcheck, query, withClient } from '../../db.js'
import { bridgeRequestIdentity } from './hindsight-agy-openai-bridge.js'

const pgReachable = await healthcheck().then(result => result.ok).catch(() => false)
const tablePresent = pgReachable
  ? await query<{ present: boolean }>("SELECT to_regclass('public.learning_hindsight_agy_bridge_requests') IS NOT NULL AS present")
      .then(result => result.rows[0]?.present === true)
  : false

test('Postgres operation lock admits at most one novel request at a one-call budget and exact replay is stable', {
  skip: !tablePresent,
}, async () => {
  const experimentId = `bridge-race-${randomUUID()}`
  const operationId = 'retain'
  const first = bridgeRequestIdentity({ model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'first' }] }, experimentId, operationId)
  const second = bridgeRequestIdentity({ model: 'gemini-3.7-flash', messages: [{ role: 'user', content: 'second' }] }, experimentId, operationId)

  const reserve = async (identity: typeof first): Promise<'inserted' | 'exhausted'> => withClient(async client => {
    await client.query('BEGIN')
    try {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${experimentId}\n${operationId}`])
      const count = await client.query<{ calls: string }>(
        'SELECT COUNT(*)::text AS calls FROM learning_hindsight_agy_bridge_requests WHERE experiment_id=$1 AND operation_id=$2',
        [experimentId, operationId],
      )
      if (Number(count.rows[0]?.calls) >= 1) {
        await client.query('ROLLBACK')
        return 'exhausted'
      }
      await client.query(
        `INSERT INTO learning_hindsight_agy_bridge_requests
          (request_id,experiment_id,operation_id,operation_call_budget,request_sha256,status,backend,requested_model,
           requested_effort,timeout_seconds,attempt_limit,max_output_tokens_enforced,temperature_enforced,request_body)
         VALUES ($1,$2,$3,1,$4,'running','agy','gemini-3.7-flash','high',420,1,false,false,'{}'::jsonb)`,
        [identity.requestId, experimentId, operationId, identity.requestHash],
      )
      await client.query('COMMIT')
      return 'inserted'
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    }
  })

  try {
    const outcomes = await Promise.all([reserve(first), reserve(second)])
    assert.deepEqual([...outcomes].sort(), ['exhausted', 'inserted'])
    const rows = await query<{ requestId: string; status: string; requestSha256: string }>(
      'SELECT request_id,status,request_sha256 FROM learning_hindsight_agy_bridge_requests WHERE experiment_id=$1 AND operation_id=$2',
      [experimentId, operationId],
    )
    assert.equal(rows.rows.length, 1)
    const winner = rows.rows[0]!
    assert.equal(winner.status, 'running')

    const response = { id: 'cached', object: 'chat.completion' }
    await query(
      `UPDATE learning_hindsight_agy_bridge_requests
          SET status='completed',response_body=$2::jsonb,completed_at=NOW()
        WHERE request_id=$1 AND status='running'`,
      [winner.requestId, JSON.stringify(response)],
    )
    const replay = await query<{ requestSha256: string; responseBody: unknown }>(
      'SELECT request_sha256,response_body FROM learning_hindsight_agy_bridge_requests WHERE request_id=$1',
      [winner.requestId],
    )
    assert.equal(replay.rows[0]?.requestSha256, winner.requestSha256)
    assert.deepEqual(replay.rows[0]?.responseBody, response)
  } finally {
    await query('DELETE FROM learning_hindsight_agy_bridge_requests WHERE experiment_id=$1', [experimentId])
  }
})
