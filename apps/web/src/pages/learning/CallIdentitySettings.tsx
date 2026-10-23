import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { UNKNOWN_SPEAKER, type CallIdentity, type CallNeedingAttribution } from '@learner/contract'
import { Alert } from '../../components/ui/alert'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Field, Input } from '../../components/ui/input'
import { Spinner } from '../../components/ui/progress'
import { useRpcMutation, useRpcQuery } from '../../lib/api'
import { dateTime, errorText } from './learning-model'

const list = (text: string): string[] => text.split(',').map((s) => s.trim()).filter(Boolean)
const asText = (identity: CallIdentity) => ({ names: identity.names.join(', '), emails: identity.emails.join(', ') })

/**
 * Who the learner is on meeting calls, and the calls where no speaker is theirs by name.
 * Saving the identity or settling a call re-attributes the stored calls on the server
 * and grades any lines it recovers.
 */
export function CallIdentitySettings() {
  const queryClient = useQueryClient()
  const identityQuery = useRpcQuery('getCallIdentity', {})
  const callsQuery = useRpcQuery('listCallsNeedingAttribution', {})
  const saveIdentity = useRpcMutation('saveCallIdentity')
  const claim = useRpcMutation('claimCallSpeakers')
  const [draft, setDraft] = useState<{ names: string; emails: string } | null>(null)
  const [outcome, setOutcome] = useState<string | null>(null)
  const shown = draft ?? (identityQuery.data ? asText(identityQuery.data) : null)
  const changed = Boolean(draft && identityQuery.data && JSON.stringify(draft) !== JSON.stringify(asText(identityQuery.data)))

  const refresh = async (reattributed: number) => {
    setOutcome(`Re-attributed ${reattributed} call${reattributed === 1 ? '' : 's'}`)
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['getCallIdentity'] }), queryClient.invalidateQueries({ queryKey: ['listCallsNeedingAttribution'] })])
  }
  const save = async () => {
    if (!shown) return
    const saved = await saveIdentity.mutateAsync({ names: list(shown.names), emails: list(shown.emails) }).catch(() => null)
    if (!saved) return
    setDraft(null)
    await refresh(saved.reattributed)
  }
  const settle = async (call: CallNeedingAttribution, speakers: string[], remember: boolean) => {
    const result = await claim.mutateAsync({ sessionId: call.sessionId, speakers, remember }).catch(() => null)
    if (result) await refresh(result.reattributed)
  }
  const error = identityQuery.error ?? callsQuery.error ?? saveIdentity.error ?? claim.error

  return (
    <Card inset className="flex flex-col gap-3" data-testid="learning-call-identity">
      <div>
        <strong className="block">You on calls</strong>
        <p className="m-0 text-sm text-ink-soft">A meeting line is yours when its speaker is one of these names; you were on the call when a participant matches a name or an email. Separate entries with commas.</p>
      </div>
      {shown && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label="Speaker names"><Input value={shown.names} placeholder="Ben Pollack" onChange={(e) => setDraft({ ...shown, names: e.target.value })} /></Field>
          <Field label="Emails"><Input value={shown.emails} placeholder="you@company.com" onChange={(e) => setDraft({ ...shown, emails: e.target.value })} /></Field>
        </div>
      )}
      {error && <Alert tone="danger" title="Call identity">{errorText(error)}</Alert>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {outcome && <Badge tone="success" data-testid="learning-call-outcome">{outcome}</Badge>}
        {changed && <Badge tone="warning">Unsaved changes</Badge>}
        <Button size="sm" disabled={!changed || saveIdentity.isPending} onClick={() => void save()}>
          {saveIdentity.isPending && <Spinner className="size-3" />}Save and re-attribute
        </Button>
      </div>

      <div className="flex flex-col gap-2" data-testid="learning-calls-needing-attribution">
        <strong className="text-sm">Calls to settle</strong>
        {callsQuery.data && callsQuery.data.calls.length === 0 && <p className="m-0 text-sm text-ink-soft">None: every call you were on has your lines by name, or you settled it.</p>}
        {callsQuery.data?.calls.map((call) => (
          <Card key={call.sessionId} className="flex flex-col gap-2 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><strong>{call.title || call.sessionId}</strong> <span className="text-xs text-ink-soft">{call.eventTime && dateTime(call.eventTime)} · {call.source}</span></span>
              {call.attribution === 'inferred'
                ? <Badge tone="accent">Inferred: graded, please confirm</Badge>
                : <Badge tone="warning">You were there, but which speaker? Not graded</Badge>}
            </div>
            <span className="text-xs text-ink-soft">Participants: {call.participants.join(', ')}</span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {call.speakers.map((s) => (
                <li key={s.label} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 flex-1"><strong>{s.label}</strong>{s.learner && <Badge className="ml-1">inferred you</Badge>} <span className="text-ink-soft">· {s.lines} line{s.lines === 1 ? '' : 's'} · “{s.sample}”</span></span>
                  <span className="flex gap-1">
                    <Button size="sm" variant="secondary" disabled={claim.isPending} onClick={() => void settle(call, [s.label], false)}>This is me</Button>
                    {s.label !== UNKNOWN_SPEAKER && <Button size="sm" variant="secondary" disabled={claim.isPending} onClick={() => void settle(call, [s.label], true)}>Always me</Button>}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end">
              <Button size="sm" variant="secondary" disabled={claim.isPending} onClick={() => void settle(call, [], false)}>I didn’t speak</Button>
            </div>
          </Card>
        ))}
      </div>
    </Card>
  )
}
