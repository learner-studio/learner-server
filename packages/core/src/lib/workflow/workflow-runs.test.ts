import { describe, expect, test } from 'bun:test'
import type { WorkflowRun, WorkflowRunService, WorkflowService } from '../../runtime/types.js'
import { cancelRunForUser, isRunActive } from './workflow-runs.js'

// @pikku/core 0.12.156 ends a failed run that unwound its steps `compensated` (or `compensation_failed`): terminal.
describe('the unwind statuses are terminal', () => {
  const run = (status: string): WorkflowRun => ({ id: 'r1', workflow: 'w', status, input: {}, wire: { userId: 'u1' }, createdAt: new Date(), updatedAt: new Date() })

  test.each(['compensated', 'compensation_failed'])('%s: not active, and a cancel leaves it as it ended', async (status) => {
    expect(isRunActive(run(status))).toBe(false)
    const written: string[] = []
    const runs = { getRun: async () => run(status) } as unknown as WorkflowRunService
    const workflows = { updateRunStatus: async (_id: string, s: string) => { written.push(s) } } as unknown as WorkflowService
    expect(await cancelRunForUser(runs, workflows, 'u1', 'r1')).toEqual({ found: true, cancelled: false, status })
    expect(written).toEqual([])
  })
})
