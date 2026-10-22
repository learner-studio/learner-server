import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  type Edge as ReactFlowEdge,
  type Node as ReactFlowNode,
  type NodeProps as ReactFlowNodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './learning.css'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, Eyebrow } from '../../components/ui/card'
import { Select } from '../../components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '../../components/ui/popover'
import { Progress } from '../../components/ui/progress'
import { SegmentedControl } from '../../components/ui/tabs'
import { LEARNER_BUILD } from '../../lib/routes'
import { NO_ROLLUP, rollupLabel } from './curriculum-rollups'
import { currentScheme, subscribeScheme, type Concept, type LearningGraph, type LearningModule } from './learning-model'
import { branchPositions, derivedOverviewLayout, prerequisiteBranches, SKILL_TREE_ROW_GAP, type SkillBranch } from './skill-tree-layout'

// The lane hues and the orange highlight are data encoding, not chrome: they
// stay fixed in both schemes while the surfaces around them follow the tokens.
const GRAPH_ORANGE = '#d99062'
const GRAPH_DARK_GRAY = '#5c6368'

type SkillTreeNodeData = {
  title: string
  eyebrow: string
  detail: string
  icon: string
  completion: number
  rollupText?: string
  color: string
  areaId: string
  moduleId?: string
  isLaneLabel?: boolean
  laneHeight?: number
}
type SkillTreeNode = ReactFlowNode<SkillTreeNodeData, 'skill'>
type Viewport = { x: number; y: number; zoom: number }

const SkillTreeNodeCard = ({ data, selected }: ReactFlowNodeProps<SkillTreeNode>) => data.isLaneLabel
  ? <div className="skill-lane-band" style={{ '--skill-color': data.color, '--lane-height': `${data.laneHeight ?? 730}px` } as CSSProperties} aria-hidden="true" />
  : (
    <div className={`skill-node ${selected ? 'skill-node-selected' : ''}`} style={{ '--skill-color': data.color, '--mastery-fill': `${data.completion}%` } as CSSProperties}>
      <Handle type="target" position={Position.Top} className="skill-handle" />
      <div className="skill-node-fill" />
      <div className="skill-node-content">
        <div className="skill-node-title">{data.title}</div>
        <span className="skill-node-icon" aria-hidden="true">{data.icon}</span>
        <strong className="skill-node-mastery">{data.rollupText ?? 'Unknown'}</strong>
      </div>
      <Handle type="source" position={Position.Bottom} className="skill-handle" />
    </div>
  )

const skillTreeNodeTypes = { skill: SkillTreeNodeCard }

const SKILL_LANE_WIDTH = 136

function PinnedSkillLaneHeaders({ laneNodes, viewport }: { readonly laneNodes: readonly SkillTreeNode[]; readonly viewport: Viewport }) {
  // React Flow's fit/pan transform can leave a small screen-space gap between
  // the fixed header and the first canvas lane. Extend the header exactly to
  // that transformed lane edge, so the two surfaces meet at every zoom.
  const laneTop = Math.min(...laneNodes.map((node) => (node.position.y * viewport.zoom) + viewport.y))
  const headerHeight = Math.max(60, Math.ceil(laneTop))
  return (
    <div className="skill-lane-pinned-headers" style={{ height: headerHeight }} aria-label="Pinned curriculum lane headers">
      {laneNodes.map((node) => (
        <div key={node.id} className="skill-lane-pinned-header"
          style={{ left: (node.position.x * viewport.zoom) + viewport.x, width: SKILL_LANE_WIDTH * viewport.zoom, height: headerHeight, '--skill-color': node.data.color } as CSSProperties}>
          <div className="skill-lane-label" style={{ fontSize: Math.max(8, Math.min(14, 14 * viewport.zoom)) }}>{node.data.title}</div>
        </div>
      ))}
    </div>
  )
}

const OVERVIEW_HORIZONTAL_LANE_GAP = 175
const DETAIL_HORIZONTAL_LANE_GAP = 255
// Chapter tile plus its label; also the bottom of the chapter view's scroll range.
const DETAIL_TILE_HEIGHT = 230

/** A real scrollbar for the skill tree: mirrors React Flow's vertical pan so the
 * wheel, a drag on the canvas, the thumb, and the zoom controls all agree. */
