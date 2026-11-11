import type { RpcOutput } from '@learner/contract'
import { Alert } from '../../components/ui/alert'
import { useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'

type Health = RpcOutput<'getLearningGradingHealth'>

/** Silent while reactive grading moves or is idle; loud when work has waited past the stall bound with nothing completing. */
export function LearningGradingHealthAlert({ health, error }: { readonly health?: Health; readonly error?: string }) {
  if (error) return <Alert tone="warning" title="Grading health unavailable" data-testid="learning-grading-health">{error}</Alert>
  if (!health || health.status === 'ok') return null
  return (
    <Alert tone={health.status === 'error' ? 'danger' : 'warning'} data-testid="learning-grading-health"
      title={health.status === 'error' ? 'Reactive grading has stalled' : 'Reactive grading needs attention'}>
      <p className="m-0 mb-1">Last reading {health.grading.lastReadingAt ?? 'never'}; last routed batch {health.routing.lastRoutedAt ?? 'never'}.</p>
      <ul className="m-0 list-disc pl-5">{health.messages.map((message) => <li key={message}>{message}</li>)}</ul>
    </Alert>
  )
}

export function LearningGradingHealth() {
  const query = useRpcQuery('getLearningGradingHealth', {}, { refetchInterval: 60_000 })
  return <LearningGradingHealthAlert health={query.data} error={query.error ? errorText(query.error) : undefined} />
}
