import { pikkuSessionlessFunc } from '#pikku/function'
import { sharedRpc } from './adapt.js'

/** The framework's internal RPCs a delayed job may name: only the workflow sleep wake-up. */
const TIMER_RPCS = new Set(['pikkuWorkflowSleeper'])

/**
 * Delivers the framework's delayed internal RPCs. A durable `workflow.sleep`
 * is a pg-boss job on `pikku-remote-internal-rpc` that wakes the run when it
 * comes due; without a worker on that queue the sleep cannot be scheduled and
 * the run stalls. This is the queue half of the framework's remote-RPC
 * scaffold, without its HTTP endpoint, and limited to the sleep wake-up.
 */
export const workflowTimer = pikkuSessionlessFunc<{ rpcName: string; data?: unknown }, unknown>({
  func: async (_services, { rpcName, data }, { rpc }) => {
    if (!TIMER_RPCS.has(rpcName)) throw new Error(`Delayed internal RPC not allowed: ${rpcName}`)
    return sharedRpc({ rpc }).invoke(rpcName, data)
  },
})
