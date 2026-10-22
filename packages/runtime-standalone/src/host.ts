import { FUNCTION, type FunctionContext, type FunctionDefinition } from '@learner/server/runtime/define.js'
import { RpcNotFoundError } from '@learner/core/runtime/errors.js'
import { checkAccess, parseInput } from '@learner/server/runtime/invoke.js'
import type { RpcInvoker, Session } from '@learner/core/runtime/index.js'
import type { Services } from '@learner/server/services.js'
import type { WorkflowHost } from './workflow/durable.js'

export interface CallOptions {
  session?: Session
  /**
   * How the call arrived. 'rpc' (POST /rpc/:name) requires `expose` (or a
   * session function); 'route' (a declared REST route) does not. Both enforce
   * the session and `scopes`.
   */
  external?: 'rpc' | 'route'
  context?: Partial<FunctionContext>
}

/**
 * Executes registered functions: input validation, session and scope checks,
 * and the context (`rpc`, `workflow`, ...) each body receives. It is also the
 * durable engine's host, so workflow steps run through the same path.
 */
export class FunctionRuntime implements WorkflowHost {
  constructor(readonly registry: Map<string, FunctionDefinition>, private readonly services: () => Services) {}

  get(name: string) {
    const def = this.registry.get(name)
    if (!def) throw new RpcNotFoundError(name)
    return def
  }
  isWorkflow(name: string) { return this.registry.get(name)?.[FUNCTION] === 'workflow' }

  rpc(session?: Session, extra: Partial<FunctionContext> = {}): RpcInvoker {
    return { invoke: (name, data) => this.call(name, data, { session, context: extra }) as never }
  }

  async call(name: string, data: unknown, options: CallOptions = {}): Promise<unknown> {
    const def = this.get(name)
    const { session } = options
    checkAccess(name, def, session, options.external)
    const input = parseInput(name, def, data)
    const context: FunctionContext = { ...options.context, session, rpc: this.rpc(session, options.context?.workflowStep ? { workflowStep: options.context.workflowStep } : {}) }
    return def.func(this.services(), input, context)
  }

  // ------------------------------------------------------ WorkflowHost
  async runBody(name: string, input: unknown, { workflow, rpc, wire }: Parameters<WorkflowHost['runBody']>[2]) {
    const def = this.get(name)
    const data = parseInput(name, def, input)
    const session: Session | undefined = wire?.userId ? { userId: wire.userId, scopes: [] } : undefined
    return def.func(this.services(), data, { workflow, rpc, session })
  }
  async invoke(name: string, data: unknown, context: Parameters<WorkflowHost['invoke']>[2]) {
    // Steps run as the run's owner, as before: a session function used as a
    // step sees the user who started the workflow.
    const session: Session | undefined = context.wire?.userId ? { userId: context.wire.userId, scopes: [] } : undefined
    return this.call(name, data, { session, context: { workflowStep: context.workflowStep } })
  }
  dispatch?: WorkflowHost['dispatch']
}
