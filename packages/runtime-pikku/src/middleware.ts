import { pikkuState } from '@pikku/core/state'
import type { PikkuWire } from '@pikku/core/types'
import { betterAuthSession } from '@pikku/better-auth'
import { pikkuMiddleware } from '#pikku/middleware'
import { getCurrentCliScope } from '@learner/llm/lib/cli/cli-observer-registry.js'
import { withCliTelemetry } from '@learner/llm/lib/cli/cli-telemetry.js'
import { sessionForUser } from '@learner/server/auth.js'
import { buildRegistry } from '@learner/server/functions/registry.js'
import { accessOf, checkAccess, type Access } from '@learner/server/runtime/invoke.js'
import { RpcNotFoundError, UnauthorizedError } from '@learner/core/runtime/errors.js'
import type { Session } from '@learner/core/runtime/index.js'
import type { SingletonServices } from './application-types.js'

/**
 * Learner's runtime rules as Pikku middleware (wirings/middleware.wiring.ts):
 *
 *   learnerSession  global   the session of the OWNING USER (`sessionForUser`), never the key's or Better Auth's own
 *   learnerCallScope global  the model-call telemetry scope and the crash-test fault pause, around every function
 *   externalAccess  HTTP '*' the external access rules (`checkAccess`) for the function a route or /rpc reaches
 *
 * Steps, queue jobs and schedules get their session from `sessionStore` (services.ts), also `sessionForUser`.
 * Internal calls carry the caller's session; a session function refuses none (pikkuFunc), and Pikku checks a
 * function's `scopes` on every call.
 *
 * Coexistence: a function still written with runtime/define.js (in `shared`) runs through adapt.ts runShared,
 * which applies its own telemetry scope and fault pause, so learnerCallScope skips it.
 */
const shared = buildRegistry()

/**
 * The runtime's own entry points, outside the Learner function rules: the health route, and Pikku's scaffold routes
 * (tagged 'pikku'). Read from the HTTP route meta: Pikku strips `tags` from the runtime FUNCTION meta
 * (@pikku/cli strip-verbose-meta.js), but keeps them on routes.
 */
const OPEN = new Set(['learnerHealth'])
const pikkuRoutes = () => new Set(Object.values(pikkuState(null, 'http', 'meta') ?? {})
  .flatMap((byRoute) => Object.values(byRoute ?? {})).filter((route) => route.tags?.includes('pikku')).map((route) => route.pikkuFuncId))
const isOpen = (name: string) => OPEN.has(name) || pikkuRoutes().has(name)

/**
 * The access a function declares. A Pikku-native function: its kind and `expose` and `scopes` from Pikku's
 * function meta. It admits no confined credential: Pikku's runtime meta has no field that could carry `confined`
 * (tags are stripped), so a function that declares `confined` stays a shared definition.
 */
export function accessFor(name: string): Access | undefined {
  const def = shared.get(name)
  if (def) return accessOf(def)
  const meta = pikkuState(null, 'function', 'meta')[name]
  if (!meta) return undefined
  return { kind: meta.funcWrapper === 'pikkuWorkflowFunc' ? 'workflow' : meta.sessionless ? 'sessionless' : 'session', expose: Boolean(meta.expose), scopes: meta.scopes ?? [] }
}

const liveSession = async ({ getSession, session }: Pick<PikkuWire, 'getSession' | 'session'>) =>
  ((await getSession?.()) ?? session) as Session | undefined

/**
 * HTTP middleware on every route ('*'), so it runs once per request, on the function the route wires, and never
 * on the calls that function makes. /rpc/:rpcName is judged by the function it names (the 'rpc' rules, so an
 * unexposed, unknown or versioned name is not found); every other route by its own function (the 'route'
 * rules). Runs after the session middleware and before input validation, as the shared rules always did.
 */
export const externalAccess = pikkuMiddleware({
  priority: 'lowest',
  func: async (_services, { functionId, http, getSession, session }, next) => {
    const name = functionId!
    const [target, via] = name === 'rpcCaller' ? [String(http?.request?.params().rpcName), 'rpc' as const] : [name, 'route' as const]
    if (via === 'rpc' || !isOpen(name)) {
      const access = accessFor(target)
      if (!access) throw new RpcNotFoundError(target)
      checkAccess(target, access, await liveSession({ getSession, session }), via)
    }
    return next()
  },
})

/**
 * Better Auth resolves the credential (cookie, bearer or `x-api-key`) to its user; the session is that user's
 * Learner session. A valid credential whose user has none (a revoked or expired test device) is refused rather
 * than served anonymously. Registered at the default priority, so the scaffold's own `betterAuthSession`
 * (priority 'lowest') finds the session set and stands down.
 */
export const learnerSession = betterAuthSession({
  mapSession: async ({ user }, services) => {
    const { kysely, authConfig } = services as unknown as SingletonServices
    const session = await sessionForUser(kysely, authConfig, user.id)
    if (!session) throw new UnauthorizedError('Authentication required')
    return { ...session, scopes: [...session.scopes] }
  },
})

type CallWire = Pick<PikkuWire, 'workflowStep' | 'traceId'>

/**
 * Every model call under the outermost function carries who made it: the function (label), the workflow run
 * (Langfuse session) and Pikku's trace id. A nested call keeps the scope it runs in, so the label is the step's
 * function, except a step of another run: a durable child a queue job runs inline opens its own scope, or its
 * calls lose the run. The sink is a no-op: the scope's context is what the generation records read.
 */
export async function withCallScope<T>(name: string, wire: CallWire, userId: string | undefined, logger: SingletonServices['logger'], body: () => Promise<T>): Promise<T> {
  const step = wire.workflowStep
  const scope = getCurrentCliScope()
  const nested = scope && (!step || (scope.context as { jobId?: string } | undefined)?.jobId === step.runId)
  const output = nested ? await body() : await withCliTelemetry({
    label: name, traceId: wire.traceId, userId, logger, ...(step ? { jobId: step.runId } : {}),
  }, body, () => undefined)
  if (step) await faultPause(name, logger, step.runId)
  return output
}

export const learnerCallScope = pikkuMiddleware(async ({ logger }, { functionId, getSession, session, pikkuUserId, queue, workflow, workflowStep, traceId }, next) => {
  const name = functionId!
  if (shared.has(name) || isOpen(name) || name === 'rpcCaller') return next()
  // Middleware runs before Pikku resolves the owner (function-runner resolveSession), so read it as Pikku does.
  const userId = (await liveSession({ getSession, session }))?.userId ?? pikkuUserId ?? queue?.pikkuUserId ?? workflow?.pikkuUserId
  return withCallScope(name, { workflowStep, traceId }, userId, logger, next)
})

/**
 * Fault injection for the crash/resume smoke:
 * `LEARNER_FAULT_PAUSE_AFTER_STEP_RPC="<function name>:<ms>"`. It holds a
 * workflow step after its body returned, before the framework records the
 * result, so a `kill -9` lands after the step's side effects but before its
 * checkpoint, and the resumed run must replay the step idempotently.
 */
async function faultPause(name: string, logger: SingletonServices['logger'], runId: string) {
  const pause = process.env.LEARNER_FAULT_PAUSE_AFTER_STEP_RPC
  if (!pause) return
  const at = pause.lastIndexOf(':')
  if (pause.slice(0, at) !== name) return
  const ms = Number(pause.slice(at + 1))
  logger.info({ event: 'workflow-step-pause', runId, rpcName: name, ms })
  await new Promise((resolve) => setTimeout(resolve, ms))
}
