import { z } from 'zod'
import { pikkuFunc, pikkuSessionlessFunc, pikkuVoidFunc } from '#pikku/function'
import { defineSessionlessFunction } from '../../runtime/define.js'
import { priorRun } from '../../runtime/start-once.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { ReactiveGradingHealth, StallCheckInput, StallCheckMeasured, StallCheckResult, STALL_VERDICT_PREFIX, ensureStallCheckRun, readReactiveGradingHealth } from '@learner/core/lib/learning/learning-reactive-health.js'
import { ReactiveRecoveryPlan, RecoveryInput, RecoveryStarted, planReactiveRecovery, releaseRecoverableHolds, releaseUnpaidReactiveSessions } from '@learner/core/lib/learning/learning-reactive-recovery.js'
import { ReactiveHoldRelease } from '@learner/core/lib/learning/learning-reactive-consolidation.js'
import { cancelWorkflowRuns } from '@learner/core/lib/workflow/workflow-runs.js'

/**
 * Stall detection and recovery for reactive grading, as durable workflow steps so
 * each one appears, with its input, output and failure reason, in the workflow
 * run tables and graph tooling. Runbook: docs/operations/reactive-grading-runbook.md.
 */

export const LearningGradingHealthInput = z.object({})
export const getLearningGradingHealth = pikkuFunc({
  title: 'Is reactive grading moving? Red when work has waited past the stall bound with nothing completed', expose: true, readonly: true, scopes: ['admin'],
  input: LearningGradingHealthInput, output: ReactiveGradingHealth,
  func: async ({ logger }, _data, { session }) => {
    // The API (not the worker) reads the stall check's own freshness, so a dead worker shows here.
    const health = await readReactiveGradingHealth(session.userId, undefined, { stallCheck: process.env.LEARNER_SCHEDULES_ENABLED === 'true' })
    if (health.status === 'error') logger.error(`[learning-grading] health error: ${health.messages.join(' | ')}`)
    return health
  },
})


export const measureLearningReactiveHealthStep = pikkuSessionlessFunc({
  title: 'Measure reactive routing and grading progress for each enabled owner', input: StallCheckInput, output: StallCheckMeasured,
  func: async (_services, { userId }) => {
    const owners = (await metaDbQuery<{ user_id: string }>('SELECT user_id FROM learning_reactive_settings WHERE ($1::text IS NULL OR user_id=$1) ORDER BY user_id', [userId ?? null])).rows
    return { owners: await Promise.all(owners.map(async o => ({ userId: o.user_id, ...await readReactiveGradingHealth(o.user_id) }))) }
  },
})

/** Fails (and so fails its workflow run, with the reason) when any owner's grading has stalled. */
// Still shared: its input has nested defaults, which Pikku's JSON-schema validation does not apply.
export const assertLearningReactiveMovingStep = defineSessionlessFunction({
  title: 'Fail when reactive grading has stalled', input: StallCheckMeasured, output: StallCheckResult,
  func: async ({ logger }, { owners }) => {
    const messages = owners.flatMap(o => o.messages.map(m => `${o.userId}: ${m}`))
    const status = owners.some(o => o.status === 'error') ? 'error' : owners.some(o => o.status === 'warning') ? 'warning' : 'ok'
    if (status === 'error') {
      logger.error({ event: 'learning-reactive-stalled', messages })
      throw new Error(`${STALL_VERDICT_PREFIX}${messages.join(' | ')}`)
    }
    if (status === 'warning') logger.warn({ event: 'learning-reactive-health-warning', messages })
    return { checked: owners.length, status, messages }
  },
})

export const scheduledLearningReactiveStallCheck = pikkuVoidFunc({
  func: async ({ workflowService, workflowRunService, locks, logger }, _data, { rpc }) => {
    await locks.withLock('learning-reactive', 'stall-check', async () => {
      const result = await ensureStallCheckRun(
        async () => (await rpc.startWorkflow('learningReactiveStallCheckWorkflow', {}, { wire: { type: 'scheduled' } })).runId,
        async runId => { const run = await workflowRunService.getRun(runId); if (run) await cancelWorkflowRuns(workflowService, [run]) })
      if (result.reclaimed.length) logger.warn({ event: 'learning-reactive-stall-check-reclaimed', reclaimed: result.reclaimed, started: result.started })
    })
  },
})


