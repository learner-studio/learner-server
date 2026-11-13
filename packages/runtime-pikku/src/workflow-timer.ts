import { pikkuSessionlessFunc } from '#pikku/function'

/**
 * Delivers the framework's delayed internal RPCs. A durable `workflow.sleep`
 * is a pg-boss job on `pikku-mesh-rpc` that wakes the run when it
 * comes due; without a worker on that queue the sleep cannot be scheduled and
 * the run stalls. This is the queue half of the framework's remote-RPC
 * scaffold, without its HTTP endpoint, and limited to the sleep wake-up.
 *
 * It completes the sleep on the workflow service directly, as core's own
 * `pikkuWorkflowSleeper` does: that function is registered at run time, so
 * the inspector cannot see an `rpc.invoke` of it (PKU944).
 */
export const workflowTimer = pikkuSessionlessFunc<{ rpcName: string; data?: { runId: string; stepId: string } }, void>({
  func: async ({ workflowService }, { rpcName, data }) => {
    if (rpcName !== 'pikkuWorkflowSleeper') throw new Error(`Delayed internal RPC not allowed: ${rpcName}`)
    if (!data?.runId || !data.stepId) throw new Error('pikkuWorkflowSleeper needs runId and stepId')
    if (!workflowService) throw new Error('workflowService is not configured')
    await workflowService.executeWorkflowSleepCompleted(data.runId, data.stepId)
  },
})
