import {
  CamelCasePlugin,
  IdentifierNode,
  Kysely,
  PostgresDialect,
  OperationNodeTransformer,
  SchemableIdentifierNode,
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
import { KyselyWorkflowRunService, KyselyWorkflowService, type KyselyPikkuDB } from '@pikku/kysely'
import { PgBossQueueService } from '@pikku/queue-pg-boss'
import type { QueueJob as FrameworkQueueJob } from '@pikku/core/queue'
import type { PikkuRPC } from '@pikku/core/rpc'
import type { WorkflowRun as FrameworkWorkflowRun, WorkflowRunWire } from '@pikku/core/workflow'
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

/**
 * The framework's workflow tables, renamed onto the tables the standalone
 * engine uses (migration 0004 gives them the extra columns). Ported Learning
 * code reads `learner_workflow_runs` directly, so one set of tables keeps
 * those reads correct under either runtime.
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
export class LearnerWorkflowService extends KyselyWorkflowService implements WorkflowService {
  override async startWorkflow(name: string, input: unknown, wire?: WorkflowWire, rpc?: RpcInvoker, options?: { inline?: boolean }): Promise<{ runId: string }> {
    return super.startWorkflow(name, input, toFrameworkWire(wire), frameworkRpc(rpc), options)
  }
  override async runWorkflowJob(runId: string, rpc?: RpcInvoker): Promise<void> {
    return super.runWorkflowJob(runId, frameworkRpc(rpc))
  }
  override async getRun(id: string): Promise<SharedRun | null> {
    return toSharedRun(await super.getRun(id))
  }
}

export class LearnerWorkflowRunService extends KyselyWorkflowRunService implements WorkflowRunService {
  override async getRun(id: string): Promise<SharedRun | null> {
    return toSharedRun(await super.getRun(id))
  }
  override async listRuns(options?: Parameters<KyselyWorkflowRunService['listRuns']>[0]): Promise<SharedRun[]> {
    return (await super.listRuns(options)).map((run) => toSharedRun(run)!)
  }
}

/**
 * The framework's pg-boss queue, speaking the shared QueueService too: a job
 * handle always has an async `status()` (a delayed job reads as waiting, as
 * under the standalone runtime) and a `waitForCompletion`.
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
