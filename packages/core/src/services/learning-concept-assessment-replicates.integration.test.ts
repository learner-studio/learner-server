import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { LLMService } from '@learner/llm/services/llm-service.js'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import type { QueryFn } from '../db/handle.js'
import { LocalVariablesService } from '../runtime/types.js'
import { ASSESSMENT_MODEL, buildConceptAssessmentInput } from '../lib/learning/learning-concept-assessment.js'
import { persistAssessmentCache } from '../lib/learning/learning-assessment-persistence.js'
import { LearningConceptAssessmentService } from './learning-concept-assessment.js'
import { LearningCurriculumStore } from './learning-curriculum-store.js'

// Replicate grading (docs/specs/mastery-change-statistics.md, part B) on learner_test, each test in a
// transaction that is rolled back. The model is a fake that answers a scripted percent and confidence
// and counts its (paid) calls.
describe.skipIf(!process.env.TEST_DATABASE_URL)('replicate grading (learner_test)', () => {
  let client: Client
  let query: QueryFn
  let userId: string
  let conceptId: string

  class Scripted extends LLMService {
    calls = 0
    constructor(private readonly answers: Array<{ percent: number | null; confidence: 'insufficient' | 'low' | 'medium' | 'high' }>, private readonly nodeVersion: () => string) { super(new LocalVariablesService()) }
    override async callLLMWithStructuredOutput(input: Parameters<LLMService['callLLMWithStructuredOutput']>[0]) {
      const a = this.answers[this.calls++]!
      input.callOptions?.onUsage?.({ inputTokens: 1000, outputTokens: 100 })
      return [{ conceptId, nodeVersion: this.nodeVersion(), understandingPercent: a.percent, confidence: a.confidence, demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: true }] as never
    }
  }

  beforeEach(async () => {
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    await client.query('BEGIN')
    query = (async (text: string, params?: ReadonlyArray<unknown>) => {
      const r = await client.query(text, params ? [...params] : [])
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    }) as QueryFn
    userId = `rep-${randomUUID()}`
    conceptId = `rep-${randomUUID().slice(0, 8)}`
    await query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind) VALUES($1,'T','s','e','x','d','c',0,0,'user')`, [conceptId])
  })
  afterEach(async () => { await client.query('ROLLBACK'); await client.end() })

  const setReplicates = (k: number) => query(`INSERT INTO learning_policy_settings(config_key,settings,updated_by,updated_at) VALUES('default',$1::jsonb,'test',now())
    ON CONFLICT(config_key) DO UPDATE SET settings=EXCLUDED.settings`, [JSON.stringify({ ...DEFAULT_LEARNING_POLICY, gradingReplicates: k })])

  /** A prepared manual (live) run, as `prepare` leaves it: snapshot frozen, no receipt. */
  const manualRun = async (experimentId?: string) => {
    const concept = { conceptId, title: 'T', description: 's\ne', objectives: [] }
    const evidence = [{ id: 'm1', conversationId: 'c', role: 'user', text: 'I explained it.', occurredAt: '2026-10-01T12:00:00.000Z' }]
    const built = buildConceptAssessmentInput(concept, evidence, null)
    const runId = randomUUID()
    const snapshot = { ...built, evidence, prior: null, model: ASSESSMENT_MODEL, promptRevision: 'test', indexStartedAt: new Date().toISOString(), ...(experimentId ? { experimentId } : {}) }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,$2,$1,$3,$4,$5,$6::jsonb)`,
      [runId, userId, conceptId, built.nodeVersion, `${built.inputHash}-${runId}`, JSON.stringify(snapshot)])
    return { runId, concept, nodeVersion: built.nodeVersion }
  }
  const service = (llm: LLMService) => new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype), llm)
  const reading = async (runId: string) => (await query<{ understanding_percent: string; confidence: string; replicates: number; replicate_sd: string | null }>(
    'SELECT understanding_percent, confidence, replicates, replicate_sd FROM learning_mastery_readings WHERE run_id=$1', [runId])).rows[0]
  const cached = async () => (await query<{ assessment: Record<string, unknown> }>('SELECT assessment FROM learning_concept_assessment_cache WHERE user_id=$1 AND concept_id=$2', [userId, conceptId])).rows[0]?.assessment
  const receipt = async (runId: string) => (await query<{ receipt: { assessment: Record<string, unknown> } }>('SELECT receipt FROM learning_concept_assessment_receipts WHERE run_id=$1', [runId])).rows[0]!.receipt

  test('k = 1 (the default): no plan, one paid call, and the reading and cache are the grading itself', async () => {
    await setReplicates(1)
    const { runId, concept, nodeVersion } = await manualRun()
    const llm = new Scripted([{ percent: 40, confidence: 'medium' }], () => nodeVersion)
    const s = service(llm)
    expect(await s.planReplicates(runId, query)).toEqual({ runId, replicates: [] })
    expect(await s.execute(runId, query)).toEqual({ runId, status: 'completed' })
    expect(llm.calls).toBe(1)
    expect((await query('SELECT 1 FROM learning_concept_assessment_replicate_plans WHERE run_id=$1', [runId])).rowCount).toBe(0)
    expect(await reading(runId)).toEqual({ understanding_percent: '40', confidence: 'medium', replicates: 1, replicate_sd: null })
    const assessment = (await receipt(runId)).assessment
    await persistAssessmentCache(query, { userId, concept, nodeVersion, inputHash: 'h', runId, assessment: assessment as never, completedAt: new Date().toISOString() })
    // Byte-identical: the cache holds exactly the receipt's assessment.
    expect(JSON.stringify(await cached())).toBe(JSON.stringify((await query<{ a: unknown }>('SELECT $1::jsonb AS a', [JSON.stringify(assessment)])).rows[0]!.a))
  })

  test('k = 3: the reading stays unpublished until combined, then is the raw mean with its spread and the weakest confidence', async () => {
    await setReplicates(3)
    const { runId, concept, nodeVersion } = await manualRun()
    const llm = new Scripted([{ percent: 40, confidence: 'high' }, { percent: 55, confidence: 'medium' }, { percent: 50, confidence: 'high' }], () => nodeVersion)
    const s = service(llm)
    expect(await s.planReplicates(runId, query)).toEqual({ runId, replicates: [2, 3] })
    await s.execute(runId, query)
    expect(await reading(runId)).toBeUndefined() // planned, not combined: not a reading yet
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'completed' })
    expect(await s.executeReplicate(runId, 3, query)).toEqual({ runId, replicate: 3, status: 'completed' })
    expect(await reading(runId)).toBeUndefined()
    expect(await s.combineReplicates(runId, query)).toEqual({ runId, replicates: 3, meanPercent: 48.333333333333336 })
    expect(llm.calls).toBe(3)
    const r = (await reading(runId))!
    expect(Number(r.understanding_percent)).toBeCloseTo(145 / 3, 9)
    expect(r.confidence).toBe('medium') // high, medium, high → medium
    expect(r.replicates).toBe(3)
    expect(Number(r.replicate_sd)).toBeCloseTo(Math.sqrt(((40 - 145 / 3) ** 2 + (55 - 145 / 3) ** 2 + (50 - 145 / 3) ** 2) / 2), 9)
    // The cache publishes the grid value and the combined confidence.
    await persistAssessmentCache(query, { userId, concept, nodeVersion, inputHash: 'h', runId, assessment: (await receipt(runId)).assessment as never, completedAt: new Date().toISOString() })
    expect(await cached()).toMatchObject({ understandingPercent: 50, confidence: 'medium' })
    const cost = (await query<{ input_tokens: string; output_tokens: string }>('SELECT input_tokens, output_tokens FROM learning_concept_assessment_replicate_summaries WHERE run_id=$1', [runId])).rows[0]!
    expect([Number(cost.input_tokens), Number(cost.output_tokens)]).toEqual([3000, 300])
    // Replays change nothing and pay nothing.
    expect(await s.planReplicates(runId, query)).toEqual({ runId, replicates: [2, 3] })
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'completed' })
    expect(await s.combineReplicates(runId, query)).toEqual({ runId, replicates: 3, meanPercent: 48.333333333333336 })
    expect(llm.calls).toBe(3)
  })

  test('a replicate step killed during its model call is never paid again on replay', async () => {
    await setReplicates(3)
    const { runId, nodeVersion } = await manualRun()
    const llm = new Scripted([{ percent: 40, confidence: 'medium' }, { percent: 60, confidence: 'medium' }], () => nodeVersion)
    const s = service(llm)
    await s.planReplicates(runId, query)
    await s.execute(runId, query)
    // Replicate 2 was reserved and the process died before its receipt was written.
    await query('INSERT INTO learning_concept_assessment_replicates(run_id,replicate) VALUES($1,2)', [runId])
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'uncertain' })
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'uncertain' })
    expect(llm.calls).toBe(1)
    expect(await s.executeReplicate(runId, 3, query)).toEqual({ runId, replicate: 3, status: 'completed' })
    expect(llm.calls).toBe(2)
    // The reading is the mean of the gradings that have a number: 40 and 60.
    await s.combineReplicates(runId, query)
    expect(await reading(runId)).toMatchObject({ understanding_percent: '50', replicates: 2 })
  })

  test('nothing to replicate: a grading with no percent, or an experiment run, is graded once', async () => {
    await setReplicates(3)
    const { runId, nodeVersion } = await manualRun()
    const llm = new Scripted([{ percent: null, confidence: 'insufficient' }], () => nodeVersion)
    const s = service(llm)
    expect((await s.planReplicates(runId, query)).replicates).toEqual([2, 3])
    await s.execute(runId, query)
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'skipped' })
    await s.combineReplicates(runId, query)
    expect(llm.calls).toBe(1)
    expect(await reading(runId)).toMatchObject({ understanding_percent: null, confidence: 'insufficient', replicates: 1 })
    // An experiment run (an experimentId that is no live pass) is never planned.
    const exp = await manualRun(randomUUID())
    expect(await s.planReplicates(exp.runId, query)).toEqual({ runId: exp.runId, replicates: [] })
  })

  test('a live pass part is planned after its grading, until the pass completes; then never', async () => {
    await setReplicates(3)
    const pass = randomUUID()
    await query(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,config,status) VALUES($1,$2,'{"purpose":"live"}'::jsonb,'running')`, [pass, userId])
    const { runId, nodeVersion } = await manualRun(pass)
    const s = service(new Scripted([{ percent: 30, confidence: 'medium' }, { percent: 40, confidence: 'medium' }, { percent: 50, confidence: 'medium' }], () => nodeVersion))
    await s.execute(runId, query)
    expect(await s.planReplicates(runId, query)).toEqual({ runId, replicates: [2, 3] })
    const late = await manualRun(pass)
    await query(`UPDATE learning_vector_turn_experiments SET status='completed', finished_at=now() WHERE run_id=$1`, [pass])
    expect(await s.planReplicates(late.runId, query)).toEqual({ runId: late.runId, replicates: [] })
    // A manual run already graded (so already published) is never planned afterwards.
    const graded = await manualRun()
    await s.execute(graded.runId, query)
    expect(await s.planReplicates(graded.runId, query)).toEqual({ runId: graded.runId, replicates: [] })
  })
})
