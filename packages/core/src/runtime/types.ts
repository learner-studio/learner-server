/**
 * Runtime service contracts shared by core and the server. The server owns the
 * implementations (packages/server/src/runtime, packages/server/src/workflow); core code
 * depends only on these shapes.
 */
export interface Logger {
  info(message: unknown, ...rest: unknown[]): void
  warn(message: unknown, ...rest: unknown[]): void
  error(message: unknown, ...rest: unknown[]): void
  debug(message: unknown, ...rest: unknown[]): void
}

export interface Session { userId: string; email?: string | null; scopes: readonly string[] }

/** Who started a workflow run. `userId` is the owning user when there is one. */
export interface WorkflowWire { type?: 'http' | 'internal' | 'scheduler' | 'queue' | 'workflow' | string; userId?: string; id?: string; parentRunId?: string }
export type WorkflowStatus = 'running' | 'suspended' | 'completed' | 'failed' | 'cancelled'
export interface WorkflowRun {
  id: string
  workflow: string
  status: WorkflowStatus | string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  output?: any
  error?: { message?: string; name?: string; code?: string; [k: string]: unknown } | null
  /** Who started the run; `{}` when it was not recorded. */
  wire: WorkflowWire
  createdAt: Date
  updatedAt: Date
}
export type StepStatus = 'pending' | 'running' | 'scheduled' | 'succeeded' | 'failed'
export interface WorkflowStep {
  stepId: string
  stepName: string
  rpcName?: string | null
  data?: unknown
  status: StepStatus | string
  result?: unknown
  error?: { message?: string; [k: string]: unknown } | null
  attemptCount: number
  /** Not recorded by this engine (kept for readers that fall back to createdAt/updatedAt). */
  runningAt?: Date
  succeededAt?: Date
  createdAt: Date
  updatedAt: Date
}

export interface WorkflowRunService {
  listRuns(options?: { status?: string; workflowName?: string; limit?: number; offset?: number }): Promise<WorkflowRun[]>
  getRun(runId: string): Promise<WorkflowRun | null>
  getRunSteps(runId: string): Promise<WorkflowStep[]>
  deleteRun(runId: string): Promise<boolean>
}

export interface RpcInvoker {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke<O = any>(name: string, data?: unknown): Promise<O>
}

export interface WorkflowService {
  /** Create a run and either enqueue it for the worker or (inline) run it now. */
  startWorkflow(name: string, input: unknown, wire?: WorkflowWire, rpc?: RpcInvoker, options?: { inline?: boolean }): Promise<{ runId: string }>
  /** Run (or resume) an existing run in this process and wait for it to settle. */
  runWorkflowJob(runId: string, rpc?: RpcInvoker): Promise<void>
  getRun(runId: string): Promise<WorkflowRun | null>
  updateRunStatus(runId: string, status: string, output?: unknown, error?: unknown): Promise<void>
}

export interface QueueJobOptions {
  jobId?: string
  attempts?: number
  backoff?: { type: 'fixed' | 'exponential'; delay: number }
  delay?: number
  priority?: number
  singletonKey?: string
  group?: { id: string; tier?: string }
  expireInSeconds?: number
  [k: string]: unknown
}
export type QueueJobStatus = 'waiting' | 'active' | 'completed' | 'failed'
/** A job handle. `status()` reads the live state; cancelled reads as failed. */
export interface QueueJob {
  queueName: string
  id: string
  data?: unknown
  status(): Promise<QueueJobStatus>
  waitForCompletion(timeoutMs?: number): Promise<unknown>
}
export interface QueueService {
  /** Enqueue; throws when nothing was created (including a live duplicate `jobId`). */
  add(queue: string, data: unknown, options?: QueueJobOptions): Promise<string>
  getJob(queue: string, id: string): Promise<QueueJob | null>
}
export interface QueueCancellationService {
  findByKey(queueName: string, key: string): Promise<Array<{ id: string; state: string }>>
  cancelByKey(queueName: string, key: string): Promise<number>
}

/** Transaction-scoped Postgres advisory locks keyed by (scope, key). */
export interface LockService {
  withLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T>
  tryWithLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<{ acquired: false } | { acquired: true; value: T }>
}

export interface VariablesService { get<T = unknown>(name: string): T | undefined | Promise<T | undefined> }
export { LocalVariablesService } from './variables.js'
