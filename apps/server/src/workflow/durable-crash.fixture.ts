import { createDatabase } from '@learner/core/db/handle.js'
import { DurableEngine, type WorkflowHost } from './durable.js'

/**
 * Subprocess half of the crash/resume test: executes one run of `crashProbe`
 * and pauses after step `one` commits, so the parent can SIGKILL it mid-run.
 *   bun durable-crash.fixture.ts <runId> <leaseMs>
 */
export const PROBE_WORKFLOW = 'crashProbe'

export function probeHost(db: ReturnType<typeof createDatabase>): WorkflowHost {
  const record = (runId: string, step: string) =>
    db.query('INSERT INTO durable_probe (run_id, step) VALUES ($1, $2)', [runId, step]).then(() => step)
  return {
    isWorkflow: (name) => name === PROBE_WORKFLOW,
    async runBody(_name, input, { workflow }) {
      const one = await workflow.do('one', () => record(workflow.runId, 'one'))
      const two = await workflow.do('two', () => record(workflow.runId, 'two'))
      return { one, two, input }
    },
    invoke: async () => { throw new Error('crashProbe has no RPC steps') },
    dispatch: async () => undefined,
  }
}

if (import.meta.main) {
  const [runId, leaseMs] = process.argv.slice(2)
  const db = createDatabase(process.env.TEST_DATABASE_URL!, { max: 2 })
  const engine = new DurableEngine(db, { leaseMs: Number(leaseMs), pauseAfterStep: { stepName: 'one', ms: 600_000 } }).attach(probeHost(db))
  await engine.runWorkflowJob(runId!)
}
