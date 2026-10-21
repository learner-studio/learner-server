import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineFunction,defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { ArchiveClaimInput,ArchivePass,ArchiveEmpty,ArchiveStatus,ArchiveDispatchOutput } from '@learner/core/lib/learning/learning-archive-coordinator.js'
import { INDEX_SCOPE,indexCoalescer,markIndexDirty } from '@learner/core/lib/learning/learning-index-admission.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'

export const IndexDirtyInput=z.object({runId:z.string().uuid()})
export const IndexClaimInput=ArchiveClaimInput.partial().extend({runId:z.string().uuid()})
export const IndexPass=ArchivePass.nullable()
export const markLearningIndexDirtyStep=defineSessionlessFunction({input:IndexDirtyInput,output:ArchiveDispatchOutput,
  func:async({learningSemanticIndex},{runId})=>{
    if(learningSemanticIndex.scheduleEnabled) await markIndexDirty(runId)
    return {started:0}
  },
})
export const dispatchLearningIndexStep=defineSessionlessFunction({input:ArchiveEmpty,output:ArchiveDispatchOutput,
  func:async({learningSemanticIndex,workflowService},_data,{rpc})=>{
    if(learningAdmissionPaused() || !learningSemanticIndex.scheduleEnabled) return {started:0}
    return learningSemanticIndex.withStartLock(async()=>{
      // Adopt legacy in-flight indexing by waiting for it, never run beside it.
      const legacy=await metaDbQuery("SELECT 1 FROM learner_workflow_runs WHERE workflow='learningSemanticIndexWorkflow' AND status NOT IN ('completed','failed','cancelled','canceled') AND input::jsonb->>'dispatchId' IS NULL LIMIT 1")
      if(legacy.rows.length) return {started:0}
      return indexCoalescer.dispatchArchiveSessions(async data=>(await workflowService.startWorkflow('learningSemanticIndexWorkflow',data,{type:'scheduled'},rpc)).runId)
    })
  },
})
export const claimLearningIndexPassStep=defineSessionlessFunction({input:IndexClaimInput,output:IndexPass,
  func:async({learningSemanticIndex},input)=>input.dispatchId?learningSemanticIndex.withStartLock(()=>indexCoalescer.claimArchivePass(ArchiveClaimInput.parse(input))):null,
})
export const settleLearningIndexPassStep=defineSessionlessFunction({input:IndexPass,output:ArchiveDispatchOutput,
  func:async({learningSemanticIndex},input)=>input?learningSemanticIndex.withStartLock(()=>indexCoalescer.settleArchivePass(input)):{started:0},
})
export const getLearningIndexAdmission=defineFunction({expose:true,readonly:true,scopes:['admin'],input:ArchiveEmpty,output:ArchiveStatus,
  func:async({learningSemanticIndex})=>{learningSemanticIndex.assertEnabled();return indexCoalescer.archiveSessionStatus(INDEX_SCOPE.userId,INDEX_SCOPE.sessionId)},
})
export const retryLearningIndexAdmission=defineFunction({expose:true,scopes:['admin'],input:ArchiveEmpty,output:ArchiveStatus,
  func:async({learningSemanticIndex},_data,{rpc})=>{
    learningSemanticIndex.assertEnabled()
    await learningSemanticIndex.withStartLock(async()=>{
      const state=await indexCoalescer.archiveSessionStatus(INDEX_SCOPE.userId,INDEX_SCOPE.sessionId)
      if(state.state!=='blocked') throw new Error('Only a blocked index lane can be repaired; live runs are never reset')
      await learningSemanticIndex.retryFailedOperations()
      await indexCoalescer.retryArchiveSession(INDEX_SCOPE.userId,INDEX_SCOPE.sessionId)
    })
    await rpc.invoke('dispatchLearningIndexStep',{})
    return indexCoalescer.archiveSessionStatus(INDEX_SCOPE.userId,INDEX_SCOPE.sessionId)
  },
})
