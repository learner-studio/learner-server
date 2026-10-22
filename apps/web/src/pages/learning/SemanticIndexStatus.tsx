import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'

/** Coverage of the local conversation index, with the one action that moves it. */
export function SemanticIndexStatus() {
  const status = useRpcQuery('getLearningIndexStatus', {}, { refetchInterval: 5000 })
  const start = useRpcMutation('startLearningIndex')
  const s = status.data
  return (
    <Card inset data-testid="learning-index-status" className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><strong className="text-sm">Local conversation index</strong><Badge tone="warning">{s?.model ?? 'BGE local'}</Badge></div>
        <Button variant="secondary" size="sm" disabled={start.isPending || s?.runStatus === 'running'} onClick={() => start.mutate({}, { onSuccess: () => void status.refetch() })}>Sync archive</Button>
      </div>
      {status.isLoading && <p className="m-0 text-sm">Checking index…</p>}
      {s && <>
        <p className="m-0 text-sm">{s.indexedMessages} indexed messages · {s.indexedChunks} chunks · {s.pendingMessages} pending · {s.errorMessages} errors</p>
        <p className="m-0 text-xs text-ink-soft">{s.bank} · last indexed {s.latestIndexedAt ?? 'never'} · background sync {s.scheduleEnabled ? 'enabled' : 'gated'}</p>
        {s.limitations.map((item) => <p key={item} className="m-0 text-xs text-ink-soft">{item}</p>)}
      </>}
      {(status.error || start.error) && <Alert tone="danger">{errorText(status.error ?? start.error)} <Button variant="ghost" size="sm" onClick={() => void status.refetch()}>Retry status</Button></Alert>}
    </Card>
  )
}
