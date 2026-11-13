import {
  CamelCasePlugin,
  IdentifierNode,
  Kysely,
  PostgresDialect,
  OperationNodeTransformer,
  SchemableIdentifierNode,
  sql,
  TableNode,
  type KyselyPlugin,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
} from 'kysely'
import type { Pool } from 'pg'
import type { PgBoss } from 'pg-boss'
import type { KyselyPikkuDB } from '@pikku/kysely'
import { PgKyselyWorkflowRunService, PgKyselyWorkflowService } from '@pikku/kysely-postgres'
import { PgBossQueueService } from '@pikku/queue-pg-boss'
import type { QueueJob as FrameworkQueueJob } from '@pikku/core/queue'
import type { PikkuRPC } from '@pikku/core/rpc'
import type { WorkflowRun as FrameworkWorkflowRun, WorkflowRunWire, WorkflowStatus } from '@pikku/core/workflow'
import type {
  QueueCancellationService,
  QueueJob,
  QueueJobStatus,
  QueueService,
  RpcInvoker,
  WorkflowRun,
  WorkflowRunService,
  WorkflowService,
  WorkflowWire,
} from '@learner/core/runtime/index.js'
import { currentCliContext } from '@learner/llm/lib/cli/cli-telemetry.js'

/**
 * The framework's workflow tables, renamed onto `learner_workflow_*`
 * (migrations 0002 and 0004). Ported Learning code reads
 * `learner_workflow_runs` directly.
 *
 * Both spellings are mapped because the name reaches this plugin camelCased
 * or already snake_cased, depending on where CamelCasePlugin sits in the
 * plugin chain of the query that names it.
 */
const TABLES: Record<string, string> = {
  workflowRuns: 'learner_workflow_runs',
  workflow_runs: 'learner_workflow_runs',
  workflowStep: 'learner_workflow_steps',
  workflow_step: 'learner_workflow_steps',
  workflowStepHistory: 'learner_workflow_step_history',
  workflow_step_history: 'learner_workflow_step_history',
  workflowVersions: 'learner_workflow_versions',
  workflow_versions: 'learner_workflow_versions',
}

class RenameTables extends OperationNodeTransformer {
  protected override transformTable(node: TableNode): TableNode {
    const renamed = TABLES[node.table.identifier.name]
    if (!renamed) return super.transformTable(node)
    const identifier = IdentifierNode.create(renamed)
    return { ...node, table: { ...node.table, identifier } as SchemableIdentifierNode }
  }
}

export class WorkflowTablesPlugin implements KyselyPlugin {
  readonly #transformer = new RenameTables()
  transformQuery({ node }: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(node)
  }
  async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return result
  }
}

/** The framework's workflow store on the shared pool, bound to the shared workflow tables. */
export const workflowKysely = (pool: Pool): Kysely<KyselyPikkuDB> =>
  new Kysely<KyselyPikkuDB>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin(), new WorkflowTablesPlugin()] })

/** The shared code records the owner as `wire.userId`; the framework reads `wire.pikkuUserId`. */
const toFrameworkWire = (wire: WorkflowWire = {}): WorkflowRunWire => {
  const { userId, ...rest } = wire
  return { ...rest, type: wire.type ?? 'internal', ...(userId ? { pikkuUserId: userId } : {}) }
}
type SharedRun = FrameworkWorkflowRun & { wire: WorkflowRunWire & WorkflowWire }
const toSharedRun = (run: FrameworkWorkflowRun | null): SharedRun | null =>
  run && { ...run, wire: { ...run.wire, ...(run.wire?.pikkuUserId ? { userId: run.wire.pikkuUserId } : {}) } }

/**
 * Shared code passes `context.rpc` on; under this runtime that is the
 * framework's own RPC handle, which is what runs the steps.
 */
function frameworkRpc(rpc: RpcInvoker | undefined): PikkuRPC {
  if (rpc && 'rpcWithWire' in rpc && 'startWorkflow' in rpc) return rpc as RpcInvoker & PikkuRPC
  throw new Error('workflows under this runtime must be started with the calling function\'s context.rpc')
}

/**
 * The framework's durable workflow service, speaking the shared
 * WorkflowService interface as well: the owner moves between `userId` and
 * `pikkuUserId`, and a run read back carries both.
 */
/** Run statuses that never change again (core's WORKFLOW_TERMINAL_STATES, which it does not export). */
const SETTLED = new Set<WorkflowStatus>(['completed', 'failed', 'cancelled', 'compensated', 'compensation_failed'])

