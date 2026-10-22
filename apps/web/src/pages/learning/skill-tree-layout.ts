/**
 * Skill-tree layout style guide
 * ==============================
 * Both trees on the Learning page (the curriculum overview and each course's
 * chapter view) are laid out like a video-game RPG skill tree. Anyone adding
 * tiers, chapters, or a new lane should keep these rules so the tree stays
 * readable and scrolls the same way:
 *
 * 1. Width is fixed, height is free. The frame fits the tree's WIDTH at load
 *    (`fitTreeWidth` in CurriculumTree.tsx) and the viewer scrolls DOWN through the
 *    tree with the scrollbar on the right. Never squeeze rows together to make
 *    the whole tree fit the frame; add vertical room instead.
 * 2. Lanes are columns; tiers are rows. Column spacing (`*_HORIZONTAL_LANE_GAP`)
 *    is tight because lane headers are pinned and the tree must fit the pane's
 *    width. Row spacing is the generous axis: a 100px tile plus its label needs
 *    ~120px of clear air below it so the smoothstep edges can drop, turn, and
 *    land on the next tile without crossing a label. That gives the row pitches
 *    below (tile ≈ 110-130px + ≥120px air).
 * 3. Edges are the story. Thick (3px) rounded (22px radius) paths with arrow
 *    heads read as "unlocks" between tiles; keep enough row pitch that a
 *    prerequisite edge never has to run behind a tile in the same column.
 * 4. Lane bands run past the last row. Every lane's background band is derived
 *    from the deepest tier it holds (plus one tile), so no tile sits on bare
 *    canvas at the bottom of the scroll range.
 * 5. Rows are per branch, not per curriculum index. Each lane packs its own
 *    modules from its first row down; a global order would strand new lessons
 *    far below the visible tree.
 * 6. First rows stay under the headers. Row 0 sits directly beneath the pinned
 *    lane header, so a new lane or tier changes the pitch, never the offset.
 * 7. Prerequisites decide the shape. A course without hand-authored lanes is
 *    laid out by `prerequisiteBranches`: row = depth in the in-course
 *    prerequisite graph, column = branch. Never chunk chapters into columns
 *    by list position; a linear course must read as one tall spine that
 *    scrolls, not a grid. Hand-authored lanes (Data Science) may override the
 *    columns but should still order each column by prerequisite.
 *
 * Overview tiers use `OVERVIEW_VERTICAL_GAP` in CurriculumTree.tsx; chapter rows in a
 * course use `SKILL_TREE_ROW_GAP` here. Keep both within the same tile-plus-air
 * ratio when you change either.
 */
export const SKILL_TREE_ROW_GAP = 260

/** A column of the chapter view. `rows` pins a module to a prerequisite depth;
 * without it the lane packs its modules from row 0 down (rule 5). */
export type SkillBranch = { title: string; moduleIds: readonly string[]; rows?: Readonly<Record<string, number>> }
export type SkillBranchLayout = Pick<SkillBranch, 'moduleIds' | 'rows'>

export function branchPositions(lanes: readonly SkillBranchLayout[], horizontalGap: number) {
  return new Map(lanes.flatMap((lane, column) => lane.moduleIds.map((id, index) =>
    [id, {x: column * horizontalGap + 18, y: (lane.rows?.[id] ?? index) * SKILL_TREE_ROW_GAP}] as const)))
}

/** Longest in-course prerequisite chain above each module; edges to modules
 * outside the course are ignored because they are not drawn in this view. */
export function prerequisiteDepths(modules: readonly {id: string; dependsOnModuleIds: readonly string[]}[]): Map<string, number> {
  const byId = new Map(modules.map((module) => [module.id, module]))
  const depths = new Map<string, number>()
  const depthOf = (id: string, trail: readonly string[]): number => {
    const known = depths.get(id)
    if (known !== undefined) return known
    const module = byId.get(id)
    const inCourse = (module?.dependsOnModuleIds ?? []).filter((dep) => byId.has(dep) && !trail.includes(dep))
    const depth = inCourse.length ? Math.max(...inCourse.map((dep) => depthOf(dep, [...trail, id]))) + 1 : 0
    depths.set(id, depth)
    return depth
  }
  for (const module of modules) depthOf(module.id, [])
  return depths
}

/**
 * Rule 7 of the style guide: when a course has no hand-authored lanes, the
 * prerequisite graph decides the shape. Row = prerequisite depth, so a chain
 * of chapters stretches DOWN the frame and every edge points at the next row.
 * Column = branch: a chapter stays under its first in-course prerequisite; a
 * sibling that would collide with a chapter already in that row slides one
 * column right. A linear course is therefore one tall spine, a fork adds a
 * side branch, and roots with nothing above them open their own column.
 */
