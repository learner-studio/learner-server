import { describe, expect, test } from 'bun:test'
import { compareCurriculumShapes, dependencyCycles, measureCurriculumShape, moduleDepths, type ShapeModule } from './curriculum-shape.js'

const mod = (id: string, dependsOnModuleIds: string[] = [], conceptCount = 5, sourceCount = 0): ShapeModule =>
  ({ id, dependsOnModuleIds, conceptCount, sourceCount })

/** A straight chain, which is what a syllabus transcribed without inference
 * looks like: week 2 after week 1, week 3 after week 2. */
const spine = (length: number): ShapeModule[] =>
  Array.from({ length }, (_unused, index) => mod(`m${index}`, index ? [`m${index - 1}`] : []))

const shapeOf = (modules: ShapeModule[], extra: Partial<Parameters<typeof measureCurriculumShape>[0]> = {}) =>
  measureCurriculumShape({ laneCount: 1, modules, conceptEdgeCount: 0, ...extra })

describe('measureCurriculumShape distinguishes a transcribed syllabus from an inferred tree', () => {
  test('a straight chain is reported as a spine, with depth equal to its length', () => {
    const shape = shapeOf(spine(6))
    expect(shape.isSpine).toBe(true)
    expect(shape.maxDepth).toBe(5)
    expect(shape.maxWidth).toBe(1)
    expect(shape.rootModules).toBe(1)
  })

  test('a branching tree is not a spine and stays shallower than its module count', () => {
    // One root gating two independent branches that rejoin.
    const shape = shapeOf([
      mod('root'), mod('left', ['root']), mod('right', ['root']), mod('join', ['left', 'right']),
    ])
    expect(shape.isSpine).toBe(false)
    expect(shape.maxDepth).toBe(2)
    expect(shape.maxWidth).toBe(2)
    expect(shape.maxFanOut).toBe(2)
    expect(shape.maxFanIn).toBe(2)
  })

  test('a single module is never called a spine, because one node has no shape', () => {
    expect(shapeOf([mod('only')]).isSpine).toBe(false)
  })

  test('several roots means several places a learner may start', () => {
    const shape = shapeOf([mod('a'), mod('b'), mod('c', ['a', 'b'])])
    expect(shape.rootModules).toBe(2)
    expect(shape.leafModules).toBe(1)
    expect(shape.isSpine).toBe(false)
  })
})

describe('measureCurriculumShape reports the failure modes of inferred structure', () => {
  test('a module with no edge in either direction counts as isolated', () => {
    const shape = shapeOf([mod('a'), mod('b', ['a']), mod('floating')])
    expect(shape.isolatedModules).toBe(1)
  })

  test('a dependency pointing outside the curriculum is ignored, matching the renderer', () => {
    // The frontend only draws edges between modules it is rendering, so an
    // edge to an absent module must not inflate fan-in or depth.
    const shape = shapeOf([mod('a', ['not-in-this-curriculum'])])
    expect(shape.moduleEdges).toBe(0)
    expect(shape.maxDepth).toBe(0)
    expect(shape.isolatedModules).toBe(1)
  })

  test('a module depending on itself is dropped rather than counted', () => {
    const shape = shapeOf([mod('a', ['a'])])
    expect(shape.moduleEdges).toBe(0)
  })

  test('confident edge share is null without confidences and a ratio with them', () => {
    expect(shapeOf(spine(3)).confidentEdgeShare).toBeNull()
    expect(shapeOf(spine(3), { dependencyConfidences: [0.9, 0.5, 0.85, 0.2] }).confidentEdgeShare).toBe(0.5)
  })

  test('grounded share counts only modules citing a real source', () => {
    expect(shapeOf([mod('a', [], 5, 2), mod('b', ['a'], 5, 0)]).groundedShare).toBe(0.5)
  })

  test('a concept in two modules is counted once when the distinct total is supplied', () => {
    // The seed has 664 distinct concepts across 674 memberships, so summing
    // per-module counts would report ten concepts that do not exist.
    const modules = [mod('a', [], 5), mod('b', ['a'], 5)]
    expect(shapeOf(modules).concepts).toBe(10)
    expect(shapeOf(modules, { distinctConceptCount: 9 }).concepts).toBe(9)
    // conceptsPerModule still reads memberships, because a module really does
    // teach that many topics whether or not a neighbour also teaches one.
    expect(shapeOf(modules, { distinctConceptCount: 9 }).conceptsPerModule.mean).toBe(5)
  })
})

describe('cycle detection protects the depth-based layout', () => {
  test('a two-module cycle is found', () => {
    // The frontend assigns a row from prerequisite depth, so a cycle has no
    // terminating depth and must be refused before it is written.
    const cycles = dependencyCycles([mod('a', ['b']), mod('b', ['a'])])
    expect(cycles.length).toBe(1)
    expect([...cycles[0]!].sort()).toEqual(['a', 'b'])
  })

  test('a longer cycle is found once, not once per entry point', () => {
    const cycles = dependencyCycles([mod('a', ['c']), mod('b', ['a']), mod('c', ['b'])])
    expect(cycles.length).toBe(1)
  })

  test('an acyclic graph reports no cycles and terminates', () => {
    expect(dependencyCycles(spine(20))).toEqual([])
    expect(moduleDepths(spine(20)).get('m19')).toBe(19)
  })

  test('measuring a cyclic curriculum still returns rather than hanging', () => {
    const shape = shapeOf([mod('a', ['b']), mod('b', ['a'])])
    expect(shape.cycles.length).toBe(1)
    expect(shape.modules).toBe(2)
  })
})

describe('compareCurriculumShapes reads a candidate against a baseline', () => {
  test('delta is candidate minus baseline, and null when either side is null', () => {
    const baseline = shapeOf(spine(4))
    const candidate = shapeOf([mod('root'), mod('l', ['root']), mod('r', ['root'])], { dependencyConfidences: [0.9, 0.9] })
    const rows = compareCurriculumShapes(baseline, candidate)
    const byMetric = new Map(rows.map((row) => [row.metric, row]))
    expect(byMetric.get('Modules')!.delta).toBe(-1)
    expect(byMetric.get('Max width at a depth')!.delta).toBe(1)
    // The seed carries no confidences, so this comparison is undefined, not zero.
    expect(byMetric.get('Confident edge share')!.baseline).toBeNull()
    expect(byMetric.get('Confident edge share')!.delta).toBeNull()
  })

  test('every row is present so the report table never has ragged columns', () => {
    const rows = compareCurriculumShapes(shapeOf(spine(2)), shapeOf(spine(3)))
    expect(rows.length).toBe(17)
    expect(rows.every((row) => typeof row.metric === 'string' && row.metric.length > 0)).toBe(true)
  })
})
