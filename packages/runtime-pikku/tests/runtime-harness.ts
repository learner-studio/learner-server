import { randomUUID } from 'node:crypto'
import { rpcService } from '@pikku/core/rpc'
import { setRuntimeRole } from '@learner/core/lib/learning/learning-worker-runtime.js'

/**
 * The framework runtime for one test file (the ONE copy, restart-safety R8): the worker role, queue steps on a pg-boss
 * schema of this run's own (dropped at `stop`, with any of the same prefix over an hour old, left by a killed run),
 * background jobs started after `prepare`. `databaseUrl` binds every service to that database; without it the
 * services use TEST_DATABASE_URL as configured.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bootRuntime(opts: { schemaPrefix: string; databaseUrl?: string; prepare?: (services: any) => Promise<void> | void }) {
  if (opts.databaseUrl) process.env.LEARNER_DATABASE_URL = process.env.DATABASE_URL = opts.databaseUrl
  process.env.LEARNING_LOCAL_MVP_ENABLED = 'true'
  const schema = `${opts.schemaPrefix}${Math.floor(Date.now() / 1000)}_${randomUUID().slice(0, 8)}`
  process.env.LEARNER_PIKKU_PGBOSS_SCHEMA = schema
  delete process.env.LEARNER_SCHEDULES_ENABLED
  setRuntimeRole('learning-worker')
  const booted = (async () => {
    await import('../.pikku/pikku-bootstrap.gen.js')
    const { createConfig } = await import('../src/config.js')
    const { createSingletonServices } = await import('../src/services.js')
    const services = await createSingletonServices(await createConfig())
    await opts.prepare?.(services)
    await services.backgroundJobs.start()
    return services
  })()
  const stop = async () => {
    await (await booted).backgroundJobs.stop()
    const { Client } = await import('pg')
    const client = new Client({ connectionString: opts.databaseUrl ?? process.env.TEST_DATABASE_URL })
    await client.connect()
    try {
      const names = (await client.query<{ name: string }>('SELECT nspname AS name FROM pg_namespace WHERE starts_with(nspname, $1)', [opts.schemaPrefix])).rows.map((r) => r.name)
        .filter((n) => n === schema || Number(n.slice(opts.schemaPrefix.length).split('_')[0]) < Date.now() / 1000 - 3600)
      for (const n of names) await client.query(`DROP SCHEMA IF EXISTS "${n}" CASCADE`)
    } finally { await client.end() }
  }
  /** Start `workflow` on the queue and return its run id. */
  const start = async (workflow: string, input: unknown) => {
    const services = await booted
    return (await services.workflowService.startWorkflow(workflow, input, { type: 'internal' }, rpcService.getContextRPCService(services, {}, false))).runId as string
  }
  /** Wait for a run to end (completed, failed or cancelled) or `ms` to pass; the run as it then stands. */
  const awaitRun = async (runId: string, ms = 100_000) => {
    const services = await booted
    let run = await services.workflowRunService.getRun(runId)
    for (const deadline = Date.now() + ms; run && !['completed', 'failed', 'cancelled'].includes(run.status) && Date.now() < deadline;) {
      await Bun.sleep(300)
      run = await services.workflowRunService.getRun(runId)
    }
    return run
  }
  return { booted, stop, start, awaitRun }
}
