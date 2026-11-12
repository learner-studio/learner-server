import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { LLMService } from '@learner/llm/services/llm-service.js'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import type { QueryFn } from '../db/handle.js'
import { LocalVariablesService } from '../runtime/types.js'
import { ASSESSMENT_MODEL, buildConceptAssessmentInput } from '../lib/learning/learning-concept-assessment.js'
import { PRIOR_SECTION_HEADING } from '../lib/learning/learning-incremental-assessment.js'
import { persistAssessmentCache } from '../lib/learning/learning-assessment-persistence.js'
import { LearningConceptAssessmentService } from './learning-concept-assessment.js'
import { LearningCurriculumStore } from './learning-curriculum-store.js'

// Replicate grading (docs/specs/mastery-change-statistics.md, part B) on learner_test, each test in a
// transaction that is rolled back. The model is a fake that answers a scripted percent and confidence,
// counts its (paid) calls and keeps the prompts it was sent. Since migration 0031 replicates are
// PRIOR-BLIND gradings: the reading stays the live grading and the summary is its blind measurement.
describe.skipIf(!process.env.TEST_DATABASE_URL)('replicate grading (learner_test)', () => {
  let client: Client
  let query: QueryFn
  let userId: string
  let conceptId: string

  class Scripted extends LLMService {
    calls = 0
    prompts: string[] = []
    constructor(private readonly answers: Array<{ percent: number | null; confidence: 'insufficient' | 'low' | 'medium' | 'high' }>, private readonly nodeVersion: () => string) { super(new LocalVariablesService()) }
    override async callLLMWithStructuredOutput(input: Parameters<LLMService['callLLMWithStructuredOutput']>[0]) {
      const a = this.answers[this.calls++]!
      this.prompts.push(input.prompt)
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

  /**
   * A prepared manual (live) run, as `prepare` leaves it: snapshot frozen, no receipt. With `prior`, its
   * prompt carries that published estimate (the v6 incremental section) and the run is anchored on it.
   */
  const manualRun = async (experimentId?: string, prior?: number) => {
    const concept = { conceptId, title: 'T', description: 's\ne', objectives: [] }
    const evidence = [{ id: 'm1', conversationId: 'c', role: 'user', text: 'I explained it.', occurredAt: '2026-10-01T12:00:00.000Z' }]
    const built = buildConceptAssessmentInput(concept, evidence, null)
    const runId = randomUUID()
    const priorAssessment = prior === undefined ? null : { conceptId, understandingPercent: prior, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'n', needsReview: true }
    if (priorAssessment) built.prompt = `${built.prompt}\n\n${PRIOR_SECTION_HEADING} (already reflects every earlier turn)\n${JSON.stringify(priorAssessment)}\n\n### AFTER`
    const snapshot = { ...built, evidence, prior: priorAssessment, model: ASSESSMENT_MODEL, promptRevision: 'test', indexStartedAt: new Date().toISOString(), ...(experimentId ? { experimentId } : {}) }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,$2,$1,$3,$4,$5,$6::jsonb)`,
      [runId, userId, conceptId, built.nodeVersion, `${built.inputHash}-${runId}`, JSON.stringify(snapshot)])
    return { runId, concept, nodeVersion: built.nodeVersion }
  }
  const service = (llm: LLMService) => new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype), llm)
  const reading = async (runId: string) => (await query<{ understanding_percent: string | null; confidence: string; prior_percent: string | null; blind_percent: string | null; blind_gradings: number; blind_confidence: string | null; blind_sd: string | null }>(
    'SELECT understanding_percent, confidence, prior_percent, blind_percent, blind_gradings, blind_confidence, blind_sd FROM learning_mastery_readings WHERE run_id=$1', [runId])).rows[0]
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
    // A first grading carries no prior: the live reading is also one prior-blind grading.
    expect(await reading(runId)).toEqual({ understanding_percent: '40', confidence: 'medium', prior_percent: null, blind_percent: '40', blind_gradings: 1, blind_confidence: 'medium', blind_sd: null })
    const assessment = (await receipt(runId)).assessment
    await persistAssessmentCache(query, { userId, concept, nodeVersion, inputHash: 'h', runId, assessment: assessment as never, completedAt: new Date().toISOString() })
    // Byte-identical: the cache holds exactly the receipt's assessment.
    expect(JSON.stringify(await cached())).toBe(JSON.stringify((await query<{ a: unknown }>('SELECT $1::jsonb AS a', [JSON.stringify(assessment)])).rows[0]!.a))
  })

  test('k = 3: the reading stays unpublished until combined; then it is the live grading, and its blind measurement the raw mean, spread and median confidence', async () => {
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
    expect([r.understanding_percent, r.confidence]).toEqual(['40', 'high']) // the live grading, never averaged
    expect(Number(r.blind_percent)).toBeCloseTo(145 / 3, 9)
    expect(r.blind_confidence).toBe('high') // high, medium, high → the median (S6)
    expect(r.blind_gradings).toBe(3)
    expect(Number(r.blind_sd)).toBeCloseTo(Math.sqrt(((40 - 145 / 3) ** 2 + (55 - 145 / 3) ** 2 + (50 - 145 / 3) ** 2) / 2), 9)
    // The cache publishes the live grading, the same value the reading shows.
    await persistAssessmentCache(query, { userId, concept, nodeVersion, inputHash: 'h', runId, assessment: (await receipt(runId)).assessment as never, completedAt: new Date().toISOString() })
    expect(await cached()).toMatchObject({ understandingPercent: 40, confidence: 'high' })
    const cost = (await query<{ input_tokens: string; output_tokens: string }>('SELECT input_tokens, output_tokens FROM learning_concept_assessment_replicate_summaries WHERE run_id=$1', [runId])).rows[0]!
    expect([Number(cost.input_tokens), Number(cost.output_tokens)]).toEqual([3000, 300])
    // Replays change nothing and pay nothing.
    expect(await s.planReplicates(runId, query)).toEqual({ runId, replicates: [2, 3] })
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'completed' })
    expect(await s.combineReplicates(runId, query)).toEqual({ runId, replicates: 3, meanPercent: 48.333333333333336 })
    expect(llm.calls).toBe(3)
  })

  // Restart safety (docs/operations/restart-safety.md): an unreceipted replicate whose owner is dead is FINISHED on a
  // repeat-free backend (the flat-rate local CLI: a second call costs nothing) and NEVER repeated on a metered one.
  const withMetered = async <T>(backends: string, body: () => Promise<T>) => {
    const before = process.env.LEARNER_METERED_BACKENDS
    process.env.LEARNER_METERED_BACKENDS = backends
    try { return await body() } finally { if (before === undefined) delete process.env.LEARNER_METERED_BACKENDS; else process.env.LEARNER_METERED_BACKENDS = before }
  }
  const takeovers = async (runId: string, n: number) => (await query<{ action: string }>('SELECT action FROM learning_llm_attempt_reclaims WHERE attempt_key=$1', [`replicate:${runId}:${n}`])).rows.map((r) => r.action)

  test('a replicate step killed during its model call is finished once on replay (repeat-free backend), with one receipt', async () => {
    await setReplicates(3)
    const { runId, nodeVersion } = await manualRun()
    const llm = new Scripted([{ percent: 40, confidence: 'medium' }, { percent: 60, confidence: 'medium' }, { percent: 50, confidence: 'medium' }], () => nodeVersion)
    const s = service(llm)
    await s.planReplicates(runId, query)
    await s.execute(runId, query)
    // Replicate 2 was reserved by a process that died before its receipt (and before leases existed: no lease row).
    await query(`INSERT INTO learning_concept_assessment_replicates(run_id,replicate,reserved_at) VALUES($1,2,now()-interval '1 hour')`, [runId])
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'completed' })
    expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'completed' })
    expect(llm.calls).toBe(2)
    expect(await takeovers(runId, 2)).toEqual(['takeover'])
    expect(await s.executeReplicate(runId, 3, query)).toEqual({ runId, replicate: 3, status: 'completed' })
    expect(llm.calls).toBe(3)
    await s.combineReplicates(runId, query)
    expect(await reading(runId)).toMatchObject({ understanding_percent: '40', blind_percent: '50', blind_gradings: 3 })
  })

  test('a metered backend: a replicate killed during its paid call is never paid again on replay', async () => {
    await setReplicates(3)
    const { runId, nodeVersion } = await manualRun()
    const llm = new Scripted([{ percent: 40, confidence: 'medium' }, { percent: 60, confidence: 'medium' }], () => nodeVersion)
    const s = service(llm)
    await s.planReplicates(runId, query)
    await s.execute(runId, query)
    await query(`INSERT INTO learning_concept_assessment_replicates(run_id,replicate,reserved_at) VALUES($1,2,now()-interval '1 hour')`, [runId])
    await withMetered('codex', async () => {
      expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'uncertain' })
      expect(await s.executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'uncertain' })
    })
    expect(llm.calls).toBe(1)
    expect(await takeovers(runId, 2)).toEqual(['refused', 'refused']) // never taken over; each refusal says so
    expect((await query<{ error: string }>(`SELECT receipt->>'error' AS error FROM learning_concept_assessment_replicates WHERE run_id=$1 AND replicate=2`, [runId])).rows[0]!.error).toContain('is metered')
    expect(await s.executeReplicate(runId, 3, query)).toEqual({ runId, replicate: 3, status: 'completed' })
    expect(llm.calls).toBe(2)
    // The blind measurement is the mean of the blind gradings that have a number: 40 and 60.
    await s.combineReplicates(runId, query)
    expect(await reading(runId)).toMatchObject({ understanding_percent: '40', blind_percent: '50', blind_gradings: 2 })
  })

  test('S4: a process that dies DURING the replicate call: a metered replay pays nothing, a repeat-free one finishes it once', async () => {
    for (const metered of [true, false]) {
      await setReplicates(2)
      const { runId, nodeVersion } = await manualRun()
      const s = service(new Scripted([{ percent: 40, confidence: 'medium' }], () => nodeVersion))
      await s.planReplicates(runId, query)
      await s.execute(runId, query)
      // The dying process: its model call is counted (paid) and never answers. Nothing after it runs.
      let paid = 0
      let reached!: () => void
      const inCall = new Promise<void>((resolve) => { reached = resolve })
      class Dies extends Scripted {
        override async callLLMWithStructuredOutput(): Promise<never> { paid++; reached(); return new Promise<never>(() => {}) }
      }
      await withMetered(metered ? 'codex' : '', async () => {
        void service(new Dies([], () => nodeVersion)).executeReplicate(runId, 2, query)
        await inCall
        expect(paid).toBe(1)
        // The process is gone: its lease names an owner whose advisory lock nobody holds.
        await query(`UPDATE learning_llm_attempt_leases SET owner='gone-host:1:dead' WHERE attempt_key=$1`, [`replicate:${runId}:2`])
        const replay = new Scripted([{ percent: 60, confidence: 'medium' }], () => nodeVersion)
        expect(await service(replay).executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: metered ? 'uncertain' : 'completed' })
        expect(replay.calls).toBe(metered ? 0 : 1)
      })
      expect(paid).toBe(1)
    }
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
    expect(await reading(runId)).toMatchObject({ understanding_percent: null, confidence: 'insufficient', blind_percent: null, blind_gradings: 0 })
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

  test('B1: an anchored run is not a blind measurement; its replicates are graded with the estimate withheld', async () => {
    await setReplicates(3)
    const { runId, nodeVersion } = await manualRun(undefined, 30)
    const llm = new Scripted([{ percent: 35, confidence: 'medium' }, { percent: 60, confidence: 'medium' }, { percent: 50, confidence: 'high' }], () => nodeVersion)
    const s = service(llm)
    await s.planReplicates(runId, query)
    await s.execute(runId, query)
    await s.executeReplicate(runId, 2, query)
    await s.executeReplicate(runId, 3, query)
    expect(await s.combineReplicates(runId, query)).toEqual({ runId, replicates: 2, meanPercent: 55 })
    // The live grading saw the prior; both replicates saw 'none' in its place, and the rest of the prompt unchanged.
    expect(llm.prompts[0]).toContain('"understandingPercent":30')
    for (const p of llm.prompts.slice(1)) {
      expect(p).not.toContain('"understandingPercent":30')
      expect(p).toContain(`${PRIOR_SECTION_HEADING} (already reflects every earlier turn)\nnone\n\n### AFTER`)
    }
    expect(await reading(runId)).toEqual({ understanding_percent: '35', confidence: 'medium', prior_percent: '30', blind_percent: '55', blind_gradings: 2, blind_confidence: 'medium', blind_sd: expect.any(String) })
  })

  test('S5: a duplicate delivery during the call waits and pays nothing; a late receipt replaces an uncertain stamp', async () => {
    await setReplicates(2)
    const { runId, nodeVersion } = await manualRun()
    const s = service(new Scripted([{ percent: 40, confidence: 'medium' }, { percent: 50, confidence: 'medium' }], () => nodeVersion))
    await s.planReplicates(runId, query)
    await s.execute(runId, query)
    const slow = new Scripted([{ percent: 50, confidence: 'medium' }], () => nodeVersion)
    let duplicate: Promise<unknown> | undefined
    slow.callLLMWithStructuredOutput = (async (input: never) => {
      // A duplicate delivery of the step arrives while the call runs: it must wait, not call.
      duplicate = s.executeReplicate(runId, 2, query)
      await Bun.sleep(50)
      // A metered peer that judged this owner dead stamped the reservation uncertain meanwhile.
      await query(`UPDATE learning_concept_assessment_replicates SET receipt='{"status":"uncertain"}'::jsonb WHERE run_id=$1 AND replicate=2`, [runId])
      return Scripted.prototype.callLLMWithStructuredOutput.call(slow, input)
    }) as never
    expect(await service(slow).executeReplicate(runId, 2, query)).toEqual({ runId, replicate: 2, status: 'completed' })
    expect(await duplicate).toEqual({ runId, replicate: 2, status: 'completed' })
    const stored = (await query<{ status: string }>(`SELECT receipt->>'status' AS status FROM learning_concept_assessment_replicates WHERE run_id=$1 AND replicate=2`, [runId])).rows[0]!
    expect(stored.status).toBe('completed')
    expect(await s.combineReplicates(runId, query)).toEqual({ runId, replicates: 2, meanPercent: 45 })
  })
})
