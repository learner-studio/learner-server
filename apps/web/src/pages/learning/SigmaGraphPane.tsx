import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import Graph from 'graphology'
import Sigma from 'sigma'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, Eyebrow } from '../../components/ui/card'
import { currentScheme, masteryLabel, masteryTone, percent, subscribeScheme, type LearningGraph, type LearningLane, type LearningModule } from './learning-model'

// The graph keeps its own colours on purpose: orange for the selected/active
// concepts, gray for the rest, fixed in both colour schemes. Only the label
// text follows the scheme, because Sigma paints it straight onto the card.
const GRAPH_ORANGE = '#d99062'
const GRAPH_DARK_GRAY = '#5c6368'
const GRAPH_EDGE = `${GRAPH_DARK_GRAY}33`
const GRAPH_TEXT = { light: '#343a40', dark: '#f9fbfb' } as const
/** Camera ratio at or below which node names are drawn: two `+` clicks from the default view (1 / 1.5²). */
const LABEL_ZOOM_RATIO = 0.5

export type LearningGraphPaneProps = {
  readonly graph: LearningGraph
  readonly selectedConceptId: string
  readonly highlightedConceptIds?: readonly string[]
  readonly highlightLabel?: string
  readonly currentModule?: LearningModule
  readonly currentLane?: LearningLane
  readonly onSelect: (id: string) => void
  /** Opens the concept-scoped conversation history. */
  readonly onShowAll: () => void
}

const hash = (value: string): number => {
  let result = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 16777619)
  }
  return result >>> 0
}

/** A full, jittered point field is a fast neutral starting placement, not a topology layout. */
const previewPosition = (index: number, total: number, id: string): { x: number; y: number } => {
  const value = hash(id)
  const angle = (index * 2.399963229728653) + ((value % 1000) / 1000 * 0.16)
  const radius = Math.sqrt((index + 0.5) / Math.max(total, 1))
  const jitter = (((value >>> 12) % 1000) / 1000 - 0.5) * 0.025
  return { x: (Math.cos(angle) * radius) + jitter, y: (Math.sin(angle) * radius) + jitter }
}

const ZoomButton = ({ label, onClick, children }: { readonly label: string; readonly onClick: () => void; readonly children: string }) =>
  <Button variant="secondary" size="icon" aria-label={label} title={label} onClick={onClick}>{children}</Button>