export class LearnerWorkflowService extends PgKyselyWorkflowService implements WorkflowService {
  /** A run started from inside a workflow step names that step's run as its parent (the Pikku call scope, adapt.ts). */
  override async startWorkflow(name: string, input: unknown, wire?: WorkflowWire, rpc?: RpcInvoker, options?: { inline?: boolean }): Promise<{ runId: string }> {
    const parentRunId = wire?.parentRunId ?? currentCliContext().jobId
    return super.startWorkflow(name, input, toFrameworkWire({ ...wire, ...(parentRunId ? { parentRunId } : {}) }), frameworkRpc(rpc), options)
  }
  /**
   * One orchestration pass of a run at a time in this process, in arrival order.
   * Every pass of a run shares one replay context, and the framework's
   * `beginReplay` resets its step ordinals BEFORE the pass takes the run lease,
   * so a second pass arriving mid-run renumbers the first one's looped steps
   * (`name#n`) even though the lease then turns it away. Other processes have
   * their own contexts and are fenced by the run lease.
   */
  private readonly passes = new Map<string, Promise<void>>()
  override async runWorkflowJob(runId: string, rpc?: RpcInvoker): Promise<void> {
    const mine = (this.passes.get(runId) ?? Promise.resolve()).then(() => super.runWorkflowJob(runId, frameworkRpc(rpc)))
    const tail = mine.catch(() => {})
    this.passes.set(runId, tail)
    try { return await mine } finally { if (this.passes.get(runId) === tail) this.passes.delete(runId) }
  }
  /**
   * Pikku's recovery (worker.ts `startRecovery`: a startup pass, then one every 30 s under its lease) asks this for
   * the running runs with nothing in flight and resumes them. A child run settles in one write and its parent step
   * hears of it in another (workflow-dsl-pass.js); a kill, or one failed write, between them leaves the step waiting on
   * a settled child, which this query counts as in flight, so the parent waits for good (core 0.12.157). Before it
   * answers, each such step is told through Pikku's own child hooks, as the child would have told it:
   * - a completed child's output becomes the step's result (any unsettled step: the result is that child's);
   * - a failed or cancelled child fails a `running` step, and the parent's replay applies the step's retries. A
   *   `pending` or `scheduled` step on one is a retry armed after it (a retry keeps `childRunId`): the claim leaves
   *   that to the framework, which starts the retry's child.
   * Only children settled before `before`, the sweep's own idleness bound: a younger one may still be telling its
   * parent. Bounded by the running runs (index `status, created_at`), their unsettled steps (`workflow_run_id,
   * status`) and the child by key; `limit` caps it like the sweep.
   */
  protected override async findStalledRunIds(before: Date, limit: number): Promise<string[]> {
    const untold = await this.db.selectFrom('workflowRuns as p')
      .innerJoin('workflowStep as s', 's.workflowRunId', 'p.workflowRunId')
      .innerJoin('workflowRuns as c', 'c.workflowRunId', 's.childRunId')
      .select(['c.workflowRunId as childId', 'c.status as childStatus', 's.status as stepStatus'])
      .where('p.status', '=', 'running').where('s.status', 'in', ['pending', 'scheduled', 'running'])
      .where('c.status', 'in', [...SETTLED]).where('c.updatedAt', '<', before)
      .limit(limit).execute()
    for (const { childId, childStatus, stepStatus } of untold) {
      if (childStatus !== 'completed' && stepStatus !== 'running') continue
      const child = await super.getRun(childId)
      if (child) await this.tellParent(child)
    }
    return super.findStalledRunIds(before, limit)
  }
  /** What a settling child does (pikku-workflow-service.js); `onChildWorkflowCompleted` is private in core's types. */
  private async tellParent(child: FrameworkWorkflowRun) {
    if (child.status === 'completed') await (this as unknown as { onChildWorkflowCompleted(run: FrameworkWorkflowRun, output: unknown): Promise<void> }).onChildWorkflowCompleted(child, child.output)
    else await this.notifyChildWorkflowFailed(child, new Error(child.error?.message ?? `child workflow ${child.status}`))
  }
  /**
   * A step whose child run has not settled is the child's to complete, never a dispatch's to run again.
   * Core 0.12.156 releases a queued child step's lease once the child starts; a replay of the parent re-arms the
   * step (`scheduled`) and dispatches it, and the framework's claim starts a second child. A parallel fan-out of
   * children (`Promise.all` of child `workflow.do`) replays on every sibling that settles, so each still-waiting child
   * was started again (the sim experiment's wave ran learners 2-4 times).
   * - A child that completed while its result never reached the step has that result delivered instead.
   * - A step with no child recorded adopts the run started for it (`wire.parentStepId`): a kill between the child's
   *   start and `setStepChildRunId` otherwise starts a second child once the step's lease lapses.
   * - A child that failed or was cancelled is the framework's: its claim starts the retry's child.
   */
  protected override async claimStepForExecution(runId: string, stepName: string, rpcName: string, leaseMs: number) {
    const step = await this.db.selectFrom('workflowStep').select(['workflowStepId', 'status', 'childRunId', 'leaseExpiresAt'])
      .where('workflowRunId', '=', runId).where('stepName', '=', stepName).executeTakeFirst()
    if (!step || step.status === 'succeeded' || step.status === 'failed') return super.claimStepForExecution(runId, stepName, rpcName, leaseMs)
    // Only a step claimed before can have started an unrecorded child: a claim sets the lease, and only the release
    // after `setStepChildRunId` clears it. A first claim never pays for the lookup (index `workflow, created_at`).
    const childId = step.childRunId ?? (step.leaseExpiresAt == null ? undefined : (await this.db.selectFrom('workflowRuns').select('workflowRunId')
      .where('workflow', '=', rpcName).where(sql<string>`wire::jsonb->>'parentStepId'`, '=', step.workflowStepId)
      .orderBy('createdAt', 'desc').executeTakeFirst())?.workflowRunId)
    if (!childId) return super.claimStepForExecution(runId, stepName, rpcName, leaseMs)
    if (!step.childRunId) await this.setStepChildRunId(step.workflowStepId, childId)
    const child = await super.getRun(childId)
    if (!child || (SETTLED.has(child.status) && child.status !== 'completed')) return super.claimStepForExecution(runId, stepName, rpcName, leaseMs)
    if (child.status === 'completed') await this.tellParent(child)
    return null
  }
  override async getRun(id: string): Promise<SharedRun | null> {
    return toSharedRun(await super.getRun(id))
  }
}

