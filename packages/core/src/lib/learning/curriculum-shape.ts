/**
 * Structural measurements of a curriculum, used to compare a generated tree
 * against the hand-authored Computer Science seed.
 *
 * The question these answer is not "is the content good" but "is this the same
 * KIND of object". A syllabus transcribed without inference produces one tall
 * spine: depth equals module count, width is one, every module has exactly one
 * parent. A curriculum with real structure branches: several roots, modules
 * that gate more than one successor, and a depth well below the module count.
 * Reporting both against the seed shows whether grounding in published course
 * material changed the shape or only the words.
 *
 * Everything here is pure and works on the minimal structural shape shared by
 * a stored `LearningGraph` and an in-flight proposal, so the same numbers
 * describe the seed and a draft.
 */

export type ShapeModule = {
  readonly id: string
  readonly laneId?: string
  readonly dependsOnModuleIds: readonly string[]
  readonly conceptCount: number
  /** How many published sources this module cites. Zero for the seed, which
   * was model-authored, and zero for a generated module the model supplied
   * without grounding. */
  readonly sourceCount?: number
}

export type ShapeInput = {
  readonly laneCount: number
  readonly modules: readonly ShapeModule[]
  readonly conceptEdgeCount: number
  /**
   * Distinct concepts in the curriculum. Supplied separately because a concept
   * may belong to more than one module: the seed has 664 distinct concepts
   * across 674 memberships, so summing per-module counts would report ten
   * concepts that do not exist. When absent, memberships are assumed distinct.
   */
  readonly distinctConceptCount?: number
  /** Confidences of inferred module dependencies, when the curriculum was
   * generated. Absent for a hand-authored one. */
  readonly dependencyConfidences?: readonly number[]
}

export type CurriculumShape = {
  readonly lanes: number
  readonly modules: number
  readonly concepts: number
  readonly moduleEdges: number
  readonly conceptEdges: number
  /** Longest prerequisite chain, counted in modules. */
  readonly maxDepth: number
  readonly meanDepth: number
  /** Most modules sharing one prerequisite depth. A spine has width 1. */
  readonly maxWidth: number
  /** Modules with nothing above them: where a learner may start. */
  readonly rootModules: number
  /** Modules nothing depends on: where a path ends. */
  readonly leafModules: number
  /** Modules with neither a prerequisite nor a dependent. These float free of
   * the tree and are the clearest sign inference failed. */
  readonly isolatedModules: number
  readonly meanFanIn: number
  readonly maxFanIn: number
  readonly meanFanOut: number
  readonly maxFanOut: number
  readonly conceptsPerModule: { readonly mean: number; readonly min: number; readonly max: number }
  /** moduleEdges / modules. Below 1 means the tree is barely connected;
   * a spine sits at just under 1; branching pushes it above. */
  readonly edgesPerModule: number
  /** Share of modules citing at least one source, 0 to 1. */
  readonly groundedShare: number
  /** Share of inferred dependencies at confidence 0.8 or above. Null when the
   * curriculum was hand-authored and carries no confidences. */
  readonly confidentEdgeShare: number | null
  /** True when every module sits in a single chain, which is what a raw
   * syllabus transcription looks like. */
  readonly isSpine: boolean
  /** Module IDs forming a dependency cycle, which the writer must reject
   * because the layout assigns rows by depth and would not terminate. */
  readonly cycles: readonly (readonly string[])[]
}

const round = (value: number, places = 2): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

const mean = (values: readonly number[]): number =>
  values.length ? round(values.reduce((total, value) => total + value, 0) / values.length) : 0

/**
 * Depth of each module: the longest chain of in-curriculum prerequisites above
 * it. Dependencies pointing outside the curriculum are ignored, matching the
 * frontend layout, which only draws edges between modules it is rendering.
 * Modules inside a cycle get depth 0 rather than recursing forever; the cycle
 * itself is reported separately so the caller can refuse to write it.
 */
export function moduleDepths(modules: readonly ShapeModule[]): Map<string, number> {
  const byId = new Map(modules.map((module) => [module.id, module]))
  const depths = new Map<string, number>()
  const depthOf = (id: string, trail: readonly string[]): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    const parents = (byId.get(id)?.dependsOnModuleIds ?? []).filter((parent) => byId.has(parent) && !trail.includes(parent))
    const depth = parents.length ? Math.max(...parents.map((parent) => depthOf(parent, [...trail, id]))) + 1 : 0
    depths.set(id, depth)
    return depth
  }
  for (const module of modules) depthOf(module.id, [])
  return depths
}

/**
 * Every dependency cycle, as the list of modules involved. A cycle is a real
 * possibility here because the edges are model-inferred: nothing stops a model
 * claiming A needs B and B needs A. Depth-first with an active trail; each
 * cycle is reported once, keyed by its sorted membership.
 */
export function dependencyCycles(modules: readonly ShapeModule[]): string[][] {
  const byId = new Map(modules.map((module) => [module.id, module]))
  const found = new Map<string, string[]>()
  const settled = new Set<string>()
  const walk = (id: string, trail: string[]): void => {
    const seenAt = trail.indexOf(id)
    if (seenAt !== -1) {
      const cycle = trail.slice(seenAt)
      found.set([...cycle].sort().join('>'), cycle)
      return
    }
    if (settled.has(id)) return
    const next = [...trail, id]
    for (const parent of byId.get(id)?.dependsOnModuleIds ?? []) if (byId.has(parent)) walk(parent, next)
    settled.add(id)
  }
  for (const module of modules) walk(module.id, [])
  return [...found.values()]
}

