import { z } from 'zod'
import { defineFunction, defineSessionlessFunction, defineVoidFunction } from '../../runtime/define.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { ReactiveGradingHealth, StallCheckInput, StallCheckMeasured, StallCheckResult, ensureStallCheckRun, readReactiveGradingHealth } from '@learner/core/lib/learning/learning-reactive-health.js'
import { ReactiveRecoveryPlan, RecoveryInput, RecoveryStarted, planReactiveRecovery, releaseUnpaidReactiveSessions } from '@learner/core/lib/learning/learning-reactive-recovery.js'
import { ReactiveHoldRelease, releaseReactiveHolds } from '@learner/core/lib/learning/learning-reactive-consolidation.js'
import { cancelWorkflowRuns } from '@learner/core/lib/workflow/workflow-runs.js'

/**
 * Stall detection and recovery for reactive grading, as durable workflow steps so
 * each one appears, with its input, output and failure reason, in the workflow
 * run tables and graph tooling. Runbook: docs/operations/reactive-grading-runbook.md.
 */

export const getLearningGradingHealth = defineFunction({
  title: 'Is reactive grading moving? Red when work has waited past the stall bound with nothing completed', expose: true, readonly: true, scopes: ['admin'],
  input: z.object({}), output: ReactiveGradingHealth,
  func: async ({ logger }, _data, { session }) => {
    // The API (not the worker) reads the stall check's own freshness, so a dead worker shows here.
    const health = await readReactiveGradingHealth(session.userId, undefined, { stallCheck: process.env.LEARNER_SCHEDULES_ENABLED === 'true' })
    if (health.status === 'error') logger.error(`[learning-grading] health error: ${health.messages.join(' | ')}`)
    return health
  },
})


export const measureLearningReactiveHealthStep = defineSessionlessFunction({
  title: 'Measure reactive routing and grading progress for each enabled owner', input: StallCheckInput, output: StallCheckMeasured,
  func: async (_services, { userId }) => {
    const owners = (await metaDbQuery<{ user_id: string }>('SELECT user_id FROM learning_reactive_settings WHERE ($1::text IS NULL OR user_id=$1) ORDER BY user_id', [userId ?? null])).rows
    return { owners: await Promise.all(owners.map(async o => ({ userId: o.user_id, ...await readReactiveGradingHealth(o.user_id) }))) }
  },
})

/** Fails (and so fails its workflow run, with the reason) when any owner's grading has stalled. */
export const assertLearningReactiveMovingStep = defineSessionlessFunction({
  title: 'Fail when reactive grading has stalled', input: StallCheckMeasured, output: StallCheckResult,
  func: async ({ logger }, { owners }) => {
    const messages = owners.flatMap(o => o.messages.map(m => `${o.userId}: ${m}`))
    const status = owners.some(o => o.status === 'error') ? 'error' : owners.some(o => o.status === 'warning') ? 'warning' : 'ok'
    if (status === 'error') {
      logger.error({ event: 'learning-reactive-stalled', messages })
      throw new Error(`Reactive grading stalled: ${messages.join(' | ')}`)
    }
    if (status === 'warning') logger.warn({ event: 'learning-reactive-health-warning', messages })
    return { checked: owners.length, status, messages }
  },
})

export const scheduledLearningReactiveStallCheck = defineVoidFunction({
  func: async ({ workflowService, workflowRunService, locks, logger }, _data, ctx) => {
    await locks.withLock('learning-reactive', 'stall-check', async () => {
      const result = await ensureStallCheckRun(
        async () => (await workflowService.startWorkflow('learningReactiveStallCheckWorkflow', {}, { type: 'scheduled' }, ctx!.rpc)).runId,
        async runId => { const run = await workflowRunService.getRun(runId); if (run) await cancelWorkflowRuns(workflowService, [run]) })
      if (result.reclaimed.length) logger.warn({ event: 'learning-reactive-stall-check-reclaimed', reclaimed: result.reclaimed, started: result.started })
    })
  },
})


/** Start (or find) the recovery workflow for one request id. Dry run by default: it reconciles nothing and releases nothing. */
export const recoverLearningReactiveGrading = defineFunction({
  title: 'Recover stalled reactive grading: reconcile vectorless chunks, release concepts blocked before any paid call, route and admit', expose: true, scopes: ['admin'],
  input: RecoveryInput, output: RecoveryStarted,
  func: async ({ workflowService, locks }, data, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    return locks.withLock('learning-reactive', `recovery:${data.requestId}`, async () => {
      const prior = (await metaDbQuery<{ workflow_run_id: string }>("SELECT workflow_run_id FROM learner_workflow_runs WHERE workflow='learningReactiveRecoveryWorkflow' AND input::jsonb->>'requestId'=$1 ORDER BY created_at LIMIT 1", [data.requestId])).rows[0]
      if (prior) return { workflowRunId: prior.workflow_run_id, existing: true }
      const { runId } = await workflowService.startWorkflow('learningReactiveRecoveryWorkflow', { ...data, userId: session.userId }, { type: 'internal', userId: session.userId }, rpc)
      return { workflowRunId: runId, existing: false }
    })
  },
})

export const reconcileLearningIndexVectorsStep = defineSessionlessFunction({
  title: 'Installation-wide: mark content-free indexed chunks the bank holds no vector for as empty; flag the ones with text', input: z.object({ apply: z.boolean() }),
  output: z.object({ checked: z.number(), vectorless: z.array(z.string()), marked: z.number(), withContent: z.array(z.string()) }),
  func: async ({ learningSemanticIndex }, { apply }) => learningSemanticIndex.reconcileVectorlessChunks({ apply }),
})

export const planLearningReactiveRecoveryStep = defineSessionlessFunction({
  title: 'Count blocked concepts, which are releasable (no paid call reserved), and the paid calls recovery would make', input: z.object({ userId: z.string() }), output: ReactiveRecoveryPlan,
  func: async (_services, { userId }) => planReactiveRecovery(userId),
})

export const releaseLearningReactiveUnpaidStep = defineSessionlessFunction({
  title: 'Reset the retry budget of concepts blocked before any paid call', input: z.object({ userId: z.string(), sessionIds: z.array(z.string().uuid()) }), output: z.object({ released: z.number() }),
  func: async ({ locks }, { userId, sessionIds }) => {
    if (learningAdmissionPaused()) throw new Error('Learning admission is paused; nothing released')
    return locks.withLock('learning-reactive', 'admission', () => releaseUnpaidReactiveSessions(userId, sessionIds))
  },
})

export const releaseLearningReactiveExhaustedHoldsStep = defineSessionlessFunction({
  title: 'Give arrivals that exhausted their routing retries a fresh budget, so the next route tries them again', input: z.object({ userId: z.string() }), output: ReactiveHoldRelease,
  func: async ({ locks }, { userId }) => locks.withLock('learning-reactive', 'routing', () => releaseReactiveHolds(userId, true)),
})
