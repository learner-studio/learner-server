import { defineFunction } from '../../runtime/define.js'
import { z } from 'zod'

import { assertLearningLocalMvpEnabled } from '@learner/core/lib/runtime-flags.js'
import { readCurriculumShape } from '@learner/core/lib/learning/curriculum-shape-query.js'

/**
 * Structural measurements of a curriculum, optionally read against another.
 *
 * This exists as an RPC rather than a one-off analysis script because it
 * answers a question the learner is asked at approval time: is the tree the
 * agent just proposed the same KIND of object as the library curriculum they
 * already trust, or is it a transcribed syllabus wearing a tree's clothes? A
 * number computed once in a terminal cannot be shown on that screen, and it
 * goes stale the moment either curriculum changes.
 *
 * It reads the curriculum tables directly, so it works on a DRAFT — which is
 * the only moment the answer can still change a decision.
 */
export const ReadCurriculumShapeInput = z.object({
  curriculumId: z.string().min(1),
  /** Read the curriculum against this one, row by row. Omit for the raw
   * measurement with no comparison. */
  compareWithCurriculumId: z.string().min(1).optional(),
})

const CurriculumShapeSchema = z.object({
  lanes: z.number(),
  modules: z.number(),
  concepts: z.number(),
  moduleEdges: z.number(),
  conceptEdges: z.number(),
  maxDepth: z.number(),
  meanDepth: z.number(),
  maxWidth: z.number(),
  rootModules: z.number(),
  leafModules: z.number(),
  isolatedModules: z.number(),
  meanFanIn: z.number(),
  maxFanIn: z.number(),
  meanFanOut: z.number(),
  maxFanOut: z.number(),
  conceptsPerModule: z.object({ mean: z.number(), min: z.number(), max: z.number() }),
  edgesPerModule: z.number(),
  groundedShare: z.number(),
  confidentEdgeShare: z.number().nullable(),
  isSpine: z.boolean(),
  cycles: z.array(z.array(z.string())),
})

export const ReadCurriculumShapeOutput = z.object({
  curriculumId: z.string(),
  shape: CurriculumShapeSchema,
  baselineCurriculumId: z.string().nullable(),
  comparison: z.array(z.object({
    metric: z.string(),
    baseline: z.number().nullable(),
    candidate: z.number().nullable(),
    delta: z.number().nullable(),
  })),
})

export const readCurriculumShapeRpc = defineFunction({
  title: 'Read Curriculum Shape',
  description: 'Measure a curriculum\'s structure, optionally against a baseline curriculum.',
  expose: true,
  readonly: true,
  input: ReadCurriculumShapeInput,
  output: ReadCurriculumShapeOutput,
  func: async ({ kysely }, input, { session }) => {
    assertLearningLocalMvpEnabled()
    // Both curricula are checked, not just the subject: a comparison leaks the
    // baseline's module and concept counts just as surely as a measurement does.
    for (const id of [input.curriculumId, input.compareWithCurriculumId].filter((value): value is string => Boolean(value))) {
      const row = await kysely
        .selectFrom('learningCurricula')
        .select('ownerUserId')
        .where('id', '=', id)
        .executeTakeFirst()
      if (!row) throw new Error(`No such curriculum: ${id}`)
      if (row.ownerUserId !== null && row.ownerUserId !== session.userId) {
        throw new Error(`No such curriculum: ${id}`)
      }
    }
    const reading = await readCurriculumShape(kysely, input.curriculumId, input.compareWithCurriculumId)
    if (!reading) throw new Error(`No such curriculum: ${input.curriculumId}`)
    // The measurement types are deeply readonly, which is right for a pure
    // value but not assignable to a transport payload. Copying at the boundary
    // is the honest conversion; a cast here would only hide that the response
    // really is a fresh mutable object.
    return {
      ...reading,
      shape: { ...reading.shape, cycles: reading.shape.cycles.map((cycle) => [...cycle]) },
      comparison: reading.comparison.map((row) => ({ ...row })),
    }
  },
})
