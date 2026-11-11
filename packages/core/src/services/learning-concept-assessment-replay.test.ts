import { expect, test } from 'bun:test'
import { LocalVariablesService } from '../runtime/types.js'
import { LearningConceptAssessmentService } from './learning-concept-assessment.js'
import { LearningCurriculumStore } from './learning-curriculum-store.js'
import { LLMService } from '@learner/llm/services/llm-service.js'
import { ASSESSMENT_MODEL, buildConceptAssessmentInput } from '../lib/learning/learning-concept-assessment.js'
import type { MetaPgQueryFn } from '../lib/db-metadata/_shared.js'

/**
 * Recovery replays workflow steps; a step that was running when its process died
 * runs again. The assessment step must then make NO second paid call, and write
 * at most one receipt per run (readings are one row per pass and concept, built
 * from receipts, so a run with one receipt cannot add a second reading).
 * The fake keeps state across calls, as the attempts and receipts tables do.
 */
const built = buildConceptAssessmentInput({ conceptId: 'replay-concept', title: 'Replay', description: 'Replay safety', objectives: [] },
  [{ id: 'human', conversationId: 'session', role: 'user', text: 'Human evidence', occurredAt: null }], null)
const proposal = { conceptId: 'replay-concept', nodeVersion: built.nodeVersion, understandingPercent: null, confidence: 'insufficient', demonstrated: [], gaps: [], nextCheck: 'Explain the concept.', needsReview: true }

class Counting extends LLMService {
  calls = 0
  override async callLLMWithStructuredOutput(): Promise<never> { this.calls++; return [proposal] as never }
}

function store(crashAtReceipt: { once: boolean }) {
  const attempts = new Map<string, Date>()
  const receipts = new Map<string, Record<string, unknown>>()
  const query: MetaPgQueryFn = async <R>(sql: string, params?: ReadonlyArray<unknown>) => {
    let rows: unknown[] = []
    if (sql.startsWith('SELECT r.*')) rows = [{ run_id: 'r', user_id: 'replay-user', concept_id: 'replay-concept', input_hash: 'h', reserved_at: attempts.get('r') ?? null, receipt: receipts.get('r') ?? null,
      snapshot: { ...built, model: { ...ASSESSMENT_MODEL, maxParseRetries: 0, maxAttempts: 1 }, evidence: [{ id: 'human', role: 'user', text: 'Human evidence' }] } }]
    else if (sql.startsWith('SELECT c.run_id,t.receipt FROM learning_concept_assessment_cache')) rows = []
    else if (sql.startsWith('INSERT INTO learning_concept_assessment_attempts')) {
      const id = String(params?.[0])
      if (!attempts.has(id)) { attempts.set(id, new Date()); rows = [{ run_id: id }] }
    } else if (sql.startsWith('INSERT INTO learning_concept_assessment_receipts')) {
      // The process is killed after the provider answered and before the receipt committed.
      if (crashAtReceipt.once) { crashAtReceipt.once = false; throw new Error('process killed') }
      const id = String(params?.[0])
      if (!receipts.has(id)) receipts.set(id, JSON.parse(String(params?.[1])))
    } else throw new Error(`Unexpected persistence side effect: ${sql}`)
    return { rows: rows as R[], rowCount: rows.length }
  }
  return { query, attempts, receipts }
}

test('a step killed after its paid call is replayed without a second paid call and settles as uncertain, once', async () => {
  const llm = new Counting(new LocalVariablesService())
  const service = new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype), llm)
  const db = store({ once: true })
  await expect(service.execute('r', db.query)).rejects.toThrow('process killed')
  expect(llm.calls).toBe(1)
  expect(db.attempts.size).toBe(1)
  expect(await service.execute('r', db.query)).toEqual({ runId: 'r', status: 'uncertain' })
  expect(await service.execute('r', db.query)).toEqual({ runId: 'r', status: 'uncertain' })
  expect(llm.calls).toBe(1)
  expect(db.receipts.size).toBe(0) // the reservation stands for review; nothing new is written
})

test('a step replayed after it completed returns the recorded outcome: one paid call, one receipt', async () => {
  const llm = new Counting(new LocalVariablesService())
  const service = new LearningConceptAssessmentService(Object.create(LearningCurriculumStore.prototype), llm)
  const db = store({ once: false })
  expect(await service.execute('r', db.query)).toEqual({ runId: 'r', status: 'completed' })
  expect(await service.execute('r', db.query)).toEqual({ runId: 'r', status: 'completed' })
  expect(llm.calls).toBe(1)
  expect(db.receipts.size).toBe(1)
  expect(db.receipts.get('r')).toMatchObject({ status: 'completed', assessment: { confidence: 'insufficient' } })
})
