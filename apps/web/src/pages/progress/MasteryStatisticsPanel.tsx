import { GlassPanel } from '../../components/glass'
import { useRpcQuery } from '../../lib/api'
import { errorText } from '../learning/learning-model'
import { anchoredLine, changeLine, conceptsLine, efficacyLine, feedLine, noiseLine, powerLine, velocityLine } from './progress-statistics-model'

/** Signed mastery change with its interval, velocity, and the holdout efficacy line (docs/specs/mastery-change-statistics.md). */
export function MasteryStatisticsPanel() {
  const changes = useRpcQuery('getMasteryChanges', { sinceDays: null }, { refetchInterval: 300_000 })
  const holdout = useRpcQuery('getHoldoutEffect', {}, { refetchInterval: 300_000 })
  const velocity = changes.data ? velocityLine(changes.data) : null
  const power = holdout.data ? powerLine(holdout.data) : null
  const concepts = changes.data ? conceptsLine(changes.data) : null
  const anchored = changes.data ? anchoredLine(changes.data) : null
  return (
    <GlassPanel as="section" data-testid="mastery-statistics" className="flex flex-col gap-2 p-6.5">
      <h2 className="m-0 text-xl font-bold tracking-[-0.016em]">Mastery change</h2>
      <p className="m-0 text-[15px] font-semibold" data-testid="mastery-change-line">
        {changes.data ? changeLine(changes.data) : changes.error ? `Unavailable: ${errorText(changes.error)}` : 'Loading…'}
      </p>
      {velocity ? <p className="m-0 text-sm tabular-nums" data-testid="mastery-velocity-line">Velocity: {velocity}</p> : null}
      {concepts ? <p className="m-0 text-sm" data-testid="mastery-concepts-line">{concepts}</p> : null}
      {anchored ? <p className="m-0 text-[13px] text-ink-soft" data-testid="mastery-anchored-line">{anchored}</p> : null}
      {changes.data ? <p className="m-0 text-[13px] text-ink-soft" data-testid="mastery-noise-line">{noiseLine(changes.data)}</p> : null}
      {changes.data ? <p className="m-0 text-[13px] text-ink-soft" data-testid="mastery-feed-line">{feedLine(changes.data)}</p> : null}
      <p className="m-0 mt-2 text-sm" data-testid="mastery-efficacy-line">
        {holdout.data ? efficacyLine(holdout.data) : holdout.error ? `Holdout unavailable: ${errorText(holdout.error)}` : 'Loading holdout…'}
      </p>
      {power ? <p className="m-0 text-[13px] text-ink-soft" data-testid="mastery-power-line">{power}</p> : null}
    </GlassPanel>
  )
}