export function measureCurriculumShape(input: ShapeInput): CurriculumShape {
  const { modules } = input
  const byId = new Set(modules.map((module) => module.id))
  const inCurriculum = (module: ShapeModule) => module.dependsOnModuleIds.filter((parent) => byId.has(parent) && parent !== module.id)

  const depths = moduleDepths(modules)
  const depthValues = modules.map((module) => depths.get(module.id) ?? 0)
  const widthByDepth = new Map<number, number>()
  for (const depth of depthValues) widthByDepth.set(depth, (widthByDepth.get(depth) ?? 0) + 1)

  const fanIn = modules.map((module) => inCurriculum(module).length)
  const dependents = new Map<string, number>(modules.map((module) => [module.id, 0]))
  for (const module of modules) for (const parent of inCurriculum(module)) dependents.set(parent, (dependents.get(parent) ?? 0) + 1)
  const fanOut = modules.map((module) => dependents.get(module.id) ?? 0)

  const conceptCounts = modules.map((module) => module.conceptCount)
  const moduleEdges = fanIn.reduce((total, count) => total + count, 0)
  const rootModules = fanIn.filter((count) => count === 0).length
  const leafModules = fanOut.filter((count) => count === 0).length
  const isolatedModules = modules.filter((module, index) => fanIn[index] === 0 && fanOut[index] === 0).length
  const grounded = modules.filter((module) => (module.sourceCount ?? 0) > 0).length
  const confidences = input.dependencyConfidences

  return {
    lanes: input.laneCount,
    modules: modules.length,
    concepts: input.distinctConceptCount ?? conceptCounts.reduce((total, count) => total + count, 0),
    moduleEdges,
    conceptEdges: input.conceptEdgeCount,
    maxDepth: depthValues.length ? Math.max(...depthValues) : 0,
    meanDepth: mean(depthValues),
    maxWidth: widthByDepth.size ? Math.max(...widthByDepth.values()) : 0,
    rootModules,
    leafModules,
    isolatedModules,
    meanFanIn: mean(fanIn),
    maxFanIn: fanIn.length ? Math.max(...fanIn) : 0,
    meanFanOut: mean(fanOut),
    maxFanOut: fanOut.length ? Math.max(...fanOut) : 0,
    conceptsPerModule: {
      mean: mean(conceptCounts),
      min: conceptCounts.length ? Math.min(...conceptCounts) : 0,
      max: conceptCounts.length ? Math.max(...conceptCounts) : 0,
    },
    edgesPerModule: modules.length ? round(moduleEdges / modules.length) : 0,
    groundedShare: modules.length ? round(grounded / modules.length) : 0,
    confidentEdgeShare: confidences?.length ? round(confidences.filter((value) => value >= 0.8).length / confidences.length) : null,
    isSpine: modules.length > 1 && rootModules === 1 && (widthByDepth.size ? Math.max(...widthByDepth.values()) : 0) === 1,
    cycles: dependencyCycles(modules),
  }
}

/** A side-by-side reading of two shapes, for the comparison report. Positive
 * `delta` means the candidate exceeds the baseline. */
export type ShapeComparisonRow = {
  readonly metric: string
  readonly baseline: number | null
  readonly candidate: number | null
  readonly delta: number | null
}

export function compareCurriculumShapes(baseline: CurriculumShape, candidate: CurriculumShape): ShapeComparisonRow[] {
  const metrics: ReadonlyArray<readonly [string, number | null, number | null]> = [
    ['Lanes', baseline.lanes, candidate.lanes],
    ['Modules', baseline.modules, candidate.modules],
    ['Concepts', baseline.concepts, candidate.concepts],
    ['Module prerequisite edges', baseline.moduleEdges, candidate.moduleEdges],
    ['Concept edges', baseline.conceptEdges, candidate.conceptEdges],
    ['Max prerequisite depth', baseline.maxDepth, candidate.maxDepth],
    ['Mean depth', baseline.meanDepth, candidate.meanDepth],
    ['Max width at a depth', baseline.maxWidth, candidate.maxWidth],
    ['Root modules', baseline.rootModules, candidate.rootModules],
    ['Leaf modules', baseline.leafModules, candidate.leafModules],
    ['Isolated modules', baseline.isolatedModules, candidate.isolatedModules],
    ['Mean fan-in', baseline.meanFanIn, candidate.meanFanIn],
    ['Max fan-out', baseline.maxFanOut, candidate.maxFanOut],
    ['Edges per module', baseline.edgesPerModule, candidate.edgesPerModule],
    ['Concepts per module', baseline.conceptsPerModule.mean, candidate.conceptsPerModule.mean],
    ['Grounded module share', baseline.groundedShare, candidate.groundedShare],
    ['Confident edge share', baseline.confidentEdgeShare, candidate.confidentEdgeShare],
  ]
  return metrics.map(([metric, base, cand]) => ({
    metric,
    baseline: base,
    candidate: cand,
    delta: base === null || cand === null ? null : round(cand - base),
  }))
}
