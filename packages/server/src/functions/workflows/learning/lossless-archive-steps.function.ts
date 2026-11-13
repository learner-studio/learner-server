import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { pikkuSessionlessFunc } from '#pikku/function'
import {
  LosslessArchiveBatchResult, LosslessArchiveDiscoveryInput,
  LosslessArchiveDiscoveryOutput, LosslessArchiveRunInput,
} from '@learner/core/lib/learning/lossless-archive-schemas.js'

export const discoverLearningLosslessArchiveStep = pikkuSessionlessFunc({
  title: 'Inventory approved CLI stores and persist source coverage',
  input: LosslessArchiveDiscoveryInput, output: LosslessArchiveDiscoveryOutput,
  func: async ({ learningLosslessArchiveSyncService }, { runId, mode, prefer }) =>
    learningLosslessArchiveSyncService.discover(runId, mode, prefer ?? []),
})

export const captureLearningLosslessArchiveStep = pikkuSessionlessFunc({
  title: 'Capture and atomically acknowledge a bounded source batch',
  input: LosslessArchiveRunInput, output: LosslessArchiveRunInput,
  func: async ({ learningLosslessArchiveSyncService, learningExposureIngestService, queueService }, { runId }) => {
    await learningLosslessArchiveSyncService.captureBatch(runId)
    if(learningExposureIngestService.drainEnabled) {
      if (!learningAdmissionPaused()) await Promise.all([0,1].map(slot=>queueService.add('learning.exposure-drain',{slot},{attempts:3,backoff:{type:'exponential',delay:1000}})))
    }
    return { runId }
  },
})

export const verifyLearningLosslessArchiveStep = pikkuSessionlessFunc({
  title: 'Restore committed archive chunks and verify their digests',
  input: LosslessArchiveRunInput, output: LosslessArchiveRunInput,
  func: async ({ learningLosslessArchiveSyncService }, { runId }) => {
    await learningLosslessArchiveSyncService.verifyBatch(runId)
    return { runId }
  },
})

export const finishLearningLosslessArchiveStep = pikkuSessionlessFunc({
  title: 'Publish measured archive progress and explicit gaps',
  input: LosslessArchiveRunInput, output: LosslessArchiveBatchResult,
  func: async ({ learningLosslessArchiveSyncService }, { runId }) =>
    learningLosslessArchiveSyncService.finish(runId),
})
