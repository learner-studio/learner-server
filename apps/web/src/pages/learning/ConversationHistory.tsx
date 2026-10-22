import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card, Eyebrow } from '../../components/ui/card'
import { Field, Input, Select } from '../../components/ui/input'
import { Spinner } from '../../components/ui/progress'
import { LearnerBackdrop } from '../../components/glass'
import { useRpcQuery } from '../../lib/api'
import { LEARNER_OSMOSIS } from '../../lib/routes'
import ConversationDetail from './ConversationDetail'
import ConversationFolderTree from './ConversationFolderTree'
import ConversationThreadList from './ConversationThreadList'
import { threadInFolder } from './conversation-history-model'
import { dateTime, errorText, masteryLabel, masteryTone, percent } from './learning-model'
import { OsmosisNav } from './OsmosisNav'

type ConversationProvider = 'google' | 'anthropic' | 'openai'
const providerLabel = (provider: ConversationProvider): string => provider === 'google' ? 'Google' : provider === 'anthropic' ? 'Claude' : 'OpenAI'
const locationLabel = (location: 'local' | 'remote'): string => location === 'local' ? 'Local' : 'Remote'

const getFilterValue = <T extends string>(params: URLSearchParams, key: string, allowed: readonly T[], fallback: T): T => {
  const value = params.get(key)
  return value && allowed.includes(value as T) ? value as T : fallback
}

const Stat = ({ label, children }: { readonly label: string; readonly children: React.ReactNode }) => (
  <div className="flex flex-col gap-0.5"><Eyebrow>{label}</Eyebrow><strong>{children}</strong></div>
)

