import type { RpcInvoker } from '@learner/core/runtime/index.js'

/**
 * The workflow surface a workflow body is written against. Both runtimes
 * implement it: the standalone durable engine, and the framework adapter's
 * own durable workflows. Bodies use literal step names and call steps by RPC
 * name, so either runtime can checkpoint and replay them.
 */
export type Duration = string | number
/** `compensate: false` keeps a step out of the framework's unwind of a failed run. Every step that runs a child
 * workflow sets it: otherwise the unwind fails the child's COMPLETED run and erases its output. The standalone
 * engine has no unwind and ignores it. */
export interface StepOptions { retries?: number; retryDelay?: Duration; onError?: string; compensate?: false }

export interface WorkflowContext {
  readonly runId: string
  readonly name: string
  /** Run a registered function (by RPC name) or an inline closure as a checkpointed step. */
  do<T = any>(stepName: string, rpcOrFn: string | (() => Promise<T> | T), data?: unknown, options?: StepOptions): Promise<T>
  /** A checkpointed pause: survives restarts (the wake time is stored). */
  sleep(stepName: string, duration: Duration): Promise<void>
}
export type { RpcInvoker }
