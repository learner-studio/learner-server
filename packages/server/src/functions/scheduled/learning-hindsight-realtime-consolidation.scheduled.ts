import { defineVoidFunction } from '../../runtime/define.js'
import { hindsightRealtimeConsolidationConfig } from '@learner/core/lib/learning/hindsight-realtime-consolidation.js'

/**
 * Reconciliation is deliberately inert until the seed workflow owns and passes
 * completed derived-fact projection receipts. It never reads raw archives.
 */
export const scheduledLearningHindsightRealtimeConsolidationReconciliation = defineVoidFunction({
  title: 'Scheduled: Hindsight realtime consolidation reconciliation',
  func: async ({}, _data, { scheduledTask }) => {
    const config = hindsightRealtimeConsolidationConfig()
    if (!config.enabled) {
      scheduledTask?.skip('Hindsight realtime consolidation is disabled or lacks dedicated runtime/bank configuration')
      return
    }
    scheduledTask?.skip('Completed derived-fact projection hook is not wired yet; refusing raw archive or inferred work')
  },
})
