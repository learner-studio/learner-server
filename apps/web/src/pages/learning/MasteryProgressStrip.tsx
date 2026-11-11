import type { RpcOutput } from '@learner/contract'
import { Card, Eyebrow } from '../../components/ui/card'
import { useRpcQuery } from '../../lib/api'
import { errorText } from './learning-model'
import { Link } from 'react-router-dom'
import { LEARNER_PROGRESS } from '../../lib/routes'
import { PROGRESS_LINK_TEXT, firstClearText, gainText, priorBlindText, sharedPriorBlindText, showsGain, stripScoresLabel } from './mastery-progress-strip-model'

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
 * mean LIVE score before → now for 24h / 7d / 30d, labelled as the live grader's (it rises on its own,
 * review round 3 B2) with a link to the Progress page, prior-blind rises beyond noise out of those compared
 * (the only ▲, withheld while the grader's drift is unmeasured) or the prior-blind "no verdict yet" / "no rise"
 * line (once for the strip when every window says the same), first clear readings (live grader, no ▲), reviews
 * due, and the learning baseline. Positive only: a lower "now" is a number, never a decline marker.
 */
export function MasteryProgressStripView({ progress, baseline, error, baselineError, empty }: { readonly progress?: Progress; readonly baseline?: Baseline; readonly error?: string; readonly baselineError?: string; readonly empty?: boolean }) {
  if (error) return <Card className="text-sm text-ink-soft" data-testid="mastery-progress">Progress unavailable: {error}</Card>
  if (empty) return <Card className="text-sm text-ink-soft" data-testid="mastery-progress">This curriculum has no concepts yet.</Card>
  if (!progress) return <Card className="text-sm text-ink-soft" data-testid="mastery-progress">Loading progress…</Card>
  // The server's drift-aware gain rule withholds every ▲ while the grader's drift is unmeasured (strip review B1).
  const withheld = progress.gainsWithheldForDrift
  const shared = sharedPriorBlindText(progress.windows, withheld)
  return (
    <Card className="flex flex-wrap items-center gap-x-6 gap-y-3" data-testid="mastery-progress">
      <p className="w-full text-xs text-ink-soft">
        <span data-testid="mastery-scores-label">{stripScoresLabel(progress)}</span>{' '}
        <Link to={LEARNER_PROGRESS} className="font-semibold text-accent hover:underline" data-testid="mastery-progress-link">{PROGRESS_LINK_TEXT}</Link>
      </p>
      {shared ? <p className="w-full text-xs text-ink-soft" data-testid="mastery-prior-blind-all">{progress.windows.map((w) => w.window).join(' · ')}: {shared}</p> : null}
      {progress.windows.map((w) => {
        const blind = shared ? null : priorBlindText(w, withheld)
        return (
          <div key={w.window} className="flex min-w-[120px] max-w-[220px] flex-col gap-1" data-testid={`mastery-window-${w.window}`}>
            <Eyebrow>{w.window}</Eyebrow>
            {/* The live figures carry no colour, sign or marker: they rise on their own (B2, strip review S3). */}
            <span className="text-base font-semibold tabular-nums" data-testid={`mastery-live-${w.window}`}>{pct(w.beforePercent)} → {pct(w.nowPercent)}</span>
            {showsGain(w, withheld)
              ? <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300" data-testid={`mastery-up-${w.window}`}><span aria-hidden="true">▲ </span>{gainText(w.up, w.compared)}</span>
              : null}
            {blind ? <span className="text-xs text-ink-soft" data-testid={`mastery-prior-blind-${w.window}`}>{blind}</span> : null}
            {w.firstClear > 0 ? <span className="text-xs text-ink-soft" data-testid={`mastery-first-clear-${w.window}`}>{firstClearText(w.firstClear)}</span> : null}
          </div>
        )
      })}
      <div className="flex flex-col gap-1">
        <Eyebrow>Review</Eyebrow>
        <span className="text-base font-semibold tabular-nums" data-testid="mastery-due">{count(progress.due)} due for review</span>
      </div>
      {baseline || baselineError ? (
        <div className="flex min-w-[220px] flex-1 flex-col gap-1">
          {/* The baseline spans every curriculum the learner was exposed to, not just this one. */}
          <Eyebrow>Learning baseline · all curricula</Eyebrow>
          <span className="text-sm text-ink-soft" data-testid="mastery-baseline">{baseline ? baselineLine(baseline.learning) : `unavailable: ${baselineError}`}</span>
        </div>
      ) : null}
    </Card>
  )
}

export function MasteryProgressStrip({ conceptIds }: { readonly conceptIds: string[] }) {
  const progress = useRpcQuery('getMasteryProgress', { conceptIds }, { enabled: conceptIds.length > 0, refetchInterval: 60_000 })
  const baseline = useRpcQuery('getBaselineStatus', {}, { refetchInterval: 300_000 })
  return <MasteryProgressStripView progress={progress.data} baseline={baseline.data} empty={conceptIds.length === 0}
    error={progress.error ? errorText(progress.error) : undefined} baselineError={baseline.error ? errorText(baseline.error) : undefined} />
}