function SkillTreeScrollbar({ viewport, extent, frameHeight, onScrollTo }: {
  readonly viewport: Viewport
  readonly extent: [[number, number], [number, number]]
  readonly frameHeight: number
  readonly onScrollTo: (canvasY: number) => void
}) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const contentTop = extent[0][1]
  const contentHeight = extent[1][1] - contentTop
  const visibleHeight = frameHeight / viewport.zoom
  if (!frameHeight || contentHeight <= visibleHeight) return null
  const thumbFraction = visibleHeight / contentHeight
  const scrollFraction = Math.min(1 - thumbFraction, Math.max(0, ((-viewport.y / viewport.zoom) - contentTop) / contentHeight))
  const scrollToPointer = (clientY: number, grabOffset: number) => {
    const track = trackRef.current?.getBoundingClientRect()
    if (!track) return
    const fraction = Math.min(1 - thumbFraction, Math.max(0, (clientY - track.top - grabOffset) / track.height))
    onScrollTo(contentTop + (fraction * contentHeight))
  }
  return (
    <div ref={trackRef} className="skill-scroll-track" role="scrollbar" aria-orientation="vertical" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round((scrollFraction / Math.max(1 - thumbFraction, 0.0001)) * 100)} aria-label="Scroll the skill tree"
      onPointerDown={(event) => { if (event.target === trackRef.current) scrollToPointer(event.clientY, (thumbFraction * (trackRef.current?.clientHeight ?? 0)) / 2) }}>
      <div className="skill-scroll-thumb" style={{ top: `${scrollFraction * 100}%`, height: `${thumbFraction * 100}%` }}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          event.preventDefault()
          event.stopPropagation()
          const thumb = event.currentTarget
          const grabOffset = event.clientY - thumb.getBoundingClientRect().top
          thumb.setPointerCapture(event.pointerId)
          thumb.dataset.dragging = 'true'
          const move = (moveEvent: PointerEvent) => scrollToPointer(moveEvent.clientY, grabOffset)
          const stop = () => { delete thumb.dataset.dragging; thumb.removeEventListener('pointermove', move); thumb.removeEventListener('pointerup', stop); thumb.removeEventListener('pointercancel', stop) }
          thumb.addEventListener('pointermove', move)
          thumb.addEventListener('pointerup', stop)
          thumb.addEventListener('pointercancel', stop)
        }} />
    </div>
  )
}

// Row pitch for curriculum tiers. The style guide for BOTH trees (why width is
// fixed and height scrolls, how much air a tile needs, how lane bands are sized)
// lives at the top of ./skill-tree-layout.ts; change spacing there and here
// together so the overview and the chapter view keep the same tile-plus-air ratio.
const OVERVIEW_VERTICAL_GAP = 230
const SKILL_TREE_FRAME_PADDING = 8
const SKILL_TREE_BOTTOM_PADDING = 36
// A narrow tree (one spine and a side branch) must not blow up to full size;
// at this cap the frame still shows about three rows, so the scroll reads as
// "more tree below" rather than "two giant tiles".
const SKILL_TREE_FIT_MAX_ZOOM = 0.72
// Screen pixels between the frame top and row 0: the pinned header's minimum
// height (60px) plus a small gap, so no tile ever hides under a header.
const SKILL_TREE_HEADER_CLEARANCE = 72
const SKILL_TREE_EDGE_RADIUS = 22

const OVERVIEW_CONCEPTUAL_LANES = [
  { title: 'Theory & foundations', color: '#7479c9', areaIds: ['foundations', 'mathematics', 'algorithms'] },
  { title: 'Software & systems', color: '#4f91a8', areaIds: ['programming', 'systems', 'architecture', 'networks', 'security-privacy'] },
  { title: 'Data & intelligence', color: '#d48754', areaIds: ['data-databases', 'data-science', 'ai-ml'] },
  { title: 'People & practice', color: '#b58d3f', areaIds: ['hci', 'delivery', 'professional-societal'] },
  { title: 'Applied building', color: '#6b9b72', areaIds: ['developer-practice', 'frontend-web', 'web-apis', 'durable-workflows', 'llm-collaboration'] },
] as const

const OVERVIEW_TILE_HEIGHT = 150
const OVERVIEW_TIERS: Record<string, number> = {
  foundations: 0,
  mathematics: 1,
  programming: 1,
  algorithms: 2,
  systems: 2,
  hci: 2,
  architecture: 3,
  'data-databases': 3,
  networks: 4,
  'data-science': 4,
  delivery: 4,
  'security-privacy': 5,
  'ai-ml': 5,
  'professional-societal': 5,
  'developer-practice': 0,
  'frontend-web': 1,
  'web-apis': 2,
  'durable-workflows': 3,
  'llm-collaboration': 4,
}
// The lane bands must run past the last tier so no tile sits on bare canvas.
const OVERVIEW_LANE_HEIGHT = ((Math.max(...Object.values(OVERVIEW_TIERS)) + 1) * OVERVIEW_VERTICAL_GAP) + OVERVIEW_TILE_HEIGHT

// Game-skill-tree contract: courses occupy curated, compact branches, never
// curriculum.order * pixels. That storage order is not a visual depth or a
// prerequisite. Add new courses to a branch above; unknown courses get a nearby
// overflow column rather than stretching fitView and shrinking every tile.
const overviewPosition = new Map<string, { x: number; y: number }>(OVERVIEW_CONCEPTUAL_LANES.flatMap((lane, laneIndex) =>
  lane.areaIds.map((areaId) => [areaId, { x: (laneIndex * OVERVIEW_HORIZONTAL_LANE_GAP) + 18, y: (OVERVIEW_TIERS[areaId] ?? 0) * OVERVIEW_VERTICAL_GAP }] as const),
))

