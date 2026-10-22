import { useMutation, useQuery, type UseQueryOptions } from '@tanstack/react-query'
import { createLearnerClient, RpcError, type RpcInput, type RpcName, type RpcOutput } from '@learner/contract'

/** Same-origin client: the browser's session cookie authenticates every call. */
export const call = createLearnerClient()

/** `refetchInterval` may be a function of the query, so a page polls only while a run is still moving. */
export function useRpcQuery<N extends RpcName>(name: N, data: RpcInput<N>, options: Pick<UseQueryOptions<RpcOutput<N>, Error, RpcOutput<N>, readonly unknown[]>, 'refetchInterval' | 'enabled'> = {}) {
  return useQuery({
    queryKey: [name, data], queryFn: () => call(name, data),
    // An auth refusal will not fix itself by retrying.
    retry: (count, error) => !(error instanceof RpcError && error.status < 500) && count < 2,
    ...options,
  })
}

export function useRpcMutation<N extends RpcName>(name: N) {
  return useMutation({ mutationFn: (data: RpcInput<N>) => call(name, data) })
}

export interface SessionUser { id: string; name: string; email: string }

/** Better Auth's session endpoint; `null` when signed out. */
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const response = await fetch('/api/auth/get-session', { credentials: 'include' })
      if (!response.ok) return null
      const body = await response.json() as { user?: SessionUser } | null
      return body?.user ?? null
    },
    retry: false,
  })
}

export async function signOut() {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: '{}' })
}
