import { describe, expect, test } from 'bun:test'
import { PikkuWorkflowService } from '@pikku/core/workflow'

// Two orchestrations of one run used to interleave in one process: each
// beginReplay reset the run's shared step ordinals while the other was mid-run,
// so a run skipped ahead or repeated steps (patches/pikku-core-0.12.102.patch).
class Probe extends (PikkuWorkflowService as unknown as new (o: object) => {
  runWorkflowJob(runId: string, rpc: unknown): Promise<void>
}) {
  active = 0
  peak = 0
  order: string[] = []
  async runWorkflowJobInner(runId: string, tag: unknown): Promise<void> {
    this.active++
    this.peak = Math.max(this.peak, this.active)
    this.order.push(`start:${runId}:${tag}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
    this.order.push(`end:${runId}:${tag}`)
    this.active--
  }
}

describe('workflow orchestration', () => {
  test('runs one orchestration of a run at a time, in arrival order', async () => {
    const probe = new Probe({ wireQueues: false })
    await Promise.all([probe.runWorkflowJob('r1', 'a'), probe.runWorkflowJob('r1', 'b'), probe.runWorkflowJob('r1', 'c')])
    expect(probe.peak).toBe(1)
    expect(probe.order).toEqual(['start:r1:a', 'end:r1:a', 'start:r1:b', 'end:r1:b', 'start:r1:c', 'end:r1:c'])
  })

  test('different runs still overlap', async () => {
    const probe = new Probe({ wireQueues: false })
    await Promise.all([probe.runWorkflowJob('r1', 'a'), probe.runWorkflowJob('r2', 'a')])
    expect(probe.peak).toBe(2)
  })

  test('a failed orchestration releases the run', async () => {
    const probe = new Probe({ wireQueues: false })
    const inner = probe.runWorkflowJobInner.bind(probe)
    let first = true
    probe.runWorkflowJobInner = async (runId: string, tag: unknown) => {
      if (first) { first = false; throw new Error('boom') }
      return inner(runId, tag)
    }
    const results = await Promise.allSettled([probe.runWorkflowJob('r1', 'a'), probe.runWorkflowJob('r1', 'b')])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(probe.order).toEqual(['start:r1:b', 'end:r1:b'])
  })
})
