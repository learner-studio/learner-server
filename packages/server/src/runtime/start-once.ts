import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'

/**
 * The earliest run of `workflow` whose `input[key]` matches, unless its status is in `again`. A Pikku-native function
 * starts the run itself with a literal `rpc.startWorkflow` when there is none, so the inspector sees the edge.
 */
export const priorRun = async (workflow: string, input: Record<string, unknown>, key: string, again: readonly string[] = []) =>
  (await metaDbQuery<{ workflow_run_id: string; status: string }>(`SELECT workflow_run_id, status FROM learner_workflow_runs WHERE workflow=$1
    AND input::jsonb->>$2=$3 AND NOT (status = ANY($4::text[])) ORDER BY created_at LIMIT 1`, [workflow, key, String(input[key]), [...again]])).rows[0]

type Starter = {
  startWorkflow: (name: string, input: unknown, wire: unknown, rpc: unknown, options?: { inline: boolean }) => Promise<{ runId: string }>
  runWorkflowJob: (runId: string, rpc: unknown) => Promise<unknown>
}

/**
 * The ONE "start a workflow once per key" (docs/operations/restart-safety.md, R4): the earliest run of `workflow` whose
 * `input[key]` matches is returned; with none, one is started. A prior run whose status is in `again` does not count
 * (a failed week is started again). `child`: a queue job's durable child, started inline, and an unfinished prior run
 * is driven on (a redelivered job resumes its child, never starts a second). The caller holds its lock around this
 * when other writes must share it.
 */
export async function startWorkflowOnce(workflowService: unknown, rpc: unknown, workflow: string, input: Record<string, unknown>, key: string,
  wire: { type: string; userId?: string }, options: { again?: readonly string[]; child?: boolean } = {}): Promise<{ workflowRunId: string; existing: boolean }> {
  const service = workflowService as Starter
  const prior = await priorRun(workflow, input, key, options.again)
  if (!prior) return { workflowRunId: (await service.startWorkflow(workflow, input, wire, rpc, options.child ? { inline: true } : undefined)).runId, existing: false }
  if (options.child && prior.status !== 'completed') await service.runWorkflowJob(prior.workflow_run_id, rpc)
  return { workflowRunId: prior.workflow_run_id, existing: true }
}
