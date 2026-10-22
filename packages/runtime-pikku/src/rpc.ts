import { pikkuSessionlessFunc } from '#pikku/function'
import { buildRegistry } from '@learner/server/functions/registry.js'
import { checkAccess } from '@learner/server/runtime/invoke.js'
import { RpcNotFoundError } from '@learner/core/runtime/errors.js'
import { resolveSession, runInternal, sharedRpc } from './adapt.js'

const registry = buildRegistry()

/**
 * POST /rpc/:rpcName with `{ data }`: the standalone runtime's 'rpc' rules
 * (expose, session, scopes) checked here against the shared definition, then
 * the call runs as an internal one so the target does not check again.
 */
export const rpcCaller = pikkuSessionlessFunc<{ rpcName: string; data?: unknown }, unknown>({
  auth: false,
  func: async ({ kysely, authConfig }, { rpcName, data }, { rpc, session, pikkuUserId }) => {
    const def = registry.get(rpcName)
    if (!def) throw new RpcNotFoundError(rpcName)
    const caller = await resolveSession({ kysely, authConfig }, { session, pikkuUserId })
    checkAccess(rpcName, def, caller, 'rpc')
    return runInternal(caller, () => sharedRpc({ rpc }).invoke(rpcName, data ?? {}))
  },
})
