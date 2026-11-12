import { useState } from 'react'
import { PairDesktopInput, type RpcOutput } from '@learner/contract'
import { Alert } from '../../components/ui/alert'
import { Button } from '../../components/ui/button'
import { Card } from '../../components/ui/card'
import { Field, Input } from '../../components/ui/input'
import { Spinner } from '../../components/ui/progress'
import { useRpcMutation } from '../../lib/api'
import { errorText } from './learning-model'

/**
 * Settings > Integrations > Pair a desktop (docs/specs/server-desktop-pairing.md, round 2).
 * One click mints a device key and shows it as a one-paste pairing code and a
 * learner-desktop:// link. The code IS the key: it lives only in this card's state, the
 * server keeps a hash, and closing the dialog forgets it.
 */
export function PairDesktopSettings() {
  const pair = useRpcMutation('pairDesktop')
  const [clientId, setClientId] = useState('')
  const [issued, setIssued] = useState<RpcOutput<'pairDesktop'> | null>(null)
  const [copied, setCopied] = useState(false)
  const parsed = PairDesktopInput.safeParse({ clientId })
  const issue = async () => {
    setCopied(false)
    setIssued(await pair.mutateAsync({ clientId }).catch(() => null))
  }
  const copy = () => issued && navigator.clipboard.writeText(issued.pairingCode).then(() => setCopied(true), () => setCopied(false))

  return (
    <Card inset className="flex flex-col gap-3" data-testid="pair-desktop">
      <div>
        <strong className="block">Pair a desktop</strong>
        <p className="m-0 text-sm text-ink-soft">Makes a key for one Mac running Learner Desktop. Open the link on that Mac, or paste the code into the app. The code is a password: it is shown once.</p>
      </div>
      <Field label="Device name">
        <div className="flex gap-2">
          <Input className="flex-1 font-mono" value={clientId} placeholder="e.g. ben-mbp" spellCheck={false} autoComplete="off"
            onChange={(e) => { setClientId(e.target.value.trim().toLowerCase()); setIssued(null) }} data-testid="pair-desktop-client-id" />
          <Button size="sm" disabled={!parsed.success || pair.isPending} onClick={() => void issue()}>
            {pair.isPending && <Spinner className="size-3" />}Create pairing code
          </Button>
        </div>
      </Field>
      {clientId && !parsed.success && <span className="text-xs text-rose-700 dark:text-rose-300">{parsed.error.issues[0]?.message}</span>}
      {pair.error && <Alert tone="danger" title="Pair a desktop">{errorText(pair.error)}</Alert>}
      {issued && (<>
        <Field label="Pairing code">
          <div className="flex gap-2">
            <Input className="flex-1 font-mono" readOnly value={issued.pairingCode} onFocus={(e) => e.currentTarget.select()} data-testid="pair-desktop-code" />
            <Button size="sm" variant="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</Button>
          </div>
        </Field>
        <a className="text-sm underline" href={`learner-desktop://pair?code=${encodeURIComponent(issued.pairingCode)}`} data-testid="pair-desktop-link">Open in Learner Desktop</a>
      </>)}
    </Card>
  )
}
