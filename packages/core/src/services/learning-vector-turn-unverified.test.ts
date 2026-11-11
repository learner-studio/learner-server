import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { metaDbQuery } from '../lib/db-metadata/_shared.js'
import { LearningVectorTurnService } from './learning-vector-turn-service.js'

/**
 * The health check counts passes that graded without some indexed chunks from
 * `unverified_chunks`, a column mirroring counts.unverifiedChunks outside the large
 * TOASTed snapshot (reading the snapshot took 5.6 s on dev). This is the write.
 * Rows on learner_test carry a fixture user id of their own and are removed after.
 */
describe.skipIf(!process.env.TEST_DATABASE_URL)('a pass snapshot mirrors its unverified chunk count', () => {
  const user = `unverified-write-${randomUUID()}`
  afterAll(async () => { await metaDbQuery('DELETE FROM learning_vector_turn_experiments WHERE user_id=$1', [user]) })
  // Evidence selection is the service's own (and heavy); only the snapshot write is under test here.
  class Fixed extends LearningVectorTurnService {
    constructor(private readonly counts: Record<string, unknown>) { super(null as never, null as never, null as never) }
    override async selectEvidence() { return { messages: [], selections: [], metadata: {}, counts: { messages: 0, chunks: 3, turns: 0, unpaired: 0, ...this.counts }, batches: [] } as never }
  }
  const prepared = async (counts: Record<string, unknown>) => {
    const runId = randomUUID()
    await metaDbQuery(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,config) VALUES($1,$2,'{"purpose":"live","concurrency":1}')`, [runId, user])
    await new Fixed(counts).prepare(runId)
    return (await metaDbQuery<{ unverified_chunks: number; status: string }>('SELECT unverified_chunks,status FROM learning_vector_turn_experiments WHERE run_id=$1', [runId])).rows[0]
  }
  test('two unverified chunks are written as 2, beside the snapshot', async () => {
    expect(await prepared({ unverifiedChunks: 2, unverifiedChunkIds: ['a', 'b'] })).toEqual({ unverified_chunks: 2, status: 'running' })
  })
  test('a fully verified pass writes 0', async () => {
    expect(await prepared({})).toEqual({ unverified_chunks: 0, status: 'running' })
  })
})
