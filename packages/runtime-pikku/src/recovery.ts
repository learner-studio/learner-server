import { DEFAULT_STEP_RETRIES } from '@pikku/core/workflow'
import type { Logger } from '@learner/core/runtime/index.js'
import type { LearnerWorkflowRunService, LearnerWorkflowService } from './transport.js'

/**
 * Boot-time replay of the runs whose executor died: the framework's half of
 * the standalone engine's orphan recovery.
 *
 * A step runs inside the worker process. When the process dies mid-step the
 * row stays `running`, and both of the framework's own recovery queries read a
 * `running` step as proof that someone is working on it, so the run would
 * never finish and never fail. Only the worker executes runs, and it holds the
 * role's singleton fence, so at its boot every run row and step row written
 * before it started was written by a process that is gone.
 *
 * Only runs this runtime created are touched: those carry the graph hash it
 * records at start. A run the standalone engine started (it leases its runs
 * instead), or one carried over from the previous host, is never resumed
 * here; in-flight runs do not migrate between runtimes.
 *
 * Recovery resumes the SAME run: completed steps stay cached, an interrupted
 * step replays in place (step bodies are idempotent), and a step that failed
 * between the framework's error and retry writes gets a fresh attempt.
 */
export interface RecoveryResult { recovered: string[]; retriedSteps: string[]; failed: string[] }

type Steps = Awaited<ReturnType<LearnerWorkflowRunService['getRunSteps']>>
const epoch = (value: Date | string | number | null | undefined) => {
  const time = value == null ? NaN : new Date(value).getTime()
  return Number.isFinite(time) ? time : null
}

/** The step ids to retry, or null when the run is not provably orphaned. */
function retryPlan(run: { status: string; graphHash?: string; createdAt: Date; updatedAt: Date }, steps: Steps, bootedAt: number): string[] | null {
  if (run.status !== 'running' || !run.graphHash) return null
  const writes = [run.updatedAt ?? run.createdAt, ...steps.map((s) => s.updatedAt ?? s.createdAt)]
  if (writes.some((w) => { const t = epoch(w); return t === null || t >= bootedAt })) return null
  // Waiting by design: on an external resume, or on a child run that resumes it when it settles.
  if (steps.some((s) => s.status === 'suspended' || (s.status === 'running' && s.childRunId))) return null
  const retry = steps.filter((s) => s.status === 'failed' && (s.attemptCount ?? 0) < (s.retries ?? DEFAULT_STEP_RETRIES) + 1)
  // A durable sleep (pg-boss keeps the timer) with nothing running is legitimately waiting.
  if (!retry.length && steps.some((s) => s.status === 'scheduled') && !steps.some((s) => s.status === 'running')) return null
  return retry.map((s) => s.stepId)
}

export async function recoverInterruptedRuns(
  runs: LearnerWorkflowRunService,
  workflows: LearnerWorkflowService,
  { bootedAt, logger, pageSize = 500 }: { bootedAt: number; logger: Logger; pageSize?: number },
): Promise<RecoveryResult> {
  // Snapshot first: a resumed run that completes leaves the `running` page and would shift the offsets.
  const running = []
  for (let offset = 0; ; offset += pageSize) {
    const page = await runs.listRuns({ status: 'running', limit: pageSize, offset })
    running.push(...page)
    if (page.length < pageSize) break
  }
  const result: RecoveryResult = { recovered: [], retriedSteps: [], failed: [] }
  for (const run of running) {
    if (!run.graphHash) continue
    try {
      const retry = retryPlan(run, await runs.getRunSteps(run.id), bootedAt)
      if (!retry) continue
      for (const stepId of retry) {
        await workflows.createRetryAttempt(stepId, 'pending')
        result.retriedSteps.push(stepId)
      }
      await workflows.resumeWorkflow(run.id)
      result.recovered.push(run.id)
    } catch (error) {
      result.failed.push(run.id)
      logger.error({ event: 'workflow-recovery-failed', runId: run.id, message: (error as Error).message })
    }
  }
  if (result.recovered.length || result.failed.length) logger.info({ event: 'workflow-recovery', ...result })
  return result
}
