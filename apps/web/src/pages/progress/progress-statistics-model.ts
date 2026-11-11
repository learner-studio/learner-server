import type { RpcOutput } from '@learner/contract'

type Changes = RpcOutput<'getMasteryChanges'>
type Holdout = RpcOutput<'getHoldoutEffect'>

/**
 * The Progress page's honest lines (docs/specs/mastery-change-statistics.md). Signed, declines
 * included, always with the 95 % interval, and saying "not yet distinguishable" when it spans zero.
 */

const count = (n: number) => n.toLocaleString('en-US')
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`
const range = (i: { low: number; high: number }) => `95% ${signed(i.low)} to ${signed(i.high)}`
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`

const verdict = (i: { low: number; high: number }) =>
  i.low > 0 ? 'a real gain' : i.high < 0 ? 'a real decline' : 'not yet distinguishable from no change'

/** "+0.6 points (95% −2.7 to +3.9) across 87 concepts: not yet distinguishable from no change". */
export function changeLine(changes: Changes): string {
  const a = changes.aggregate
  if (a.meanChange === null) return 'No concept has two counted readings yet, so there is no change to report.'
  const across = `across ${plural(a.nConcepts, 'concept')} measured twice`
  if (!a.changeInterval) return `${signed(a.meanChange)} points ${across}: too few concepts for an interval yet.`
  return `${signed(a.meanChange)} points (${range(a.changeInterval)}) ${across}: ${verdict(a.changeInterval)}.`
}

/** "+0.3 points per week (95% −0.5 to +1.1)", null when there is no slope. */
export function velocityLine(changes: Changes): string | null {
  const a = changes.aggregate
  if (a.meanSlopePerWeek === null) return null
  return `${signed(a.meanSlopePerWeek)} points per week${a.slopeInterval ? ` (${range(a.slopeInterval)})` : ''}`
}

/** The grader's own noise, so a reader can weigh the numbers. */
export function noiseLine(changes: Changes): string {
  const source = changes.graderNoiseSource === 'measured' ? `measured from ${count(changes.graderNoiseDf)} regrade degrees of freedom` : 'fallback, not enough regrades measured'
  return `Grader noise sd ${changes.graderSd.toFixed(1)} points (${source}); a single reading must rise ${changes.gainThreshold.toFixed(0)}+ points to count as a gain.`
}

/** The holdout's one line: baseline progress, or the adjusted effect with its interval. */
export function efficacyLine(holdout: Holdout): string {
  const e = holdout.estimate
  if (e.state === 'setting_baseline')
    return `Teaching vs holdout: setting baseline: ${count(e.measuredTwice.heldOut)} of ${count(e.minimumPerArm)} held-out concepts measured twice (taught: ${count(e.measuredTwice.taught)} of ${count(e.minimumPerArm)}).`
  const n = `n = ${count(e.measuredTwice.taught)} taught, ${count(e.measuredTwice.heldOut)} held out`
  return `Teaching vs holdout: ${signed(e.effect ?? 0)} points${e.interval ? ` (${range(e.interval)})` : ''}, adjusted for baseline, ${n}: ${e.interval ? verdict(e.interval).replace('a real gain', 'teaching helps').replace('a real decline', 'teaching hurts') : 'no interval yet'}.`
}

/** "Detectable now: 9.8 points at 80% power; 412 more concepts measured twice to detect 5." */
export function powerLine(holdout: Holdout): string | null {
  const p = holdout.estimate.power
  if (p.minimumDetectableEffect === null && p.conceptsStillNeeded === null) return null
  const mde = p.minimumDetectableEffect === null ? 'not yet estimable' : `${p.minimumDetectableEffect.toFixed(1)} points`
  const need = p.conceptsStillNeeded === null ? '' : p.conceptsStillNeeded === 0
    ? `; enough concepts to detect ${p.targetEffect}`
    : `; ${count(p.conceptsStillNeeded)} more concepts measured twice to detect ${p.targetEffect}`
  return `Smallest effect detectable today at 80% power: ${mde}${need}.`
}
