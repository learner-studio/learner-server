import { z } from 'zod'
import { metaDbQuery as defaultQuery, type MetaPgQueryFn } from '../db-metadata/_shared.js'
import { holdAwaitsAccept, releaseReactiveHolds } from './learning-reactive-consolidation.js'
import { VECTORLESS_WITH_CONTENT_REASON } from './learning-semantic-index.js'

/**
 * Recovery of concepts the reactive breaker blocked. Blocked is deliberate for a
 * pass that reserved a paid model call (its receipts need review), so only
 * sessions whose last pass reserved NONE are released; the others are counted
 * and listed for an operator. Releasing marks only: the dispatcher then admits
 * them at the configured concurrency, the same rate as normal operation.
 */
export const ReactiveRecoveryPlan = z.object({
  userId: z.string(),
  concurrency: z.number(),
  waiting: z.number(),
  blocked: z.number(),
  releasableUnpaid: z.array(z.string()),
  blockedPaid: z.number(),
  blockedUnknown: z.number(),
  /** Arrivals whose routing retries are exhausted; apply gives them a fresh budget. */
  exhaustedHolds: z.number(),
  /** Exhausted arrivals held only on chunks flagged with text: apply leaves them; acceptLearningVectorlessChunks resolves them. */
  holdsAwaitingAccept: z.number().default(0),
  partsPerPass: z.number(),
  estimatedPaidCalls: z.number(),
})
export type ReactiveRecoveryPlan = z.infer<typeof ReactiveRecoveryPlan>

/** Recovery workflow schemas. */
export const RecoveryInput = z.object({ requestId: z.string().uuid(), apply: z.boolean().default(false), userId: z.string().optional() })
export const RecoveryStarted = z.object({ workflowRunId: z.string(), existing: z.boolean() })
export const RecoveryResult = z.object({ apply: z.boolean(), vectorless: z.array(z.string()), emptied: z.number(), withContent: z.array(z.string()).default([]), plan: ReactiveRecoveryPlan,
  released: z.number(), releasedHolds: z.number().default(0) })

export async function planReactiveRecovery(userId: string, q: MetaPgQueryFn = defaultQuery): Promise<ReactiveRecoveryPlan> {
  const setting = (await q<{ config: { concurrency?: number } }>('SELECT config FROM learning_reactive_settings WHERE user_id=$1', [userId])).rows[0]
  if (!setting) throw new Error('Reactive configuration missing')
  const blocked = (await q<{ session_id: string; dispatch_id: string | null; paid: number | null }>(`SELECT a.session_id,r.input::jsonb->>'dispatchId' AS dispatch_id,
      (SELECT count(*)::int FROM learning_vector_turn_assessments v JOIN learning_concept_assessment_attempts t USING(run_id)
        WHERE v.experiment_id::text=r.input::jsonb->>'dispatchId') AS paid
    FROM learning_reactive_admission a LEFT JOIN learner_workflow_runs r ON r.workflow_run_id=a.last_run_id::text
    WHERE a.user_id=$1 AND a.requested_generation>a.captured_generation AND a.attempts>=3 AND a.dispatch_id IS NULL ORDER BY a.session_id`, [userId])).rows
  const waiting = Number((await q<{ n: string }>('SELECT count(*) AS n FROM learning_reactive_admission WHERE user_id=$1 AND requested_generation>captured_generation AND attempts<3', [userId])).rows[0]?.n ?? 0)
  // Parts per settled live pass over the last 30 days: one paid call each, cache and dedupe hits aside.
  const parts = Number((await q<{ avg: string | null }>(`SELECT avg(n) AS avg FROM (SELECT count(*) n FROM learning_vector_turn_assessments v
      JOIN learning_vector_turn_experiments e ON e.run_id=v.experiment_id WHERE e.user_id=$1 AND e.config->>'purpose'='live' AND e.status='completed'
      AND e.created_at>now()-interval '30 days' GROUP BY v.experiment_id) passes`, [userId])).rows[0]?.avg ?? 1)
  const holds = (await q<{ releasable: string; awaiting: string }>(`SELECT count(*) FILTER(WHERE NOT ${holdAwaitsAccept('$2')}) AS releasable,
      count(*) FILTER(WHERE ${holdAwaitsAccept('$2')}) AS awaiting FROM learning_reactive_route_holds h WHERE h.user_id=$1 AND h.next_attempt_at IS NULL`,
    [userId, VECTORLESS_WITH_CONTENT_REASON])).rows[0]
  const exhaustedHolds = Number(holds?.releasable ?? 0), holdsAwaitingAccept = Number(holds?.awaiting ?? 0)
  const releasableUnpaid = blocked.filter(b => b.dispatch_id !== null && b.paid === 0).map(b => b.session_id)
  const partsPerPass = Math.round(parts * 100) / 100
  return {
    userId, concurrency: setting.config.concurrency ?? 9, waiting, blocked: blocked.length, releasableUnpaid,
    blockedPaid: blocked.filter(b => (b.paid ?? 0) > 0).length, blockedUnknown: blocked.filter(b => b.dispatch_id === null).length, exhaustedHolds, holdsAwaitingAccept,
    partsPerPass, estimatedPaidCalls: Math.ceil((waiting + releasableUnpaid.length) * partsPerPass),
  }
}

/** Reset the retry budget of the named sessions if they are still blocked, idle and unpaid AT THIS WRITE (a stale plan cannot release a paid one). Replaying it releases nothing twice. */
export async function releaseUnpaidReactiveSessions(userId: string, sessionIds: readonly string[], q: MetaPgQueryFn = defaultQuery) {
  if (!sessionIds.length) return { released: 0 }
  const result = await q(`UPDATE learning_reactive_admission SET attempts=0,last_failure=NULL,last_failed_at=NULL,unpaid_failures=0,waiting_since=now()
    WHERE user_id=$1 AND session_id=ANY($2::uuid[]) AND attempts>=3 AND dispatch_id IS NULL
      AND EXISTS(SELECT 1 FROM learner_workflow_runs r WHERE r.workflow_run_id=learning_reactive_admission.last_run_id::text
        AND NOT EXISTS(SELECT 1 FROM learning_vector_turn_assessments v JOIN learning_concept_assessment_attempts t USING(run_id)
          WHERE v.experiment_id::text=r.input::jsonb->>'dispatchId'))`, [userId, [...sessionIds]])
  return { released: result.rowCount ?? 0 }
}

/** Recovery's hold release: exhausted holds get a fresh budget, except those waiting only on chunks an operator must accept (round-2 N-S2). */
export const releaseRecoverableHolds = (userId: string, q: MetaPgQueryFn = defaultQuery) => releaseReactiveHolds(userId, true, q, { skipAwaitingAccept: true })
