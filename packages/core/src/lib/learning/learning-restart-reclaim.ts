import { llmBackendCost } from '@learner/llm/lib/llm/backend-cost.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import { assessmentHash } from './learning-concept-assessment.js'
import { assessmentAttemptKey, attemptTakeovers, MAX_ATTEMPT_TAKEOVERS } from './llm-attempt-lease.js'

/**
 * Of the paid parts reservedPaidAttempts counts for a live pass, how many a NEW pass repairs by itself with nothing
 * paid twice (docs/operations/restart-safety.md):
 *  - a reserved part whose receipt is completed/unchanged/no_evidence: the new pass reuses it ('unchanged');
 *  - a reserved part with no receipt, on a repeat-free backend, takeovers left: the new pass's paid-attempt fence
 *    finishes it for its dead owner (learning-concept-assessment.ts driveReserved);
 *  - a part the fence refused as 'uncertain' whose holder now has a completed receipt, or is itself repairable.
 * A failed paid receipt, a metered unknown, and a spent takeover budget are NOT repairable: those still block.
 * Reusing a known receipt costs nothing on any backend; finishing an UNKNOWN outcome needs a repeat-free one.
 */
export async function restartRepairableParts(dispatchId: string, q: MetaPgQueryFn): Promise<number> {
  type Part = { run_id: string; user_id: string; concept_id: string; input_hash: string; backend: string | null; reserved: boolean; status: string | null }
  const parts = (await q<Part>(`SELECT v.run_id, r.user_id, r.concept_id, r.input_hash, r.snapshot#>>'{model,backend}' AS backend,
      a.run_id IS NOT NULL AS reserved, t.receipt->>'status' AS status
    FROM learning_vector_turn_assessments v JOIN learning_concept_assessment_runs r USING(run_id)
    LEFT JOIN learning_concept_assessment_attempts a USING(run_id) LEFT JOIN learning_concept_assessment_receipts t USING(run_id)
    WHERE v.experiment_id=$1::uuid AND (a.run_id IS NOT NULL OR t.receipt->>'status'='uncertain')`, [dispatchId])).rows
  if (!parts.length) return 0
  const free = (backend: string | null) => llmBackendCost(backend).repeatIsFree
  const reusable = (status: string | null) => status === 'completed' || status === 'unchanged' || status === 'no_evidence'
  // The holder of each fence-refused part: the run that reserved the identical input.
  const holders = new Map<string, { run_id: string; backend: string | null; status: string | null }>()
  for (const part of parts.filter((p) => !p.reserved)) {
    const scope = assessmentHash([part.user_id, part.concept_id, part.input_hash])
    const holder = (await q<{ run_id: string; backend: string | null; status: string | null }>(`SELECT a.run_id, r.snapshot#>>'{model,backend}' AS backend, t.receipt->>'status' AS status
      FROM learning_concept_assessment_attempts a JOIN learning_concept_assessment_runs r USING(run_id) LEFT JOIN learning_concept_assessment_receipts t USING(run_id) WHERE a.scope_key=$1`, [scope])).rows[0]
    if (holder) holders.set(part.run_id, holder)
  }
  const unknownRuns = [...parts.filter((p) => p.reserved && !p.status).map((p) => p.run_id), ...[...holders.values()].filter((h) => !h.status).map((h) => h.run_id)]
  const takeovers = await attemptTakeovers(q, unknownRuns.map(assessmentAttemptKey))
  const repairableUnknown = (runId: string, backend: string | null) => free(backend) && (takeovers.get(assessmentAttemptKey(runId)) ?? 0) < MAX_ATTEMPT_TAKEOVERS
  let repairable = 0
  for (const part of parts) {
    if (part.reserved) {
      if (reusable(part.status) || (!part.status && repairableUnknown(part.run_id, part.backend))) repairable++
      continue
    }
    const holder = holders.get(part.run_id)
    if (!holder) continue
    if (holder.status === 'completed' || (!holder.status && repairableUnknown(holder.run_id, holder.backend))) repairable++
  }
  return repairable
}

/** How many times a blocked concept was released automatically; a fourth would mean the release does not heal it. */
export const MAX_AUTOMATIC_RELEASES = 3
export const releaseKey = (userId: string, sessionId: string) => `reactive-target:${userId}:${sessionId}`
