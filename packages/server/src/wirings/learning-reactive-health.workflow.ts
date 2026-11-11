import { defineWorkflow } from '../runtime/define.js'
import { StallCheckInput, StallCheckResult } from '@learner/core/lib/learning/learning-reactive-health.js'
import { RecoveryInput, RecoveryResult } from '@learner/core/lib/learning/learning-reactive-recovery.js'

/**
 * Scheduled every 15 minutes (SCHEDULES: learning-reactive-stall-check). A stalled
 * pipeline fails the second step, so a failed run of this workflow, with the
 * stall reason as its step error, is the alarm.
 */
export const learningReactiveStallCheckWorkflow = defineWorkflow({
  title: 'Check that reactive routing and grading are moving', input: StallCheckInput, output: StallCheckResult,
  func: async ({}, data, { workflow }) => {
    const measured = await workflow.do('Measure reactive grading progress', 'measureLearningReactiveHealthStep', data, { retries: 2, retryDelay: '5s' })
    const result = await workflow.do('Fail when grading has stalled', 'assertLearningReactiveMovingStep', measured, { retries: 0 })
    // Each step call stays a plain `const x = await` statement: one nested in an expression is invisible to the step graph.
    return StallCheckResult.parse(result)
  },
})

/**
 * Recovery after a stall (runbook). Dry run (apply false) only measures. With
 * apply it marks content-free vectorless chunks empty (installation-wide), releases
 * concepts whose blocked pass reserved no paid call and arrivals whose routing
 * retries are exhausted, then routes and admits at the configured concurrency.
 * Every step is idempotent: a replay reconciles, releases and routes nothing twice.
 */
export const learningReactiveRecoveryWorkflow = defineWorkflow({
  title: 'Recover stalled reactive grading', input: RecoveryInput, output: RecoveryResult,
  func: async ({}, data, { workflow }) => {
    const userId = data.userId!
    const apply = data.apply ?? false
    const index = await workflow.do('Reconcile indexed chunks without vectors', 'reconcileLearningIndexVectorsStep', { apply }, { retries: 1, retryDelay: '5s' })
    const plan = await workflow.do('Plan release of blocked concepts', 'planLearningReactiveRecoveryStep', { userId }, { retries: 1, retryDelay: '5s' })
    let release = { released: 0 }
    let holds = { released: 0 }
    if (apply) {
      release = await workflow.do('Release concepts blocked before any paid call', 'releaseLearningReactiveUnpaidStep', { userId, sessionIds: plan.releasableUnpaid }, { retries: 1, retryDelay: '5s' })
      holds = await workflow.do('Release arrivals that exhausted their routing retries', 'releaseLearningReactiveExhaustedHoldsStep', { userId }, { retries: 1, retryDelay: '5s' })
      await workflow.do('Route pending indexed messages', 'routeLearningReactiveArrivalsStep', {}, { retries: 2, retryDelay: '5s' })
      await workflow.do('Admit at the configured concurrency', 'dispatchLearningReactiveConceptsStep', {}, { retries: 2, retryDelay: '1s' })
    }
    return { apply, vectorless: index.vectorless, emptied: index.marked, withContent: index.withContent, plan, released: release.released, releasedHolds: holds.released }
  },
})
