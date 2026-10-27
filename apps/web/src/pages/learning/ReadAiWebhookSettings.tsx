import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { READAI_WEBHOOK_TEST_HEADER, READAI_WEBHOOK_TEST_PAYLOAD, ReadAiWebhookToken, ReceiveReadAiWebhookOutput, type ReadAiWebhookStatus } from '@learner/contract'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Field, Input } from '../../components/ui/input'
import { Spinner } from '../../components/ui/progress'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { dateTime, errorText } from './learning-model'

/**
 * The public address Read.ai posts to. Served from the API root the path is
 * /api/webhooks/readai/; under a prefix (/learner/ on the shared dev host)
 * nginx publishes machine routes under the sibling /learner-api/, never behind
 * the human sign-in gate, which Read.ai cannot pass.
 */
const base = import.meta.env.BASE_URL.replace(/\/$/, '')
export const webhookPath = base ? `${base}-api/webhooks/readai/` : '/api/webhooks/readai/'
const webhookUrl = (token: string) => `${window.location.origin}${webhookPath}${encodeURIComponent(token)}`

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const OUTCOME: Record<NonNullable<ReadAiWebhookStatus['lastDelivery']>['outcome'], string> = {
  'stored': 'stored', 'updated': 'updated', 'unchanged': 'already stored', 'duplicate': 'already delivered by another source',
  'not-stored': 'not stored (no speech)', 'test-ok': 'test passed',
}

/**
 * Settings > Integrations > Read AI webhook. The token is shown only while it
 * is in this form: the server keeps its hash, so a saved token cannot be read
 * back, only replaced. The test posts the fixture meeting to the public URL
 * through nginx, exactly as Read.ai would, and the server stores nothing.
 */
export function ReadAiWebhookSettings() {
  const queryClient = useQueryClient()
  const statusQuery = useRpcQuery('getReadAiWebhook', {})
  const saveToken = useRpcMutation('saveReadAiWebhook')
  const clearToken = useRpcMutation('clearReadAiWebhook')
  const [token, setToken] = useState('')
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [test, setTest] = useState<{ pending: boolean; result: string | null; error: string | null }>({ pending: false, result: null, error: null })
  const status = statusQuery.data
  // The token a test was sent with: a result for a token since edited or regenerated is dropped.
  const current = useRef(token)
  current.current = token
  const valid = ReadAiWebhookToken.safeParse(token).success

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['getReadAiWebhook'] })
  const edit = (value: string) => { setToken(value.trim()); setSaved(false); setCopied(false); setTest({ pending: false, result: null, error: null }) }
  const save = async () => {
    const result = await saveToken.mutateAsync({ token }).catch(() => null)
    if (!result) return
    queryClient.setQueryData(['getReadAiWebhook', {}], result)
    setSaved(true)
  }
  const remove = async () => {
    const result = await clearToken.mutateAsync({}).catch(() => null)
    if (!result) return
    queryClient.setQueryData(['getReadAiWebhook', {}], result)
    edit('')
  }
  const copy = async () => {
    await navigator.clipboard.writeText(webhookUrl(token)).then(() => setCopied(true), () => setCopied(false))
  }
  const sendTest = async () => {
    const sent = token
    const settle = (next: typeof test) => { if (current.current === sent) setTest(next) }
    setTest({ pending: true, result: null, error: null })
    try {
      const response = await fetch(webhookUrl(sent), {
        method: 'POST', headers: { 'content-type': 'application/json', [READAI_WEBHOOK_TEST_HEADER]: '1' }, body: JSON.stringify(READAI_WEBHOOK_TEST_PAYLOAD),
      })
      const body = await response.json().catch(() => null) as { message?: string } | null
      if (!response.ok) throw new Error(response.status === 401 ? 'The server does not know this token: save it first.' : `${response.status}: ${body?.message ?? response.statusText}`)
      const parsed = ReceiveReadAiWebhookOutput.safeParse(body)
      if (!parsed.success) throw new Error('The URL answered, but not as the Learner webhook (check the address).')
      settle({ pending: false, result: 'Test delivery accepted: the URL reaches the server and the token is valid.', error: null })
    } catch (error) {
      settle({ pending: false, result: null, error: errorText(error) })
    }
    await refresh()
  }
  const error = statusQuery.error ?? saveToken.error ?? clearToken.error

  return (
    <Card inset className="flex flex-col gap-3" data-testid="readai-webhook">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <strong className="block">Read AI webhook</strong>
          <p className="m-0 text-sm text-ink-soft">Read.ai sends each finished meeting to this server’s webhook URL; your lines are graded like any other call. The token in the URL is the only credential, so treat the URL as a password. The server keeps only a hash: a saved token cannot be shown again, only replaced.</p>
        </div>
        {status && (status.configured
          ? <Badge tone="success" data-testid="readai-webhook-state">Configured · token …{status.tokenHint}</Badge>
          : <Badge data-testid="readai-webhook-state">Not configured</Badge>)}
      </div>
      {statusQuery.isPending && <div className="flex items-center gap-2 text-sm"><Spinner />Loading…</div>}
      {error && <Alert tone="danger" title="Read AI webhook">{errorText(error)}</Alert>}

      <Field label="Webhook token">
        <div className="flex gap-2">
          <Input className="flex-1 font-mono" value={token} placeholder={status?.configured ? 'Enter the current token to test it, or a new one to replace it' : 'Generate one, or paste the token you already use'}
            spellCheck={false} autoComplete="off" onChange={(e) => edit(e.target.value)} data-testid="readai-webhook-token" />
          <Button size="sm" variant="secondary" onClick={() => edit(newToken())}>Generate</Button>
        </div>
      </Field>
      {token && !valid && <span className="text-xs text-rose-700 dark:text-rose-300">{ReadAiWebhookToken.safeParse(token).error?.issues[0]?.message}</span>}

      {valid && (
        <Field label="Webhook URL: paste this into Read.ai’s webhook settings">
          <div className="flex gap-2">
            <Input className="flex-1 font-mono" readOnly value={webhookUrl(token)} data-testid="readai-webhook-url" onFocus={(e) => e.currentTarget.select()} />
            <Button size="sm" variant="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </Field>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {saved && <Badge tone="success">Saved</Badge>}
        {test.result && <Badge tone="success" data-testid="readai-webhook-test-result">{test.result}</Badge>}
        {test.error && <Badge tone="danger" data-testid="readai-webhook-test-error">{test.error}</Badge>}
        {status?.configured && <Button size="sm" variant="secondary" disabled={clearToken.isPending} onClick={() => void remove()}>Remove</Button>}
        <Button size="sm" variant="secondary" disabled={!valid || test.pending} onClick={() => void sendTest()}>
          {test.pending && <Spinner className="size-3" />}Send test
        </Button>
        <Button size="sm" disabled={!valid || saved || saveToken.isPending} onClick={() => void save()}>
          {saveToken.isPending && <Spinner className="size-3" />}Save token
        </Button>
      </div>

      <div className="text-xs text-ink-soft" data-testid="readai-webhook-last-delivery">
        {status?.lastDelivery
          ? <>Last delivery {dateTime(status.lastDelivery.at)}{status.lastDelivery.test ? ' (test)' : ''}: “{status.lastDelivery.title ?? status.lastDelivery.sessionId}”, {status.lastDelivery.lines} line{status.lastDelivery.lines === 1 ? '' : 's'}, {OUTCOME[status.lastDelivery.outcome]}{!status.lastDelivery.test && !status.lastDelivery.graded ? ' · not graded' : ''}.</>
          : status?.configured ? 'No delivery since this token was saved.' : null}
      </div>
    </Card>
  )
}
