import { useRef, useState } from 'react'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Field, Input, Select } from '../../components/ui/input'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'

const SETTLED = ['completed', 'partial', 'failed', 'cancelled']

/** The archive-wide assessment run: its latest receipt, and a form for a new (paid) one. */
export function VectorExperiment({ onUpdated }: { readonly onUpdated?: () => void }) {
  const [runId, setRunId] = useState<string>()
  const [selection, setSelection] = useState<'all' | 'latest' | 'relevant'>('relevant')
  const [latestTurns, setLatestTurns] = useState(50)
  const [threshold, setThreshold] = useState(0.65)
  const [maxInputTokens, setMaxInputTokens] = useState(400000)
  const [concurrency, setConcurrency] = useState(3)
  const requestId = useRef<string | null>(null)
  const experimentQuery = useRpcQuery('getLearningVectorExperiment', { runId }, {
    refetchInterval: (query) => query.state.data?.experiment && !SETTLED.includes(query.state.data.experiment.status) ? 3000 : false,
  })
  const start = useRpcMutation('startLearningVectorExperiment')
  const experiment = experimentQuery.data?.experiment
  const busy = start.isPending || Boolean(experiment && !SETTLED.includes(experiment.status))
  const submit = async () => {
    requestId.current ??= crypto.randomUUID()
    try {
      const result = await start.mutateAsync({ purpose: 'experiment', requestId: requestId.current, selection, latestTurns, threshold, maxInputTokens, concurrency, incremental: false })
      setRunId(result.runId); requestId.current = null; onUpdated?.()
    } catch { /* Preserve request identity so an uncertain submission is not repeated blindly. */ }
  }
  const number = (value: string) => Number(value)
  return (
    <Card inset data-testid="learning-vector-experiment" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><h4 className="m-0 text-base font-bold">Assessment from archive</h4><Badge variant="outline">dev1: vector+turns</Badge></div>
        <Badge tone="accent">{experiment?.status ?? (experimentQuery.isLoading ? 'Loading' : 'Not started')}</Badge>
      </div>
      <p className="m-0 text-xs">Vector-selected archived turns → review-only concept assessment. Curriculum estimates are calculated locally; unknown evidence is not zero or mastery.</p>
      {experiment && <>
        <p className="m-0 text-sm">{`${experiment.items.length} concepts · ${experiment.pending} pending · ${experiment.failed} failed · ${experiment.inputTokens} input / ${experiment.outputTokens} output tokens${experiment.unknownUsageCalls ? ` (known-only; ${experiment.unknownUsageCalls} calls have unknown usage)` : ''}`}</p>
        <p className="m-0 text-xs">{`Run ${experiment.runId} · ${experiment.counts?.turns ?? 0} paired turns · ${experiment.counts?.unpaired ?? 0} unpaired · ${experiment.durationMs === null ? 'Unknown duration' : `${(experiment.durationMs / 1000).toFixed(1)}s elapsed`}`}</p>
        <details><summary className="cursor-pointer text-xs">Recorded configuration, effective settings and execution changes</summary>
          <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-glass p-2 text-[11px]">{JSON.stringify({ effectiveConfig: experiment.config, metadata: experiment.metadata }, null, 2)}</pre>
        </details>
        <details><summary className="cursor-pointer text-xs">Per-concept selection and assessment progress</summary>
          <div className="mt-1 flex flex-col gap-1">{experiment.items.map((item) => <p key={item.conceptId} className="m-0 text-xs">{`${item.title} · ${item.status} · ${item.matchingChunks} matching chunks · ${item.matchingTurns} matching turns · ${item.turns} selected · ${item.batches} batches · ${item.exhaustive ? 'exhaustive selection' : 'bounded selection'}`}</p>)}</div>
        </details>
      </>}
      <details><summary className="cursor-pointer text-xs">Configure a new experiment (uses model calls)</summary>
        <div className="mt-2 flex flex-col gap-2">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <Field label="Turn selection"><Select value={selection} disabled={busy} options={['relevant', 'all', 'latest'].map((value) => ({ value, label: value }))} onChange={(event) => { const value = event.target.value; if (value === 'all' || value === 'latest' || value === 'relevant') setSelection(value) }} /></Field>
            <Field label="Turn limit"><Input type="number" value={latestTurns} min={1} max={100000} disabled={busy || selection === 'all'} onChange={(event) => setLatestTurns(number(event.target.value))} /></Field>
            <Field label="Vector threshold"><Input type="number" value={threshold} min={0} max={1} step={0.05} disabled={busy} onChange={(event) => setThreshold(number(event.target.value))} /></Field>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Maximum input tokens"><Input type="number" value={maxInputTokens} min={10000} max={400000} disabled={busy} onChange={(event) => setMaxInputTokens(number(event.target.value))} /></Field>
            <Field label="Concurrency"><Input type="number" value={concurrency} min={1} max={9} disabled={busy} onChange={(event) => setConcurrency(number(event.target.value))} /></Field>
          </div>
          <p className="m-0 text-xs text-ink-soft">New experiments default to concurrency 3. Changing this form does not alter an active experiment.</p>
          <Button size="md" disabled={busy} onClick={() => void submit()}>Re-assess from archive · paid model calls</Button>
        </div>
      </details>
      <div><Button variant="ghost" size="sm" onClick={() => { void experimentQuery.refetch(); onUpdated?.() }}>Refresh assessment</Button></div>
      {(experimentQuery.error || start.error) && <Alert tone="danger">{errorText(experimentQuery.error ?? start.error)}</Alert>}
    </Card>
  )
}
