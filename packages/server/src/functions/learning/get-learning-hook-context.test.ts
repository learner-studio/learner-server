import { afterAll, beforeAll, expect, test } from 'bun:test'
import { isHeldOut } from '@learner/core/lib/learning/learning-concept-holdout.js'
import { getLearningHookContext } from './get-learning-hook-context.function.js'

const previous = process.env.LEARNING_LOCAL_MVP_ENABLED
beforeAll(() => { process.env.LEARNING_LOCAL_MVP_ENABLED = 'true' })
afterAll(() => { if (previous === undefined) delete process.env.LEARNING_LOCAL_MVP_ENABLED; else process.env.LEARNING_LOCAL_MVP_ENABLED = previous })

const ids = Array.from({ length: 40 }, (_, i) => `hook-ctx-${i}`)
const held = ids.find(isHeldOut)!, taught = ids.find((id) => !isHeldOut(id))!
const assessment = (conceptId: string) => ({ conceptId, status: 'ready', sourceIds: ['m1'],
  assessment: { conceptId, understandingPercent: 40, confidence: 'medium', demonstrated: [], gaps: [], nextCheck: 'n', needsReview: true } })

test('the hook context never offers a held-out concept (osmosis-concept-holdout)', async () => {
  const services = {
    learningSemanticIndex: { search: async () => [{ messageId: 'm1' }] },
    learningCurriculumStore: { listGraphs: async () => [] },
    learningVectorTurns: { lookupAssessments: async () => ({ experimentId: null, assessments: [assessment(held), assessment(taught)] }) },
  }
  const out = await getLearningHookContext.func(services as never, { message: 'hi', requestId: 'r', foundationFirst: false } as never, { session: { userId: 'u' } } as never) as { conceptIds: string[]; context: string }
  expect(out.conceptIds).toEqual([taught])
  expect(out.context).not.toContain(held)
})
