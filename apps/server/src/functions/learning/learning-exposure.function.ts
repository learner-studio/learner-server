import { learningAdmissionPaused } from '@learner/core/lib/learning/learning-worker-runtime.js'
import { defineFunction, defineSessionlessFunction } from '../../runtime/define.js'
import { z } from 'zod'
import { LearningExposureIngestOutput, QueryLearningExposureInput, QueryLearningExposureOutput, QueryLearningExposureExchangesOutput } from '@learner/core/lib/learning/learning-exposure-schemas.js'

export const getLearningExposure = defineFunction({
  title: 'Read deduplicated user-facing Learning inputs and media', expose: true,
  readonly: true, scopes: ['admin'], input: QueryLearningExposureInput, output: QueryLearningExposureOutput,
  func: async ({ learningExposureService }, input) => learningExposureService.query(input),
})

export const IngestLearningExposureSpoolStepInput = z.object({})
export const ingestLearningExposureSpoolStep = defineSessionlessFunction({
  title: 'Archive gateway observations and project user-facing media',
  input: IngestLearningExposureSpoolStepInput, output: LearningExposureIngestOutput,
  func: async ({ learningExposureIngestService }) => learningExposureIngestService.ingestSpool(),
})

export const getLearningExposureExchanges = defineFunction({
  title: 'Read consolidated User plus metadata and Agent plus metadata', expose: true,
  readonly: true, scopes: ['admin'], input: QueryLearningExposureInput, output: QueryLearningExposureExchangesOutput,
  func: async ({ learningExposureService }, input) => learningExposureService.queryExchanges(input),
})

export const LearningExposureStatusOutput = z.object({
  observations: z.number(), visibleMessages: z.number(), nonvisibleObservations: z.number(),
  importGaps: z.array(z.object({ code: z.string(), count: z.number() })),
})
export const getLearningExposureStatus = defineFunction({
  title: 'Inspect Learning exposure projection coverage and import gaps', expose: true,
  readonly: true, scopes: ['admin'], input: IngestLearningExposureSpoolStepInput,
  output: LearningExposureStatusOutput,
  func: async ({ learningExposureService }) => learningExposureService.status(),
})

export const StartLearningExposureDrainOutput = z.object({ enabled: z.boolean(), jobIds: z.array(z.string()) })
export const LearningExposureParityOutput = z.object({
  capturedAt: z.string(), rawPendingSources: z.number(), rawBacklogBytes: z.number(),
  projectionEligibleVersions: z.number(), projectionPendingVersions: z.number(), projectionGapVersions: z.number(),
  pendingSpool: z.number(), historyPending: z.number(), mediaGapObservations: z.number(),
  history: z.object({ cursor: z.record(z.string(), z.unknown()), counters: z.record(z.string(), z.unknown()) }).nullable(),
  errors: z.array(z.object({ key: z.string(), error: z.string().nullable() })), limitations: z.array(z.string()),
})
export const getLearningExposureParity = defineFunction({
  title: 'Measure raw capture, projection, history and media parity separately',
  expose: true, readonly: true, scopes: ['admin'], input: IngestLearningExposureSpoolStepInput, output: LearningExposureParityOutput,
  func: async ({ learningExposureIngestService }) => learningExposureIngestService.parity(),
})
export const startLearningExposureDrain = defineFunction({
  title: 'Start two independently checkpointed Learning exposure workers',
  expose: true, scopes: ['admin'], input: IngestLearningExposureSpoolStepInput, output: StartLearningExposureDrainOutput,
  func: async ({ learningExposureIngestService, queueService }) => {
    if (!learningExposureIngestService.drainEnabled) return { enabled: false, jobIds: [] }
    if (learningAdmissionPaused()) throw new Error('Learning admission is paused')
    const jobIds = await Promise.all([0, 1].map((slot) => queueService.add('learning.exposure-drain', { slot }, {
      attempts: 3, backoff: { type: 'exponential', delay: 1000 },
    })))
    return { enabled: true, jobIds }
  },
})