function SigmaCanvas({ graph, selectedConceptId, activeConceptIds, onSelect }: {
  readonly graph: LearningGraph
  readonly selectedConceptId: string
  readonly activeConceptIds: readonly string[]
  readonly onSelect: (conceptId: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const graphRef = useRef<Graph | null>(null)
  const rendererRef = useRef<Sigma | null>(null)
  const selectedRef = useRef(selectedConceptId)
  const hoveredRef = useRef<string | null>(null)
  const activeIdsRef = useRef<Set<string>>(new Set(activeConceptIds))
  const activeEdgesRef = useRef<Set<string>>(new Set())
  const onSelectRef = useRef(onSelect)
  const graphInputRef = useRef(graph)
  const cameraStateRef = useRef<{ x: number; y: number; ratio: number; angle: number } | null>(null)
  const scheme = useSyncExternalStore(subscribeScheme, currentScheme)
  onSelectRef.current = onSelect
  graphInputRef.current = graph
  // The 5s graph refetch hands us a fresh object with the same topology. Rebuilding the
  // renderer on identity alone reset the camera on every poll and every click, so the
  // renderer is keyed on the structure instead.
  const structureKey = useMemo(
    () => `${graph.curriculum.id}|${graph.concepts.map((concept) => concept.id).join(',')}|${graph.edges.length}`,
    [graph.concepts, graph.curriculum.id, graph.edges.length],
  )

  useEffect(() => {
    selectedRef.current = selectedConceptId
    activeIdsRef.current = new Set(activeConceptIds)
    const sigmaGraph = graphRef.current
    activeEdgesRef.current = sigmaGraph && activeConceptIds.length
      ? new Set(sigmaGraph.edges().filter((edge) => {
        const [source, target] = sigmaGraph.extremities(edge)
        return activeIdsRef.current.has(source) && activeIdsRef.current.has(target)
      }))
      : new Set()
    rendererRef.current?.refresh()
  }, [activeConceptIds, selectedConceptId])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return undefined
    const graph = graphInputRef.current
    // A pair can be both related and a prerequisite; retain both relationship types.
    const sigmaGraph = new Graph({ multi: true })
    const order = [...graph.concepts].sort((left, right) => hash(left.id) - hash(right.id))
    const positions = new Map(order.map((concept, index) => [concept.id, previewPosition(index, order.length, concept.id)]))

    for (const concept of graph.concepts) {
      sigmaGraph.addNode(concept.id, { ...positions.get(concept.id)!, label: concept.title, color: GRAPH_DARK_GRAY, size: 3 })
    }
    for (const [index, edge] of graph.edges.entries()) {
      if (sigmaGraph.hasNode(edge.from) && sigmaGraph.hasNode(edge.to)) {
        sigmaGraph.addDirectedEdgeWithKey(`${edge.from}:${edge.to}:${index}`, edge.from, edge.to, {
          color: GRAPH_EDGE,
          size: edge.kind === 'hard-prerequisite' ? 0.35 : 0.2,
        })
      }
    }

    graphRef.current = sigmaGraph
    const renderer = new Sigma(sigmaGraph, container, {
      allowInvalidContainer: true,
      defaultEdgeColor: GRAPH_EDGE,
      defaultNodeColor: GRAPH_DARK_GRAY,
      edgeReducer: (edge, data) => activeEdgesRef.current.has(edge) ? { ...data, color: GRAPH_ORANGE, size: 0.8, zIndex: 1 } : data,
      hideEdgesOnMove: true,
      hideLabelsOnMove: true,
      labelColor: { color: GRAPH_TEXT[scheme] },
      labelDensity: 0.07,
      labelRenderedSizeThreshold: 9,
      labelSize: 12,
      minEdgeThickness: 0.15,
      nodeReducer: (node, data) => {
        const selected = node === selectedRef.current
        const hovered = node === hoveredRef.current
        const active = activeIdsRef.current.has(node)
        if (selected || hovered) return { ...data, color: GRAPH_ORANGE, forceLabel: true, size: selected ? 8 : 6, zIndex: 2 }
        if (active) return { ...data, color: GRAPH_ORANGE, size: 6, zIndex: 1 }
        // Keep every concept legible in the all-concepts overview. Selection
        // adds emphasis; it must not make the other hundreds of nodes vanish.
        return { ...data, color: GRAPH_DARK_GRAY, size: 4 }
      },
      renderLabels: true,
      stagePadding: 38,
      zIndex: true,
    })
    renderer.on('clickNode', ({ node }) => onSelectRef.current(node))
    renderer.on('enterNode', ({ node }) => { hoveredRef.current = node; renderer.refresh() })
    renderer.on('leaveNode', () => { hoveredRef.current = null; renderer.refresh() })
    // Names only when punched in: the overview stays a point field, the selected
    // and hovered nodes keep their forced label at any zoom.
    const applyLabelVisibility = () => {
      const zoomedIn = renderer.getCamera().ratio <= LABEL_ZOOM_RATIO
      renderer.setSetting('labelRenderedSizeThreshold', zoomedIn ? 0 : Number.POSITIVE_INFINITY)
      renderer.setSetting('labelDensity', zoomedIn ? 0.5 : 0.07)
    }
    renderer.getCamera().on('updated', applyLabelVisibility)
    if (cameraStateRef.current) renderer.getCamera().setState(cameraStateRef.current)
    applyLabelVisibility()
    rendererRef.current = renderer
    activeEdgesRef.current = new Set(sigmaGraph.edges().filter((edge) => {
      const [source, target] = sigmaGraph.extremities(edge)
      return activeIdsRef.current.has(source) && activeIdsRef.current.has(target)
    }))
    renderer.refresh()

    return () => {
      cameraStateRef.current = renderer.getCamera().getState()
      renderer.kill()
      graphRef.current = null
      rendererRef.current = null
    }
  }, [scheme, structureKey])

  const camera = () => rendererRef.current?.getCamera()
  return (
    <div className="relative h-[500px] overflow-hidden rounded-b-lg border border-rule" aria-label="Nonlinear knowledge graph" data-layout-type="sigma-static-preview" data-renderer="sigma-webgl" data-active-concept-count={activeConceptIds.length}>
      <div ref={containerRef} className="size-full" />
      <div className="absolute right-3 bottom-3 flex gap-1 rounded-lg bg-canvas/80 p-1" aria-label="Graph view controls">
        <ZoomButton label="Zoom out" onClick={() => void camera()?.animatedUnzoom({ duration: 150 })}>−</ZoomButton>
        <ZoomButton label="Zoom in" onClick={() => void camera()?.animatedZoom({ duration: 150 })}>+</ZoomButton>
        <ZoomButton label="Fit graph to view" onClick={() => void camera()?.animatedReset({ duration: 150 })}>⌗</ZoomButton>
      </div>
    </div>
  )
}

