import type { RpcOutput } from '@learner/contract'
import { Alert } from '../../components/ui/alert'
import { useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'

type Health = RpcOutput<'getLearningHookHealth'>

/** Silent when every CLI session's hook is live; loud when a prompt went unrecorded or the hook reported a failure. */
export function LearningHookHealthAlert({ health, error }: { readonly health?: Health; readonly error?: string }) {
  if (error) return <Alert tone="warning" title="Learning hook health unavailable" data-testid="learning-hook-health">{error}</Alert>
  if (!health || health.status === 'ok') return null
  const live = health.sessions.filter((session) => session.state === 'live').length
  return (
    <Alert tone={health.status === 'error' ? 'danger' : 'warning'} data-testid="learning-hook-health" title={health.status === 'error' ? 'Learning hook is failing' : 'Learning hook warning'}>
      <p className="m-0 mb-1">{live} of {health.sessions.length} CLI sessions live in the last {health.windowMinutes} min.</p>
      <ul className="m-0 list-disc pl-5">{health.messages.map((message) => <li key={message}>{message}</li>)}</ul>
    </Alert>
  )
}

export function LearningHookHealth() {
  const query = useRpcQuery('getLearningHookHealth', { windowMinutes: 30 }, { refetchInterval: 30_000 })
  return <LearningHookHealthAlert health={query.data} error={query.error ? errorText(query.error) : undefined} />
}
