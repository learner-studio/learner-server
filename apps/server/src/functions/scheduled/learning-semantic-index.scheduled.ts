export const LearningMaintenanceInput = z.object({})
import { z } from 'zod'
import { enqueueLearningMaintenance } from '@learner/core/lib/learning/learning-maintenance.js'
import { defineVoidFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { markIndexDirty,INDEX_SCOPE,indexCoalescer } from '@learner/core/lib/learning/learning-index-admission.js'

export const scheduledLearningSemanticIndexOperation = defineSessionlessFunction({
  input: LearningMaintenanceInput,
  title: 'Index late canonical arrivals and revisions',
  func: async ({ learningSemanticIndex }, _data, { rpc }) => {
    if (!learningSemanticIndex.scheduleEnabled) return
    const state=await indexCoalescer.archiveSessionStatus(INDEX_SCOPE.userId,INDEX_SCOPE.sessionId)
    if(state.state==='idle' && await learningSemanticIndex.hasPendingChanges()) await markIndexDirty(crypto.randomUUID())
    await rpc.invoke('dispatchLearningIndexStep',{})
  },
})

export const scheduledLearningSemanticIndex=defineVoidFunction({
  func:async({queueService,queueCancellationService,locks})=>{
    await enqueueLearningMaintenance(queueService,queueCancellationService,locks,'index')
  },
})
