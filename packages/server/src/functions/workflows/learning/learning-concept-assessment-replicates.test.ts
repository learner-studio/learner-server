import { expect, test } from 'bun:test'
import { learningConceptAssessmentWorkflow } from './learning-concept-assessment.workflow.js'
import { learningReactiveConceptWorkflow } from '../../../wirings/learning-reactive-consolidation.workflow.js'

// The workflow shape of replicate grading (docs/specs/mastery-change-statistics.md): each extra grading
// is its own step, and the mean is combined before the reading is published.
const recorder = (replicates: number[], batches = 1) => {
  const calls: Array<[string, unknown]> = []
  const workflow = {
    runId: 'wf', sleep: async () => {},
    do: async (_name: string, rpc: string, data: unknown) => {
      calls.push([rpc, data])
      if (rpc === 'planLearningAssessmentReplicatesStep') return { runId: (data as { runId: string }).runId, replicates }
      if (rpc === 'prepareLearningVectorExperimentStep') return { batches: Array.from({ length: batches }, (_, i) => [{ part: i }]) }
      if (rpc === 'prepareLearningReactivePassStep') return { runId: 'pass', conceptId: 'c' }
      if (rpc === 'prepareLearningVectorAssessmentStep') return { runId: `part-${(data as { part: number }).part}` }
      return { runId: 'r', status: 'completed' }
    },
  }
  return { calls, context: { workflow } as never }
}

test('manual assessment at k = 1 is the old sequence plus an empty plan', async () => {
  const { calls, context } = recorder([])
  await learningConceptAssessmentWorkflow.func({} as never, { runId: 'r' } as never, context)
  expect(calls.map(([rpc]) => rpc)).toEqual(['planLearningAssessmentReplicatesStep', 'executeLearningConceptAssessmentStep', 'publishLearningConceptAssessmentStep'])
})

test('manual assessment at k = 3: two replicate steps, then the mean, then publication', async () => {
  const { calls, context } = recorder([2, 3])
  await learningConceptAssessmentWorkflow.func({} as never, { runId: 'r' } as never, context)
  expect(calls).toEqual([
    ['planLearningAssessmentReplicatesStep', { runId: 'r' }],
    ['executeLearningConceptAssessmentStep', { runId: 'r' }],
    ['executeLearningAssessmentReplicateStep', { runId: 'r', replicate: 2 }],
    ['executeLearningAssessmentReplicateStep', { runId: 'r', replicate: 3 }],
    ['combineLearningAssessmentReplicatesStep', { runId: 'r' }],
    ['publishLearningConceptAssessmentStep', { runId: 'r' }],
  ])
})

test('a reactive pass replicates only its last (published) part, before the pass finishes', async () => {
  const { calls, context } = recorder([2, 3], 3)
  await learningReactiveConceptWorkflow.func({} as never, { userId: 'u', sessionId: 's', conceptId: 'c' } as never, context)
  const rpcs = calls.map(([rpc, data]) => rpc === 'executeLearningAssessmentReplicateStep' || rpc === 'planLearningAssessmentReplicatesStep' || rpc === 'combineLearningAssessmentReplicatesStep' || rpc === 'executeLearningConceptAssessmentStep' ? `${rpc}:${JSON.stringify(data)}` : rpc)
  expect(rpcs.filter((x) => x.startsWith('planLearning'))).toEqual(['planLearningAssessmentReplicatesStep:{"runId":"part-2"}'])
  expect(rpcs.filter((x) => x.startsWith('executeLearningAssessmentReplicateStep'))).toEqual([
    'executeLearningAssessmentReplicateStep:{"runId":"part-2","replicate":2}', 'executeLearningAssessmentReplicateStep:{"runId":"part-2","replicate":3}'])
  // Planned after the last part's own grading: a pass part is not a reading until the pass finishes.
  expect(rpcs.indexOf('planLearningAssessmentReplicatesStep:{"runId":"part-2"}')).toBeGreaterThan(rpcs.indexOf('executeLearningConceptAssessmentStep:{"runId":"part-2"}'))
  const combine = rpcs.indexOf('combineLearningAssessmentReplicatesStep:{"runId":"part-2"}')
  expect(combine).toBeGreaterThan(-1)
  expect(combine).toBeLessThan(rpcs.indexOf('finishLearningVectorExperimentStep'))
  expect(combine).toBeLessThan(rpcs.indexOf('publishLearningReactivePassStep'))
})

test('a reactive pass at k = 1 runs no replicate or combine step', async () => {
  const { calls, context } = recorder([], 2)
  await learningReactiveConceptWorkflow.func({} as never, { userId: 'u', sessionId: 's', conceptId: 'c' } as never, context)
  expect(calls.map(([rpc]) => rpc).filter((rpc) => /Replicate|combine/.test(rpc))).toEqual(['planLearningAssessmentReplicatesStep'])
})
