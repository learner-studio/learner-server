import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { reservedPaidAttempts } from '@learner/core/lib/learning/learning-archive-coordinator.js'
import { reactiveCoalescer, reactiveIdentity } from '@learner/core/lib/learning/learning-reactive-consolidation.js'
import { readReactiveGradingHealth } from '@learner/core/lib/learning/learning-reactive-health.js'
import { LIVE_INCREMENTAL_VARIANT } from '@learner/core/lib/learning/learning-live-incremental-variant.js'
import { LIVE_COLD_SLICES } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'
import { coldVectorParts, extendVectorCoverage, vectorRunMetadata, type VectorConfig, type VectorMessage, type VectorTurn } from '@learner/core/lib/learning/learning-vector-turns.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'
import { LearningVectorTurnService } from '@learner/core/services/learning-vector-turn-service.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * learningReactiveConceptWorkflow end to end under the framework runtime, on this checkout's OWN database and queue
 * schema, with the shipped prepare/part/grade/publish/settle steps and a fake model. Only the bank lookup
 * (selectEvidence: canonical index, embeddings, vector bank) is a fixture. A live cold pass regrades the concept's
 * whole history; a pass whose selection repeats the published pass used to store every part again (~240 kB each,
 * all 'unchanged') and ~1 MB of text: 98% of the live rows on 2026-11-13. It now stores neither. Every text is synthetic.
 */
const url = await ownTestDatabaseUrl('reactiverepeat')

