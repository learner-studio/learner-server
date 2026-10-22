import { useState } from 'react'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Field, Select } from '../../components/ui/input'
import { Progress, Spinner } from '../../components/ui/progress'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { LEARNER_PLAYGROUND } from '../../lib/routes'
import { errorText, type ScopedAssessment } from './learning-model'

const IN_FLIGHT = ['queued', 'reserved']
const pollWhileRunning = (query: { state: { data?: { status: string } } }) => IN_FLIGHT.includes(query.state.data?.status ?? '') ? 1500 : false

/** The concept's provisional, source-backed understanding. Review only: it never writes mastery. */
export function ConceptAssessment({ conceptId, scoped, evidenceRuns }: { readonly conceptId: string; readonly scoped?: ScopedAssessment; readonly evidenceRuns?: readonly { part: number; runId: string }[] }) {
  const [requestedRun, setRequestedRun] = useState<string | null>(null)
  const state = useRpcQuery('getLearningConceptAssessment', { conceptId }, { enabled: !scoped, refetchInterval: scoped ? false : 3000 })
  const displayed = scoped ?? state.data
  const start = useRpcMutation('startLearningConceptAssessment')
  const [evidenceRunId, setEvidenceRunId] = useState<string | null>(null)
  const runId = evidenceRunId ?? displayed?.runId
  const requested = useRpcQuery('getLearningAssessmentRun', { runId: requestedRun ?? '' }, { enabled: Boolean(requestedRun), refetchInterval: pollWhileRunning })
  const run = useRpcQuery('getLearningAssessmentRun', { runId: runId ?? '' }, { enabled: Boolean(runId), refetchInterval: pollWhileRunning })
  const assessment = displayed?.assessment
  const pending = start.isPending || IN_FLIGHT.includes(requested.data?.status ?? '')
  const refresh = async () => {
    try {
      const result = await start.mutateAsync({ conceptId, requestId: crypto.randomUUID() })
      setRequestedRun(result.runId)
      void state.refetch()
    } catch { /* Preserve the current assessment; display the request error. */ }
  }
  const error = (!scoped && state.error) || start.error || run.error || requested.error
  return (
    <section className="mt-4 flex flex-col gap-2.5" data-testid="learning-concept-assessment" data-status={displayed?.status ?? 'loading'}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="m-0 text-base font-bold">Provisional understanding</h4>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="warning">{scoped ? 'dev1 · review only' : 'Review only · not measured mastery'}</Badge>
          {!scoped && <Button size="sm" disabled={pending} onClick={() => void refresh()}>{pending && <Spinner className="size-3" />}Refresh assessment</Button>}
          <a className="rounded-md px-2 py-0.5 text-xs font-semibold text-accent hover:bg-glass" href={`${LEARNER_PLAYGROUND}?concept=${encodeURIComponent(conceptId)}`}>Practice</a>
        </div>
      </div>
      {!scoped && state.isLoading && <p className="m-0 text-sm">Loading assessment…</p>}
      {error && <Alert tone="danger">{errorText(error)}</Alert>}
      {(scoped || !state.isLoading) && !assessment && <p className="m-0 text-sm text-ink-soft">Unknown — no source-backed assessment yet. This is not a zero score.</p>}
      {assessment && <>
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm">{assessment.understandingPercent === null ? 'Unknown' : `${assessment.understandingPercent}% provisional understanding`}</strong>
          <Badge>{assessment.confidence} confidence</Badge>
          <span className="text-xs text-ink-soft">{displayed?.status} · {displayed?.assessedAt ?? ''}</span>
        </div>
        {assessment.understandingPercent !== null && <Progress value={assessment.understandingPercent} tone="warning" aria-label="Provisional understanding" />}
        {assessment.demonstrated.map((item, index) => (
          <Card inset key={index}>
            <p className="m-0 text-sm font-semibold">{item.description}</p>
            <p className="m-0 text-sm">{item.quote}</p>
            <p className="m-0 text-xs text-ink-soft">{item.sourceId}</p>
          </Card>
        ))}
        {assessment.gaps.map((item, index) => <p key={index} className="m-0 text-sm">{item.kind}: {item.description}</p>)}
        <p className="m-0 text-sm">Next check: {assessment.nextCheck}</p>
      </>}
      {evidenceRuns && evidenceRuns.length > 1 && runId && (
        <Field label="Evidence batch receipt">
          <Select value={runId} onChange={(event) => setEvidenceRunId(event.target.value)} options={evidenceRuns.map((item) => ({ value: item.runId, label: `Batch ${item.part + 1} · ${item.runId}` }))} />
        </Field>
      )}
      {run.data && <p className={`m-0 text-xs ${run.data.receipt?.error ? 'text-rose-600 dark:text-rose-400' : 'text-ink-soft'}`}>Run {run.data.status} · {run.data.runId}{run.data.receipt ? ` · ${(run.data.receipt.durationMs / 1000).toFixed(1)}s · ${run.data.receipt.outputTokens ?? 'unknown'} output tokens` : ''}{run.data.receipt?.error ? ` · ${run.data.receipt.error}` : ''}</p>}
      {requested.data && requested.data.runId !== runId && <p className={`m-0 text-xs ${requested.data.receipt?.error ? 'text-rose-600 dark:text-rose-400' : 'text-ink-soft'}`}>Refresh {requested.data.status} · {requested.data.runId}{requested.data.receipt?.error ? ` · ${requested.data.receipt.error}` : ''}</p>}
      {run.data?.provenance && <p className="m-0 text-xs text-ink-soft" data-testid="assessment-evidence-counts">{`${run.data.provenance.completeTurns} complete linked turns · ${run.data.provenance.unpairedGroups} unpaired groups · ${run.data.provenance.unknownGroups} groups with unknown linkage · ${run.data.evidence.length} source messages${run.data.provenance.experimentId ? ` · Vector run ${run.data.provenance.experimentId}` : ''} · ${run.data.provenance.selectionRevision ?? 'historical selection'}`}</p>}
    </section>
  )
}
