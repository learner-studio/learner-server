import { PgBoss } from 'pg-boss'
import { Pool } from 'pg'
import { STOPPED_WORKFLOW_STATUSES } from '@learner/core/lib/workflow/workflow-runs.js'

/**
 * Quiesce the workflow runtime before a deploy changes its code (scripts/deploy.ts). The caller has stopped the API
 * unit (no run is admitted over HTTP); this pauses the schedules and waits until no run is in flight and no queue
 * job is due or active, since a job queued before the pause (a schedule tick, a job the API enqueued) can still
 * start a run.
 *
 * Pausing is the framework's own: @pikku/queue-pg-boss's `PgBossSchedulerService.stop()` unschedules each recurring
 * task's pg-boss schedule (pg-boss-scheduler-service.js:137-142), and its `start()`, which every worker boot runs,
 * schedules them all again (:93-103). So a pause cannot outlive a unit restart: a worker that restarts mid-drain is
 * a normal worker again, and the drain re-asserts the pause on every poll while it waits. A schedule only produces
 * jobs (pg-boss's timekeeper), so a paused schedule loses no work: its next tick after the restart runs as usual.
 */
export const RECURRING_TASK_PREFIX = 'pikku-recurring-scheduled-task_' // pg-boss-scheduler-service.js:8, not exported

async function pauseSchedules(boss: PgBoss): Promise<string[]> {
  const names = (await boss.getSchedules()).map((s) => s.name).filter((name) => name.startsWith(RECURRING_TASK_PREFIX))
  for (const name of names) await boss.unschedule(name)
  return names
}

type Busy = { runs: { runId: string; workflow: string; status: string; createdAt: Date }[]; jobs: { queue: string; count: number }[] }

/** Every run not in a terminal status (running, suspended, compensating), oldest first; every queue with a job due or active. */
async function busy(pool: Pool, bossSchema: string): Promise<Busy> {
  const terminal = [...STOPPED_WORKFLOW_STATUSES, 'completed']
  const runs = (await pool.query(`SELECT workflow_run_id::text AS "runId", workflow, status, created_at AS "createdAt"
    FROM learner_workflow_runs WHERE status <> ALL($1::text[]) ORDER BY created_at`, [terminal])).rows
  // A deferred job (start_after ahead) is not running and runs on the new code after the deploy, as any queued job does.
  const jobs = (await pool.query(`SELECT name AS queue, count(*)::int AS count FROM "${bossSchema}".job
    WHERE state = 'active' OR (state IN ('created', 'retry') AND start_after <= now()) GROUP BY name ORDER BY name`)).rows
  return { runs, jobs }
}

/** Pause the schedules (again on every poll) until nothing is busy, or the timeout; then what is still busy. */
export async function drain(opts: { connectionString: string; bossSchema: string; timeoutMs: number; pollMs?: number; log?: (line: string) => void }) {
  const log = opts.log ?? (() => {})
  // Its own small pg-boss client: no workers, no timekeeper, no supervisor, no migration; it only reads and unschedules.
  const boss = new PgBoss({ connectionString: opts.connectionString, schema: opts.bossSchema, max: 1, schedule: false, supervise: false, migrate: false, application_name: 'learner-drain' })
  boss.on('error', (error) => log(`drain: pg-boss: ${(error as Error).message}`))
  const pool = new Pool({ connectionString: opts.connectionString, max: 1, application_name: 'learner-drain' })
  try {
    await boss.start()
    const deadline = Date.now() + opts.timeoutMs
    const paused = new Set<string>()
    for (;;) {
      for (const name of await pauseSchedules(boss)) paused.add(name)
      const left = await busy(pool, opts.bossSchema)
      if (left.runs.length === 0 && left.jobs.length === 0) return { drained: true, paused: [...paused], left }
      if (Date.now() >= deadline) return { drained: false, paused: [...paused], left }
      log(`drain: ${left.runs.length} run(s) in flight (${[...new Set(left.runs.map((r) => r.workflow))].join(', ')}); jobs due in ${left.jobs.map((j) => `${j.queue} x${j.count}`).join(', ') || 'no queue'}`)
      await Bun.sleep(opts.pollMs ?? 2_000)
    }
  } finally {
    await boss.stop({ graceful: false, close: true }).catch(() => {})
    await pool.end().catch(() => {})
  }
}
