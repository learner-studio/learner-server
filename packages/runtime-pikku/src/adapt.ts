import { AsyncLocalStorage } from 'node:async_hooks'
import type { PikkuWire, SecretlessServices } from '@pikku/core/types'
import { sessionForUser } from '@learner/server/auth.js'
import type { FunctionContext, FunctionDefinition, Services as LearnerServices } from '@learner/server/runtime/define.js'
import { checkAccess, parseInput } from '@learner/server/runtime/invoke.js'
import type { Session } from '@learner/core/runtime/index.js'
import type { Services } from './application-types.js'
import { withCallScope } from './middleware.js'

/** The wire types of a shared definition, for the generated wrappers. */
type Body<D> = D extends { func: (services: never, data: infer I, context: never) => Promise<infer O> } ? [I, O] : [unknown, unknown]
export type InputOf<D> = Body<D>[0]
export type OutputOf<D> = Body<D>[1]

type WiredServices = SecretlessServices<Services>
/** The parts of the framework's wire a shared function's context is built from. */
type SharedWire = Pick<PikkuWire, 'session' | 'pikkuUserId' | 'rpc' | 'workflow' | 'workflowStep' | 'scheduledTask' | 'queue' | 'http' | 'traceId'>

/**
 * Calls already inside a shared function keep the session they run as, without resolving it again. The external
 * rules (a route, /rpc) are applied before any function runs, by the externalAccess middleware (middleware.ts).
 */
const inside = new AsyncLocalStorage<{ session: Session | undefined }>()
const runInternal = <T>(session: Session | undefined, fn: () => Promise<T>): Promise<T> => inside.run({ session }, fn)

/**
 * The caller, resolved as the standalone runtime resolves it: identity from
 * the framework (cookie session, API key, or the run/job owner), privilege
 * from the OWNING USER via `sessionForUser`, never from the key or the
 * framework's own session mapping.
 */
async function resolveSession(
  { kysely, authConfig }: Pick<WiredServices, 'kysely' | 'authConfig'>,
  wire: Pick<PikkuWire, 'session' | 'pikkuUserId'>,
): Promise<Session | undefined> {
  const store = inside.getStore()
  if (store) return store.session
  const userId = (wire.session as { userId?: string } | undefined)?.userId ?? wire.pikkuUserId
  return userId ? sessionForUser(kysely, authConfig, userId) : undefined
}

const httpRequest = (request: NonNullable<NonNullable<PikkuWire['http']>['request']>) => ({
  header: (name: string) => request.header(name) ?? undefined,
  params: () => Object.fromEntries(Object.entries(request.params()).map(([k, v]) => [k, Array.isArray(v) ? v.join('/') : String(v ?? '')])),
})

export function contextOf(wire: SharedWire, session: Session | undefined): FunctionContext {
  return {
    session,
    rpc: wire.rpc,
    ...(wire.workflow ? { workflow: wire.workflow } : {}),
    ...(wire.workflowStep ? { workflowStep: { runId: wire.workflowStep.runId, stepName: wire.workflowStep.invocationId } } : {}),
    ...(wire.scheduledTask ? { scheduledTask: { name: wire.scheduledTask.name, skip: wire.scheduledTask.skip } } : {}),
    ...(wire.queue ? { queue: { queueName: wire.queue.queueName, jobId: wire.queue.jobId } } : {}),
    ...(wire.http?.request ? { http: { request: httpRequest(wire.http.request) } } : {}),
  }
}

/** The framework's service bag is the shared one (application-types.ts); functions never see `secrets`. */
const learnerServices = (services: WiredServices): LearnerServices => services

/**
 * Runs a shared function definition under the framework: the internal access
 * rule and input validation of runtime/invoke.ts, the shared FunctionContext
 * built from the framework's wire, and the call scope every function gets
 * (middleware.ts withCallScope).
 */
export async function runShared<D extends FunctionDefinition>(name: string, def: D, services: WiredServices, data: unknown, wire: SharedWire): Promise<OutputOf<D>> {
  const session = await resolveSession(services, wire)
  checkAccess(name, def, session)
  const input = parseInput(name, def, data)
  return withCallScope(name, wire, session?.userId, services.logger,
    () => runInternal(session, async () => def.func(learnerServices(services), input, contextOf(wire, session))))
}

/**
 * A shared workflow's `onError` handler, run as the framework's compensation
 * of the workflow's first step (gen-wiring.ts). The framework undoes steps
 * newest-first, so the first step's compensation runs last and exactly once,
 * whichever step failed, and also when the first step itself failed. The
 * handler gets `{ error: { message } }`, as under the standalone engine: the
 * failed step's own error, or else the error the run is unwinding for.
 */
export async function compensateWith<D extends FunctionDefinition>(name: string, def: D, services: WiredServices, wire: SharedWire): Promise<OutputOf<D>> {
  const forward = wire.workflow?.compensatingFor
  const error = forward && !forward.ok ? forward.error : (await wire.workflow?.getRun())?.error
  return runShared(name, def, services, { error: { message: error?.message ?? 'workflow failed' } }, wire)
}
