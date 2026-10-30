import type { RpcOutput } from '@learner/contract'
import { Badge } from '../../components/ui/badge'
import { Card, Eyebrow } from '../../components/ui/card'
import { useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'

type Progress = RpcOutput<'getMasteryProgress'>
type Baseline = RpcOutput<'getBaselineStatus'>

const pct = (value: number) => `${Number.isInteger(value) ? value : value.toFixed(1)}%`
const count = (n: number) => n.toLocaleString('en-US')

/** "83 of 1,155 concepts tracking · about 243 days at this pace", or "estimating your pace" until there is one. */
export function baselineLine(learning: Baseline['learning']) {
  const days = learning.daysLeft === null ? 'estimating your pace' : learning.daysLeft === 0 ? 'baseline reached' : `about ${count(learning.daysLeft)} days at this pace`
  return `${count(learning.have)} of ${count(learning.need)} concepts tracking · ${days}`
}

/**
 * The Osmosis Map's progress strip (docs/specs/mastery-notifications.md S5): the curriculum's
 * mean before → now for 24h / 7d / 30d, concepts up (gains only), reviews due, and the learning
 * baseline. Positive only: a lower "now" is shown as a number, never as a decline marker.
 */
export function MasteryProgressStripView({ progress, baseline, error }: { readonly progress?: Progress; readonly baseline?: Baseline; readonly error?: string }) {
  if (error) return <Card className="text-sm text-ink-soft" data-testid="mastery-progress">Progress unavailable: {error}</Card>
  if (!progress) return <Card className="text-sm text-ink-soft" data-testid="mastery-progress">Loading progress…</Card>
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="mastery-progress">
      {progress.windows.map((w) => (
        <div key={w.window} className="flex min-w-[120px] flex-col gap-1" data-testid={`mastery-window-${w.window}`}>
          <Eyebrow>{w.window}</Eyebrow>
          <span className="text-base font-semibold tabular-nums">{pct(w.beforePercent)} → {pct(w.nowPercent)}</span>
          {w.up > 0 ? <Badge tone="success" data-testid={`mastery-up-${w.window}`}>▲ {count(w.up)} up</Badge> : null}
        </div>
      ))}
      <div className="flex flex-col gap-1">
        <Eyebrow>Review</Eyebrow>
        <span className="text-base font-semibold tabular-nums" data-testid="mastery-due">{count(progress.due)} due for review</span>
      </div>
      {baseline ? (
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          <Eyebrow>Learning baseline</Eyebrow>
          <span className="text-sm text-ink-soft" data-testid="mastery-baseline">{baselineLine(baseline.learning)}</span>
        </div>
      ) : null}
    </Card>
  )
}

export function MasteryProgressStrip({ conceptIds }: { readonly conceptIds: string[] }) {
  const progress = useRpcQuery('getMasteryProgress', { conceptIds }, { enabled: conceptIds.length > 0, refetchInterval: 60_000 })
  const baseline = useRpcQuery('getBaselineStatus', {}, { refetchInterval: 300_000 })
  return <MasteryProgressStripView progress={progress.data} baseline={baseline.data} error={progress.error ? errorText(progress.error) : undefined} />
}