/** Start (or find) the recovery workflow for one request id. Dry run by default: it reconciles nothing and releases nothing. */
export const recoverLearningReactiveGrading = pikkuFunc({
  title: 'Recover stalled reactive grading: reconcile vectorless chunks, release concepts blocked before any paid call, route and admit', expose: true, scopes: ['admin'],
  input: RecoveryInput, output: RecoveryStarted,
  func: async ({ locks }, data, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    // Any prior run of this request id answers, whatever its status: a repeated request never starts a second paid recovery.
    return locks.withLock('learning-reactive', `recovery:${data.requestId}`, async () => {
      const input = { ...data, userId: session.userId }
      const prior = await priorRun('learningReactiveRecoveryWorkflow', input, 'requestId')
      if (prior) return { workflowRunId: prior.workflow_run_id, existing: true }
      return { workflowRunId: (await rpc.startWorkflow('learningReactiveRecoveryWorkflow', input, { wire: { type: 'internal', pikkuUserId: session.userId } })).runId, existing: false }
    })
  },
})

export const ReconcileLearningIndexVectorsInput = z.object({ apply: z.boolean() })
export const ReconcileLearningIndexVectorsOutput = z.object({ checked: z.number(), vectorless: z.array(z.string()), marked: z.number(), withContent: z.array(z.string()) })
export const reconcileLearningIndexVectorsStep = pikkuSessionlessFunc({
  title: 'Installation-wide: mark content-free indexed chunks the bank holds no vector for as empty; flag the ones with text', input: ReconcileLearningIndexVectorsInput,
  output: ReconcileLearningIndexVectorsOutput,
  func: async ({ learningSemanticIndex }, { apply }) => learningSemanticIndex.reconcileVectorlessChunks({ apply }),
})

export const LearningReactiveOwnerInput = z.object({ userId: z.string() })
// Still shared: as a native step its output type drops the zod defaults, and the recovery workflow returns it.
export const planLearningReactiveRecoveryStep = defineSessionlessFunction({
  title: 'Count blocked concepts, which are releasable (no paid call reserved), and the paid calls recovery would make', input: LearningReactiveOwnerInput, output: ReactiveRecoveryPlan,
  func: async (_services, { userId }) => planReactiveRecovery(userId),
})

export const ReleaseLearningReactiveUnpaidInput = z.object({ userId: z.string(), sessionIds: z.array(z.string().uuid()) })
export const ReleaseLearningReactiveUnpaidOutput = z.object({ released: z.number() })
export const releaseLearningReactiveUnpaidStep = pikkuSessionlessFunc({
  title: 'Reset the retry budget of concepts blocked before any paid call', input: ReleaseLearningReactiveUnpaidInput, output: ReleaseLearningReactiveUnpaidOutput,
  func: async ({ locks }, { userId, sessionIds }) => {
    if (learningAdmissionPaused()) throw new Error('Learning admission is paused; nothing released')
    return locks.withLock('learning-reactive', 'admission', () => releaseUnpaidReactiveSessions(userId, sessionIds))
  },
})

export const releaseLearningReactiveExhaustedHoldsStep = pikkuSessionlessFunc({
  title: 'Give arrivals that exhausted their routing retries a fresh budget, so the next route tries them again (not those held only on chunks awaiting accept)', input: LearningReactiveOwnerInput, output: ReactiveHoldRelease,
  func: async ({ locks }, { userId }) => locks.withLock('learning-reactive', 'routing', () => releaseRecoverableHolds(userId)),
})

/**
 * Resolve indexed chunks flagged as having text but no vector in the bank (round-2 review N-S2):
 * after reading their text, an operator accepts them as ungradable. They become `empty`, and the
 * routing holds waiting only on them are released. Installation-wide (the index has no owner).
 */
export const AcceptLearningVectorlessChunksInput = z.object({ chunkIds: z.array(z.string()).min(1).max(500) })
export const AcceptLearningVectorlessChunksOutput = z.object({ accepted: z.array(z.string()), notFlagged: z.array(z.string()), releasedHolds: z.number() })
export const acceptLearningVectorlessChunks = pikkuFunc({
  title: 'Accept flagged vectorless chunks with text as ungradable and release the arrivals held on them', expose: true, scopes: ['admin'],
  input: AcceptLearningVectorlessChunksInput,
  output: AcceptLearningVectorlessChunksOutput,
  func: async ({ learningSemanticIndex, locks, logger }, { chunkIds }) => {
    assertLearningLocalMvpEnabled()
    const result = await locks.withLock('learning-reactive', 'routing', () => learningSemanticIndex.acceptVectorlessChunks(chunkIds))
    logger.warn({ event: 'learning-vectorless-chunks-accepted', ...result })
    return result
  },
})
