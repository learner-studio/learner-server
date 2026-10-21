import { defineFunction } from '../../runtime/define.js'
import { NotFoundError } from '@learner/core/runtime/errors.js'
import { z } from 'zod'

import { learningTranscriptArchiveScheduleEnabled } from '@learner/core/lib/runtime-flags.js'
import { getRunUserId, isRunActive } from '@learner/core/lib/workflow/workflow-runs.js'
import { RunLearningTranscriptArchiveScanStepOutput } from '../workflows/learning/transcript-archive-steps.function.js'

const WORKFLOW_NAME = 'learningTranscriptArchiveWorkflow'

export const StartLearningTranscriptArchiveSweepInput = z.object({
  scanMode: z.enum(['periodic', 'daily']).default('periodic'),
})

export const StartLearningTranscriptArchiveSweepOutput = z.object({
  runId: z.string().uuid(),
})

export const GetLearningTranscriptArchiveSweepInput = z.object({
  runId: z.string().uuid(),
})

export const GetLearningTranscriptArchiveSweepOutput = z.object({
  status: z.enum(['running', 'suspended', 'completed', 'failed', 'cancelled']),
  result: RunLearningTranscriptArchiveScanStepOutput.nullable(),
})

/**
 * Authenticated maintenance trigger used by the live dev scenario. It exposes
 * only a workflow ID; transcript text remains confined to Hindsight.
 */
export const startLearningTranscriptArchiveSweep = defineFunction({
  title: 'Start Learning transcript archive sweep',
  description: 'Start one bounded, archive-only local transcript sweep.',
  expose: true,
  audit: true,
  scopes: ['admin'],
  input: StartLearningTranscriptArchiveSweepInput,
  output: StartLearningTranscriptArchiveSweepOutput,
  func: async ({ workflowRunService, workflowService }, input, { session, rpc }) => {
    if (!learningTranscriptArchiveScheduleEnabled()) {
      throw new Error('Learning transcript archive schedule is disabled on this host')
    }
    const runs = await workflowRunService.listRuns({ workflowName: WORKFLOW_NAME, limit: 20 })
    if (runs.some((run) => isRunActive(run))) {
      throw new Error('A Learning transcript archive sweep is already running')
    }
    const { runId } = await workflowService.startWorkflow(
      WORKFLOW_NAME,
      { scanMode: input.scanMode },
      { type: 'http', userId: session.userId },
      rpc,
    )
    return { runId }
  },
})

/** Read only the aggregate result of a sweep started by this actor. */
export const getLearningTranscriptArchiveSweep = defineFunction({
  title: 'Read Learning transcript archive sweep',
  description: 'Read terminal counts from an actor-owned archive sweep.',
  expose: true,
  readonly: true,
  audit: true,
  scopes: ['admin'],
  input: GetLearningTranscriptArchiveSweepInput,
  output: GetLearningTranscriptArchiveSweepOutput,
  func: async ({ workflowRunService }, { runId }, { session }) => {
    const run = await workflowRunService.getRun(runId)
    if (!run || run.workflow !== WORKFLOW_NAME || getRunUserId(run) !== session.userId) {
      throw new NotFoundError('Transcript archive sweep not found')
    }
    const parsed = RunLearningTranscriptArchiveScanStepOutput.safeParse(run.output)
    return {
      status: run.status,
      result: parsed.success ? parsed.data : null,
    }
  },
})
