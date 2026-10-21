import { z } from 'zod'
import { LosslessArchiveBatchResult } from './lossless-archive-schemas.js'
import { LearningExposureIngestOutput } from './learning-exposure-schemas.js'
export const LearningActiveArchiveInput=z.object({sessionId:z.string().uuid(),invocationId:z.string().uuid()})
export const LearningActiveArchiveRunInput=LearningActiveArchiveInput.extend({runId:z.string().uuid()})
export const LearningActiveArchiveSource=z.object({runId:z.string().uuid(),sourceId:z.string().uuid()})
export const LearningActiveArchiveOutput=z.object({runId:z.string().uuid().nullable(),coalesced:z.boolean().optional(),pending:z.boolean().optional()})
export const LearningActiveArchiveReceipt=z.object({archive:LosslessArchiveBatchResult,projection:LearningExposureIngestOutput})
