import { afterAll, describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { sql, type RawBuilder } from 'kysely'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { reservedPaidAttempts } from '@learner/core/lib/learning/learning-archive-coordinator.js'
import { reactiveCoalescer, reactiveIdentity } from '@learner/core/lib/learning/learning-reactive-consolidation.js'
import { readReactiveGradingHealth } from '@learner/core/lib/learning/learning-reactive-health.js'
import { LIVE_INCREMENTAL_VARIANT } from '@learner/core/lib/learning/learning-live-incremental-variant.js'
import { priorBlindPrompt } from '@learner/core/lib/learning/learning-incremental-assessment.js'
import { LIVE_COLD_SLICES } from '@learner/core/lib/learning/learning-vector-turn-schemas.js'
import { coldVectorParts, extendVectorCoverage, vectorRunMetadata, type VectorConfig, type VectorMessage, type VectorTurn } from '@learner/core/lib/learning/learning-vector-turns.js'
import { LearningConceptAssessmentService } from '@learner/core/services/learning-concept-assessment.js'
import { LearningVectorTurnService } from '@learner/core/services/learning-vector-turn-service.js'
import { LearningExposureService } from '@learner/core/services/learning-exposure-service.js'
import { LearningLosslessArchiveService } from '@learner/core/services/learning-lossless-archive-service.js'
import { archivePlaygroundTurn } from '@learner/core/lib/learning/learning-playground-archive.js'
import { LearningExposureObservation } from '@learner/core/lib/learning/learning-exposure-schemas.js'
import { canonicalSemanticMessage } from '@learner/core/lib/learning/learning-semantic-index.js'
import { SOURCE_COLUMNS } from '@learner/core/lib/learning/learning-vector-part-input.js'
import { sourcePrompt, type SourceRun } from '@learner/core/lib/learning/grader-drift-panel.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * learningReactiveConceptWorkflow end to end under the framework runtime, on this checkout's OWN database and queue
 * schema, with the shipped prepare/part/grade/publish/settle steps and a fake model. Only the bank lookup
 * (selectEvidence: canonical index, embeddings, vector bank) is a fixture. A live cold pass regrades the concept's
 * whole history; a pass whose selection repeats the published pass used to store every part again (~240 kB each,
 * all 'unchanged') and ~1 MB of text: 98% of the live rows on 2026-11-13. It now stores neither. A graded run stores
 * references and its prompt's digest, no text: its prompt is rebuilt from the pass and the canonical message rows. Every text is synthetic.
 */
const url = await ownTestDatabaseUrl('reactiverepeat')

describe.skipIf(!url)('a repeated live pass stores no parts (learner_reactiverepeat_test_<checkout>)', () => {
  const userId = `repeat-${randomUUID()}`
  const conceptId = `repeat-c-${randomUUID().slice(0, 8)}`
  const concept = { conceptId, title: 'Synthetic caching', description: 'What a cache is.\nWhy invalidation is hard.', objectives: [] as string[] }
  const conversationId = randomUUID()
  /** Canonical rows (learning_semantic_index_messages) of seven turns, oldest first, written as indexing writes them. */
  let rows: VectorMessage[] = []
  const texts = new Map<string, string>()
  const fixture = { turns: 6 }
  const calls = { n: 0, outage: '' }
  const prompts = new Map<string, string>()
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  // A fake model: cites the first human message of the part's new evidence. Its first grading of `outage` is a provider error.
  const llm = {
    async callLLMWithStructuredOutput(params: { prompt: string; parseFn: (value: unknown) => unknown; callOptions?: { onUsage?: (u: Record<string, unknown>) => void } }) {
      calls.n++
      prompts.set(sha(params.prompt), params.prompt)
      const section = params.prompt.slice(params.prompt.indexOf('### NEW EVIDENCE'))
      const id = rows.filter((m) => m.role === 'user').map((m) => m.id).find((key) => section.includes(`"${key}"`))!
      if (id === calls.outage) { calls.outage = ''; throw new Error('LLM_ERROR synthetic provider outage') }
      params.callOptions?.onUsage?.({ inputTokens: 1000, outputTokens: 100 })
      return params.parseFn(JSON.stringify({ proposals: [{ conceptId, understandingPercent: 40, confidence: 'medium',
        demonstrated: [{ description: 'synthetic', sourceId: id, quote: texts.get(id)!.slice(0, 12) }], gaps: [], nextCheck: 'synthetic', needsReview: true }] }))
    },
  }
  /** The bank's answer: `fixture.turns` human turns, each with a reply, as selectEvidence leaves a live cold pass. */
  class FixtureSelection extends LearningVectorTurnService {
    override async selectEvidence(config: VectorConfig, _user: string, runId: string) {
      const messages = rows.slice(0, 2 * fixture.turns)
      const turns: VectorTurn[] = Array.from({ length: fixture.turns }, (_, i) => ({ id: `t-${i}`, conversationId, at: messages[2 * i]!.occurredAt!, messageIds: [messages[2 * i]!.id, messages[2 * i + 1]!.id], linkage: 'explicit' }))
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
    const archive = new LearningLosslessArchiveService(services.kysely), exposure = new LearningExposureService(services.kysely)
    for (let i = 0; i < 7; i++) {
      const turn = await archivePlaygroundTurn(archive, exposure, { requestId: randomUUID(), conversationId, userId: `${userId}-source`, provider: 'codex',
        message: `Synthetic learner question ${i} about cache invalidation`, response: `Synthetic reply ${i}`, receivedAt: new Date(Date.UTC(2026, 10, 1, 10, i)).toISOString() })
      for (const id of turn.observationIds) {
        const raw = (await sql<{ payload: unknown }>`SELECT payload FROM learning_exposure_observations WHERE observation_id=${id}::uuid`.execute(services.kysely)).rows[0]!
        const observation = LearningExposureObservation.parse(raw.payload), m = canonicalSemanticMessage(observation, turn.rawVersionId)
        await sql`INSERT INTO learning_semantic_index_messages(message_id,observation_id,logical_message_key,raw_version_id,conversation_id,role,observed_at,payload,source_text,source_sha256,parts,media_count,status)
          VALUES(${m.messageId},${m.observationId}::uuid,${m.logicalMessageKey},${m.rawVersionId}::uuid,${m.conversationId},${m.role},${m.observedAt}::timestamptz,${JSON.stringify(observation)}::jsonb,
            ${m.text},${m.sourceSha256},${JSON.stringify(m.parts)}::jsonb,0,'indexed')`.execute(services.kysely)
      }
    }
    rows = (await sql<VectorMessage>`SELECT ${sql.raw(SOURCE_COLUMNS)} FROM learning_semantic_index_messages WHERE conversation_id=${conversationId} ORDER BY observed_at`.execute(services.kysely)).rows
    for (const m of rows) texts.set(m.id, m.text)
    calls.outage = rows[10]!.id
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
    const booted = await runtime.booted
    // Each run stores references and its prompt's digest, no text; the digest still records the prior its prompt carried.
    const graded = (await booted.db.query(`SELECT r.run_id, r.snapshot::text AS text, r.snapshot ? 'prompt' AS "hasPrompt", r.snapshot->>'promptSha256' AS digest,
      pg_column_size(r.snapshot) AS bytes, d.prior_percent::text AS prior FROM learning_concept_assessment_runs r JOIN learning_concept_assessment_run_digests d USING(run_id)
      WHERE r.user_id=$1 ORDER BY (r.snapshot->>'part')::int`, [userId])).rows as Array<{ run_id: string; text: string; hasPrompt: boolean; digest: string; bytes: number; prior: string | null }>
    console.log(`[repeat] run snapshots: ${graded.map((r) => r.bytes).join(', ')} bytes`)
    for (const r of graded) { expect(r.hasPrompt).toBe(false); for (const text of texts.values()) expect(r.text).not.toContain(text) }
    expect(graded.map((r) => r.prior)).toEqual([null, '40', '40', '40'])
    // The prompt and evidence are rebuilt byte for byte from the pass and the canonical rows: what the model was sent.
    for (const r of graded) {
      const run = await booted.learningConceptAssessment.run(r.run_id)
      expect([sha(run.prompt), prompts.get(r.digest)]).toEqual([r.digest, run.prompt])
      expect(run.evidence.map((e) => e.text)).toEqual(run.evidence.map((e) => texts.get(e.id)))
    }
    // The drift panel reads a source run's prompt the same way (selection and regrade).
    const stored = (await booted.db.query(`SELECT concept_id, input_hash, NULL AS prompt, snapshot AS stored FROM learning_concept_assessment_runs WHERE run_id=$1`, [graded[1]!.run_id])).rows[0] as SourceRun
    expect(await sourcePrompt(booted.db.query.bind(booted.db) as never, stored)).toBe(prompts.get(graded[1]!.digest)!)

    const second = await pass()
    // The same selection, but a replay of the failed part is not a repeat: its one provider retry is paid.
    expect(second).toMatchObject({ calls: 5, paid: 1, tokens: 1000, runs: 8, attempts: 5, parts: 4, messages: 12, unchangedFrom: null, readings: 2, settled: true, published: { status: 'completed' } })

    const services = await runtime.booted
    // Rows are immutable by trigger; only a replica session (as the historical cleanup runs) may rewrite one.
    const replica = (update: RawBuilder<unknown>) => services.kysely.transaction().execute(async (trx) => {
      await sql`SET LOCAL session_replication_role = replica`.execute(trx); await update.execute(trx) })
    // Every part must repeat, not only the last: a published pass whose first part had other input is graded again (copies, nothing paid).
    await replica(sql`UPDATE learning_concept_assessment_runs SET input_hash='other-input' WHERE run_id=(SELECT run_id FROM learning_vector_turn_assessments WHERE experiment_id=${second.dispatchId}::uuid AND part=0)`)
    const regraded = await pass()
    expect(regraded).toMatchObject({ calls: 5, paid: 0, tokens: 0, runs: 12, attempts: 5, parts: 4, messages: 12, unchangedFrom: null, settled: true, published: { status: 'unchanged' } })

    const third = await pass()
    // Every part would repeat the published pass's input and receipt: nothing is stored or paid, the estimate stays published.
    expect(third).toMatchObject({ calls: 5, paid: 0, tokens: 0, runs: 12, attempts: 5, parts: 0, messages: 0, unchangedFrom: regraded.dispatchId, readings: regraded.readings, settled: true,
      cacheRun: regraded.cacheRun, cachePercent: regraded.cachePercent, published: { status: 'unchanged' } })
    expect(third.item).toMatchObject({ status: 'completed', batches: 0, unchangedFrom: regraded.dispatchId })
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
    expect(fourth).toMatchObject({ calls: 7, paid: 2, tokens: 2000, runs: 16, attempts: 7, parts: 4, messages: 14, unchangedFrom: null, readings: (regraded.readings as number) + 1, settled: true, published: { status: 'completed' } })
    expect(fourth.cacheRun).not.toBe(regraded.cacheRun)
    // A replicate (gradingReplicates > 1) grades the rebuilt prompt with its estimate withheld; the summary leaves out
    // the run's own grading, whose rebuilt prompt carried the prior.
    expect(await services.learningConceptAssessment.executeReplicate(graded[1]!.run_id, 2)).toMatchObject({ status: 'completed' })
    expect(prompts.has(sha(priorBlindPrompt(prompts.get(graded[1]!.digest)!)))).toBe(true)
    await services.db.query('INSERT INTO learning_concept_assessment_replicate_plans(run_id,replicates) VALUES($1,2)', [graded[1]!.run_id])
    expect(await services.learningConceptAssessment.combineReplicates(graded[1]!.run_id)).toMatchObject({ replicates: 1 })
    // The text a run was graded on cannot change, and a row changed anyway (replica session) is refused, never regraded
    // on other text: through the input hash for the part it is evidence of, through the prompt's digest where it is only
    // earlier context; the drift panel then leaves the run out.
    const tamper = sql`UPDATE learning_semantic_index_messages SET source_text='Synthetic tampered text' WHERE message_id=${rows[0]!.id}`
    await expect(tamper.execute(services.kysely)).rejects.toThrow('is immutable')
    // Any column the prompt is rebuilt from; indexing's own columns stay free.
    for (const change of [`message_id=message_id||'x'`, `conversation_id=conversation_id||'x'`, `role=CASE role WHEN 'user' THEN 'assistant' ELSE 'user' END`,
      `observed_at=observed_at+interval '1 second'`, `logical_message_key=logical_message_key||'x'`, `payload=jsonb_set(payload,'{correlation,sourceOrder}','7')`,
      `raw_version_id=gen_random_uuid()`])
      await expect(sql`UPDATE learning_semantic_index_messages SET ${sql.raw(change)} WHERE message_id=${rows[0]!.id}`.execute(services.kysely)).rejects.toThrow('is immutable')
    expect((await sql`UPDATE learning_semantic_index_messages SET status='indexed',error=NULL,indexed_at=now() WHERE message_id=${rows[0]!.id}`.execute(services.kysely)).numAffectedRows).toBe(1n)
    await expect(sql`DELETE FROM learning_semantic_index_messages WHERE message_id=${rows[0]!.id}`.execute(services.kysely)).rejects.toThrow('is immutable')
    await replica(tamper)
    for (const r of graded) await expect(services.learningConceptAssessment.run(r.run_id)).rejects.toThrow('differs from the one this run froze')
    expect(await sourcePrompt(services.db.query.bind(services.db) as never, stored)).toBeNull()
    // The CLI e2e fixture cleanup may still delete the messages its run row lists.
    await services.db.query(`INSERT INTO learning_cli_vector_e2e_runs(run_id,provider,model,session_id,marker_sha256,prompt_sha256,prompt_bytes,source_path,message_ids,status)
      VALUES($1,'claude','fixture',$1,$2,$2,1,'fixture',$3,'cleanup_pending')`, [randomUUID(), sha('fixture'), [rows[13]!.id]])
    expect((await sql`DELETE FROM learning_semantic_index_messages WHERE message_id=${rows[13]!.id}`.execute(services.kysely)).numAffectedRows).toBe(1n)

    // A part that can no longer be built (its reply is gone) is never taken for a repeat, though every other part
    // repeats the published pass: the pass prepares its parts (and then fails on that one, as it must).
    await replica(sql`UPDATE learning_semantic_index_messages SET source_text=${texts.get(rows[0]!.id)!} WHERE message_id=${rows[0]!.id}`)
    await reactiveCoalescer.markArchiveDirty(userId, sessionId, randomUUID())
    let unbuildable = '', workflowRun = ''
    await reactiveCoalescer.dispatchArchiveSessions(async (data) => { unbuildable = data.dispatchId; return (workflowRun = await runtime.start('learningReactiveConceptWorkflow', data)) })
    await runtime.awaitRun(workflowRun, 60_000)
    expect((await services.db.query(`SELECT snapshot->'selections'->0->>'unchangedFrom' AS "unchangedFrom", jsonb_array_length(snapshot->'batches') AS batches
      FROM learning_vector_turn_experiments WHERE run_id=$1::uuid`, [unbuildable])).rows[0]).toEqual({ unchangedFrom: null, batches: 4 })
  }, 400_000)
})
