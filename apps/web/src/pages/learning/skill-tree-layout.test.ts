import { expect, test } from 'bun:test'
import { branchPositions, derivedOverviewLayout, prerequisiteBranches, SKILL_TREE_ROW_GAP } from './skill-tree-layout'

test('each skill branch starts at the top instead of a global lesson index', () => {
  const lanes = [{moduleIds:['a','b','c']},{moduleIds:['d','e']},{moduleIds:['f']}]
  const positions = branchPositions(lanes,255)
  expect(positions.get('a')?.y).toBe(0)
  expect(positions.get('d')).toEqual({x:273,y:0})
  expect(positions.get('f')?.y).toBe(0)
  expect(positions.get('c')?.y).toBe(2*SKILL_TREE_ROW_GAP)
  expect(new Set([...positions.values()].map(p=>`${p.x}:${p.y}`)).size).toBe(6)
  // Style guide rule 2: a tile (~130px) plus at least 120px of air under it.
  expect(SKILL_TREE_ROW_GAP).toBeGreaterThanOrEqual(250)
})

test('a linear course becomes one tall spine, a fork adds a side branch (rule 7)', () => {
  const modules = [
    {id:'exec', dependsOnModuleIds:['outside-course']},
    {id:'data', dependsOnModuleIds:['exec']},
    {id:'funcs', dependsOnModuleIds:['data']},
    {id:'errors', dependsOnModuleIds:['funcs']},
    {id:'langs', dependsOnModuleIds:['funcs']},
    {id:'runtime', dependsOnModuleIds:['errors','langs']},
  ]
  const branches = prerequisiteBranches(modules)
  expect(branches.map((branch) => branch.moduleIds)).toEqual([['exec','data','funcs','errors','runtime'],['langs']])
  const positions = branchPositions(branches, 255)
  expect(positions.get('runtime')?.y).toBe(4 * SKILL_TREE_ROW_GAP)
  expect(positions.get('langs')).toEqual({x:273, y:3 * SKILL_TREE_ROW_GAP})
  // Every edge points DOWN: a prerequisite always sits in a higher row.
  for (const module of modules) for (const dep of module.dependsOnModuleIds) {
    if (positions.has(dep)) expect(positions.get(dep)!.y).toBeLessThan(positions.get(module.id)!.y)
  }
})

test('independent roots open their own columns and a cycle cannot hang the layout', () => {
  const branches = prerequisiteBranches([
    {id:'a', dependsOnModuleIds:[]}, {id:'b', dependsOnModuleIds:[]}, {id:'c', dependsOnModuleIds:['a','b']},
    {id:'x', dependsOnModuleIds:['y']}, {id:'y', dependsOnModuleIds:['x']},
  ])
  expect(branches[0]?.moduleIds).toContain('a')
  expect(branches[1]?.moduleIds).toContain('b')
  expect(branches[0]?.rows?.c).toBe(1)
  expect(branches.flatMap((branch) => branch.moduleIds).sort()).toEqual(['a','b','c','x','y'])
})

// The overview layout for a curriculum that brings its own lanes. The bug this
// replaces: the overview drew five hardcoded Computer-Science bands and looked
// each lane up in a map keyed by CS area ids, so a generated curriculum's lanes
// missed the map and were dumped in one column past the last band. Six of the
// personal-finance tree's seven lanes landed there (2026-09-10).
const financeLanes = [
  {id:'foundations',title:'Foundations',color:'#7479c9'},
  {id:'valuation',title:'Valuation',color:'#4f91a8'},
  {id:'securities',title:'Financial Securities',color:'#d48754'},
  {id:'portfolio',title:'Risk and Portfolio Management',color:'#b58d3f'},
]
const financeModules = [
  {id:'m-found',laneId:'foundations',dependsOnModuleIds:[]},
  {id:'m-val',laneId:'valuation',dependsOnModuleIds:['m-found']},
  {id:'m-sec',laneId:'securities',dependsOnModuleIds:['m-val']},
  {id:'m-sec2',laneId:'securities',dependsOnModuleIds:['m-sec']},
  {id:'m-port',laneId:'portfolio',dependsOnModuleIds:['m-sec']},
]

test('EVERY lane of a generated curriculum lands inside a drawn band', () => {
  // The acceptance criterion, asserted rather than eyeballed: a band is drawn
  // per column at `column * GAP`, so a tile is contained when its column is one
  // of the bands. Before the fix an unmapped lane got a column past the last
  // band and sat on bare canvas.
  const GAP = 175
  const {bands, cells} = derivedOverviewLayout(financeLanes, financeModules)
  expect(bands.length).toBe(financeLanes.length)
  for (const lane of financeLanes) {
    const cell = cells.get(lane.id)!
    expect(cell.column).toBeGreaterThanOrEqual(0)
    expect(cell.column).toBeLessThan(bands.length)
    const x = (cell.column * GAP) + 18
    expect(x).toBeGreaterThanOrEqual(cell.column * GAP)
    expect(x).toBeLessThan((cell.column + 1) * GAP)
  }
})

test('no two lanes share a column, so nothing is stacked in an overflow pile', () => {
  const {cells} = derivedOverviewLayout(financeLanes, financeModules)
  expect(new Set([...cells.values()].map((cell) => cell.column)).size).toBe(financeLanes.length)
})

test('a lane sits one row below the lane its modules depend on', () => {
  // Rule 7 one level up: the row is read off the approved prerequisites, so
  // "portfolio comes after securities" is a fact about the curriculum rather
  // than a hardcoded tier table.
  const {cells, rows} = derivedOverviewLayout(financeLanes, financeModules)
  expect(cells.get('foundations')?.row).toBe(0)
  expect(cells.get('valuation')?.row).toBe(1)
  expect(cells.get('securities')?.row).toBe(2)
  expect(cells.get('portfolio')?.row).toBe(3)
  expect(rows).toBe(4)
})

test('a dependency INSIDE a lane does not push the lane down', () => {
  // `m-sec2` depends on `m-sec`, both in securities. That is a fact about the
  // chapter order within the lane, not about where the lane belongs.
  const alone = derivedOverviewLayout(
    [{id:'securities',title:'S',color:'#000'}],
    [{id:'m-sec',laneId:'securities',dependsOnModuleIds:[]},{id:'m-sec2',laneId:'securities',dependsOnModuleIds:['m-sec']}],
  )
  expect(alone.cells.get('securities')?.row).toBe(0)
  expect(alone.rows).toBe(1)
})

test('lanes with no prerequisites between them all open at row 0', () => {
  const flat = derivedOverviewLayout(financeLanes, financeLanes.map((lane, index) => ({id:`m${index}`,laneId:lane.id,dependsOnModuleIds:[]})))
  expect([...flat.cells.values()].every((cell) => cell.row === 0)).toBe(true)
  expect(flat.rows).toBe(1)
})

test('a dependency on a module outside the curriculum is ignored, not treated as a lane', () => {
  const {cells} = derivedOverviewLayout(financeLanes, [
    {id:'m-found',laneId:'foundations',dependsOnModuleIds:['from-another-curriculum']},
    ...financeModules.slice(1),
  ])
  expect(cells.get('foundations')?.row).toBe(0)
})

test('a curriculum with no modules still puts every lane in its own band', () => {
  const {bands, cells, rows} = derivedOverviewLayout(financeLanes, [])
  expect(bands.length).toBe(4)
  expect([...cells.values()].map((cell) => cell.column)).toEqual([0,1,2,3])
  expect(rows).toBe(1)
})
