import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY, startPilotWorkflowOnce } from '@learner/core/lib/learning/learning-hindsight-native-pilot.js'
import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'

export const StartLearningHindsightNativePilotInput = z.object({ runId: z.string().uuid() })
export const StartLearningHindsightNativePilotOutput = z.object({ runId: z.string().uuid(), started: z.literal(true) })

/** Admin-only entrypoint for a pre-frozen pilot; every model-bearing step remains private to its workflow. */
export const startLearningHindsightNativePilot = defineFunction({
  title: 'Start the frozen Hindsight AGY native pilot',
  description: 'Start the durable, review-only three-pair native pilot after its immutable input and zero-call preflight have been frozen.',
  expose: true,
  audit: true,
  scopes: ['admin'],
  input: StartLearningHindsightNativePilotInput,
  output: StartLearningHindsightNativePilotOutput,
  func: async ({ workflowService }, input, { session, rpc }) => {
    assertLearningLocalMvpEnabled()
    await startPilotWorkflowOnce({
      reserve: async () => {
        const reserved = await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET
          config=jsonb_set(config,'{nativePilot}',COALESCE(config->'nativePilot','{}'::jsonb)||$2::jsonb)
          WHERE run_id=$1 AND status='queued' AND config->>'contextStrategy'=$3
            AND config->'nativePilot'->>'workflowStartState' IS NULL RETURNING run_id`,
        [input.runId, JSON.stringify({ workflowStartState: 'reserved', workflowStartReservedAt: new Date().toISOString() }), HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY])
        return reserved.rows.length === 1
      },
      start: async () => (await workflowService.startWorkflow('learningHindsightNativePilotWorkflow', input,
        { type: 'http', userId: session.userId }, rpc)).runId,
      checkpointStarted: async workflowRunId => {
        await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET config=jsonb_set(config,'{nativePilot}',
          COALESCE(config->'nativePilot','{}'::jsonb)||$2::jsonb) WHERE run_id=$1`,
        [input.runId, JSON.stringify({ workflowStartState: 'started', workflowRunId })])
      },
      markUncertain: async message => {
        await metaDbQuery(`UPDATE learning_extraction_benchmark_runs SET config=jsonb_set(config,'{nativePilot}',
          COALESCE(config->'nativePilot','{}'::jsonb)||$2::jsonb) WHERE run_id=$1`,
        [input.runId, JSON.stringify({ workflowStartState: 'uncertain', workflowStartError: message.slice(0, 4_000) })])
      },
    })
    return { runId: input.runId, started: true as const }
  },
})
