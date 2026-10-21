import type { ZodType } from 'zod'
import type { RpcInvoker, Session } from '@learner/core/runtime/index.js'
import type { WorkflowContext } from '../workflow/durable.js'
import type { Services } from '../services.js'
export type { Services, WiredServices } from '../services.js'

/**
 * Function definitions. A function is a plain `(services, input, context) =>
 * output` with a Zod input; `defineFunction` only attaches metadata. The RPC
 * name of a function is the name it is EXPORTED under (see functions/index.ts),
 * which keeps every existing RPC name and the hook wire format unchanged.
 */
export interface FunctionContext {
  /** Present for authenticated calls; absent for internal/scheduled/queue calls. */
  session?: Session
  /** Call another registered function by name (same process, same services). */
  rpc: RpcInvoker
  /** Present while running as a durable workflow body. */
  workflow?: WorkflowContext
  /** Present while running as a workflow step: the enclosing run. */
  workflowStep?: { runId: string; stepName: string }
  /** Present for scheduled runs; `skip` records why a tick did nothing. */
  scheduledTask?: { name: string; skip(reason?: string): void }
  /** Present while handling a queue job. */
  queue?: { queueName: string; jobId: string }
  /** Present for calls that arrived over HTTP. */
  http?: { request?: { header(name: string): string | undefined; params(): Record<string, string> } }
}
export interface SessionContext extends FunctionContext { session: Session }

type AnyZod = ZodType<any, any>
type In<S> = S extends ZodType<infer _O, infer I> ? I : unknown
type Out<S> = S extends ZodType<infer O, any> ? O : unknown

interface BaseDef { title?: string; description?: string; tags?: string[]; expose?: boolean; readonly?: boolean; internal?: boolean; scopes?: string[]; [k: string]: unknown }

export const FUNCTION = Symbol.for('learner.function')
export type FunctionKind = 'session' | 'sessionless' | 'void' | 'workflow'
export interface FunctionDefinition<I = any, O = any> {
  readonly [FUNCTION]: FunctionKind
  readonly meta: BaseDef
  readonly input?: AnyZod
  readonly output?: AnyZod
  readonly func: (services: Services, data: I, context: FunctionContext) => Promise<O>
}

function make<I, O>(kind: FunctionKind, def: any): FunctionDefinition<I, O> {
  if (typeof def === 'function') return { [FUNCTION]: kind, meta: {}, func: def }
  const { input, output, func, ...meta } = def
  return { [FUNCTION]: kind, meta, input, output, func }
}

/** Requires an authenticated session (and its `scopes`, when listed). */
export function defineFunction<IS extends AnyZod | undefined = undefined, OS extends AnyZod | undefined = undefined, R = OS extends AnyZod ? Out<OS> : unknown>(
  def: BaseDef & { input?: IS; output?: OS; func: (services: Services, data: IS extends AnyZod ? Out<IS> : any, context: SessionContext) => Promise<R> | R },
): FunctionDefinition<IS extends AnyZod ? In<IS> : any, R> { return make('session', def) }

/** Callable without a session (internal steps, queue/scheduler handlers, hooks). */
export function defineSessionlessFunction<IS extends AnyZod | undefined = undefined, OS extends AnyZod | undefined = undefined, R = OS extends AnyZod ? Out<OS> : unknown>(
  def: ((services: Services, data: any, context: FunctionContext) => Promise<R> | R) | (BaseDef & { input?: IS; output?: OS; func: (services: Services, data: IS extends AnyZod ? Out<IS> : any, context: FunctionContext) => Promise<R> | R }),
): FunctionDefinition<IS extends AnyZod ? In<IS> : any, R> { return make('sessionless', def) }

/** No input, no output: scheduled and maintenance entry points. */
export function defineVoidFunction(
  def: ((services: Services, data: any, context: FunctionContext) => Promise<unknown> | unknown) | (BaseDef & { func: (services: Services, data: any, context: FunctionContext) => Promise<unknown> | unknown }),
): FunctionDefinition<void, void> { return make('void', def) }

/** A durable workflow body; `context.workflow` is always present. */
export function defineWorkflow<IS extends AnyZod | undefined = undefined, OS extends AnyZod | undefined = undefined, R = OS extends AnyZod ? Out<OS> : unknown>(
  def: BaseDef & { input?: IS; output?: OS; func: (services: Services, data: IS extends AnyZod ? Out<IS> : any, context: FunctionContext & { workflow: WorkflowContext }) => Promise<R> | R },
): FunctionDefinition<IS extends AnyZod ? In<IS> : any, R> { return make('workflow', def) }

export const isFunctionDefinition = (value: unknown): value is FunctionDefinition =>
  typeof value === 'object' && value !== null && FUNCTION in value
