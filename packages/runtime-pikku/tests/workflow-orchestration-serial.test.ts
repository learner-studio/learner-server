import { describe, expect, test } from 'bun:test'
import type { RpcInvoker } from '@learner/core/runtime/index.js'
import { LearnerWorkflowService } from '../src/transport.js'

// Two orchestrations of one run must not interleave in one process: the
// framework's beginReplay resets the run's shared step ordinals before the run
// lease is taken, so a second pass would renumber a looping first pass's steps.
class Probe extends LearnerWorkflowService {
  active = 0
  peak = 0
  order: string[] = []
  fail = new Set<string>()
  override async listStepStates(): Promise<null> { return null }
  override async runWorkflowJobInner(runId: string, rpc: { tag: string }): Promise<void> {
    this.active++
    this.peak = Math.max(this.peak, this.active)
    try {
      if (this.fail.delete(rpc.tag)) throw new Error('boom')
      this.order.push(`start:${runId}:${rpc.tag}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      this.order.push(`end:${runId}:${rpc.tag}`)
    } finally { this.active-- }
  }
}
const rpc = (tag: string) => ({ tag, rpcWithWire: () => {}, startWorkflow: () => {} }) as unknown as RpcInvoker
const probe = () => new Probe({} as never, { wireQueues: false } as never)

describe('workflow orchestration', () => {
  test('runs one orchestration of a run at a time, in arrival order; other runs overlap', async () => {
    const p = probe()
    await Promise.all([p.runWorkflowJob('r1', rpc('a')), p.runWorkflowJob('r1', rpc('b')), p.runWorkflowJob('r1', rpc('c'))])
    expect(p.peak).toBe(1)
    expect(p.order).toEqual(['start:r1:a', 'end:r1:a', 'start:r1:b', 'end:r1:b', 'start:r1:c', 'end:r1:c'])
    await Promise.all([p.runWorkflowJob('r1', rpc('a')), p.runWorkflowJob('r2', rpc('a'))])
    expect(p.peak).toBe(2)
  })

  test('a failed orchestration releases the run', async () => {
    const p = probe()
    p.fail.add('a')
    const results = await Promise.allSettled([p.runWorkflowJob('r1', rpc('a')), p.runWorkflowJob('r1', rpc('b'))])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect(p.order).toEqual(['start:r1:b', 'end:r1:b'])
  })
})