/** A debug reader over the ingested CLI archive: folders, threads, and the turns of one thread. */
export default function ConversationHistoryPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const curriculumId = searchParams.get('curriculumId') ?? ''
  const graphQuery = useRpcQuery('getLearningGraph', { curriculumId: curriculumId || undefined })
  const graph = graphQuery.data
  const conceptId = searchParams.get('conceptId') ?? ''
  const providerFilter = getFilterValue(searchParams, 'provider', ['all', 'google', 'anthropic', 'openai'] as const, 'all')
  const locationFilter = getFilterValue(searchParams, 'location', ['local', 'remote'] as const, 'local')
  const selectedConcept = graph?.concepts.find((concept) => concept.id === conceptId)
  const [conceptInput, setConceptInput] = useState('')
  const [folder, setFolder] = useState('__all__')
  const [selectedThreadId, setSelectedThreadId] = useState('')

  const historyQuery = useRpcQuery('getConversationHistory', { limit: conceptId ? 200 : 50, conceptId: conceptId || undefined }, { refetchInterval: conceptId ? 15_000 : 5_000 })
  const history = historyQuery.data

  useEffect(() => { setConceptInput(selectedConcept?.title ?? '') }, [selectedConcept?.id, selectedConcept?.title])
  const updateFilter = (key: 'provider' | 'location', value: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.set(key, value)
      return next
    })
  }

  const selectConceptFilter = (nextConceptId: string) => {
    const next = new URLSearchParams(searchParams)
    if (nextConceptId) next.set('conceptId', nextConceptId)
    else next.delete('conceptId')
    setSearchParams(next)
  }

  const visibleThreads = useMemo(
    () => !history ? [] : history.threads.filter((thread) => thread.location === locationFilter && (providerFilter === 'all' || thread.provider === providerFilter) && threadInFolder(thread, folder)),
    [history, locationFilter, providerFilter, folder],
  )
  useEffect(() => { if (!visibleThreads.some((thread) => thread.id === selectedThreadId)) setSelectedThreadId(visibleThreads[0]?.id ?? '') }, [selectedThreadId, visibleThreads])
  const selectedThread = visibleThreads.find((thread) => thread.id === selectedThreadId)
  const visibleTurns = visibleThreads.reduce((count, thread) => count + thread.turns.length, 0)
  const visibleUserTurns = visibleThreads.reduce((count, thread) => count + thread.turns.filter((turn) => turn.role === 'user').length, 0)
  const lastMatch = visibleThreads.flatMap((thread) => thread.turns).sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)))[0]
  const conceptByTitle = useMemo(() => new Map(graph?.concepts.map((concept) => [concept.title, concept.id]) ?? []), [graph?.concepts])

  const body = historyQuery.isLoading || graphQuery.isLoading ? (
    <div className="flex items-center justify-center gap-2 py-10"><Spinner />Loading conversation history…</div>
  ) : historyQuery.error || !history ? (
    <Alert tone="danger" title="Conversation history unavailable">{historyQuery.error ? errorText(historyQuery.error) : 'No history data returned.'}</Alert>
  ) : (
    <>
      <Card className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="m-0 text-2xl font-bold">Conversation history</h1>
            <Badge>debug view</Badge>
          </div>
          <p className="m-0 text-sm text-ink-soft">
            {conceptId
              ? `Conversation exchanges associated with ${selectedConcept?.title ?? 'the selected concept'}. Raw matches are not treated as mastery evidence.`
              : `The latest ${history.limit} conversation inputs, grouped by conversation and agent. Authorship is derived from provider-native provenance rather than transport role.`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="md" onClick={() => navigate(`${LEARNER_OSMOSIS}${conceptId ? `?conceptId=${encodeURIComponent(conceptId)}` : ''}`)}>Curriculum map</Button>
          <Button variant="secondary" size="md" onClick={() => void historyQuery.refetch()}>Refresh</Button>
        </div>
      </Card>

      {selectedConcept && (
        <Card data-testid="history-concept-summary">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="flex flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <h2 className="m-0 text-xl font-bold">{selectedConcept.title}</h2>
                <Badge tone={masteryTone(selectedConcept.mastery.level)}>{masteryLabel(selectedConcept.mastery.level)}</Badge>
              </div>
              <span className="text-sm text-ink-soft">Concept-filtered activity and learner-state summary</span>
            </div>
            <Button variant="ghost" size="md" onClick={() => selectConceptFilter('')}>Clear concept</Button>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-6">
            <Stat label="Current mastery">{masteryLabel(selectedConcept.mastery.level)}</Stat>
            <Stat label="Confidence">{selectedConcept.mastery.confidence ? percent(selectedConcept.mastery.confidence) : 'Not established'}</Stat>
            <Stat label="Matching turns">{visibleUserTurns}</Stat>
            <Stat label="Strong evidence">{selectedConcept.mastery.strongEvidenceCount}</Stat>
            <Stat label="Promotions">0</Stat>
            <Stat label="Last match">{dateTime(lastMatch?.timestamp ?? null)}</Stat>
          </div>
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <strong>{visibleTurns} turns across {visibleThreads.length} threads</strong>
            <span className="text-sm text-ink-soft">Newest activity determines thread order. Google readline history currently supplies verified inputs without response bodies.</span>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Concept" className="w-56">
              <Input list="history-concepts" placeholder="Search concepts" value={conceptInput}
                onChange={(event) => {
                  const value = event.currentTarget.value
                  setConceptInput(value)
                  const match = conceptByTitle.get(value)
                  if (match) selectConceptFilter(match)
                  else if (!value) selectConceptFilter('')
                }} />
              <datalist id="history-concepts">{graph?.concepts.map((concept) => <option key={concept.id} value={concept.title} />)}</datalist>
            </Field>
            <Field label="Provider" className="w-48">
              <Select value={providerFilter} onChange={(event) => updateFilter('provider', event.target.value)}
                options={[{ value: 'all', label: 'All providers' }, { value: 'google', label: 'Google / Antigravity' }, { value: 'anthropic', label: 'Claude' }, { value: 'openai', label: 'OpenAI' }]} />
            </Field>
            <Field label="Data Location" className="w-36">
              <Select value={locationFilter} onChange={(event) => updateFilter('location', event.target.value)}
                options={[{ value: 'local', label: 'Local' }, { value: 'remote', label: 'Remote' }]} />
            </Field>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {history.sources.filter((source) => source.location === locationFilter).map((source) => (
            <Badge key={`${source.location}:${source.provider}`} tone={source.available ? 'success' : 'neutral'}>
              {locationLabel(source.location)} · {providerLabel(source.provider)} · {source.files} file{source.files === 1 ? '' : 's'}
            </Badge>
          ))}
        </div>
      </Card>

      {visibleThreads.length === 0 ? (
        <Alert tone="neutral" title={conceptId ? `No conversation matches for ${selectedConcept?.title ?? 'this concept'}` : `No ${locationFilter} conversation turns found`}>
          {conceptId ? 'No matching exchanges were found in the currently ingested history window.' : `The debug reader did not find readable Google, Anthropic, or OpenAI ${locationFilter} history files.`}
        </Alert>
      ) : (
        <Card className="grid min-h-[520px] grid-cols-1 gap-4 lg:h-[min(62vh,680px)] lg:grid-cols-[22fr_32fr_46fr]" data-testid="conversation-inbox">
          <div className="flex min-h-0 min-w-0 flex-col"><ConversationFolderTree threads={history.threads} value={folder} onChange={setFolder} /></div>
          <div className="flex min-h-0 min-w-0 flex-col lg:border-l lg:border-rule lg:pl-4"><ConversationThreadList threads={visibleThreads} selected={selectedThreadId} onSelect={setSelectedThreadId} /></div>
          <div className="flex min-h-0 min-w-0 flex-col lg:border-l lg:border-rule lg:pl-4"><ConversationDetail thread={selectedThread} /></div>
        </Card>
      )}
    </>
  )

  return (
    <LearnerBackdrop wide>
      <OsmosisNav />
      <main className="flex flex-col gap-4">{body}</main>
    </LearnerBackdrop>
  )
}
