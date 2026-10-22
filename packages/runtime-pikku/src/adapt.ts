import { AsyncLocalStorage } from 'node:async_hooks'
import type { PikkuWire, SecretlessServices } from '@pikku/core/types'
import { sessionForUser } from '@learner/server/auth.js'
import type { FunctionContext, FunctionDefinition, Services as LearnerServices } from '@learner/server/runtime/define.js'
import { checkAccess, parseInput } from '@learner/server/runtime/invoke.js'
import type { RpcInvoker, Session } from '@learner/core/runtime/index.js'
import type { Services } from './application-types.js'

/** The wire types of a shared definition, for the generated wrappers. */
type Body<D> = D extends { func: (services: never, data: infer I, context: never) => Promise<infer O> } ? [I, O] : [unknown, unknown]
export type InputOf<D> = Body<D>[0]
export type OutputOf<D> = Body<D>[1]

type WiredServices = SecretlessServices<Services>
/** The parts of the framework's wire a shared function's context is built from. */
type SharedWire = Pick<PikkuWire, 'session' | 'pikkuUserId' | 'rpc' | 'workflow' | 'workflowStep' | 'scheduledTask' | 'queue' | 'http'>

/**
 * Calls already inside a shared function, and the session they run as.
 *
 * The first shared function a declared REST route reaches is external
 * ('route'); /rpc applies the 'rpc' rules itself (rpc.ts). Anything that runs
 * inside a shared function — another function, an inline workflow step — is
 * internal and keeps its caller's session. A queue job, a schedule or a
 * worker-run step is internal too, and runs as the user the job or run
 * belongs to, as under the standalone engine.
 *
 * This is async context, not the wire, because the framework copies the
 * caller's wire (including `http`) into every nested call.
 */
const inside = new AsyncLocalStorage<{ session: Session | undefined }>()
export const runInternal = <T>(session: Session | undefined, fn: () => Promise<T>): Promise<T> => inside.run({ session }, fn)

/**
 * The caller, resolved as the standalone runtime resolves it: identity from
 * the framework (cookie session, API key, or the run/job owner), privilege
 * from the OWNING USER via `sessionForUser`, never from the key or the
 * framework's own session mapping.
 */
export async function resolveSession(
  { kysely, authConfig }: Pick<WiredServices, 'kysely' | 'authConfig'>,
  wire: Pick<PikkuWire, 'session' | 'pikkuUserId'>,
): Promise<Session | undefined> {
  const store = inside.getStore()
  if (store) return store.session
  const userId = (wire.session as { userId?: string } | undefined)?.userId ?? wire.pikkuUserId
  return userId ? sessionForUser(kysely, authConfig, userId) : undefined
}

/** The framework's RPC handle, seen through the shared (name-checked at runtime) interface. */
export const sharedRpc = ({ rpc }: Pick<PikkuWire, 'rpc'>): RpcInvoker => rpc

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
 * Runs a shared function definition under the framework: the same access
 * rules and input validation as the standalone host (runtime/invoke.ts), and
 * the shared FunctionContext built from the framework's wire.
 */
export async function runShared<D extends FunctionDefinition>(name: string, def: D, services: WiredServices, data: unknown, wire: SharedWire): Promise<OutputOf<D>> {
  const session = await resolveSession(services, wire)
  checkAccess(name, def, session, wire.http && !inside.getStore() ? 'route' : undefined)
  const input = parseInput(name, def, data)
  const output = await runInternal(session, async () => def.func(learnerServices(services), input, contextOf(wire, session)))
  if (wire.workflowStep) await faultPause(name, services, wire.workflowStep.runId)
  return output
}

/**
 * Fault injection for the crash/resume smoke:
 * `LEARNER_FAULT_PAUSE_AFTER_STEP_RPC="<function name>:<ms>"`. It holds a
 * workflow step after its body returned, before the framework records the
 * result, so a `kill -9` lands after the step's side effects but before its
 * checkpoint, and the resumed run must replay the step idempotently.
 */
async function faultPause(name: string, { logger }: Pick<WiredServices, 'logger'>, runId: string) {
  const pause = process.env.LEARNER_FAULT_PAUSE_AFTER_STEP_RPC
  if (!pause) return
  const at = pause.lastIndexOf(':')
  if (pause.slice(0, at) !== name) return
  const ms = Number(pause.slice(at + 1))
  logger.info({ event: 'workflow-step-pause', runId, rpcName: name, ms })
  await new Promise((resolve) => setTimeout(resolve, ms))
}