const blendedColor = (left: string, right: string, leftWeight = 50): string =>
  `color-mix(in srgb, ${left} ${leftWeight}%, ${right})`

const overviewNodeColor = (areaId: string): string => {
  const lanes = OVERVIEW_CONCEPTUAL_LANES
  const laneIndex = lanes.findIndex((lane) => lane.areaIds.some((id) => id === areaId))
  const own = lanes[Math.max(0, laneIndex)]?.color ?? GRAPH_DARK_GRAY
  if (areaId === 'programming' || areaId === 'algorithms') return blendedColor(lanes[0].color, lanes[1].color, 45)
  if (areaId === 'data-databases') return blendedColor(lanes[1].color, lanes[2].color, 45)
  if (areaId === 'ai-ml') return blendedColor(lanes[2].color, lanes[3].color, 70)
  if (areaId === 'delivery') return blendedColor(lanes[1].color, lanes[3].color, 45)
  if (areaId === 'professional-societal') return blendedColor(lanes[2].color, lanes[3].color, 25)
  return own
}

const detailLaneColor = (base: string, laneIndex: number): string => {
  const accents = ['#7479c9', '#4f91a8', '#d48754', '#b58d3f', '#9a6caf']
  return blendedColor(base, accents[laneIndex % accents.length]!, 62)
}

const conceptualLanesForCourse = (areaId: string, modules: readonly LearningModule[]): SkillBranch[] => {
  if (areaId === 'data-science') {
    return [
      { title: 'Questions & evidence', moduleIds: ['ds-question-framing', 'ds-data-lifecycle', 'ds-measurement', 'ds-sampling', 'ds-eda', 'ds-missing-data'] },
      { title: 'Uncertainty & causality', moduleIds: ['ds-probabilistic-reasoning', 'ds-statistical-inference', 'ds-causal-reasoning', 'ds-experiments', 'ds-observational-causality'] },
      { title: 'Models & validation', moduleIds: ['ds-representation', 'ds-modeling', 'ds-evaluation'] },
      { title: 'Communication & operations', moduleIds: ['ds-communication', 'ds-production'] },
    ]
  }
  // Rule 7 of the skill-tree style guide (./skill-tree-layout.ts): the
  // prerequisite graph shapes the tree; never chunk chapters into columns.
  return prerequisiteBranches(modules)
}

const laneLabelNode = (id: string, title: string, color: string, laneIndex: number, horizontalGap: number, laneHeight: number): SkillTreeNode => ({
  id: `visual-lane:${id}`,
  type: 'skill',
  position: { x: laneIndex * horizontalGap, y: horizontalGap === OVERVIEW_HORIZONTAL_LANE_GAP ? -85 : -105 },
  draggable: false,
  selectable: false,
  connectable: false,
  zIndex: -1,
  data: { title, eyebrow: '', detail: '', icon: '', completion: 0, color, areaId: '', isLaneLabel: true, laneHeight },
})

const COURSE_ICONS: Record<string, string> = {
  'data-science': '📊',
  foundations: '🧱',
  mathematics: '∑',
  programming: '⌨',
  algorithms: '⛓',
  systems: '⚙',
  architecture: '🏛',
  networks: '🌐',
  'data-databases': '◉',
  'ai-ml': '✦',
  'security-privacy': '🛡',
  hci: '☝',
  delivery: '🚀',
  'professional-societal': '⚖',
}

const chapterIcon = (title: string, areaId: string): string => {
  const text = title.toLowerCase()
  if (/question|problem|requirement/.test(text)) return '❓'
  if (/data|storage|database|schema/.test(text)) return '▤'
  if (/measure|metric|evaluation|test/.test(text)) return '✓'
  if (/sample|population/.test(text)) return '◎'
  if (/probab|uncertain|inference/.test(text)) return '🎲'
  if (/causal|experiment/.test(text)) return '⚗'
  if (/visual|communication|interface/.test(text)) return '◫'
  if (/security|privacy|threat|identity/.test(text)) return '🛡'
  if (/network|distributed|protocol/.test(text)) return '⌁'
  if (/production|delivery|reliab|observ/.test(text)) return '⚙'
  if (/model|learning|neural|intelligence/.test(text)) return '✦'
  return COURSE_ICONS[areaId] ?? '◆'
}

const rollupTileText = (rollup: { estimate: number | null; known: number; required: number }) =>
  rollup.estimate === null ? 'Unknown' : `${rollup.estimate}% · ${rollup.known}/${rollup.required}`

