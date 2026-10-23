import { afterAll, describe, expect, test } from 'bun:test'
import { getKysely } from '../db.js'
import { metaDbQuery } from '../lib/db-metadata/_shared.js'
import { conceptVersion } from '../lib/learning/learning-concept-assessment.js'
import { GRADUAL_ASSESSMENT_REVISION } from '../lib/learning/learning-gradual-assessment.js'
import { LearningCurriculumStore } from './learning-curriculum-store.js'
import { LearningConceptAssessmentService, conceptFromGraphs } from './learning-concept-assessment.js'
import { LearningVectorTurnService } from './learning-vector-turn-service.js'

// The live hook's assessment lookup reads a run's small fields from its digest, which the
// insert trigger writes; reading them out of the ~240 kB snapshot cost ~1.6 s per turn.
describe.skipIf(!process.env.TEST_DATABASE_URL)('assessment run digest (learner_test)', () => {
  const userId = `digest-test-${crypto.randomUUID()}`
  const runId = crypto.randomUUID()
  const experimentId = crypto.randomUUID()
  afterAll(async () => {
    await metaDbQuery(`ALTER TABLE learning_concept_assessment_runs DISABLE TRIGGER learning_assessment_run_immutable`)
    await metaDbQuery(`ALTER TABLE learning_concept_assessment_receipts DISABLE TRIGGER learning_assessment_receipt_immutable`)
    try {
      await metaDbQuery(`DELETE FROM learning_concept_assessment_cache WHERE user_id=$1`, [userId])
      await metaDbQuery(`DELETE FROM learning_vector_turn_assessments WHERE experiment_id=$1`, [experimentId])
      await metaDbQuery(`DELETE FROM learning_vector_turn_experiments WHERE run_id=$1`, [experimentId])
      await metaDbQuery(`DELETE FROM learning_concept_assessment_receipts WHERE run_id=$1`, [runId])
      await metaDbQuery(`DELETE FROM learning_concept_assessment_runs WHERE run_id=$1`, [runId])
    } finally {
      await metaDbQuery(`ALTER TABLE learning_concept_assessment_runs ENABLE TRIGGER learning_assessment_run_immutable`)
      await metaDbQuery(`ALTER TABLE learning_concept_assessment_receipts ENABLE TRIGGER learning_assessment_receipt_immutable`)
    }
  })

  test('the insert trigger digests the snapshot, and both lookups answer from it', async () => {
    const store = new LearningCurriculumStore(await getKysely())
    const graphs = await store.listGraphs()
    const concept = conceptFromGraphs(graphs, graphs[0]!.concepts[0]!.id)
    const nodeVersion = conceptVersion(concept)
    const snapshot = { promptRevision: GRADUAL_ASSESSMENT_REVISION, context: { nodeStates: [{ ...concept, nodeVersion }] },
      evidence: [{ id: 'msg-1', text: 'x'.repeat(1000) }, { id: 'msg-2', text: 'y' }] }
    await metaDbQuery(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot) VALUES($1,$2,$1,$3,$4,$4,$5)`,
      [runId, userId, concept.conceptId, nodeVersion, JSON.stringify(snapshot)])
    const digest = (await metaDbQuery<Record<string, unknown>>(`SELECT * FROM learning_concept_assessment_run_digests WHERE run_id=$1`, [runId])).rows[0]
    expect(digest).toEqual({ run_id: runId, prompt_revision: GRADUAL_ASSESSMENT_REVISION, node_title: concept.title,
      node_description: concept.description, node_objectives: concept.objectives, evidence_ids: ['msg-1', 'msg-2'] })

    const assessment = { conceptId: concept.conceptId, nodeVersion, understandingPercent: 40, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'Explain it.', needsReview: false }
    await metaDbQuery(`INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2)`, [runId, JSON.stringify({ assessment })])
    await metaDbQuery(`INSERT INTO learning_vector_turn_experiments(run_id,user_id,status,config,snapshot) VALUES($1,$2,'completed','{}','{}')`, [experimentId, userId])
    await metaDbQuery(`INSERT INTO learning_vector_turn_assessments(experiment_id,concept_id,part,run_id) VALUES($1,$2,0,$3)`, [experimentId, concept.conceptId, runId])

    const assessments = new LearningConceptAssessmentService(store, {} as never)
    const projection = await new LearningVectorTurnService(await getKysely(), assessments, store).lookupAssessments(userId, graphs)
    expect(projection.experimentId).toBe(experimentId)
    expect(projection.assessments).toMatchObject([{ conceptId: concept.conceptId, runId, status: 'ready', sourceIds: ['msg-1', 'msg-2'] }])

    await metaDbQuery(`INSERT INTO learning_concept_assessment_cache(user_id,concept_id,node_version,input_hash,assessment,run_id) VALUES($1,$2,$3,$3,$4,$5)`,
      [userId, concept.conceptId, nodeVersion, JSON.stringify(assessment), runId])
    expect(await assessments.list(userId)).toMatchObject([{ conceptId: concept.conceptId, runId, sourceIds: ['msg-1', 'msg-2'] }])
  })
})
