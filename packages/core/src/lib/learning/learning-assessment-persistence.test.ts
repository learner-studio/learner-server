import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { persistAssessmentCache } from './learning-assessment-persistence.js'
import { assessmentHash, type AssessmentConcept } from './learning-concept-assessment.js'

test.skipIf(process.env.LEARNING_ASSESSMENT_DB_TEST !== 'true')('real DB cache publication rejects older runs and changed concepts, preserves unknown, and immutable receipts reject rewrites (rollback)', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()
  await client.query('BEGIN')
  try {
    const row = (await client.query<{ id: string; title: string; summary: string; explanation: string }>('SELECT id,title,summary,explanation FROM learning_concepts ORDER BY id LIMIT 1')).rows[0]!
    const goals = (await client.query<{ goal: string }>(`SELECT DISTINCT goal FROM learning_curriculum_module_concepts membership
      JOIN learning_curriculum_modules module ON module.curriculum_id=membership.curriculum_id AND module.id=membership.module_id
      CROSS JOIN LATERAL jsonb_array_elements_text(module.mastery_goals) goal WHERE membership.concept_id=$1 ORDER BY goal`, [row.id])).rows.map(item => item.goal)
    const concept: AssessmentConcept = { conceptId: row.id, title: row.title, description: row.summary+'\n'+row.explanation, objectives: goals }
    const userId = 'rollback-assessment-'+randomUUID()
    const runId = randomUUID()
    const oldId = randomUUID()
    const nodeVersion = assessmentHash(concept)
    for (const [id, createdAt] of [[oldId,'2026-01-01'],[runId,'2026-01-02']]) await client.query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at)
      VALUES($1,$2,$1,$3,$4,$4,'{}',$5)`, [id,userId,row.id,nodeVersion,createdAt])
    const assessment = { conceptId: row.id, nodeVersion, understandingPercent: null, confidence: 'insufficient' as const, demonstrated: [], gaps: [], nextCheck: 'Explain this concept independently.', needsReview: true as const }
    const input = { userId, concept, nodeVersion, inputHash: nodeVersion, runId, assessment, completedAt: new Date().toISOString() }
    const query = (text: string, params: ReadonlyArray<unknown>) => client.query(text, [...params])
    expect((await persistAssessmentCache(query, input)).rowCount).toBe(1)
    expect((await client.query('SELECT assessment FROM learning_concept_assessment_cache WHERE user_id=$1', [userId])).rows[0].assessment.understandingPercent).toBeNull()
    expect((await persistAssessmentCache(query, { ...input, runId: oldId })).rowCount).toBe(0)
    expect((await persistAssessmentCache(query, { ...input, concept: { ...concept, title: 'Changed title' } })).rowCount).toBe(0)
    expect((await persistAssessmentCache(query, { ...input, concept: { ...concept, objectives: ['Changed objective'] } })).rowCount).toBe(0)
    await client.query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt) VALUES($1,$2)', [runId,JSON.stringify({ assessment })])
    await client.query('SAVEPOINT immutable_check')
    await expect(client.query("UPDATE learning_concept_assessment_receipts SET receipt='{}' WHERE run_id=$1", [runId])).rejects.toThrow('immutable')
    await client.query('ROLLBACK TO SAVEPOINT immutable_check')
    expect((await client.query('SELECT run_id FROM learning_concept_assessment_cache WHERE user_id=$1', [userId])).rows[0].run_id).toBe(runId)
  } finally {
    await client.query('ROLLBACK')
    await client.end()
  }
})