export class LearnerWorkflowRunService extends PgKyselyWorkflowRunService implements WorkflowRunService {
  override async getRun(id: string): Promise<SharedRun | null> {
    return toSharedRun(await super.getRun(id))
  }
  override async listRuns(options?: Parameters<PgKyselyWorkflowRunService['listRuns']>[0]): Promise<SharedRun[]> {
    return (await super.listRuns(options)).map((run) => toSharedRun(run)!)
  }
}

/**
 * The framework's pg-boss queue, speaking the shared QueueService too: a job
 * handle always has an async `status()` (a delayed job reads as waiting) and
 * a `waitForCompletion`.
 */
export class LearnerQueueService extends PgBossQueueService implements QueueService {
  override async getJob<T, R>(queueName: string, jobId: string): Promise<(FrameworkQueueJob<T, R> & QueueJob) | null> {
    const job = await super.getJob<T, R>(queueName, jobId)
    if (!job) return null
    const status = async (): Promise<QueueJobStatus> => {
      const state = await job.status()
      return state === 'delayed' ? 'waiting' : state
    }
    const waitForCompletion = async (timeoutMs?: number): Promise<R> => {
      if (!job.waitForCompletion) throw new Error(`queue ${queueName} cannot wait for job results`)
      return job.waitForCompletion(timeoutMs)
    }
    return { ...job, status, waitForCompletion }
  }
}

/** Cancellation by singleton key, against the same pg-boss instance the queue service sends on. */
export class PgBossCancellation implements QueueCancellationService {
  constructor(private readonly boss: PgBoss) {}
  async findByKey(queueName: string, key: string) {
    return (await this.boss.findJobs(queueName, { key })).map(({ id, state }) => ({ id, state: String(state) }))
  }
  async cancelByKey(queueName: string, key: string) {
    const live = (await this.findByKey(queueName, key)).filter(({ state }) => !['completed', 'failed', 'cancelled'].includes(state))
    if (!live.length) return 0
    const result = (await this.boss.cancel(queueName, live.map(({ id }) => id))) as { affected?: number } | undefined
    return result?.affected ?? live.length
  }
}

export type { WorkflowRun }
