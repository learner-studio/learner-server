import { FUNCTION, type FunctionDefinition } from './define.js'
import { ForbiddenError, RpcNotFoundError, UnauthorizedError, UnprocessableContentError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'

/**
 * The access and input rules every runtime applies before running a function
 * body, kept here so the standalone host and the framework adapter cannot
 * drift apart.
 *
 * `external` says how the call arrived: 'rpc' (POST /rpc/:name) needs
 * `expose`; 'route' (a declared REST route) does not. Both require the session
 * and the `scopes`. An internal call (another function, a workflow step, a
 * queue or schedule) needs a session only for a session function, and its
 * scopes are not checked: the caller already passed its own gate.
 */
export function checkAccess(name: string, def: FunctionDefinition, session: Session | undefined, external?: 'rpc' | 'route'): void {
  const kind = def[FUNCTION]
  if (external) {
    if (external === 'rpc' && !def.meta.expose) throw new RpcNotFoundError(name)
    if (kind === 'workflow') throw new RpcNotFoundError(name)
    if (kind === 'session' || def.meta.scopes?.length) {
      if (!session) throw new UnauthorizedError('Authentication required')
      const missing = (def.meta.scopes ?? []).filter((s) => !session.scopes.includes(s))
      if (missing.length) throw new ForbiddenError(`Missing scope: ${missing.join(', ')}`)
    }
  } else if (kind === 'session' && !session) {
    throw new UnauthorizedError(`Function ${name} requires a session`)
  }
}

/** Validate `data` against the function's Zod input (with its defaults applied). */
export function parseInput(name: string, def: FunctionDefinition, data: unknown): unknown {
  const input = data ?? {}
  if (!def.input) return input
  const parsed = def.input.safeParse(input)
  if (!parsed.success) throw new UnprocessableContentError(`Invalid input for ${name}: ${parsed.error.message}`)
  return parsed.data
}
