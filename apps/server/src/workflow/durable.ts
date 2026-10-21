import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { DatabaseHandle } from '@learner/core/db/handle.js'
import type {
  RpcInvoker, WorkflowRun, WorkflowRunService, WorkflowService, WorkflowStep, WorkflowWire,
} from '@learner/core/runtime/index.js'

/**
 * Durable workflows without a framework.
 *
 * A run is a row in `learner_workflow_runs`; every step is a row in
 * `learner_workflow_steps` keyed by (run, step key). Executing a run replays its
 * body from the top: a step whose row is `succeeded` returns its stored result
 * without running again, so after a crash or restart the body fast-forwards to
 * the first unfinished step and continues from there. A step that was
 * `running` when the process died is executed again, so step bodies must be
 * idempotent: the same replay semantics the Learning code was written against.
 *
 * Step keys: the logical step name, plus `#n` for its n-th repeat within one
 * run (loops call the same step name many times). Replay is deterministic as
 * long as the body issues steps in the same order for the same input.
 *
 * Exclusivity: a run is executed under a lease (`lease_owner`, `lease_until`)
 * renewed by a heartbeat. A second executor that finds a live lease backs off;
 * a lapsed lease (dead process) is taken over by the next executor, which is
 * how a killed worker's run resumes.
 */

export type Duration = string | number
export interface StepOptions { retries?: number; retryDelay?: Duration; onError?: string }
export interface WorkflowContext {
  readonly runId: string
  readonly name: string
  /** Run a registered function (by RPC name) or an inline closure as a checkpointed step. */
  do<T = any>(stepName: string, rpcOrFn: string | (() => Promise<T> | T), data?: unknown, options?: StepOptions): Promise<T>
  /** A checkpointed pause: survives restarts (the wake time is stored). */
  sleep(stepName: string, duration: Duration): Promise<void>
}

/** Runs a workflow body. `invoke` executes a registered function as a step. */
export interface WorkflowHost {
  isWorkflow(name: string): boolean
  runBody(name: string, input: unknown, context: { workflow: WorkflowContext; rpc: RpcInvoker; wire: WorkflowWire | null }): Promise<unknown>
  invoke(name: string, data: unknown, context: { rpc: RpcInvoker; workflowStep: { runId: string; stepName: string }; wire?: WorkflowWire | null }): Promise<unknown>
  /** Hand a run to the worker (pg-boss). Absent in tests that execute inline. */
  dispatch?(workflowName: string, runId: string): Promise<void>
}

/** Default step retries when a step does not say (same default as before). */
export const DEFAULT_STEP_RETRIES = 5
export const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export class WorkflowCancelledError extends Error { constructor(runId: string) { super(`Workflow run ${runId} was cancelled`); this.name = 'WorkflowCancelledError' } }
/** Another live executor holds this run's lease. */
export class WorkflowLeasedError extends Error { constructor(runId: string) { super(`Workflow run ${runId} is leased by another executor`); this.name = 'WorkflowLeasedError' } }

export function durationMs(value: Duration | undefined): number {
  if (value === undefined) return 0
  if (typeof value === 'number') return value
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)?\s*$/i.exec(value)
  if (!m) throw new Error(`Unrecognised duration: ${value}`)
  const n = Number(m[1]), unit = (m[2] ?? 'ms').toLowerCase()
  const k = unit === 'ms' ? 1 : unit.startsWith('s') ? 1000 : unit === 'm' || unit.startsWith('min') ? 60_000 : unit.startsWith('h') ? 3_600_000 : 86_400_000
  return n * k
}