describe.skipIf(!url)('a repeated live pass stores no parts (learner_reactiverepeat_test_<checkout>)', () => {
  const userId = `repeat-${randomUUID()}`
  const conceptId = `repeat-c-${randomUUID().slice(0, 8)}`
  const concept = { conceptId, title: 'Synthetic caching', description: 'What a cache is.\nWhy invalidation is hard.', objectives: [] as string[] }
  const texts = new Map<string, string>()
  const fixture = { turns: 6 }
  const calls = { n: 0, outage: 'u-5' }
  // A fake model: cites the first human message of the part's new evidence. Its first grading of `outage` is a provider error.
  const llm = {
    async callLLMWithStructuredOutput(params: { prompt: string; parseFn: (value: unknown) => unknown; callOptions?: { onUsage?: (u: Record<string, unknown>) => void } }) {
      calls.n++
      const section = params.prompt.slice(params.prompt.indexOf('### NEW EVIDENCE'))
      const id = [...texts.keys()].filter((key) => key.startsWith('u-')).find((key) => section.includes(`"${key}"`))!
      if (id === calls.outage) { calls.outage = ''; throw new Error('LLM_ERROR synthetic provider outage') }
      params.callOptions?.onUsage?.({ inputTokens: 1000, outputTokens: 100 })
      return params.parseFn(JSON.stringify({ proposals: [{ conceptId, understandingPercent: 40, confidence: 'medium',
        demonstrated: [{ description: 'synthetic', sourceId: id, quote: texts.get(id)!.slice(0, 12) }], gaps: [], nextCheck: 'synthetic', needsReview: true }] }))
    },
  }
  /** The bank's answer: `fixture.turns` human turns, each with a reply, as selectEvidence leaves a live cold pass. */
  class FixtureSelection extends LearningVectorTurnService {
    override async selectEvidence(config: VectorConfig, _user: string, runId: string) {
      const messages: VectorMessage[] = []
      const turns: VectorTurn[] = []
      for (let i = 0; i < fixture.turns; i++) {
        const at = new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString()
        for (const role of ['user', 'assistant']) {
          const id = `${role === 'user' ? 'u' : 'a'}-${i}`
          texts.set(id, role === 'user' ? `Synthetic learner question ${i} about cache invalidation` : `Synthetic reply ${i}`)
          messages.push({ id, conversationId: 'conv', role, text: texts.get(id)!, occurredAt: at, logicalKey: `k-${id}`, authorship: role === 'user' ? 'human' : 'agent', correlation: {}, sourceOrder: i, sourceVersion: 'v1' })
        }
        turns.push({ id: `t-${i}`, conversationId: 'conv', at, messageIds: [`u-${i}`, `a-${i}`], linkage: 'explicit' })
      }
      const byId = new Map(messages.map((m) => [m.id, m]))
      const plan = coldVectorParts(turns, byId, config.maxInputTokens, LIVE_COLD_SLICES)
      return { messages, selections: [{ concept, matchingChunks: messages.length, matchingMessages: messages.length, matchingTurns: turns.length, bankMatchingUnits: messages.length, exhaustive: true,
        turns: plan.turns, parts: plan.parts, covered: [...extendVectorCoverage([], plan.parts, byId)], context: [] }],
        batches: plan.parts.map((_, part) => [{ conceptId, part }]), metadata: vectorRunMetadata(runId, config, 'fixture', LIVE_INCREMENTAL_VARIANT.revision),
        counts: { messages: messages.length, chunks: messages.length, turns: turns.length, unpaired: 0 } }
    }
  }
  const runtime = bootRuntime({ databaseUrl: url!, schemaPrefix: 'learner_pikku_boss_test_repeat_', prepare: async (services) => {
    services.learningConceptAssessment = new LearningConceptAssessmentService(services.learningCurriculumStore, llm as never)
    services.learningVectorTurns = new FixtureSelection(services.kysely, services.learningConceptAssessment, services.learningCurriculumStore)
    await services.db.query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind) VALUES($1,$2,'What a cache is.','Why invalidation is hard.','x','d','c',0,0,'user')`, [conceptId, concept.title])
    await services.db.query(`INSERT INTO learning_reactive_settings(user_id,enabled,config,revision) VALUES($1,true,'{"enabled":true,"assessmentEnabled":true,"concurrency":1}','repeat-fixture')`, [userId])
    await services.db.query('INSERT INTO learning_reactive_targets(user_id,session_id,concept_id) VALUES($1,$2,$3)', [userId, sessionId, conceptId])
  } })
  const sessionId = reactiveIdentity(userId, conceptId)
  afterAll(async () => { await runtime.stop() }, 60_000)

  /** One arrival through the production admission path: mark dirty, dispatch, run the pass to its end. */
  const pass = async () => {
    const services = await runtime.booted
    await reactiveCoalescer.markArchiveDirty(userId, sessionId, randomUUID())
    let runId = '', dispatchId = ''
    await reactiveCoalescer.dispatchArchiveSessions(async (data) => { dispatchId = data.dispatchId; return (runId = await runtime.start('learningReactiveConceptWorkflow', data)) })
    const run = await runtime.awaitRun(runId, 120_000)
    if (run?.status !== 'completed') console.log(JSON.stringify((await services.workflowRunService.getRunSteps(runId)).map((s: { stepName: string; status: string; error?: unknown }) => [s.stepName, s.status, s.error])))
    expect(run?.status).toBe('completed')
    const q = services.db.query.bind(services.db)
    const counts = (await q(`SELECT
      (SELECT count(*)::int FROM learning_concept_assessment_runs WHERE user_id=$1) AS runs,
      (SELECT count(*)::int FROM learning_concept_assessment_attempts a JOIN learning_concept_assessment_runs r USING(run_id) WHERE r.user_id=$1) AS attempts,
      (SELECT count(*)::int FROM learning_vector_turn_assessments WHERE experiment_id=$2::uuid) AS parts,
      (SELECT jsonb_array_length(snapshot->'messages')::int FROM learning_vector_turn_experiments WHERE run_id=$2::uuid) AS messages,
      (SELECT finished_at FROM learning_vector_turn_experiments WHERE run_id=$2::uuid) AS "finishedAt",
      (SELECT snapshot->'selections'->0->>'unchangedFrom' FROM learning_vector_turn_experiments WHERE run_id=$2::uuid) AS "unchangedFrom",
      (SELECT count(*)::int FROM learning_mastery_readings WHERE user_id=$1) AS readings,
      (SELECT run_id FROM learning_concept_assessment_cache WHERE user_id=$1 AND concept_id=$3) AS "cacheRun",
      (SELECT assessment->>'understandingPercent' FROM learning_concept_assessment_cache WHERE user_id=$1 AND concept_id=$3) AS "cachePercent",
      (SELECT requested_generation=captured_generation FROM learning_reactive_admission WHERE user_id=$1 AND session_id=$4) AS settled`, [userId, dispatchId, conceptId, sessionId])).rows[0] as Record<string, unknown>
    const state = await services.learningVectorTurns.inspect(dispatchId, userId)
    return { dispatchId, published: (run as unknown as { output: { status: string } }).output, calls: calls.n, paid: await reservedPaidAttempts(dispatchId, q as never), tokens: state.inputTokens, item: state.items[0]!, ...counts }
  }

  test('a pass that repeats the published one stores no run, no text and pays nothing; a failure or a new turn grades again', async () => {
    const first = await pass()
    // Six turns in four cold slices: four paid parts, the last a provider error. The pass publishes part 2's estimate.
    expect(first).toMatchObject({ calls: 4, paid: 4, tokens: 3000, runs: 4, attempts: 4, parts: 4, messages: 12, unchangedFrom: null, readings: 1, settled: true, published: { status: 'completed' } })

    const second = await pass()
    // The same selection, but a replay of the failed part is not a repeat: its one provider retry is paid.
    expect(second).toMatchObject({ calls: 5, paid: 1, tokens: 1000, runs: 8, attempts: 5, parts: 4, messages: 12, unchangedFrom: null, readings: 2, settled: true, published: { status: 'completed' } })

    const third = await pass()
    // Every part would repeat the published pass's input and receipt: nothing is stored or paid, the estimate stays published.
    expect(third).toMatchObject({ calls: 5, paid: 0, tokens: 0, runs: 8, attempts: 5, parts: 0, messages: 0, unchangedFrom: second.dispatchId, readings: 2, settled: true,
      cacheRun: second.cacheRun, cachePercent: second.cachePercent, published: { status: 'unchanged' } })
    expect(third.item).toMatchObject({ status: 'completed', batches: 0, unchangedFrom: second.dispatchId })
    const services = await runtime.booted
    // A replayed prepare step reads the frozen snapshot back: still nothing to grade.
    expect((await services.learningVectorTurns.prepare(third.dispatchId)).batches).toEqual([])
    // Its coverage is the repeated pass's: nothing newly covered, nothing lost.
    expect((await services.learningVectorTurns.coverageHistory(userId, conceptId, 10)).at(-1)).toMatchObject({ runId: third.dispatchId, turns: 0, parts: 0, covered: 12, newlyCovered: 0, coverageShrank: false })
    // The no-reading health rule counts the repeat as service.
    const health = await readReactiveGradingHealth(userId, services.db.query.bind(services.db) as never)
    expect(new Date(health.grading.lastReadingAt!).toISOString()).toBe((third.finishedAt as Date).toISOString())

    fixture.turns = 7
    const fourth = await pass()
    // Slices 2,2,2,1: the first two parts reuse their receipts, the last two are new evidence and are paid.
    expect(fourth).toMatchObject({ calls: 7, paid: 2, tokens: 2000, runs: 12, attempts: 7, parts: 4, messages: 14, unchangedFrom: null, readings: 3, settled: true, published: { status: 'completed' } })
    expect(fourth.cacheRun).not.toBe(second.cacheRun)
  }, 400_000)
})
