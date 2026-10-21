import { z } from 'zod'
import { GradualAssessmentProposalSchema } from './learning-gradual-assessment.js'

/** Live incremental passes: the context allowance the grading experiment selected (round 2 winner, v2 candidate at 40k, 2026-10-21). Here, not in
 * the v6 module, so the schemas stay import-light. */
export const LIVE_CONTEXT_ALLOWANCE_BYTES = 40_000
/** Cold live passes replay a concept's whole history as this many chronological increments (the v2-cold arm, holdout 4a8b5ed2). */
export const LIVE_COLD_SLICES = 4
export type AssessmentPriorMode = 'cold' | 'warm'
/** LEARNING_ASSESSMENT_PRIOR_MODE. Cold (each pass regrades the whole history from no estimate) won the holdout
 * 0.63 vs 0.41 level agreement; warm returns only by setting it deliberately. Anything else refuses to run. */
export function assessmentPriorMode(value: string | undefined): AssessmentPriorMode {
  if (value === undefined || value === '') return 'cold'
  if (value === 'cold' || value === 'warm') return value
  throw new Error(`LEARNING_ASSESSMENT_PRIOR_MODE must be cold or warm, got ${JSON.stringify(value)}`)
}

export const VectorTurnConfig = z.object({
  purpose:z.enum(['experiment','live']).default('experiment'),
  selection:z.enum(['all','latest','relevant']).default('relevant'),latestTurns:z.number().int().min(1).max(100000).default(50),
  threshold:z.number().min(0).max(1).default(0.65),maxInputTokens:z.number().int().min(10000).max(400000).default(400000),
  concurrency:z.number().int().min(1).max(9).default(3),
  datasetTag:z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/).optional(),
  conceptIds:z.array(z.string().min(1)).min(1).max(1000).optional(),
  baseRunId:z.string().uuid().optional(),
  curriculumRevision:z.string().max(100).optional(),
  // Live only: grade the turns the published estimate has not seen, chained from that estimate.
  incremental:z.boolean().default(false),
  // Incremental only: earlier matching turns shown read-only to the v6 prompt (conservative UTF-8 bytes).
  contextAllowanceBytes:z.number().int().min(0).max(400000).default(LIVE_CONTEXT_ALLOWANCE_BYTES),
  // Incremental only, frozen per run: cold regrades every matching turn from no estimate; absent (pre-2026-10-22 runs) is warm.
  priorMode:z.enum(['cold','warm']).optional(),
})
export const VectorRunInput=z.object({runId:z.string().uuid()})
export const VectorWorkflowInput=VectorRunInput.extend({executionRequestId:z.string().uuid().optional()})
export const ResumeVectorExperiment=VectorRunInput.extend({requestId:z.string().uuid(),concurrency:z.number().int().min(1).max(9)})
export const VectorPartInput=VectorRunInput.extend({conceptId:z.string(),part:z.number().int().min(0),parentWorkflowId:z.string().uuid().optional()})
export const VectorPlan=z.object({batches:z.array(z.array(z.object({conceptId:z.string(),part:z.number().int()}))),concurrency:z.number().int().min(1).max(9)})
export const VectorConceptJob=VectorRunInput.extend({conceptId:z.string(),parts:z.array(z.number().int().min(0)).min(1),parentWorkflowId:z.string().uuid(),jobKey:z.string()})
export const VectorEnqueueInput=VectorRunInput.extend({plan:VectorPlan})
export const VectorJobs=z.object({jobIds:z.array(z.string())})
export const VectorJob=z.object({jobId:z.string()})
export const VectorQueueState=z.object({status:z.enum(['completed','failed'])})
export const VectorBatchInput=VectorRunInput.extend({items:z.array(z.object({conceptId:z.string(),part:z.number().int()}))})
export const VectorBatchOutput=z.object({runs:z.array(VectorRunInput)})
export const VectorResult=z.object({runId:z.string(),status:z.string()})
export const VectorExperiment=z.object({runId:z.string(),label:z.string(),status:z.string(),createdAt:z.string(),finishedAt:z.string().nullable(),
  durationMs:z.number().nullable(),unknownUsageCalls:z.number(),
  config:VectorTurnConfig,metadata:z.record(z.string(),z.unknown()).nullable(),counts:z.object({messages:z.number(),chunks:z.number(),turns:z.number(),unpaired:z.number()}).nullable(),
  pending:z.number(),failed:z.number(),inputTokens:z.number(),outputTokens:z.number(),items:z.array(z.object({conceptId:z.string(),title:z.string(),matchingChunks:z.number(),matchingMessages:z.number(),matchingTurns:z.number(),matchingCompleteTurns:z.number().optional(),matchingUnpairedTurns:z.number().optional(),bankMatchingUnits:z.number(),exhaustive:z.boolean(),turns:z.number(),unpaired:z.number(),messageCount:z.number(),batches:z.number(),status:z.string(),runs:z.array(z.object({part:z.number(),runId:z.string()})),runId:z.string().nullable(),assessment:GradualAssessmentProposalSchema.nullable(),sourceExperimentId:z.string().optional(),assessedAt:z.string().nullable().optional()}))})
export const StartVectorExperiment=VectorTurnConfig.extend({requestId:z.string().uuid().optional()})
export type VectorExperiment=z.infer<typeof VectorExperiment>
export const GetVectorExperiment=z.object({runId:z.string().uuid().optional()})
export const GetVectorExperimentOutput=z.object({experiment:VectorExperiment.nullable()})
export const ConceptCoverageInput=z.object({conceptId:z.string().min(1).optional(),limit:z.number().int().min(1).max(200).default(20),recentConcepts:z.number().int().min(1).max(50).default(10)})
export const ConceptCoveragePass=z.object({runId:z.string(),createdAt:z.string(),status:z.string(),turns:z.number(),parts:z.number(),
  covered:z.number(),newlyCovered:z.number(),regradedCoveredTurns:z.number().nullable(),coverageShrank:z.boolean()})
export const ConceptCoverage=z.object({concepts:z.array(z.object({conceptId:z.string(),passes:z.array(ConceptCoveragePass)}))})
