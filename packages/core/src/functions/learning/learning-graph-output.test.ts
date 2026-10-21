import { expect, test } from 'bun:test'
import { COMPUTER_SCIENCE } from './computer-science-seed.js'
import { addLearnerState } from './learning-seed.js'
import { LearningGraphWithRollupsSchema, withCurriculumRollups } from './learning-graph-output.js'

// Pikku serializes an RPC response against its output schema and silently drops
// any key the schema does not declare, so the rollups only reach the browser if
// the schema parse keeps them.
test('the getLearningGraph output schema carries server-computed rollups for every module and lane', () => {
  const graph = withCurriculumRollups(addLearnerState(COMPUTER_SCIENCE))
  const served = LearningGraphWithRollupsSchema.parse(graph)
  expect(Object.keys(served.rollups.modules).sort()).toEqual(COMPUTER_SCIENCE.curriculum.modules.map((module) => module.id).sort())
  expect(Object.keys(served.rollups.lanes).sort()).toEqual(COMPUTER_SCIENCE.curriculum.lanes.map((lane) => lane.id).sort())
  expect(served.rollups.curriculum).toMatchObject({ estimate: 0, known: 0, complete: false })
  expect(served.rollups.curriculum.required).toBe(new Set(COMPUTER_SCIENCE.curriculum.modules.flatMap((module) => module.conceptIds)).size)
})
