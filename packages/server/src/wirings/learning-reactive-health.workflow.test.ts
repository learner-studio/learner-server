import { expect, test } from 'bun:test'
import { learningReactiveRecoveryWorkflow } from './learning-reactive-health.workflow.js'

// The recovery workflow's step sequence, with every step answered by a recorder.
const recorder = () => {
  const calls: Array<[string, unknown]> = []
  const workflow = {
    runId: 'wf', sleep: async () => {},
    do: async (_name: string, rpc: string, data: unknown) => {
      calls.push([rpc, data])
      if (rpc === 'reconcileLearningIndexVectorsStep') return { checked: 9, vectorless: ['c1', 'c2'], marked: 1, withContent: ['c2'] }
      if (rpc === 'planLearningReactiveRecoveryStep') return { releasableUnpaid: ['s1'], exhaustedHolds: 4 }
      if (rpc === 'releaseLearningReactiveUnpaidStep') return { released: 1 }
      if (rpc === 'releaseLearningReactiveExhaustedHoldsStep') return { released: 4 }
      return { started: 0 }
    },
  }
  return { calls, context: { workflow } as never }
}

test('apply releases exhausted routing holds before it routes, and reports the chunks with text it would not empty (review S6, S1)', async () => {
  const { calls, context } = recorder()
  const result = await learningReactiveRecoveryWorkflow.func({} as never, { requestId: 'r', apply: true, userId: 'u' } as never, context)
  expect(calls.map(([rpc]) => rpc)).toEqual(['reconcileLearningIndexVectorsStep', 'planLearningReactiveRecoveryStep', 'releaseLearningReactiveUnpaidStep',
    'releaseLearningReactiveExhaustedHoldsStep', 'routeLearningReactiveArrivalsStep', 'dispatchLearningReactiveConceptsStep'])
  expect(calls[3]![1]).toEqual({ userId: 'u' })
  expect(result).toMatchObject({ released: 1, releasedHolds: 4, emptied: 1, withContent: ['c2'] })
})

test('a dry run releases nothing', async () => {
  const { calls, context } = recorder()
  const result = await learningReactiveRecoveryWorkflow.func({} as never, { requestId: 'r', apply: false, userId: 'u' } as never, context)
  expect(calls.map(([rpc]) => rpc)).toEqual(['reconcileLearningIndexVectorsStep', 'planLearningReactiveRecoveryStep'])
  expect(result).toMatchObject({ released: 0, releasedHolds: 0 })
})
