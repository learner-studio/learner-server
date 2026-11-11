import { randomUUID } from 'node:crypto'
import { jsonbRoundTrip } from '@learner/core/lib/learning/grader-drift-panel.js'
import { ASSESSMENT_MODEL } from '@learner/core/lib/learning/learning-concept-assessment.js'
import { buildIncrementalAssessmentInput } from '@learner/core/lib/learning/learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from '@learner/core/lib/learning/learning-live-incremental-variant.js'

type Q = (sql: string, params?: unknown[]) => Promise<unknown>

/** Remove fixture learners' panel rows (LIKE pattern). Their readings stay: runs and receipts are immutable by trigger. */
export async function purgeDriftFixtures(q: Q, users: string) {
  for (const t of ['learning_drift_panel_regrades', 'learning_drift_panel_items', 'learning_drift_panels']) await q(`DELETE FROM ${t} WHERE user_id LIKE $1`, [users])
}

/**
 * One past prior-blind reading as the live grader leaves it: run (digest by trigger) and completed receipt. Every text
 * is synthetic. Returns the run id and the concept id, which a fake model's answer must name.
 */
export async function seedDriftReading(q: Q, userId: string, i: number, percent: number, opts: { shape?: 'live' | 'v5' } = {}) {
  const conceptId = `drift-c${i}-${userId.slice(6, 14)}`
  const concept = jsonbRoundTrip({ conceptId, title: `Synthetic concept ${i}`, description: 'Made up for the drift panel test.', objectives: ['explain', 'apply'] })
  // Fields outside the schema, as real evidence carries them: the grader sees them, so the regrade must too (review B1).
  const evidence = [jsonbRoundTrip({ id: `m-${i}-${userId}`, role: 'user', text: `Synthetic learner message number ${i} about caching`, occurredAt: '2026-11-02T10:00:00.000Z', conversationId: 'conv',
    authorship: 'human', logicalKey: `k-${i}`, sourceOrder: i, sourceVersion: 'v-synthetic', correlation: { provider: 'synthetic', messageId: `msg-${i}` } })]
  const built = buildIncrementalAssessmentInput(concept, evidence, null, [], LIVE_INCREMENTAL_VARIANT)
  const prompt = opts.shape === 'v5' ? `Learning assessment.\n\nINPUT:\n${JSON.stringify({ nodeStates: [concept], evidence })}` : built.prompt
  const runId = randomUUID()
  await q(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at) VALUES($1,$2,$1,$3,$4,$1,$5::jsonb,now() - interval '20 days')`,
    [runId, userId, conceptId, built.nodeVersion, JSON.stringify({ prompt, evidence, schema: built.schema, context: built.context, prior: null, model: ASSESSMENT_MODEL, promptRevision: LIVE_INCREMENTAL_VARIANT.revision })])
  await q(`INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,now() - interval '20 days')`, [runId, JSON.stringify({ status: 'completed',
    completedAt: new Date(Date.now() - 20 * 86_400_000).toISOString(), assessment: { conceptId, understandingPercent: percent, confidence: 'medium',
      demonstrated: [{ quote: 'Synthetic', sourceId: evidence[0]!.id, description: 'd' }], gaps: [], nextCheck: 'n', needsReview: true } })])
  return { runId, conceptId }
}