const parse = (text: string | null | undefined) => {
  if (text === null || text === undefined) return undefined
  try { return JSON.parse(text) } catch { return text }
}
const serialiseError = (error: unknown) => {
  if (error instanceof Error) {
    const { message, name, stack } = error
    return { ...Object.fromEntries(Object.entries(error as unknown as Record<string, unknown>).filter(([, v]) => typeof v !== 'function')), name, message, stack }
  }
  return { message: String(error) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface RunRow { workflow_run_id: string; workflow: string; status: string; input: string; output: string | null; error: string | null; wire: string | null; created_at: Date; updated_at: Date }
interface StepRow { workflow_step_id: string; step_name: string; rpc_name: string | null; data: string | null; status: string; result: string | null; error: string | null; current_attempt: number | null; created_at: Date; updated_at: Date }

const toRun = (r: RunRow): WorkflowRun => {
  const wire = parse(r.wire) as Record<string, unknown> | undefined
  return {
    id: r.workflow_run_id, workflow: r.workflow, status: r.status, input: parse(r.input), output: parse(r.output),
    error: parse(r.error) ?? null, wire: wire ? normaliseWire(wire) : {}, createdAt: r.created_at, updatedAt: r.updated_at,
  }
}
/** Historical runs carried over from the previous host named the owner with a framework-prefixed key. */
const LEGACY_USER_KEY = ['pik', 'kuUserId'].join('')
function normaliseWire(wire: Record<string, unknown>): WorkflowWire {
  const userId = (wire.userId ?? wire[LEGACY_USER_KEY]) as string | undefined
  const { [LEGACY_USER_KEY]: _legacy, ...rest } = wire
  return { ...rest, ...(userId ? { userId } : {}) } as WorkflowWire
}
const toStep = (s: StepRow): WorkflowStep => ({
  stepId: s.workflow_step_id, stepName: s.step_name, rpcName: s.rpc_name, data: parse(s.data), status: s.status,
  result: parse(s.result), error: parse(s.error) ?? null, attemptCount: s.current_attempt ?? 0, createdAt: s.created_at, updatedAt: s.updated_at,
})

export interface DurableEngineOptions {
  /** Lease length; a dead executor's run becomes resumable after this. */
  leaseMs?: number
  /** Executor identity written to `lease_owner`. */
  owner?: string
  /** Fault injection for crash/resume tests: pause this long after the named step commits. */
  pauseAfterStep?: { stepName: string; ms: number }
}

export class DurableEngine implements WorkflowService, WorkflowRunService {
  readonly owner: string
  readonly leaseMs: number
  private host: WorkflowHost | undefined
  /** Runs executing in this process (inline children are awaited, not re-entered). */
  private readonly executing = new Map<string, Promise<void>>()
  /** The wire of each run executing here, so its steps run as the run's owner. */
  private readonly wires = new Map<string, WorkflowWire | null>()

  constructor(private readonly db: DatabaseHandle, private readonly options: DurableEngineOptions = {}) {
    this.owner = options.owner ?? `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`
    this.leaseMs = options.leaseMs ?? 60_000
  }
  attach(host: WorkflowHost) { this.host = host; return this }
  private get h() { if (!this.host) throw new Error('DurableEngine has no host attached'); return this.host }

  // ---------------------------------------------------------------- runs
  async startWorkflow(name: string, input: unknown, wire: WorkflowWire = { type: 'internal' }, _rpc?: RpcInvoker, options: { inline?: boolean } = {}) {
    if (!this.h.isWorkflow(name)) throw new Error(`Unknown workflow: ${name}`)
    const runId = randomUUID()
    await this.db.query(
      `INSERT INTO learner_workflow_runs (workflow_run_id, workflow, status, input, wire) VALUES ($1, $2, 'running', $3, $4)`,
      [runId, name, JSON.stringify(input ?? {}), JSON.stringify(wire)])
    if (options.inline || !this.h.dispatch) await this.runWorkflowJob(runId)
    else await this.h.dispatch(name, runId)
    return { runId }
  }

  /** Execute or resume `runId` here; resolves when the run settles (or is leased elsewhere). */
  async runWorkflowJob(runId: string, _rpc?: RpcInvoker): Promise<void> {
    const inFlight = this.executing.get(runId)
    if (inFlight) return inFlight
    const work = this.execute(runId).finally(() => this.executing.delete(runId))
    this.executing.set(runId, work)
    return work
  }

  private async claim(runId: string): Promise<RunRow | 'leased' | 'terminal' | 'missing'> {
    const claimed = await this.db.query<RunRow>(
      `UPDATE learner_workflow_runs SET lease_owner = $2, lease_until = now() + ($3::int * interval '1 millisecond')
        WHERE workflow_run_id = $1 AND status IN ('running','suspended')
          AND (lease_until IS NULL OR lease_until < now() OR lease_owner = $2)
        RETURNING *`, [runId, this.owner, this.leaseMs])
    if (claimed.rows[0]) return claimed.rows[0]
    const row = (await this.db.query<RunRow>('SELECT * FROM learner_workflow_runs WHERE workflow_run_id = $1', [runId])).rows[0]
    if (!row) return 'missing'
    return TERMINAL.has(row.status) ? 'terminal' : 'leased'
  }

  private async execute(runId: string): Promise<void> {
    const claimed = await this.claim(runId)
    if (claimed === 'terminal' || claimed === 'missing') return
    if (claimed === 'leased') throw new WorkflowLeasedError(runId)
    const heartbeat = setInterval(() => {
      this.db.query(`UPDATE learner_workflow_runs SET lease_until = now() + ($3::int * interval '1 millisecond') WHERE workflow_run_id = $1 AND lease_owner = $2`,
        [runId, this.owner, this.leaseMs]).catch(() => undefined)
    }, Math.max(250, Math.floor(this.leaseMs / 4)))
    try {
      if (claimed.status === 'suspended') await this.db.query(`UPDATE learner_workflow_runs SET status = 'running', updated_at = now() WHERE workflow_run_id = $1`, [runId])
      const steps = new Map((await this.stepRows(runId)).map((s) => [s.step_name, s]))
      const wire = claimed.wire ? normaliseWire(parse(claimed.wire)) : null
      this.wires.set(runId, wire)
      const context = this.context(runId, claimed.workflow, steps)
      const rpc = this.rpcFor(runId, 'workflow-body')
      const output = await this.h.runBody(claimed.workflow, parse(claimed.input), { workflow: context, rpc, wire })
      await this.settle(runId, 'completed', output, undefined)
    } catch (error) {
      if (error instanceof WorkflowCancelledError) return
      await this.settle(runId, 'failed', undefined, error)
    } finally {
      clearInterval(heartbeat)
      this.wires.delete(runId)
      await this.db.query(`UPDATE learner_workflow_runs SET lease_owner = NULL, lease_until = NULL WHERE workflow_run_id = $1 AND lease_owner = $2`, [runId, this.owner]).catch(() => undefined)
    }
  }

  private async settle(runId: string, status: 'completed' | 'failed', output: unknown, error: unknown) {
    // Never overwrite a cancellation that landed while the body was running.
    await this.db.query(
      `UPDATE learner_workflow_runs SET status = $2, output = $3, error = $4, updated_at = now()
        WHERE workflow_run_id = $1 AND status NOT IN ('cancelled')`,
      [runId, status, output === undefined ? null : JSON.stringify(output), error === undefined ? null : JSON.stringify(serialiseError(error))])
  }

  private rpcFor(runId: string, stepName: string): RpcInvoker {
    return { invoke: (name, data) => this.h.invoke(name, data, { rpc: this.rpcFor(runId, stepName), workflowStep: { runId, stepName }, wire: this.wires.get(runId) }) as never }
  }

  // ---------------------------------------------------------------- steps
  private context(runId: string, name: string, steps: Map<string, StepRow>): WorkflowContext {
    const ordinals = new Map<string, number>()
    const key = (logical: string) => {
      const n = ordinals.get(logical) ?? 0
      ordinals.set(logical, n + 1)
      return n === 0 ? logical : `${logical}#${n}`
    }
    const engine = this
    return {
      runId, name,
      async do(stepName, rpcOrFn, data, options = {}) {
        const stepKey = key(stepName)
        const rpcName = typeof rpcOrFn === 'string' ? rpcOrFn : null
        const work = typeof rpcOrFn === 'string'
          ? () => engine.runStepFunction(runId, stepKey, rpcOrFn, data)
          : async () => rpcOrFn()
        return engine.step(runId, steps, stepKey, rpcName, data, work, options) as never
      },
      async sleep(stepName, duration) {
        const stepKey = key(stepName)
        await engine.sleepStep(runId, steps, stepKey, durationMs(duration))
      },
    }
  }

  /** A step that is itself a workflow runs as an inline child run (as before). */
  private async runStepFunction(runId: string, stepKey: string, rpcName: string, data: unknown) {
    if (this.h.isWorkflow(rpcName)) {
      const parent = await this.getRun(runId)
      const { runId: childId } = await this.startWorkflow(rpcName, data, { type: 'workflow', id: rpcName, parentRunId: runId, userId: parent?.wire?.userId }, undefined, { inline: true })
      const child = await this.getRun(childId)
      if (child?.status === 'failed') throw new Error(child.error?.message || 'Sub-workflow failed')
      if (child?.status === 'cancelled') throw new Error('Sub-workflow was cancelled')
      return child?.output
    }
    return this.h.invoke(rpcName, data, { rpc: this.rpcFor(runId, stepKey), workflowStep: { runId, stepName: stepKey }, wire: this.wires.get(runId) })
  }

  private async assertNotCancelled(runId: string) {
    const status = (await this.db.query<{ status: string }>('SELECT status FROM learner_workflow_runs WHERE workflow_run_id = $1', [runId])).rows[0]?.status
    if (status === 'cancelled') throw new WorkflowCancelledError(runId)
  }

  private async upsertStep(runId: string, stepKey: string, rpcName: string | null, data: unknown, options: StepOptions, status: string, attempt: number) {
    const r = await this.db.query<StepRow>(
      `INSERT INTO learner_workflow_steps (workflow_run_id, step_name, rpc_name, data, status, retries, retry_delay, current_attempt)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workflow_run_id, step_name) DO UPDATE SET status = EXCLUDED.status, current_attempt = EXCLUDED.current_attempt, updated_at = now()
       RETURNING *`,
      [runId, stepKey, rpcName, data === undefined ? null : JSON.stringify(data), status, options.retries ?? null,
        options.retryDelay === undefined ? null : String(options.retryDelay), attempt])
    return r.rows[0]!
  }

  private async step(runId: string, steps: Map<string, StepRow>, stepKey: string, rpcName: string | null, data: unknown,
    work: () => Promise<unknown>, options: StepOptions): Promise<unknown> {
    const existing = steps.get(stepKey)
    if (existing?.status === 'succeeded') return parse(existing.result)
    if (existing?.status === 'failed') {
      const error = Object.assign(new Error((parse(existing.error) as { message?: string } | undefined)?.message ?? `Step '${stepKey}' failed`), parse(existing.error) ?? {})
      if (options.onError) await this.compensate(runId, steps, stepKey, options.onError, error)
      throw error
    }
    await this.assertNotCancelled(runId)
    const retries = options.retries ?? DEFAULT_STEP_RETRIES
    let attempt = existing?.current_attempt ?? 0
    for (;;) {
      attempt += 1
      await this.upsertStep(runId, stepKey, rpcName, data, options, 'running', attempt)
      try {
        const result = await work()
        const row = (await this.db.query<StepRow>(
          `UPDATE learner_workflow_steps SET status = 'succeeded', result = $3, error = NULL, updated_at = now()
            WHERE workflow_run_id = $1 AND step_name = $2 RETURNING *`,
          [runId, stepKey, result === undefined ? null : JSON.stringify(result)])).rows[0]!
        steps.set(stepKey, row)
        const pause = this.options.pauseAfterStep
        if (pause && pause.stepName === stepKey) {
          console.log(JSON.stringify({ event: 'workflow-step-pause', runId, stepKey, ms: pause.ms }))
          await sleep(pause.ms)
        }
        // Results round-trip through JSON so a replayed step and a fresh one return the same shape.
        return parse(row.result)
      } catch (error) {
        await this.db.query(`UPDATE learner_workflow_steps SET status = $3, error = $4, updated_at = now() WHERE workflow_run_id = $1 AND step_name = $2`,
          [runId, stepKey, attempt > retries ? 'failed' : 'pending', JSON.stringify(serialiseError(error))])
        if (attempt > retries) {
          if (options.onError) await this.compensate(runId, steps, stepKey, options.onError, error as Error)
          throw error
        }
        const delay = durationMs(options.retryDelay)
        if (delay) await sleep(delay)
      }
    }
  }

  private async compensate(runId: string, steps: Map<string, StepRow>, stepKey: string, onError: string, error: Error) {
    const key = `${stepKey}:onError`
    await this.step(runId, steps, key, onError, { error: { message: error.message } },
      () => this.runStepFunction(runId, key, onError, { error: { message: error.message } }), { retries: 0 })
  }

  private async sleepStep(runId: string, steps: Map<string, StepRow>, stepKey: string, ms: number) {
    const existing = steps.get(stepKey)
    if (existing?.status === 'succeeded') return
    await this.assertNotCancelled(runId)
    let wakeAt = (parse(existing?.data) as { wakeAt?: string } | undefined)?.wakeAt
    if (!wakeAt) {
      wakeAt = new Date(Date.now() + ms).toISOString()
      const row = (await this.db.query<StepRow>(
        `INSERT INTO learner_workflow_steps (workflow_run_id, step_name, data, status, current_attempt) VALUES ($1, $2, $3, 'scheduled', 1)
         ON CONFLICT (workflow_run_id, step_name) DO UPDATE SET updated_at = now() RETURNING *`,
        [runId, stepKey, JSON.stringify({ duration: ms, wakeAt })])).rows[0]!
      wakeAt = (parse(row.data) as { wakeAt: string }).wakeAt
    }
    const remaining = new Date(wakeAt).getTime() - Date.now()
    if (remaining > 0) await sleep(remaining)
    const row = (await this.db.query<StepRow>(`UPDATE learner_workflow_steps SET status = 'succeeded', updated_at = now() WHERE workflow_run_id = $1 AND step_name = $2 RETURNING *`, [runId, stepKey])).rows[0]!
    steps.set(stepKey, row)
  }

  private async stepRows(runId: string) {
    return (await this.db.query<StepRow>('SELECT * FROM learner_workflow_steps WHERE workflow_run_id = $1 ORDER BY created_at', [runId])).rows
  }

  // ---------------------------------------------------------------- queries
  async getRun(runId: string) {
    const row = (await this.db.query<RunRow>('SELECT * FROM learner_workflow_runs WHERE workflow_run_id = $1', [runId])).rows[0]
    return row ? toRun(row) : null
  }
  async listRuns(options: { status?: string; workflowName?: string; limit?: number; offset?: number } = {}) {
    const where: string[] = [], params: unknown[] = []
    if (options.status) { params.push(options.status); where.push(`status = $${params.length}`) }
    if (options.workflowName) { params.push(options.workflowName); where.push(`workflow = $${params.length}`) }
    params.push(options.limit ?? 100, options.offset ?? 0)
    const rows = (await this.db.query<RunRow>(
      `SELECT * FROM learner_workflow_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params)).rows
    return rows.map(toRun)
  }
  async getRunSteps(runId: string) { return (await this.stepRows(runId)).map(toStep) }
  async deleteRun(runId: string) {
    return (await this.db.query(`DELETE FROM learner_workflow_runs WHERE workflow_run_id = $1 AND status IN ('completed','failed','cancelled')`, [runId])).rowCount > 0
  }
  async updateRunStatus(runId: string, status: string, output?: unknown, error?: unknown) {
    await this.db.query(`UPDATE learner_workflow_runs SET status = $2, output = COALESCE($3, output), error = COALESCE($4, error), updated_at = now() WHERE workflow_run_id = $1`,
      [runId, status, output === undefined ? null : JSON.stringify(output), error === undefined ? null : JSON.stringify(error)])
  }

  /**
   * Runs that this engine created and whose executor died (lease lapsed while
   * still `running`). Runs copied from the previous host have never been leased
   * here and are deliberately NOT adopted.
   */
  async findOrphanedRuns(workflows?: readonly string[]) {
    const rows = (await this.db.query<{ workflow_run_id: string; workflow: string }>(
      `SELECT workflow_run_id, workflow FROM learner_workflow_runs
        WHERE status = 'running' AND lease_owner IS NOT NULL AND lease_until < now()
          AND ($1::text[] IS NULL OR workflow = ANY($1::text[]))`, [workflows ?? null])).rows
    return rows.map((r) => ({ runId: r.workflow_run_id, workflow: r.workflow }))
  }
}
