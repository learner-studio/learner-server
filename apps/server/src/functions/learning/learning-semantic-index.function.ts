import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { isRunActive } from '@learner/core/lib/workflow/workflow-runs.js'
import { INDEX_SCOPE,indexCoalescer,markIndexDirty } from '@learner/core/lib/learning/learning-index-admission.js'
import { LearningIndexStatus, LearningIndexRunInput, LearningIndexBatch, LearningSemanticHit, LearningSemanticHydration,
  LearningIndexFreezeInput, LearningIndexPlan, LearningIndexOperationInput, LearningIndexOperationOutput } from '@learner/core/lib/learning/learning-semantic-index.js'

export const EmptyLearningIndexInput = z.object({})
export const StartLearningIndexInput = z.object({ maxMessages: z.number().int().min(1).max(100).optional() })
export const SearchLearningIndexInput = z.object({ query: z.string().min(1).max(4000), limit: z.number().int().min(1).max(50).default(12), conversationId: z.string().optional() })
export const SearchLearningIndexOutput = z.object({ hits: z.array(LearningSemanticHit) })
export const HydrateLearningIndexInput = z.object({ chunkId: z.string().regex(/^[a-f0-9]{64}$/) })

export const getLearningIndexStatus = defineFunction({
  title: 'Inspect canonical Learning semantic index coverage', expose: true, readonly: true, scopes: ['admin'],
  input: EmptyLearningIndexInput, output: LearningIndexStatus,
  func: async ({ learningSemanticIndex }) => learningSemanticIndex.status(),
})
export const startLearningIndex = defineFunction({
  title: 'Index canonical Learning messages with the local BGE model', expose: true, audit: true, scopes: ['admin'],
  input: StartLearningIndexInput, output: LearningIndexRunInput,
  func: async ({ learningSemanticIndex, workflowRunService, workflowService }, input, { session, rpc }) => {
    if (learningAdmissionPaused()) throw new Error('Learning admission is paused')
    learningSemanticIndex.assertEnabled()
    if(learningSemanticIndex.scheduleEnabled) {
      if(input.maxMessages) throw new Error('Bounded index probes require realtime scheduling disabled; live indexing covers all canonical messages')
      await markIndexDirty(crypto.randomUUID())
      await rpc.invoke('dispatchLearningIndexStep',{})
      const state=await indexCoalescer.archiveSessionStatus(INDEX_SCOPE.userId,INDEX_SCOPE.sessionId)
      if(!state.runId) throw new Error(`Index request is durably ${state.state}; inspect getLearningIndexAdmission`)
      return {runId:state.runId}
    }
    return learningSemanticIndex.withStartLock(async () => {
      const runs = await workflowRunService.listRuns({ workflowName: 'learningSemanticIndexWorkflow', limit: 20 })
      const active = runs.find(run => isRunActive(run))
      if (active) return { runId: active.id }
      return workflowService.startWorkflow('learningSemanticIndexWorkflow', input, { type: 'http', userId: session.userId }, rpc)
    })
  },
})
export const searchLearningIndex = defineFunction({
  title: 'Search canonical Learning message text', expose: true, readonly: true, scopes: ['admin'],
  input: SearchLearningIndexInput, output: SearchLearningIndexOutput,
  func: async ({ learningSemanticIndex }, input) => ({ hits: await learningSemanticIndex.search(input) }),
})
export const hydrateLearningIndexSource = defineFunction({
  title: 'Read original Learning source text and neighboring context', expose: true, readonly: true, scopes: ['admin'],
  input: HydrateLearningIndexInput, output: LearningSemanticHydration,
  func: async ({ learningSemanticIndex }, input) => learningSemanticIndex.hydrate(input),
})
export const freezeLearningIndexStep = defineSessionlessFunction({
  title: 'Freeze currently queryable canonical message versions', input: LearningIndexFreezeInput, output: LearningIndexRunInput,
  func: async ({ learningSemanticIndex }, { runId, maxMessages }) => learningSemanticIndex.freeze(runId, maxMessages),
})
export const chunkLearningIndexStep = defineSessionlessFunction({
  title: 'Hydrate full source and certify token-safe chunks', input: LearningIndexRunInput, output: LearningIndexBatch,
  func: async ({ learningSemanticIndex }, { runId }) => learningSemanticIndex.chunkBatch(runId),
})
export const retainLearningIndexStep = defineSessionlessFunction({
  title: 'Reconcile and retain source chunks without LLM calls', input: LearningIndexOperationInput, output: LearningIndexOperationOutput,
  func: async ({ learningSemanticIndex }, { runId, operationId }) => learningSemanticIndex.retainBatch(runId, operationId),
})
export const prepareLearningIndexOperationsStep = defineSessionlessFunction({
  title: 'Certify source slices and freeze deterministic retain operations', input: LearningIndexRunInput, output: LearningIndexPlan,
  func: async ({ learningSemanticIndex }, { runId }) => learningSemanticIndex.prepareOperations(runId),
})
export const finishLearningIndexStep = defineSessionlessFunction({
  title: 'Publish canonical index coverage receipt', input: LearningIndexRunInput, output: LearningIndexStatus,
  func: async ({ learningSemanticIndex }, { runId }) => learningSemanticIndex.finish(runId),
})
