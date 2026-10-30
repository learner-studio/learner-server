import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { metaDbQuery } from '../lib/db-metadata/_shared.js'
import { LearningVectorTurnService } from './learning-vector-turn-service.js'

// Continuation must never reopen a completed pass: its readings are live notifications.
describe.skipIf(!process.env.TEST_DATABASE_URL)('vector-turn continuation (learner_test)', () => {
  const userId = `vtc-${randomUUID()}`
  const ids: string[] = []
  const passRow = async (status: string) => {
    const runId = randomUUID()
    ids.push(runId)
    await metaDbQuery(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,config,status,snapshot,finished_at) VALUES($1,$2,$3::jsonb,$4,$5::jsonb,now())`,
      [runId, userId, JSON.stringify({ purpose: 'live' }), status, JSON.stringify({ selections: [], metadata: {} })])
    return runId
  }
  const service = new LearningVectorTurnService(null as never, null as never, null as never)
  afterAll(async () => { await metaDbQuery('DELETE FROM learning_vector_turn_experiments WHERE run_id = ANY($1::uuid[])', [ids]) })

  test('a completed pass is refused and stays completed and finished', async () => {
    const runId = await passRow('completed')
    await expect(service.recordExecutionChange(runId, userId, randomUUID(), 1)).rejects.toThrow('continuation refused')
    const [row] = (await metaDbQuery<{ status: string; finished_at: Date | null }>('SELECT status, finished_at FROM learning_vector_turn_experiments WHERE run_id = $1', [runId])).rows
    expect(row).toMatchObject({ status: 'completed' })
    expect(row!.finished_at).not.toBeNull()
  })

  test('a partial pass gets past the guard (it then needs a terminal parent workflow)', async () => {
    const runId = await passRow('partial')
    await expect(service.recordExecutionChange(runId, userId, randomUUID(), 1)).rejects.toThrow('Previous parent must be terminal')
  })
})
