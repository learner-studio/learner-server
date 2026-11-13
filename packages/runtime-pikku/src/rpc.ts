import { pikkuSessionlessFunc } from '#pikku/function'

/**
 * POST /rpc/:rpcName with `{ data }`: Pikku's own exposed-RPC call. The 'rpc'
 * access rules for the named function (expose, session, scopes, confined
 * credentials) are applied before this runs, by the externalAccess HTTP
 * middleware (middleware.ts).
 */
export const rpcCaller = pikkuSessionlessFunc<{ rpcName: string; data?: unknown }, unknown>({
  auth: false,
  func: async (_services, { rpcName, data }, { rpc }) => rpc.exposed(rpcName, data ?? {}),
})
