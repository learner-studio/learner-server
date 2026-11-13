import { afterAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { sql } from 'kysely'
import { ownTestDatabaseUrl } from '@learner/core/db/own-test-database.js'
import { LearningExposureService } from '@learner/core/services/learning-exposure-service.js'
import { LearningLosslessArchiveService } from '@learner/core/services/learning-lossless-archive-service.js'
import { archivePlaygroundTurn } from '@learner/core/lib/learning/learning-playground-archive.js'
import { LearningExposureObservation } from '@learner/core/lib/learning/learning-exposure-schemas.js'
import { canonicalSemanticMessage } from '@learner/core/lib/learning/learning-semantic-index.js'
import { VectorTurnConfig, reconstructVectorTurns, vectorRunMetadata, type VectorMessage } from '@learner/core/lib/learning/learning-vector-turns.js'
import { LIVE_INCREMENTAL_VARIANT } from '@learner/core/lib/learning/learning-live-incremental-variant.js'
import { COMPUTER_SCIENCE } from '@learner/core/functions/learning/computer-science-seed.js'
import { bootRuntime } from './runtime-harness.js'

/**
 * A live vector-turn pass stores message REFERENCES, not text (2026-11-13: ~1.1 MB of copied text per pass, 2.9 GB/day).
 * learningVectorTurnWorkflow runs a pass twice on the framework runtime: once as this code stores it, once as the
 * previous code stored it (whole messages, i.e. a pass in flight across the deploy). Both must hand the model the
 * same input, so the second is reused as `unchanged` with one paid call in all. Selection (embeddings, vector bank)
 * and the model are stubbed; the messages are real canonical rows. Its own database; every text is synthetic.
 */
const url = await ownTestDatabaseUrl('vte')
describe.skipIf(!url)('vector-turn pass stores message references (learner_vte_test_<checkout>)', () => {
  const runtime = bootRuntime({ schemaPrefix: 'lp_boss_vte_', databaseUrl: url! })
  afterAll(() => runtime.stop(), 60_000)

  test('a new pass row carries no text, and grades exactly what a whole-message pass grades', async () => {
    const services = await runtime.booted
    const userId = `vte-${randomUUID()}`, conversationId = randomUUID()
    const words = [`synthetic question ${randomUUID()}`, `synthetic answer ${randomUUID()}`, `synthetic follow-up ${randomUUID()}`, `synthetic reply ${randomUUID()}`]
    // Canonical rows exactly as indexing writes them (learning-semantic-index-service freeze), status indexed.
    const archive = new LearningLosslessArchiveService(services.kysely), exposure = new LearningExposureService(services.kysely)
    for (const [i, at] of ['2026-10-01T12:00:00.000Z', '2026-10-01T12:05:00.000Z'].entries()) {
      const turn = await archivePlaygroundTurn(archive, exposure, { requestId: randomUUID(), conversationId, userId, provider: 'codex', message: words[2 * i]!, response: words[2 * i + 1]!, receivedAt: at })
      for (const id of turn.observationIds) {
        const raw = (await sql<{ payload: unknown }>`SELECT payload FROM learning_exposure_observations WHERE observation_id=${id}::uuid`.execute(services.kysely)).rows[0]!
        const observation = LearningExposureObservation.parse(raw.payload), m = canonicalSemanticMessage(observation, turn.rawVersionId)
        await sql`INSERT INTO learning_semantic_index_messages(message_id,observation_id,logical_message_key,raw_version_id,conversation_id,role,observed_at,payload,source_text,source_sha256,parts,media_count,status)
          VALUES(${m.messageId},${m.observationId}::uuid,${m.logicalMessageKey},${m.rawVersionId}::uuid,${m.conversationId},${m.role},${m.observedAt}::timestamptz,${JSON.stringify(observation)}::jsonb,
            ${m.text},${m.sourceSha256},${JSON.stringify(m.parts)}::jsonb,0,'indexed')`.execute(services.kysely)
      }
    }
    await services.learningCurriculumStore.syncSeed(COMPUTER_SCIENCE)
    const conceptId = COMPUTER_SCIENCE.concepts[0]!.id
    const concept = await services.learningConceptAssessment.concept(conceptId)
    const config = VectorTurnConfig.parse({ purpose: 'live', selection: 'all', incremental: true, concurrency: 1, conceptIds: [conceptId], datasetTag: 'live', priorMode: 'cold' })
    // What evidence selection returns (its vector search stubbed): the previous code stored this object whole.
    const select = async (runId: string) => {
      const messages = (await sql<VectorMessage>`SELECT message_id AS id,conversation_id AS "conversationId",role,source_text AS text,
        observed_at::text AS "occurredAt",logical_message_key AS "logicalKey",payload->>'authorship' AS authorship,payload->'correlation' AS correlation,
        COALESCE((payload->'correlation'->>'sourceOrder')::float8,0) AS "sourceOrder",raw_version_id::text AS "sourceVersion"
        FROM learning_semantic_index_messages WHERE conversation_id=${conversationId} ORDER BY observed_at`.execute(services.kysely)).rows
      // The native-chain anchor selection adds to a reply: it is not in the stored payload.
      for (const [i, m] of messages.entries()) if (m.role === 'assistant') m.correlation = { ...m.correlation, parentLogicalMessageKey: messages[i - 1]!.logicalKey }
      const turns = reconstructVectorTurns(messages)
      const parts = [messages.map((m) => m.id)]
      return { messages, batches: [[{ conceptId, part: 0 }]], counts: { messages: messages.length, chunks: messages.length, turns: turns.length, unpaired: 0 },
        metadata: vectorRunMetadata(runId, config, 'fixture', LIVE_INCREMENTAL_VARIANT.revision),
        selections: [{ concept, matchingChunks: 4, matchingMessages: 4, matchingTurns: turns.length, bankMatchingUnits: 4, exhaustive: true, turns, parts, covered: [], context: [] }] }
    }
    services.learningVectorTurns.selectEvidence = (_config: unknown, _user: string, runId: string) => select(runId)
    let paid = 0
    services.llmService.callLLMWithStructuredOutput = async () => {
      paid++
      return [{ conceptId, nodeVersion: (await sql<{ v: string }>`SELECT node_version AS v FROM learning_concept_assessment_runs WHERE user_id=${userId} LIMIT 1`.execute(services.kysely)).rows[0]!.v,
        understandingPercent: 40, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: true }]
    }
    const pass = async (runId: string) => {
      const workflowRunId = await runtime.start('learningVectorTurnWorkflow', { runId })
      expect((await runtime.awaitRun(workflowRunId))?.status).toBe('completed')
      return (await sql<{ inputHash: string; prompt: unknown; evidence: unknown; status: string; assessment: unknown }>`SELECT r.input_hash AS "inputHash",r.snapshot->'prompt' AS prompt,
        r.snapshot->'evidence' AS evidence,t.receipt->>'status' AS status,t.receipt->'assessment' AS assessment FROM learning_vector_turn_assessments a
        JOIN learning_concept_assessment_runs r USING(run_id) JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.experiment_id=${runId}::uuid`.execute(services.kysely)).rows[0]!
    }
    const stored = async (runId: string) => (await sql<{ text: string; bytes: number; messages: Array<Record<string, unknown>> }>`SELECT snapshot::text AS text,
      pg_column_size(snapshot) AS bytes,snapshot->'messages' AS messages FROM learning_vector_turn_experiments WHERE run_id=${runId}::uuid`.execute(services.kysely)).rows[0]!

    // This code: the pass row names each message by id and version; the only extra field is the reply's anchor.
    const fresh = randomUUID()
    await services.learningVectorTurns.create(fresh, userId, config)
    const graded = await pass(fresh)
    const row = await stored(fresh)
    for (const w of words) expect(row.text).not.toContain(w)
    expect(row.messages.map((m) => Object.keys(m).sort().join())).toEqual(['id,sourceVersion', 'id,parentLogicalMessageKey,sourceVersion', 'id,sourceVersion', 'id,parentLogicalMessageKey,sourceVersion'])
    console.log(`[vte] new-format pass row: ${row.bytes} bytes for ${row.messages.length} messages`)
    // The model saw the full canonical text, re-read from the rows the references name.
    expect(graded.evidence).toEqual((await select(fresh)).messages)
    expect(graded.status).toBe('completed')
    // A worker killed after the part's run was written but before its link: the replay re-reads the same inputs.
    const link = (await sql<{ runId: string }>`DELETE FROM learning_vector_turn_assessments WHERE experiment_id=${fresh}::uuid RETURNING run_id AS "runId"`.execute(services.kysely)).rows[0]!
    expect(await services.learningVectorTurns.preparePart(fresh, conceptId, 0)).toEqual({ runId: link.runId })

    // The previous code's row (whole messages): same model input, so it is reused with no second paid call.
    const whole = randomUUID()
    await services.learningVectorTurns.create(whole, userId, config)
    const before = await select(whole)
    await sql`UPDATE learning_vector_turn_experiments SET snapshot=${JSON.stringify(before)}::jsonb,status='running' WHERE run_id=${whole}::uuid`.execute(services.kysely)
    const reused = await pass(whole)
    console.log(`[vte] whole-message pass row: ${(await stored(whole)).bytes} bytes`)
    expect({ inputHash: reused.inputHash, prompt: reused.prompt, evidence: reused.evidence }).toEqual({ inputHash: graded.inputHash, prompt: graded.prompt, evidence: graded.evidence })
    expect([reused.status, paid]).toEqual(['unchanged', 1])
    expect(reused.assessment).toEqual(graded.assessment)

    // A reference whose version no longer matches its row is refused, never graded on other text.
    const moved = randomUUID()
    await services.learningVectorTurns.create(moved, userId, config)
    await services.learningVectorTurns.prepare(moved)
    await sql`UPDATE learning_vector_turn_experiments SET snapshot=jsonb_set(snapshot,'{messages,0,sourceVersion}','"00000000-0000-0000-0000-000000000000"') WHERE run_id=${moved}::uuid`.execute(services.kysely)
    await expect(services.learningVectorTurns.preparePart(moved, conceptId, 0)).rejects.toThrow('missing from the immutable snapshot')
  }, 180_000)
})
