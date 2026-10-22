import { useEffect, useRef, useState } from 'react'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Field, Select, Textarea } from '../../components/ui/input'
import { Spinner } from '../../components/ui/progress'
import { LearnerBackdrop } from '../../components/glass'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'
import { OsmosisNav } from './OsmosisNav'

export const playgroundScenarios = ['influence', 'none', 'abstain', 'empty', 'malformed', 'timeout', 'service_error', 'cli_error'] as const
type ChatMessage = { role: 'user' | 'assistant'; text: string }
type Provider = 'codex' | 'claude' | 'agy'
type ContextMode = 'fixture' | 'current_turn' | 'retrieval'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One chat turn through the Learning adapter, with every recorded event beside it. */
export default function LearningPlaygroundPage() {
  const fixtures = useRpcQuery('getLearningPlaygroundFixtures', {})
  const start = useRpcMutation('startLearningPlaygroundTurn')
  const [fixtureId, setFixtureId] = useState<string | null>(null)
  const [provider, setProvider] = useState<Provider>('codex')
  const [mode, setMode] = useState<'live' | 'fixture'>('fixture')
  const [contextMode, setContextMode] = useState<ContextMode>('retrieval')
  const [conversationId, setConversationId] = useState(() => crypto.randomUUID())
  const [scenario, setScenario] = useState<typeof playgroundScenarios[number]>('influence')
  const [message, setMessage] = useState(() => {
    const concept = new URLSearchParams(window.location.search).get('concept')
    return concept ? `Help me practice ${concept}. Use my archived evidence where relevant and ask one short understanding check.` : ''
  })
  const [history, setHistory] = useState<ChatMessage[]>([])
  const [restoredRun, setRestoredRun] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('run')
    return value && UUID.test(value) ? value : null
  })
  const [runId, setRunId] = useState<string | null>(restoredRun)
  const completedRun = useRef<string | null>(null)
  const pendingRequest = useRef<{ key: string; requestId: string } | null>(null)
  const turn = useRpcQuery('getLearningPlaygroundTurn', { runId: runId ?? '' }, {
    enabled: Boolean(runId),
    refetchInterval: (query) => query.state.data?.status === 'running' ? 500 : false,
  })
  const selected = fixtures.data?.fixtures.find((item) => item.fixtureId === fixtureId) ?? (fixtureId ? undefined : fixtures.data?.fixtures[0])
  const requiresFixture = mode === 'fixture' || contextMode !== 'retrieval'
  const busy = start.isPending || Boolean(runId && (!turn.data || (turn.data.status === 'running' && turn.data.response === null)) && !turn.error)
  useEffect(() => {
    if (turn.data?.response != null && completedRun.current !== turn.data.runId) {
      const text = turn.data.response
      completedRun.current = turn.data.runId
      setHistory((items) => [...items, { role: 'assistant', text }])
    }
  }, [turn.data])
  const submit = async () => {
    if (restoredRun || (!selected && requiresFixture) || !message.trim() || busy) return
    const text = message.trim()
    const input = { fixtureId: selected?.fixtureId ?? 'retrieval', conversationId, provider, mode, contextMode, scenario, message: text, history: history.slice(-8).map((item) => ({ ...item, text: item.text.slice(0, 6000) })) }
    const key = JSON.stringify(input)
    if (pendingRequest.current?.key !== key) pendingRequest.current = { key, requestId: crypto.randomUUID() }
    try {
      const result = await start.mutateAsync({ ...input, requestId: pendingRequest.current.requestId })
      pendingRequest.current = null
      setHistory((items) => [...items, { role: 'user', text }])
      setMessage('')
      setRunId(result.runId)
    } catch { /* The mutation error is rendered below; preserve the draft for retry. */ }
  }
  const newConversation = () => {
    setHistory([])
    setRunId(null)
    setRestoredRun(null)
    completedRun.current = null
    const url = new URL(window.location.href)
    url.searchParams.delete('run')
    window.history.replaceState(null, '', url)
    setConversationId(crypto.randomUUID())
    start.reset()
  }
  const contextOptions = [
    { value: 'retrieval', label: 'Local retrieval + cached assessment (MVP)' },
    { value: 'fixture', label: 'Frozen extraction (control)' },
    ...(provider === 'codex' ? [{ value: 'current_turn', label: 'Legacy classifier (two calls)' }] : []),
  ]
  const turnError = start.error ? errorText(start.error) : turn.error ? errorText(turn.error) : turn.data?.error

  return (
    <LearnerBackdrop wide>
      <OsmosisNav />
      <main className="flex flex-col gap-4" data-testid="learning-playground">
        <Card className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <h1 className="m-0 text-2xl font-bold">Learning playground</h1>
            <Badge tone="accent">Provisional · not mastery</Badge>
          </div>
          <p className="m-0 text-sm text-ink-soft">Retrieve archived evidence and provisional assessments before an answer. The default path uses no separate classifier call. The server records the packet, response and background capture.</p>
        </Card>
        {restoredRun && <Alert>Viewing a saved turn receipt. Start a new conversation to send a message; this view does not restore the original conversation history.</Alert>}
        <Card className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Frozen fixture">
              <Select value={selected?.fixtureId ?? ''} disabled={busy} onChange={(event) => setFixtureId(event.target.value || null)}
                options={(fixtures.data?.fixtures ?? []).map((item) => ({ value: item.fixtureId, label: item.label }))} />
            </Field>
            <Field label="Provider">
              <Select value={provider} disabled={busy} options={['codex', 'claude', 'agy'].map((value) => ({ value, label: value }))}
                onChange={(event) => {
                  const value = event.target.value
                  if (value === 'codex' || value === 'claude' || value === 'agy') {
                    setProvider(value)
                    if (value !== 'codex' && contextMode === 'current_turn') setContextMode('retrieval')
                  }
                }} />
            </Field>
            <Field label="Mode">
              <Select value={mode} disabled={busy} options={[{ value: 'fixture', label: 'Fixture simulation' }, { value: 'live', label: 'Live CLI' }]}
                onChange={(event) => { const value = event.target.value; if (value === 'fixture' || value === 'live') { setMode(value); if (value === 'live') setScenario('influence') } }} />
            </Field>
            <Field label="Lookup scenario">
              <Select value={scenario} disabled={busy || mode === 'live'} options={playgroundScenarios.map((value) => ({ value, label: value }))}
                onChange={(event) => { const match = playgroundScenarios.find((item) => item === event.target.value); if (match) setScenario(match) }} />
            </Field>
          </div>
          <Field label="Context source">
            <Select value={contextMode} disabled={busy} options={contextOptions}
              onChange={(event) => { const value = event.target.value; if (value === 'fixture' || value === 'current_turn' || value === 'retrieval') setContextMode(value) }} />
          </Field>
          {contextMode === 'retrieval' && <Alert>Adapter-enforced retrieval, not a native CLI hook. Live mode retrieves sources, injects a bounded packet and makes one response call. Assessment runs separately; no verified mastery is written.</Alert>}
          {mode === 'live' && contextMode === 'retrieval' && <p className="m-0 text-xs text-ink-soft">Claude: tools off. Codex: read-only, shell/delegation/web disabled. AGY: plan/sandbox restrictions, not a hard tools-off guarantee.</p>}
          {contextMode === 'current_turn' && <Alert title="Two-phase POC · not a native CLI hook">Live mode uses two independent CLI invocations: propose 0–5 concept IDs, then answer with the validated Learning packet. Background normalization is deterministic and does not change mastery. Fixture mode simulates this flow without paid calls.</Alert>}
          <p className="m-0 text-sm">{mode === 'fixture' ? 'Fixture simulation: synthetic assistant response; no provider CLI is called.' : `Live CLI: calls the selected provider using ${contextMode === 'retrieval' ? 'local retrieval and cached assessments' : contextMode === 'current_turn' ? 'the current message classification' : 'the chosen fixture'}.`}</p>
          {mode === 'live' && <p className="m-0 text-xs text-ink-soft">{contextMode === 'retrieval' ? 'One response call; no classifier call. Missing or unavailable Learning context does not block chat. New messages are archived in the background.' : contextMode === 'current_turn' ? 'Current-turn POC: Codex runner, Luna / medium for both calls; shell/delegation/web disabled. The frozen fixture below is only a reusable example prompt.' : 'Live uses the stored fixture lookup; select an empty fixture for a none result. Claude: tools off. Codex: read-only, shell/delegation/web disabled. AGY: plan/sandbox restrictions, not a hard tools-off guarantee.'}</p>}
          {selected && <p className="m-0 text-xs text-ink-soft">{mode === 'live' && contextMode === 'current_turn' ? 'Example prompt' : 'Source'} run {selected.runId} · case {selected.caseId} · {selected.matchCount} provisional matches</p>}
          {fixtures.isLoading && <div className="flex items-center gap-2 text-sm"><Spinner />Loading frozen fixtures…</div>}
          {fixtures.error && <Alert tone="danger" title="Fixture load error">{errorText(fixtures.error)} <Button variant="ghost" size="sm" onClick={() => void fixtures.refetch()}>Retry fixtures</Button></Alert>}
          {!fixtures.isLoading && !fixtures.error && !selected && <Alert tone="warning">No frozen fixture available. Live retrieval does not require one; fixture simulation does.</Alert>}
        </Card>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="m-0 text-lg font-bold">Chat</h2>
              <Button variant="ghost" size="md" disabled={!restoredRun && (busy || history.length === 0)} onClick={newConversation}>New conversation</Button>
            </div>
            <div className="flex h-[360px] flex-col gap-2 overflow-auto" data-testid="playground-chat">
              {history.length === 0 && <p className="m-0 text-ink-soft">Start a turn or use the frozen prompt. Chat history is sent with each subsequent turn.</p>}
              {history.map((item, index) => (
                <Card inset key={index}>
                  <span className="block text-xs font-semibold">{item.role === 'user' ? 'You' : 'Assistant'}</span>
                  <p className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{item.text}</p>
                </Card>
              ))}
              {busy && <div className="flex items-center gap-2"><Spinner /><span role="status">{start.isPending ? 'Submitting turn…' : 'Turn running…'}</span></div>}
            </div>
            <Field label="Message">
              <Textarea rows={3} value={message} disabled={busy || Boolean(restoredRun)} onChange={(event) => setMessage(event.currentTarget.value)} />
            </Field>
            <div className="flex justify-between gap-2">
              <Button variant="secondary" size="md" disabled={!selected || busy || Boolean(restoredRun)} onClick={() => setMessage(selected?.prompt ?? '')}>Use frozen prompt</Button>
              <Button size="md" disabled={Boolean(restoredRun) || (!selected && requiresFixture) || !message.trim() || busy} onClick={() => void submit()}>Send turn</Button>
            </div>
            {turnError && <Alert tone="danger" title="Turn error">{turnError} {turn.error && <Button variant="ghost" size="sm" onClick={() => void turn.refetch()}>Retry status</Button>}</Alert>}
          </Card>
          <Card className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="m-0 text-lg font-bold">Turn events</h2>
              <Badge>{turn.data?.status ?? 'Ready'}</Badge>
            </div>
            {turn.data?.timing && (
              <div className="flex flex-wrap gap-1.5">
                <Badge tone="accent">{turn.data.invocationCount} CLI invocations</Badge>
                <Badge tone="accent">Model time {(turn.data.timing.totalModelMs / 1000).toFixed(1)}s</Badge>
                <Badge>Background: {turn.data.background.status}</Badge>
              </div>
            )}
            {turn.data?.classification && <p className="m-0 text-sm">Classification: {turn.data.classification.status} · {turn.data.classification.conceptIds.length} provisional tags</p>}
            <p className="m-0 text-xs text-ink-soft">Latest turn: request, lookup decision, injected context, CLI output and errors. These are recorded payloads, not private model reasoning.</p>
            <div className="flex h-[500px] flex-col gap-2 overflow-auto" data-testid="playground-events">
              {!turn.data?.events.length && <p className="m-0 text-ink-soft">No events yet. Send a turn to inspect the adapter.</p>}
              {turn.data?.events.map((event) => (
                <Card inset key={event.sequence}>
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-sm">{event.kind}</strong>
                    <span className="text-xs text-ink-soft">#{event.sequence} · {event.at}</span>
                  </div>
                  <pre className="m-0 mt-1 rounded-md bg-glass p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{JSON.stringify(event.payload, null, 2) ?? 'null'}</pre>
                </Card>
              ))}
            </div>
          </Card>
        </div>
      </main>
    </LearnerBackdrop>
  )
}
