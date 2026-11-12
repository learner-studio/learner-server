import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { LLMService } from '@learner/llm/services/llm-service.js'
import { metaDbQuery as q } from '../db-metadata/_shared.js'
import { bindDatabase, createDatabase } from '../../db/handle.js'
import { ownTestDatabaseUrl } from '../../db/own-test-database.js'
import { LocalVariablesService } from '../../runtime/types.js'
import { ASSESSMENT_MODEL, assessmentHash, buildConceptAssessmentInput } from './learning-concept-assessment.js'
import { executeIncrementCall } from './learning-incremental-grading-store.js'

// The experiment executors share the reactive grading's fence (driveAssessmentRun, restart-safety.md). The state a
// worker killed mid-call leaves behind is a reservation with no receipt and no live lease owner: on a repeat-free
// backend the next delivery finishes it (one call, one receipt, a takeover row); on a metered one it pays nothing
// and stays 'uncertain'. The kill itself is exercised for the same mechanism in runtime-pikku/tests/restart-recovery.
// Its own migrated database (the lease tables are newer than a shared test database may be); this file's process only.
const url = await ownTestDatabaseUrl('incgrade')
if (url) bindDatabase(createDatabase(url, { max: 2, applicationName: 'learner-test-incgrade' }))
describe.skipIf(!url)('experiment call after a restart (learner_incgrade_test_<checkout>)', () => {
  // Assessment rows are immutable (a trigger refuses deletes): every id is random, so runs never collide.
  afterAll(() => { delete process.env.LEARNER_METERED_BACKENDS })
  class Counting extends LLMService {
    calls = 0
    constructor(private readonly answer: unknown) { super(new LocalVariablesService()) }
    override async callLLMWithStructuredOutput(): Promise<never> { this.calls++; return this.answer as never }
  }
  /** An increment call whose worker died after reserving it: reserved an hour ago, no receipt, no lease. */
  const orphaned = async () => {
    const conceptId = `restart-${randomUUID().slice(0, 8)}`
    const evidence = [{ id: 'm1', conversationId: 'c', role: 'user', text: 'I explained the synthetic concept.', occurredAt: null }]
    const built = buildConceptAssessmentInput({ conceptId, title: 'Synthetic', description: 'Synthetic', objectives: [] }, evidence, null)
    const runId = `incgrade-restart-${randomUUID()}`
    await q(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,'restart-test',$1,$2,$3,$4,$5::jsonb)`,
      [runId, conceptId, built.nodeVersion, `${built.inputHash}-${runId}`, JSON.stringify({ ...built, evidence, callKind: 'increment', experimentId: 'restart-test', model: ASSESSMENT_MODEL })])
    await q(`INSERT INTO learning_concept_assessment_attempts(run_id,scope_key,reserved_at) VALUES($1,$2,now() - interval '1 hour')`, [runId, assessmentHash(['incgrade', runId])])
    const answer = [{ conceptId, nodeVersion: built.nodeVersion, understandingPercent: 40, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: true }]
    return { runId, answer }
  }
  const reclaims = async (runId: string) => (await q<{ action: string }>('SELECT action FROM learning_llm_attempt_reclaims WHERE attempt_key=$1', [`assessment:${runId}`])).rows.map((r) => r.action)

  test('repeat-free backend: the orphaned call is finished once, recorded once, and audited as a takeover', async () => {
    const { runId, answer } = await orphaned()
    const llm = new Counting(answer)
    expect(await executeIncrementCall(runId, llm)).toEqual({ runId, status: 'completed' })
    expect(await executeIncrementCall(runId, llm)).toEqual({ runId, status: 'completed' })
    expect(llm.calls).toBe(1)
    expect(await reclaims(runId)).toEqual(['takeover'])
  })

  test('metered backend: the orphaned call is never paid again and answers uncertain', async () => {
    const { runId, answer } = await orphaned()
    process.env.LEARNER_METERED_BACKENDS = ASSESSMENT_MODEL.backend
    try {
      const llm = new Counting(answer)
      expect(await executeIncrementCall(runId, llm)).toEqual({ runId, status: 'uncertain' })
      expect(llm.calls).toBe(0)
      expect(await reclaims(runId)).toEqual(['refused']) // no receipt is written: the refusal row says why
    } finally { delete process.env.LEARNER_METERED_BACKENDS }
  })
})