export function SigmaGraphPane({ graph, selectedConceptId, highlightedConceptIds = [], highlightLabel, currentModule, currentLane, onSelect, onShowAll }: LearningGraphPaneProps) {
  const selectedConcept = graph.concepts.find((concept) => concept.id === selectedConceptId)
  const selectedModule = currentModule ?? graph.curriculum.modules.find((item) => item.conceptIds.includes(selectedConceptId)) ?? graph.curriculum.modules[0]
  const selectedLane = currentLane ?? graph.curriculum.lanes.find((lane) => lane.id === selectedModule?.laneId)
  const mastery = selectedConcept?.mastery
  const activeConceptIds = useMemo(() => {
    const known = new Set(graph.concepts.map((concept) => concept.id))
    const requested = highlightedConceptIds.length ? highlightedConceptIds : selectedModule?.conceptIds ?? []
    return [...new Set([...requested, selectedConceptId].filter((id) => Boolean(id) && known.has(id)))]
  }, [graph.concepts, highlightedConceptIds, selectedConceptId, selectedModule?.conceptIds])

  return (
    <Card className="flex flex-col p-3" data-highlight-label={highlightLabel ?? ''}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Eyebrow>Knowledge graph</Eyebrow>
          <span className="text-xs text-ink-soft">{graph.concepts.length} concepts · {graph.edges.length} links · laid out by prerequisite flow</span>
        </div>
        <Button variant="secondary" size="sm" disabled={!selectedConceptId} onClick={onShowAll}>Conversation history</Button>
      </div>
      <div className="mt-2.5 flex min-w-0 flex-col gap-1" aria-label="Selected concept" data-testid="selected-concept-header">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="m-0 text-lg font-bold">{selectedConcept?.title ?? 'Select a concept'}</h3>
          {mastery && <Badge tone={masteryTone(mastery.level)}>{mastery.level === 'unknown' ? masteryLabel(mastery.level) : `${masteryLabel(mastery.level)} · ${percent(mastery.score)}`}</Badge>}
          {selectedConcept && selectedModule && <Badge variant="outline">Step {selectedModule.step}</Badge>}
          {selectedConcept && selectedLane && <Badge variant="outline">{selectedLane.title}</Badge>}
          {selectedConcept && selectedModule && <Badge variant="outline">{selectedModule.dependsOnModuleIds.length} prerequisite{selectedModule.dependsOnModuleIds.length === 1 ? '' : 's'}</Badge>}
        </div>
        <p className="m-0 truncate text-sm" title={selectedConcept?.explanation ?? ''}>{selectedConcept?.explanation ?? 'Choose a curriculum step or graph node to inspect mastery, evidence, and review status.'}</p>
      </div>
      <div className="mt-2 flex h-[30px] items-center overflow-hidden rounded-t-lg border border-b-0 border-rule bg-glass px-2" aria-label="Selected concept context">
        <span className="min-w-0 flex-1 truncate text-xs" title={selectedConcept?.example ?? ''}>{selectedConcept ? `Example: ${selectedConcept.example}` : 'Example: select a concept'}</span>
      </div>
      <SigmaCanvas graph={graph} selectedConceptId={selectedConceptId} activeConceptIds={activeConceptIds} onSelect={onSelect} />
    </Card>
  )
}