export function CurriculumTree({ graph, rollup, selectedModuleId, onSelectModule, onSelectTreeModule, onSelectCurriculum, onSelectConcept, onHighlightConcepts, onOpenSettings }: {
  readonly rollup?: string
  readonly graph: LearningGraph
  readonly selectedModuleId: string
  readonly onSelectModule: (module: LearningModule) => void
  /** Updates selection and graph emphasis together so a course click cannot race a chapter click. */
  readonly onSelectTreeModule?: (module: LearningModule, conceptIds: string[], label: string) => void
  readonly onSelectCurriculum: (curriculumId: string | null) => void
  readonly selectedConceptId?: string
  readonly onSelectConcept?: (conceptId: string) => void
  readonly onHighlightConcepts?: (conceptIds: string[], label: string) => void
  readonly onOpenSettings?: () => void
}) {
  const scheme = useSyncExternalStore(subscribeScheme, currentScheme)
  const moduleMap = useMemo(() => new Map(graph.curriculum.modules.map((module) => [module.id, module])), [graph.curriculum.modules])
  const conceptMap = useMemo(() => new Map(graph.concepts.map((concept) => [concept.id, concept])), [graph.concepts])
  const selectedModule = moduleMap.get(selectedModuleId) ?? graph.curriculum.modules[0]
  const [selectedAreaId, setSelectedAreaId] = useState(selectedModule?.laneId ?? graph.curriculum.lanes[0]?.id ?? '')
  const [viewLevel, setViewLevel] = useState<'modules' | 'module'>('modules')
  const [openNodeId, setOpenNodeId] = useState<string | null>(null)
  const [detailAnchor, setDetailAnchor] = useState({ x: 0, y: 0, height: 0 })
  const [treeViewport, setTreeViewport] = useState<Viewport>({ x: 28, y: 96, zoom: 0.75 })
  const treeInstanceRef = useRef<ReactFlowInstance<SkillTreeNode, ReactFlowEdge> | null>(null)
  const treeFrameRef = useRef<HTMLDivElement | null>(null)
  const [treeFrameSize, setTreeFrameSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const frame = treeFrameRef.current
    if (!frame) return undefined
    const measure = () => setTreeFrameSize({ width: frame.clientWidth, height: frame.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])
  const selectedArea = graph.curriculum.lanes.find((lane) => lane.id === selectedAreaId) ?? graph.curriculum.lanes[0]
  const selectedAreaModules = useMemo(
    () => graph.curriculum.modules.filter((module) => module.laneId === selectedArea?.id).sort((left, right) => left.step - right.step),
    [graph.curriculum.modules, selectedArea?.id],
  )
  // WHICH overview layout this curriculum gets. The curated grouping above is
  // keyed by the Computer Science library's own lane ids; any other curriculum
  // names its own lanes, so it gets the layout derived from its prerequisites.
  const curatedOverview = useMemo(
    () => graph.curriculum.lanes.length > 0 && graph.curriculum.lanes.every((lane) => overviewPosition.has(lane.id)),
    [graph.curriculum.lanes],
  )
  const derivedOverview = useMemo(
    () => derivedOverviewLayout(
      graph.curriculum.lanes.map((lane) => ({ id: lane.id, title: lane.title, color: lane.color })),
      graph.curriculum.modules.map((module) => ({ id: module.id, laneId: module.laneId, dependsOnModuleIds: module.dependsOnModuleIds })),
    ),
    [graph.curriculum.lanes, graph.curriculum.modules],
  )
  const overviewCell = useCallback((laneId: string): { x: number; y: number } => {
    const curated = overviewPosition.get(laneId)
    if (curatedOverview && curated) return curated
    const cell = derivedOverview.cells.get(laneId) ?? { column: 0, row: 0 }
    return { x: (cell.column * OVERVIEW_HORIZONTAL_LANE_GAP) + 18, y: cell.row * OVERVIEW_VERTICAL_GAP }
  }, [curatedOverview, derivedOverview])

  // Rule 4: the band runs past the deepest row so no tile sits on bare canvas.
  const overviewLaneHeight = curatedOverview ? OVERVIEW_LANE_HEIGHT : (derivedOverview.rows * OVERVIEW_VERTICAL_GAP) + OVERVIEW_TILE_HEIGHT
  const overviewBands = useMemo(
    () => (curatedOverview ? OVERVIEW_CONCEPTUAL_LANES : derivedOverview.bands).map((lane) => ({ title: lane.title, color: lane.color })),
    [curatedOverview, derivedOverview.bands],
  )
  const overviewNodes = useMemo<SkillTreeNode[]>(() => [
    ...overviewBands.map((lane, laneIndex) => laneLabelNode(`overview:${laneIndex}`, lane.title, lane.color, laneIndex, OVERVIEW_HORIZONTAL_LANE_GAP, overviewLaneHeight)),
    ...graph.curriculum.lanes.map((lane): SkillTreeNode => {
      const modules = graph.curriculum.modules.filter((module) => module.laneId === lane.id)
      const laneRollup = graph.rollups.lanes[lane.id] ?? NO_ROLLUP
      return {
        id: `lane:${lane.id}`,
        type: 'skill',
        // Every lane lands INSIDE a band in both modes: the curated map when it
        // covers this curriculum, otherwise its own column at its prerequisite depth.
        position: overviewCell(lane.id),
        selected: lane.id === selectedArea?.id,
        ariaLabel: `${lane.title}, ${rollupLabel(laneRollup)}, ${modules.length} chapters`,
        data: {
          title: lane.title,
          eyebrow: '',
          detail: '',
          icon: COURSE_ICONS[lane.id] ?? '◆',
          completion: laneRollup.estimate ?? 0,
          rollupText: rollupTileText(laneRollup),
          color: curatedOverview ? overviewNodeColor(lane.id) : lane.color,
          areaId: lane.id,
        },
      }
    })], [graph.curriculum.lanes, graph.curriculum.modules, graph.rollups, selectedArea?.id, overviewBands, overviewCell, curatedOverview, overviewLaneHeight])
  const overviewEdges = useMemo<ReactFlowEdge[]>(() => {
    const moduleLane = new Map(graph.curriculum.modules.map((module) => [module.id, module.laneId]))
    const laneColor = new Map(graph.curriculum.lanes.map((lane) => [lane.id, curatedOverview ? overviewNodeColor(lane.id) : lane.color]))
    const seen = new Set<string>()
    return graph.curriculum.modules.flatMap((module) => module.dependsOnModuleIds.flatMap((dependencyId) => {
      const sourceLane = moduleLane.get(dependencyId)
      if (!sourceLane || sourceLane === module.laneId) return []
      const id = `${sourceLane}->${module.laneId}`
      if (seen.has(id)) return []
      seen.add(id)
      const color = laneColor.get(sourceLane) ?? GRAPH_DARK_GRAY
      return [{
        id,
        source: `lane:${sourceLane}`,
        target: `lane:${module.laneId}`,
        type: 'smoothstep',
        pathOptions: { borderRadius: SKILL_TREE_EDGE_RADIUS },
        style: { stroke: color, strokeWidth: 3 },
        markerEnd: { type: MarkerType.ArrowClosed, color },
      }]
    }))
  }, [graph.curriculum.lanes, graph.curriculum.modules, curatedOverview])
  const detailConceptualLanes = useMemo(() => conceptualLanesForCourse(selectedArea?.id ?? '', selectedAreaModules), [selectedArea?.id, selectedAreaModules])
  const detailLaneByModule = useMemo(() => new Map(detailConceptualLanes.flatMap((lane, laneIndex) =>
    lane.moduleIds.map((moduleId) => [moduleId, laneIndex] as const),
  )), [detailConceptualLanes])
  const detailPositions = useMemo(() => branchPositions(detailConceptualLanes, DETAIL_HORIZONTAL_LANE_GAP), [detailConceptualLanes])
  // Rule 4 of the skill-tree style guide: the band runs a full row pitch past
  // the deepest row, so the last tile never sits on bare canvas.
  const detailLaneHeight = Math.max(600, Math.max(0, ...[...detailPositions.values()].map((position) => position.y)) + SKILL_TREE_ROW_GAP + DETAIL_TILE_HEIGHT)
  const detailLaneColors = useMemo(
    () => detailConceptualLanes.map((_lane, laneIndex) => detailLaneColor(selectedArea?.color ?? GRAPH_DARK_GRAY, laneIndex)),
    [detailConceptualLanes, selectedArea?.color],
  )
  const detailNodes = useMemo<SkillTreeNode[]>(() => [
    ...detailConceptualLanes.map((lane, laneIndex) => laneLabelNode(`detail:${selectedArea?.id}:${laneIndex}`, lane.title, detailLaneColors[laneIndex] ?? GRAPH_DARK_GRAY, laneIndex, DETAIL_HORIZONTAL_LANE_GAP, detailLaneHeight)),
    ...selectedAreaModules.map((module, index): SkillTreeNode => {
      const moduleRollup = graph.rollups.modules[module.id] ?? NO_ROLLUP
      const conceptualLaneIndex = detailLaneByModule.get(module.id) ?? 0
      return {
        id: `module:${module.id}`,
        type: 'skill',
        position: detailPositions.get(module.id) ?? { x: 18, y: 0 },
        selected: module.id === selectedModuleId,
        ariaLabel: `${module.title}, ${rollupLabel(moduleRollup)}, step ${module.step}`,
        data: {
          title: module.title,
          eyebrow: `Chapter ${index + 1}`,
          detail: `${module.conceptIds.length} concepts · ${module.dependsOnModuleIds.length} prerequisites`,
          icon: chapterIcon(module.title, module.laneId),
          completion: moduleRollup.estimate ?? 0,
          rollupText: rollupTileText(moduleRollup),
          color: detailLaneColors[conceptualLaneIndex] ?? selectedArea?.color ?? GRAPH_ORANGE,
          areaId: module.laneId,
          moduleId: module.id,
        },
      }
    }),
  ], [detailConceptualLanes, detailLaneByModule, detailLaneColors, detailLaneHeight, detailPositions, graph.rollups, selectedArea?.color, selectedArea?.id, selectedAreaModules, selectedModuleId])
  const detailEdges = useMemo<ReactFlowEdge[]>(() => {
    const visible = new Set(selectedAreaModules.map((module) => module.id))
    const color = selectedArea?.color ?? GRAPH_DARK_GRAY
    return selectedAreaModules.flatMap((module) => module.dependsOnModuleIds.flatMap((dependencyId) => visible.has(dependencyId) ? [{
      id: `${dependencyId}->${module.id}`,
      source: `module:${dependencyId}`,
      target: `module:${module.id}`,
      type: 'smoothstep',
      pathOptions: { borderRadius: SKILL_TREE_EDGE_RADIUS },
      style: { stroke: color, strokeWidth: 3 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
    }] : []))
  }, [selectedArea?.color, selectedAreaModules])
  const nodes = viewLevel === 'modules' ? overviewNodes : detailNodes
  const edges = viewLevel === 'modules' ? overviewEdges : detailEdges
  // Fit the WIDTH only. fitView would shrink the whole spread-out tree into the
  // frame, undoing the vertical room; the height is what the scrollbar is for.
  const treeFitZoom = useMemo(() => {
    const minX = Math.min(...nodes.map((node) => node.position.x))
    const maxX = Math.max(...nodes.map((node) => node.position.x + SKILL_LANE_WIDTH))
    const frameWidth = treeFrameSize.width
    return frameWidth > 0 ? Math.min(SKILL_TREE_FIT_MAX_ZOOM, Math.max(0.2, (frameWidth - (SKILL_TREE_FRAME_PADDING * 2)) / (maxX - minX))) : 0.6
  }, [nodes, treeFrameSize.width])
  const treeTranslateExtent = useMemo(() => {
    const minX = Math.min(...nodes.map((node) => node.position.x))
    // Rule 6: row 0 must clear the pinned headers at ANY fit zoom. The header
    // has a screen-pixel minimum height, so the clearance above row 0 is
    // reserved in canvas units scaled by the zoom the frame will open at.
    const minY = Math.min(...nodes.map((node) => node.position.y), -(SKILL_TREE_HEADER_CLEARANCE / treeFitZoom))
    const maxX = Math.max(...nodes.map((node) => node.position.x + SKILL_LANE_WIDTH))
    // Tiles, not lane bands, decide the bottom of the scroll range: the last row
    // must clear the frame with room for its label and the connectors under it.
    const maxY = Math.max(...nodes.filter((node) => !node.data.isLaneLabel).map((node) => node.position.y + (viewLevel === 'modules' ? OVERVIEW_TILE_HEIGHT : DETAIL_TILE_HEIGHT))) + SKILL_TREE_BOTTOM_PADDING
    return [[minX, minY], [maxX, maxY]] as [[number, number], [number, number]]
  }, [nodes, treeFitZoom, viewLevel])
  const fitTreeWidth = useCallback((instance: ReactFlowInstance<SkillTreeNode, ReactFlowEdge>) => {
    const frameWidth = treeFrameRef.current?.clientWidth ?? 0
    const [[minX, minY], [maxX]] = treeTranslateExtent
    const zoom = treeFitZoom
    // A tree narrower than the frame (after the zoom cap) is centred; the pinned
    // lane headers follow the viewport, so they stay over their columns.
    const slack = Math.max(0, frameWidth - ((maxX - minX) * zoom) - (SKILL_TREE_FRAME_PADDING * 2))
    const viewport = { x: SKILL_TREE_FRAME_PADDING + (slack / 2) - (minX * zoom), y: -(minY * zoom), zoom }
    void instance.setViewport(viewport)
    setTreeViewport(viewport)
  }, [treeFitZoom, treeTranslateExtent])
  // Refit when the pane itself changes width (sidebar, window resize); a new
  // tree remounts React Flow and refits through onInit instead.
  const fitTreeWidthRef = useRef(fitTreeWidth)
  fitTreeWidthRef.current = fitTreeWidth
  useEffect(() => {
    if (treeInstanceRef.current && treeFrameSize.width > 0) fitTreeWidthRef.current(treeInstanceRef.current)
  }, [treeFrameSize.width])
  const scrollTreeTo = (canvasY: number) => {
    const instance = treeInstanceRef.current
    if (!instance) return
    const [[, contentTop], [, contentBottom]] = treeTranslateExtent
    const visibleHeight = treeFrameSize.height / treeViewport.zoom
    const clampedY = Math.max(contentTop, Math.min(canvasY, contentBottom - visibleHeight))
    const viewport = { ...treeViewport, y: -(clampedY * treeViewport.zoom) }
    void instance.setViewport(viewport)
    setTreeViewport(viewport)
  }
  // A tile the viewer clicks while it sits outside the frame scrolls into view,
  // so its preview anchors to something visible instead of a clipped point.
  const revealTreeNode = (node: SkillTreeNode) => {
    const visibleTop = -treeViewport.y / treeViewport.zoom
    const visibleBottom = visibleTop + (treeFrameSize.height / treeViewport.zoom)
    const nodeBottom = node.position.y + (node.measured?.height ?? 110)
    if (node.position.y >= visibleTop && nodeBottom <= visibleBottom) return
    scrollTreeTo(node.position.y - SKILL_TREE_BOTTOM_PADDING)
  }

  useEffect(() => {
    if (selectedModule?.laneId) setSelectedAreaId(selectedModule.laneId)
  }, [selectedModule?.laneId])

  const selectTreeModule = (module: LearningModule, conceptIds: string[], label: string) => {
    if (onSelectTreeModule) {
      onSelectTreeModule(module, conceptIds, label)
      return
    }
    onSelectModule(module)
    onHighlightConcepts?.(conceptIds, label)
  }

  const selectSkillNode = (_event: ReactMouseEvent, node: SkillTreeNode) => {
    if (node.data.isLaneLabel) return
    revealTreeNode(node)
    setOpenNodeId(node.id)
    setDetailAnchor({ x: node.position.x + (node.measured?.width ?? 136), y: node.position.y, height: node.measured?.height ?? 110 })
    // Previewing a node must not navigate or resize the selected-concept pane.
    // Course/concept buttons inside the preview retain explicit navigation.
    if (node.data.areaId && !node.data.moduleId) {
      const area = graph.curriculum.lanes.find((lane) => lane.id === node.data.areaId)
      const conceptIds = graph.curriculum.modules.filter((module) => module.laneId === node.data.areaId).flatMap((module) => module.conceptIds)
      onHighlightConcepts?.(conceptIds, area?.title ?? node.data.title)
    }
    if (node.data.moduleId) {
      const module = moduleMap.get(node.data.moduleId)
      if (module) onHighlightConcepts?.(module.conceptIds, module.title)
    }
  }

  const openCourse = (areaId: string) => {
    const firstModule = graph.curriculum.modules.find((module) => module.laneId === areaId)
    const area = graph.curriculum.lanes.find((lane) => lane.id === areaId)
    setSelectedAreaId(areaId)
    setViewLevel('module')
    setOpenNodeId(null)
    const conceptIds = graph.curriculum.modules.filter((module) => module.laneId === areaId).flatMap((module) => module.conceptIds)
    if (firstModule) selectTreeModule(firstModule, conceptIds, area?.title ?? 'Selected course')
  }

  const openArea = openNodeId?.startsWith('lane:') ? graph.curriculum.lanes.find((lane) => lane.id === openNodeId.slice('lane:'.length)) : undefined
  const openModule = openNodeId?.startsWith('module:') ? moduleMap.get(openNodeId.slice('module:'.length)) : undefined
  const openRollup = (openArea ? graph.rollups.lanes[openArea.id] : openModule ? graph.rollups.modules[openModule.id] : undefined) ?? NO_ROLLUP
  const openPrerequisites = openModule
    ? openModule.dependsOnModuleIds.map((id) => moduleMap.get(id)?.title ?? id)
    : (openArea
        ? overviewEdges.filter((edge) => edge.target === `lane:${openArea.id}`).map((edge) => graph.curriculum.lanes.find((lane) => `lane:${lane.id}` === edge.source)?.title).filter((title): title is string => Boolean(title))
        : [])
  const openConcepts = openModule ? openModule.conceptIds.map((id) => conceptMap.get(id)).filter((concept): concept is Concept => Boolean(concept)) : []
  const openAreaModules = openArea ? graph.curriculum.modules.filter((module) => module.laneId === openArea.id) : []

  return (
    <Card className="flex h-full min-w-0 flex-col gap-3 overflow-hidden p-3">
      <div className="flex items-start gap-3">
        <div className="flex flex-1 flex-col gap-0.5">
          <Eyebrow>Curriculum skill tree</Eyebrow>
          <span className="text-xs text-ink-soft" data-testid="curriculum-rollup">{rollup ? `${rollup} · drag to explore` : 'Drag to explore · follow prerequisite arrows'}</span>
        </div>
        <div className="flex items-center gap-2">
          <Badge>{viewLevel === 'modules' ? `${graph.curriculum.lanes.length} courses` : `${selectedAreaModules.length} chapters`}</Badge>
          {onOpenSettings && (
            <Button variant="secondary" size="icon" onClick={onOpenSettings} aria-label="Open learning policy settings" title="Learning policy settings">
              <span aria-hidden="true">⚙</span>
            </Button>
          )}
        </div>
      </div>
      {/* The switcher lists what the learner already has; the link is how they
          get another one. Shown even with a single curriculum, because "ask for
          another" is the whole reason a learner would look here. */}
      <div className="flex items-center justify-between gap-2">
        {graph.availableCurriculums.length > 1 ? (
          <Select className="flex-1" aria-label="Select curriculum" value={graph.selectedCurriculumId}
            onChange={(event) => onSelectCurriculum(event.target.value)}
            options={graph.availableCurriculums.map((curriculum) => ({ value: curriculum.id, label: curriculum.title }))} />
        ) : <span />}
        <Link to={LEARNER_BUILD} className="text-sm font-semibold text-accent hover:underline">Build a curriculum</Link>
      </div>
      <SegmentedControl label="Curriculum zoom level" value={viewLevel}
        onValueChange={(value) => { setOpenNodeId(null); setViewLevel(value) }}
        options={[{ value: 'modules', label: 'Curriculum' }, { value: 'module', label: selectedArea?.title ?? 'Selected module' }]} />
      <p className="m-0 line-clamp-2 text-xs text-ink-soft">{viewLevel === 'modules' ? graph.curriculum.description : selectedArea?.summary ?? ''}</p>
      <div ref={treeFrameRef} className="skill-viewport" aria-label={viewLevel === 'modules' ? 'Curriculum module skill tree' : `${selectedArea?.title ?? 'Selected module'} skill tree`}>
        <ReactFlow<SkillTreeNode, ReactFlowEdge>
          key={`${viewLevel}:${viewLevel === 'modules' ? 'overview' : selectedArea?.id ?? 'none'}:${nodes.map((node) => node.data.rollupText).join('|')}`}
          colorMode={scheme}
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={skillTreeNodeTypes}
          onNodeClick={selectSkillNode}
          onMoveStart={(_event, viewport) => setTreeViewport(viewport)}
          onMove={(_event, viewport) => setTreeViewport(viewport)}
          onMoveEnd={(_event, viewport) => setTreeViewport(viewport)}
          onInit={(instance) => { treeInstanceRef.current = instance; fitTreeWidth(instance) }}
          defaultViewport={{ x: 28, y: 96, zoom: 0.75 }}
          translateExtent={treeTranslateExtent}
          minZoom={0.2}
          maxZoom={4}
          panOnDrag
          panOnScroll
          zoomOnScroll={false}
          nodesDraggable={false}
          nodesConnectable={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
        >
          <Background color="var(--rule)" gap={24} size={1} />
          <Controls position="bottom-right" showInteractive={false} className="skill-tree-controls" aria-label="Curriculum viewport controls" />
        </ReactFlow>
        <PinnedSkillLaneHeaders laneNodes={nodes.filter((node) => node.data.isLaneLabel)} viewport={treeViewport} />
        <SkillTreeScrollbar viewport={treeViewport} extent={treeTranslateExtent} frameHeight={treeFrameSize.height} onScrollTo={scrollTreeTo} />
        <Popover open={Boolean(openArea || openModule)} onOpenChange={(open) => { if (!open) setOpenNodeId(null) }}>
          <PopoverAnchor asChild>
            <div className="pointer-events-none absolute w-px" aria-hidden="true"
              style={{ left: treeViewport.x + detailAnchor.x * treeViewport.zoom, top: treeViewport.y + detailAnchor.y * treeViewport.zoom, height: detailAnchor.height * treeViewport.zoom }} />
          </PopoverAnchor>
          <PopoverContent side="right" align="start" sideOffset={12} aria-label="Skill node details" data-testid="skill-node-details" onOpenAutoFocus={(event) => event.preventDefault()}>
            <div className="flex flex-col gap-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-0.5">
                  <Eyebrow>{openArea ? 'Course / subject model' : 'Section / chapter'}</Eyebrow>
                  <strong className="leading-tight">{openArea ? `${COURSE_ICONS[openArea.id] ?? '◆'} ${openArea.title}` : `${openModule ? chapterIcon(openModule.title, openModule.laneId) : '◆'} ${openModule?.title ?? ''}`}</strong>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setOpenNodeId(null)} aria-label="Close skill details">×</Button>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone="warning">{rollupLabel(openRollup)}</Badge>
                <span className="text-xs text-ink-soft">{openPrerequisites.length ? `Requires ${openPrerequisites.join(' · ')}` : 'No prerequisites'}</span>
              </div>
              {openRollup.estimate !== null && <Progress value={openRollup.estimate} tone="warning" aria-label="Provisional node understanding" />}
              <p className="m-0 text-sm">{openArea?.summary ?? openModule?.summary ?? ''}</p>
              {openArea && (
                <>
                  <Eyebrow>Course shape</Eyebrow>
                  <p className="m-0 text-sm">{openAreaModules.length} chapters · {openAreaModules.reduce((total, module) => total + module.conceptIds.length, 0)} atomic concepts</p>
                  <Button size="sm" className="self-start" onClick={() => openCourse(openArea.id)}>Open course skill tree</Button>
                </>
              )}
              {openModule && (
                <>
                  <Eyebrow>Conceptual mastery</Eyebrow>
                  <ul className="m-0 flex list-disc flex-col gap-0.5 pl-5 text-sm">{openModule.masteryGoals.map((goal) => <li key={goal}>{goal}</li>)}</ul>
                  <Eyebrow>Atomic concepts</Eyebrow>
                  <div className="flex flex-wrap gap-1.5">
                    {openConcepts.map((concept) => <Button key={concept.id} variant="secondary" size="sm" onClick={() => onSelectConcept?.(concept.id)}>{concept.title}</Button>)}
                  </div>
                </>
              )}
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </Card>
  )
}
