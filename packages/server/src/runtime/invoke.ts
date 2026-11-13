import { FUNCTION, type FunctionDefinition, type FunctionKind } from './define.js'
import { ForbiddenError, RpcNotFoundError, UnauthorizedError, UnprocessableContentError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'

/** Scopes that confine their holder to the functions naming them (checkAccess). */
export const CONFINED_SCOPES = ['ci-mint', 'test-device'] as const

/**
 * What the access rules read from a function: its kind, `expose`, `scopes`,
 * and the confined scopes it admits. A shared definition carries them in its
 * meta (`accessOf`); a Pikku-native function in the framework's own function
 * meta (runtime-pikku/src/middleware.ts accessFor).
 */
export interface Access { kind: FunctionKind; expose?: boolean; scopes?: readonly string[]; confined?: readonly string[] }
export const accessOf = (def: FunctionDefinition): Access =>
  ({ kind: def[FUNCTION], expose: Boolean(def.meta.expose), scopes: def.meta.scopes, confined: def.meta.confined })

/**
 * The access rules every runtime applies before running a function body.
 *
 * `external` says how the call arrived: 'rpc' (POST /rpc/:name) needs
 * `expose`; 'route' (a declared REST route) does not. Both require the session
 * and the `scopes`. An internal call (another function, a workflow step, a
 * queue or schedule) needs a session only for a session function, and its
 * scopes are not checked: the caller already passed its own gate.
 *
 * A session holding a CONFINED scope reaches only the functions that name that
 * scope in `scopes` or `confined`; every other function, including any added
 * later, refuses it (docs/specs/server-desktop-pairing.md, "Confined credentials").
 */
export function checkAccess(name: string, def: FunctionDefinition | Access, session: Session | undefined, external?: 'rpc' | 'route'): void {
  const { kind, expose, scopes = [], confined = [] } = FUNCTION in def ? accessOf(def) : def
  if (external) {
    if (external === 'rpc' && !expose) throw new RpcNotFoundError(name)
    if (kind === 'workflow') throw new RpcNotFoundError(name)
    const opted = [...scopes, ...confined]
    const held = CONFINED_SCOPES.find((s) => session?.scopes.includes(s) && !opted.includes(s))
    if (held) throw new ForbiddenError(`A ${held} credential cannot call ${name}`)
    if (kind === 'session' || scopes.length) {
      if (!session) throw new UnauthorizedError('Authentication required')
      const missing = scopes.filter((s) => !session.scopes.includes(s))
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
