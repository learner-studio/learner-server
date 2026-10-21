import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineSessionlessFunction } from '../../../runtime/define.js'
import {
  LosslessArchiveBatchResult, LosslessArchiveDiscoveryInput,
  LosslessArchiveDiscoveryOutput, LosslessArchiveRunInput,
} from '@learner/core/lib/learning/lossless-archive-schemas.js'

export const discoverLearningLosslessArchiveStep = defineSessionlessFunction({
  title: 'Inventory approved CLI stores and persist source coverage',
  input: LosslessArchiveDiscoveryInput, output: LosslessArchiveDiscoveryOutput,
  func: async ({ learningLosslessArchiveSyncService }, { runId, mode, prefer }) =>
    learningLosslessArchiveSyncService.discover(runId, mode, prefer ?? []),
})

export const captureLearningLosslessArchiveStep = defineSessionlessFunction({
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

export const verifyLearningLosslessArchiveStep = defineSessionlessFunction({
  title: 'Restore committed archive chunks and verify their digests',
  input: LosslessArchiveRunInput, output: LosslessArchiveRunInput,
  func: async ({ learningLosslessArchiveSyncService }, { runId }) => {
    await learningLosslessArchiveSyncService.verifyBatch(runId)
    return { runId }
  },
})

export const finishLearningLosslessArchiveStep = defineSessionlessFunction({
  title: 'Publish measured archive progress and explicit gaps',
  input: LosslessArchiveRunInput, output: LosslessArchiveBatchResult,
  func: async ({ learningLosslessArchiveSyncService }, { runId }) =>
    learningLosslessArchiveSyncService.finish(runId),
})
