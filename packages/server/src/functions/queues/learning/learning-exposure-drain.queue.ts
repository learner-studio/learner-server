import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineSessionlessFunction } from '../../../runtime/define.js'
import { z } from 'zod'

export const LearningExposureDrainInput = z.object({ slot: z.number().int().min(0).max(1) })
export const LearningExposureDrainOutput = z.object({ processed: z.number(), pending: z.number(), gaps: z.number(), batches: z.number() })

export const learningExposureDrainQueue = defineSessionlessFunction({
  title: 'Continuously drain archived exposure with bounded parallel workers',
  input: LearningExposureDrainInput, output: LearningExposureDrainOutput,
  func: async ({ learningExposureIngestService, queueService }, { slot }, {queue,rpc}) => {
    if(!queue) throw new Error('Exposure drain requires durable queue identity')
    if (!learningExposureIngestService.drainEnabled) return { processed: 0, pending: 0, gaps: 0, batches: 0 }
    const result = await learningExposureIngestService.drain(slot)
    // Replay can process zero after a crash immediately following projection.
    // Always mark with the same job identity so that wake-up is not lost.
    await rpc.invoke('markLearningIndexDirtyStep',{runId:queue.jobId})
    await rpc.invoke('dispatchLearningIndexStep',{})
    // Each source/history cursor is durable. A crash before this enqueue is
    // recovered by the scheduler; it cannot lose captured work.
    if (result.pending > 0 && !learningAdmissionPaused()) await queueService.add('learning.exposure-drain', { slot }, {
      attempts: 3, backoff: { type: 'exponential', delay: 1000 }, delay: 100,
    })
    return result
  },
})
