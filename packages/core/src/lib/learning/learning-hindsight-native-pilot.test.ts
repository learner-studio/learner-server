import { describe, expect, test } from 'bun:test'
import { assertCompletedBridgeCallAudit, HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY, startPilotWorkflowOnce, submitNativeRetainOnce } from './learning-hindsight-native-pilot.js'

describe('native Hindsight AGY pilot contract', () => {
  test('has a distinct strategy that cannot overwrite frozen V1 runs', () => {
    expect(HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY).toBe('hindsight-agy-native-pilot-v1')
    expect(HINDSIGHT_AGY_NATIVE_PILOT_STRATEGY).not.toContain('seed-v1')
  })

  test('allows only one concurrent paid submit and replays its durable operation ID', async () => {
    let claimed = false
    let posts = 0
    let operationId: string | undefined
    const reserve = async () => {
      if (claimed) return false
      claimed = true
      return true
    }
    const attempt = () => submitNativeRetainOnce({
      checkpoint: {}, requestSha256: 'a'.repeat(64), reserve,
      post: async () => { posts += 1; return '11111111-1111-4111-8111-111111111111' },
      checkpointOperation: async id => { operationId = id }, markUncertain: async () => {},
    })
    const settled = await Promise.allSettled([attempt(), attempt()])
    expect(posts).toBe(1)
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(operationId).toBe('11111111-1111-4111-8111-111111111111')
    if (!operationId) throw new Error('test checkpoint missing operation ID')
    const replay = await submitNativeRetainOnce({ checkpoint: { retainState: 'submitted', retainOperationId: operationId, retainRequestSha256: 'a'.repeat(64) },
      requestSha256: 'a'.repeat(64), reserve: async () => { throw new Error('must not reserve') }, post: async () => { throw new Error('must not post') },
      checkpointOperation: async () => { throw new Error('must not checkpoint') }, markUncertain: async () => { throw new Error('must not mark') } })
    expect(replay).toEqual({ operationId, replayed: true })
  })

  test('marks ambiguous transport failure uncertain and refuses its replay', async () => {
    let uncertain = ''
    await expect(submitNativeRetainOnce({ checkpoint: {}, requestSha256: 'b'.repeat(64), reserve: async () => true,
      post: async () => { throw new Error('lost response') }, checkpointOperation: async () => {}, markUncertain: async message => { uncertain = message } })).rejects.toThrow('lost response')
    expect(uncertain).toBe('lost response')
    await expect(submitNativeRetainOnce({ checkpoint: { retainState: 'uncertain', retainRequestSha256: 'b'.repeat(64) }, requestSha256: 'b'.repeat(64),
      reserve: async () => true, post: async () => 'should-not-run', checkpointOperation: async () => {}, markUncertain: async () => {} })).rejects.toThrow('refusing a duplicate native submit')
  })

  test('atomically starts only one parent workflow and marks ambiguous starts uncertain', async () => {
    let claimed = false
    let starts = 0
    let checkpoint = ''
    const attempt = () => startPilotWorkflowOnce({ reserve: async () => claimed ? false : (claimed = true),
      start: async () => { starts += 1; return 'workflow-1' }, checkpointStarted: async id => { checkpoint = id }, markUncertain: async () => {} })
    const settled = await Promise.allSettled([attempt(), attempt()])
    expect(starts).toBe(1)
    expect(checkpoint).toBe('workflow-1')
    expect(settled.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    let uncertain = ''
    await expect(startPilotWorkflowOnce({ reserve: async () => true, start: async () => { throw new Error('ambiguous start') },
      checkpointStarted: async () => {}, markUncertain: async message => { uncertain = message } })).rejects.toThrow('ambiguous start')
    expect(uncertain).toBe('ambiguous start')
  })

  test('requires one through five terminal-success bridge calls while allowing unknown usage', () => {
    expect(() => assertCompletedBridgeCallAudit({ callCount: 1, completedCalls: 1, failedCalls: 0 })).not.toThrow()
    expect(() => assertCompletedBridgeCallAudit({ callCount: 5, completedCalls: 5, failedCalls: 0 })).not.toThrow()
    expect(() => assertCompletedBridgeCallAudit({ callCount: 6, completedCalls: 6, failedCalls: 0 })).toThrow('within budget')
    expect(() => assertCompletedBridgeCallAudit({ callCount: 2, completedCalls: 1, failedCalls: 0 })).toThrow('within budget')
    expect(() => assertCompletedBridgeCallAudit({ callCount: 1, completedCalls: 0, failedCalls: 1 })).toThrow('within budget')
  })
})
