import {
  CamelCasePlugin,
  type Expression,
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
import { WorkflowStepSupersededError } from '@pikku/core/workflow'
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
import { TERMINAL_WORKFLOW_STATUSES } from '@learner/core/lib/workflow/workflow-runs.js'
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
   * answers, each unsettled step of a running run whose child settled before `before` (the sweep's own idleness
   * bound: a younger child may still be telling its parent) is handled:
   * - the child is the step's current attempt's: the step is told as the child would have told it (`tellParent`).
   *   A failed child only for a `running` step: a `scheduled` one has a step job queued (Pikku's scheduled-step sweep),
   *   and the framework's claim takes a `failed` step as a retry by its stored retries (default 5) whatever the
   *   workflow's own; so its claim (below) tells it instead, and a `pending` one reaches the claim by the resume;
   * - the child is an earlier attempt's (a retry keeps `childRunId`) and the step is `running` with a lapsed lease: a
   *   kill between the retry's claim and `setStepChildRunId`. The run is resumed, and the claim adopts the retry's
   *   child or starts it. A held lease, or a `pending`/`scheduled` retry, is the framework's.
   * Both cases are filtered in SQL, so a row left alone never takes a place under `limit`. Bounded by the running runs
   * (index `status, created_at`), their unsettled steps (`workflow_run_id, status`), the child by key and the step's
   * history by `(workflow_step_id, created_at)`; `limit` caps it like the sweep. One row that fails is logged and
   * left for the next pass; it never ends this one.
   */
  protected override async findStalledRunIds(before: Date, limit: number): Promise<string[]> {
    const candidates = this.db.selectFrom('workflowRuns as p')
      .innerJoin('workflowStep as s', 's.workflowRunId', 'p.workflowRunId')
      .innerJoin('workflowRuns as c', 'c.workflowRunId', 's.childRunId')
      .select(['p.workflowRunId as runId', 's.workflowStepId', 's.status as stepStatus', 's.currentAttempt', 's.leaseExpiresAt', 'c.workflowRunId as childId', 'c.status as childStatus'])
      .select((eb) => {
        const start = this.attemptStart(eb.ref('s.workflowStepId'), eb.ref('s.currentAttempt'))
        // Two-valued: with no history row the comparison is NULL, which neither branch of the filter below would take.
        return eb.or([eb.and([eb(start, 'is', null), eb(eb.fn.coalesce('s.currentAttempt', eb.val(1)), '<=', 1)]),
          eb.and([eb(start, 'is not', null), eb('c.createdAt', '>=', start)])]).as('current')
      })
      .where('p.status', '=', 'running').where('s.status', 'in', ['pending', 'scheduled', 'running'])
      .where('c.status', 'in', [...TERMINAL_WORKFLOW_STATUSES] as WorkflowStatus[]).where('c.updatedAt', '<', before)
    const rows = await this.db.selectFrom(candidates.as('u')).selectAll()
      .where((eb) => eb.or([
        eb.and([eb('u.current', '=', true), eb.or([eb('u.childStatus', '=', 'completed'), eb('u.stepStatus', '=', 'running')])]),
        eb.and([eb('u.current', '=', false), eb('u.stepStatus', '=', 'running'), eb('u.leaseExpiresAt', '<', Date.now())]),
      ]))
      .limit(limit).execute()
    const reclaim: string[] = []
    for (const row of rows) {
      if (!row.current) { reclaim.push(row.runId); continue }
      try {
        const child = await super.getRun(row.childId)
        if (child) await this.tellParent(row.runId, row, child)
      } catch (error) {
        this.logger?.error(`workflow-recovery: could not tell run ${row.runId} of its settled child ${row.childId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return [...new Set([...reclaim, ...await super.findStalledRunIds(before, limit)])]
  }
  /**
   * When the step's current attempt began: its first history row (Pikku writes one per attempt: the step's creation,
   * `reclaimStepAttempt`, `createRetryAttempt`). A child created before it is an earlier attempt's. With no row, only
   * a first attempt counts its child. The row's time is the app's clock (ms) and a run's `created_at` the database's
   * `CURRENT_TIMESTAMP`; both are this host's clock (the database is local), and the gaps they order are several
   * round trips wide: a current child is started after its attempt's claim, and an earlier attempt's child settled
   * and failed its step before the retry's claim.
   */
  private attemptStart(stepId: Expression<string>, attempt: Expression<number | null>) {
    return this.db.selectFrom('workflowStepHistory as h').select((eb) => eb.fn.min('h.createdAt').as('t'))
      .where('h.workflowStepId', '=', stepId).where('h.attempt', '=', attempt)
  }
  /**
   * What a settling child does (pikku-workflow-service.js `onChildWorkflowCompleted` / `onChildWorkflowFailed`):
   * write the step's outcome, then resume the parent. Done here with the same public calls because Pikku's hooks
   * take the parent ids from the child's wire, not the step row this was found by, and write unfenced: a step taken
   * by a newer attempt meanwhile must not get this attempt's outcome (`WorkflowStepSupersededError`).
   */
  private async tellParent(runId: string, step: { workflowStepId: string; currentAttempt: number | null }, child: FrameworkWorkflowRun) {
    const attempt = step.currentAttempt ?? 1
    try {
      if (child.status === 'completed') await this.setStepResult(step.workflowStepId, child.output, attempt)
      else await this.setStepError(step.workflowStepId, new Error(child.error?.message ?? `child workflow ${child.status}`), attempt)
    } catch (error) {
      if (error instanceof WorkflowStepSupersededError) return
      throw error
    }
    await this.resumeWorkflow(runId)
  }
  /**
   * A step whose child run has not settled is the child's to complete, never a dispatch's to run again.
   * Core 0.12.156 releases a queued child step's lease once the child starts; a replay of the parent re-arms the
   * step (`scheduled`) and dispatches it, and the framework's claim starts a second child. A parallel fan-out of
   * children (`Promise.all` of child `workflow.do`) replays on every sibling that settles, so each still-waiting child
   * was started again (the sim experiment's wave ran learners 2-4 times).
   * Only the step's current attempt's child counts: a retry keeps the previous attempt's `childRunId`.
   * - A settled child whose outcome never reached the step tells it now (`tellParent`); a failed one so spends one of
   *   the step's attempts through the framework's retry, with its delay.
   * - A step without a current child adopts the run started for it (`wire.parentStepId`, created in this attempt): a
   *   kill between the child's start and `setStepChildRunId` otherwise starts a second child once the lease lapses.
   * - Otherwise the step is the framework's: a first claim, or a retry starting its child.
   */
  protected override async claimStepForExecution(runId: string, stepName: string, rpcName: string, leaseMs: number) {
    const step = await this.db.selectFrom('workflowStep as s').select(['s.workflowStepId', 's.status', 's.childRunId', 's.leaseExpiresAt', 's.currentAttempt'])
      .select((eb) => this.attemptStart(eb.ref('s.workflowStepId'), eb.ref('s.currentAttempt')).as('attemptStart'))
      .where('s.workflowRunId', '=', runId).where('s.stepName', '=', stepName).executeTakeFirst()
    if (!step || step.status === 'succeeded' || step.status === 'failed') return super.claimStepForExecution(runId, stepName, rpcName, leaseMs)
    const since = step.attemptStart == null ? null : new Date(step.attemptStart)
    const recorded = step.childRunId ? await super.getRun(step.childRunId) : null
    // Only a step claimed before can have started an unrecorded child: a claim sets the lease, and only the release
    // after `setStepChildRunId` clears it. A first claim never pays for the lookup (index `workflow, created_at`).
    const current = recorded && (since ? recorded.createdAt >= since : (step.currentAttempt ?? 1) <= 1)
    // A retry with no history row has no attempt start to bound the lookup by, so any run found could be an earlier
    // attempt's: adopt nothing and let the framework start the child (review N11).
    const child = current ? recorded
      : step.leaseExpiresAt == null || (!since && (step.currentAttempt ?? 1) > 1) ? null
      : await this.adopt(rpcName, step.workflowStepId, since, step.childRunId)
    if (!child) return super.claimStepForExecution(runId, stepName, rpcName, leaseMs)
    if (child.id !== step.childRunId) await this.setStepChildRunId(step.workflowStepId, child.id)
    if (TERMINAL_WORKFLOW_STATUSES.has(child.status)) await this.tellParent(runId, step, child)
    return null
  }
  /** The newest run of `rpcName` started for this step in its current attempt (never the earlier attempt's), if any. */
  private async adopt(rpcName: string, stepId: string, since: Date | null, earlier: string | null) {
    let query = this.db.selectFrom('workflowRuns').select('workflowRunId').where('workflow', '=', rpcName)
      .where(sql<string>`wire::jsonb->>'parentStepId'`, '=', stepId)
    if (since) query = query.where('createdAt', '>=', since)
    if (earlier) query = query.where('workflowRunId', '!=', earlier)
    const row = await query.orderBy('createdAt', 'desc').executeTakeFirst()
    return row ? super.getRun(row.workflowRunId) : null
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