export function prerequisiteBranches(modules: readonly {id: string; dependsOnModuleIds: readonly string[]}[]): SkillBranch[] {
  const depths = prerequisiteDepths(modules)
  const byId = new Map(modules.map((module) => [module.id, module]))
  const column = new Map<string, number>()
  const occupied = new Set<string>()
  const ordered = [...modules].sort((left, right) => (depths.get(left.id)! - depths.get(right.id)!) || modules.indexOf(left) - modules.indexOf(right))
  for (const module of ordered) {
    const depth = depths.get(module.id)!
    const parent = module.dependsOnModuleIds.find((dep) => byId.has(dep) && column.has(dep))
    let col = parent ? column.get(parent)! : 0
    while (occupied.has(`${col}:${depth}`)) col += 1
    column.set(module.id, col)
    occupied.add(`${col}:${depth}`)
  }
  const columnCount = Math.max(0, ...column.values()) + 1
  const titles = ['Main path', 'Side branch', 'Second branch', 'Third branch', 'Fourth branch']
  return Array.from({length: columnCount}, (_lane, laneIndex) => ({
    title: titles[laneIndex] ?? `Branch ${laneIndex + 1}`,
    moduleIds: modules.filter((module) => column.get(module.id) === laneIndex).map((module) => module.id),
    rows: Object.fromEntries(modules.filter((module) => column.get(module.id) === laneIndex).map((module) => [module.id, depths.get(module.id)!])),
  }))
}

/**
 * The OVERVIEW tree's columns and rows for a curriculum that carries its own
 * lanes, rather than the hand-curated grouping the Computer Science library
 * ships with.
 *
 * Why this exists. The overview used to draw exactly five hardcoded bands
 * ("Theory & foundations", "Software & systems", …) and place each lane tile by
 * looking its id up in a map keyed by the eighteen COMPUTER-SCIENCE area ids.
 * That worked for as long as there was one curriculum. A generated curriculum
 * names its own lanes — a personal-finance tree has `valuation`, `securities`,
 * `portfolio` — so every lane but the ones that happen to collide with a CS id
 * missed the map and fell through to a single overflow column past the right
 * edge of the last band, stacked on bare canvas. Measured 2026-09-10 on
 * `gen-personal-finance-…-aa35c90b`: six of seven lanes landed there, which is
 * the reported "most of the nodes are sitting outside all of the lanes".
 *
 * The fix is to stop treating one curriculum's lane ids as layout keys. Here a
 * lane IS a column, in its own stored order, and the row comes from how deep
 * the lane sits in the prerequisite graph — rule 7 of the style guide, applied
 * one level up. A lane depends on another when any of its modules depends on a
 * module over there, so "Portfolio theory sits below Valuation" is read off the
 * approved prerequisites rather than declared.
 *
 * The curated CS layout is NOT replaced by this; `CurriculumTree.tsx` keeps using it
 * whenever every lane of the selected curriculum is one it knows about.
 */
export type OverviewLane = { id: string; title: string; color: string }
export type OverviewModule = { id: string; laneId: string; dependsOnModuleIds: readonly string[] }

export function derivedOverviewLayout(
  lanes: readonly OverviewLane[],
  modules: readonly OverviewModule[],
): { bands: OverviewLane[]; cells: Map<string, { column: number; row: number }>; rows: number } {
  const laneOfModule = new Map(modules.map((module) => [module.id, module.laneId]))
  const known = new Set(lanes.map((lane) => lane.id))

  // A lane's prerequisites are the OTHER lanes its modules reach into. A
  // dependency inside the lane says nothing about where the lane belongs.
  const laneNodes = lanes.map((lane) => ({
    id: lane.id,
    dependsOnModuleIds: [...new Set(modules
      .filter((module) => module.laneId === lane.id)
      .flatMap((module) => module.dependsOnModuleIds)
      .map((moduleId) => laneOfModule.get(moduleId))
      .filter((laneId): laneId is string => laneId !== undefined && laneId !== lane.id && known.has(laneId)))],
  }))

  const depths = prerequisiteDepths(laneNodes)
  const cells = new Map(lanes.map((lane, column) => [lane.id, { column, row: depths.get(lane.id) ?? 0 }]))
  return { bands: [...lanes], cells, rows: Math.max(1, ...[...cells.values()].map((cell) => cell.row + 1)) }
}

