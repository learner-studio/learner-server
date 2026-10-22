import { useEffect, useMemo, useState, type JSX } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Alert } from '../../components/ui/alert'
import { Spinner } from '../../components/ui/progress'
import { LearnerBackdrop } from '../../components/glass'
import { useRpcQuery } from '../../lib/api'
import { LEARNER_HISTORY } from '../../lib/routes'
import { ConceptInspector } from './ConceptInspector'
import { CurriculumTree } from './CurriculumTree'
import { rollupLabel } from './curriculum-rollups'
import { LearningHookHealth } from './LearningHookHealth'
import { errorText, type LearningModule } from './learning-model'
import { OsmosisNav } from './OsmosisNav'
import { LearningPolicySettingsModal } from './PolicyModal'
import { SigmaGraphPane, type LearningGraphPaneProps } from './SigmaGraphPane'

/** The Osmosis map: the curriculum skill tree beside the knowledge graph, the selected concept below. */
export function LearningPageLayout({ GraphComponent = SigmaGraphPane }: { readonly GraphComponent?: (props: LearningGraphPaneProps) => JSX.Element }) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const curriculumFromUrl = searchParams.get('curriculumId') ?? ''
  const reactiveQuery = useRpcQuery('getLearningReactiveConsolidation', {}, { refetchInterval: 10_000 })
  const datasetTag = searchParams.get('dataset') ?? (reactiveQuery.data?.enabled ? 'all' : 'dev1')
  const graphQuery = useRpcQuery('getLearningGraph', { curriculumId: curriculumFromUrl || undefined, datasetTag }, { refetchInterval: ['all', 'dev1', 'v3'].includes(datasetTag) ? 5000 : false })
  const graph = useMemo(() => {
    const result = graphQuery.data
    if (!result || datasetTag !== 'dev1') return result
    const experiment = result.vectorExperiment
    return { ...result, concepts: result.concepts.map((concept) => ({ ...concept, assessment: experiment ? concept.assessment : undefined })) }
  }, [graphQuery.data, datasetTag])
  const selectedFromUrl = searchParams.get('conceptId') ?? ''
  const nodeFromUrl = searchParams.get('nodeId') ?? searchParams.get('moduleId') ?? ''
  const [selectedModuleId, setSelectedModuleId] = useState('')
  const [selectedConceptId, setSelectedConceptId] = useState('')
  const [policySettingsOpened, setPolicySettingsOpened] = useState(false)
  const [treeHighlight, setTreeHighlight] = useState<{ conceptIds: string[]; label: string } | null>(null)
  const selectedConcept = graph?.concepts.find((concept) => concept.id === selectedConceptId)
  const selectedConceptHistoryQuery = useRpcQuery('getConversationHistory', { limit: 50, conceptId: selectedConceptId || undefined }, { enabled: Boolean(selectedConceptId), refetchInterval: 15_000 })

  useEffect(() => {
    if (!graph) return
    const firstModule = graph.curriculum.modules[0]
    const urlConcept = graph.concepts.some((concept) => concept.id === selectedFromUrl) ? selectedFromUrl : ''
    const urlModule = graph.curriculum.modules.some((module) => module.id === nodeFromUrl) ? nodeFromUrl : ''
    const conceptModule = urlConcept ? graph.curriculum.modules.find((module) => module.conceptIds.includes(urlConcept)) : undefined
    setSelectedModuleId(urlModule || conceptModule?.id || firstModule?.id || '')
    setSelectedConceptId(urlConcept || firstModule?.conceptIds[0] || graph.concepts[0]?.id || '')
  }, [graph, selectedFromUrl, nodeFromUrl])

  useEffect(() => setTreeHighlight(null), [graph?.curriculum.id])

  const selectedModule = graph?.curriculum.modules.find((module) => module.id === selectedModuleId) ?? graph?.curriculum.modules[0]
  const selectedLane = graph?.curriculum.lanes.find((lane) => lane.id === selectedModule?.laneId)

  const updateSelectionUrl = (conceptId: string, nodeId?: string) => {
    const next = new URLSearchParams(searchParams)
    // Keep the implicit default query key stable; only the curriculum selector
    // changes it. Normalizing it here unmounted the tree on its first click.
    if (conceptId) next.set('conceptId', conceptId)
    else next.delete('conceptId')
    if (nodeId) next.set('nodeId', nodeId)
    else next.delete('nodeId')
    next.delete('moduleId')
    setSearchParams(next, { replace: true })
  }

  const selectConcept = (conceptId: string) => {
    const module = graph?.curriculum.modules.find((item) => item.conceptIds.includes(conceptId))
    setSelectedConceptId(conceptId)
    if (module) {
      setSelectedModuleId(module.id)
      setTreeHighlight({ conceptIds: module.conceptIds, label: module.title })
    }
    updateSelectionUrl(conceptId, module?.id)
  }

  const selectModule = (module: LearningModule) => selectTreeModule(module, module.conceptIds, module.title)

  const selectTreeModule = (module: LearningModule, conceptIds: string[], label: string) => {
    const conceptId = module.conceptIds[0] ?? ''
    setSelectedModuleId(module.id)
    setSelectedConceptId(conceptId)
    setTreeHighlight({ conceptIds, label })
    updateSelectionUrl(conceptId, module.id)
  }

  const selectCurriculum = (curriculumId: string | null) => {
    if (!curriculumId || curriculumId === graph?.selectedCurriculumId) return
    const next = new URLSearchParams(searchParams)
    next.set('curriculumId', curriculumId)
    next.delete('conceptId')
    next.delete('nodeId')
    next.delete('moduleId')
    setSearchParams(next)
  }

  const showAllEvidence = () => {
    if (!selectedConceptId || !graph) return
    navigate(`${LEARNER_HISTORY}?curriculumId=${encodeURIComponent(graph.selectedCurriculumId)}&conceptId=${encodeURIComponent(selectedConceptId)}&provider=all&location=local`)
  }

  return (
    <LearnerBackdrop wide>
      <OsmosisNav />
      {graphQuery.isLoading ? (
        <div className="flex items-center justify-center gap-2 py-10"><Spinner />Loading learning graph…</div>
      ) : graphQuery.error || !graph ? (
        <Alert tone="danger" title="Learning graph unavailable">{graphQuery.error ? errorText(graphQuery.error) : 'No graph data returned.'}</Alert>
      ) : (
        <main className="flex flex-col gap-4" data-testid="learning-map">
          <LearningHookHealth />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            <div className="h-[640px] min-w-0 lg:col-span-5 lg:h-auto lg:min-h-[600px]">
              <CurriculumTree
                graph={graph}
                rollup={rollupLabel(graph.rollups.curriculum)}
                selectedModuleId={selectedModuleId}
                selectedConceptId={selectedConceptId}
                onSelectModule={selectModule}
                onSelectTreeModule={selectTreeModule}
                onSelectConcept={selectConcept}
                onSelectCurriculum={selectCurriculum}
                onHighlightConcepts={(conceptIds, label) => setTreeHighlight({ conceptIds, label })}
                onOpenSettings={() => setPolicySettingsOpened(true)}
              />
            </div>
            <div className="min-w-0 lg:col-span-7">
              <GraphComponent
                graph={graph}
                selectedConceptId={selectedConceptId}
                highlightedConceptIds={treeHighlight?.conceptIds}
                highlightLabel={treeHighlight?.label}
                currentModule={selectedModule}
                currentLane={selectedLane}
                onSelect={selectConcept}
                onShowAll={showAllEvidence}
              />
            </div>
          </div>
          <ConceptInspector
            experimentScoped={datasetTag === 'dev1' || Boolean(graphQuery.data?.vectorExperiment)}
            evidenceRuns={graphQuery.data?.vectorExperiment?.items.find((item) => item.conceptId === selectedConceptId)?.runs}
            concept={selectedConcept}
            history={selectedConceptHistoryQuery.data}
            historyLoading={selectedConceptHistoryQuery.isLoading}
          />
        </main>
      )}
      <LearningPolicySettingsModal opened={policySettingsOpened} onClose={() => setPolicySettingsOpened(false)} />
    </LearnerBackdrop>
  )
}

export default function LearningPage() {
  return <LearningPageLayout />
}
