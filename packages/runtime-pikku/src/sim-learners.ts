import { rpcService } from '@pikku/core/rpc'
import type { SimLearnerConfig } from '@learner/core/lib/learning/learning-sim-experiment.js'
import type { createSingletonServices } from './services.js'

/** The simulated-learner experiment's runs: one learningSimLearnerWorkflow per (run id, learner id). A learner whose
 * latest run did not fail or get cancelled is adopted, never started twice, so the runner, the test and the crash
 * worker resume a batch by its run id alone. (Not a batch workflow: a parallel fan-out of child runs restarts
 * still-running siblings on @pikku/core 0.12.102.) Callers are single per run id (the runner's liveness check). */
export async function startSimLearners(services: Awaited<ReturnType<typeof createSingletonServices>>, configs: SimLearnerConfig[]): Promise<string[]> {
  const rpc = rpcService.getContextRPCService(services, {}, false)
  const ids: string[] = []
  for (const c of configs) {
    const prior = (await services.db.query<{ workflow_run_id: string; status: string }>(`SELECT workflow_run_id,status FROM learner_workflow_runs
      WHERE workflow='learningSimLearnerWorkflow' AND input::jsonb->>'runId'=$1 AND input::jsonb->>'learnerId'=$2 ORDER BY created_at DESC LIMIT 1`, [c.runId, c.learnerId])).rows[0]
    ids.push(prior && !['failed', 'cancelled'].includes(prior.status) ? prior.workflow_run_id
      : (await services.workflowService.startWorkflow('learningSimLearnerWorkflow', c, { type: 'internal' }, rpc)).runId)
  }
  return ids
}
