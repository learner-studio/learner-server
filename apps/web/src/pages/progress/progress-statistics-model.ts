import type { RpcOutput } from '@learner/contract'

type Changes = RpcOutput<'getMasteryChanges'>
type Holdout = RpcOutput<'getHoldoutEffect'>
type Estimate = Holdout['estimate']

/**
 * The Progress page's honest lines (docs/specs/mastery-change-statistics.md). Signed, declines
 * included, always with the 95 % interval. Verdicts rest on PRIOR-BLIND measurements only and say
 * what the statistic shows, not more (review S1): readings that moved beyond grader noise are not
 * proof of learning, and a decline in one grader's readings is not proof of forgetting. The live
 * scores are described beside them with the grader's own drift, never with a verdict (review B2).
 */

const count = (n: number) => n.toLocaleString('en-US')
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(1)}`
const range = (i: { low: number; high: number }) => `95% ${signed(i.low)} to ${signed(i.high)}`
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`
const pct = (v: number | null) => (v === null ? '?' : `${(v * 100).toFixed(v < 0.01 && v > 0 ? 1 : 0)}%`)

export const VERDICT_ROSE = 'readings rose beyond grader noise (not proof of learning: regression to the mean and which concepts get read can do this)'
export const VERDICT_FELL = 'readings fell beyond grader noise (one grader’s readings can fall with no change in understanding)'
export const VERDICT_NONE = 'not distinguishable from no change'

const verdict = (i: { low: number; high: number }) => (i.low > 0 ? VERDICT_ROSE : i.high < 0 ? VERDICT_FELL : VERDICT_NONE)

/** "+3.1 points (95% +1.2 to +5.0) across 87 concepts measured twice by the prior-blind grader: readings rose …". */
export function changeLine(changes: Changes): string {
  const a = changes.aggregate
  const measured = 'measured twice without the previous score'
  if (a.meanChange === null) return `No concept is ${measured} yet, so there is no change to report.`
  const across = `across ${plural(a.nConcepts, 'concept')} ${measured}`
  if (!a.changeInterval) return `${signed(a.meanChange)} points ${across}: not enough data for an interval (${count(a.minimumConcepts)} concepts needed).`
  return `${signed(a.meanChange)} points (${range(a.changeInterval)}) ${across}: ${verdict(a.changeInterval)}.`
}

/** "+0.3 points per week (95% −0.5 to +1.1)", null when there is no slope. */
export function velocityLine(changes: Changes): string | null {
  const a = changes.aggregate
  if (a.meanSlopePerWeek === null) return null
  return `${signed(a.meanSlopePerWeek)} points per week${a.slopeInterval ? ` (${range(a.slopeInterval)})` : ''}`
}

/** Per-concept flags with their multiplicity: "2 concepts beyond noise after correcting for 87 tests (5 one at a time; about 4 expected by chance)". */
export function conceptsLine(changes: Changes): string | null {
  const a = changes.aggregate
  if (!a.nConcepts) return null
  return `${plural(a.nBeyondNoise, 'concept')} beyond noise after correcting for ${count(a.nConcepts)} tests (${count(a.nBeyondNoiseUnadjusted)} one at a time; about ${a.expectedBeyondNoiseByChance.toFixed(0)} expected by chance).`
}

/** The live scores, described with what the grader alone does to them. */
export function anchoredLine(changes: Changes): string | null {
  const a = changes.anchored, d = changes.noise.drift
  if (a.meanChange === null) return null
  const gradings = a.meanGradingsBetween === null ? '' : ` over ${a.meanGradingsBetween.toFixed(1)} gradings on average`
  const drift = d.meanMove === null ? '' : `; the grader alone raises a score about ${signed(d.meanMove)} points per grading${a.expectedFromDrift === null ? '' : ` (${signed(a.expectedFromDrift)} here)`}`
  return `Your scores (each grading starts from the previous score) moved ${signed(a.meanChange)} points across ${plural(a.nConcepts, 'concept')}${gradings}${drift}, so they are not evidence of learning.`
}

/** The grader's own noise and drift, so a reader can weigh the numbers. N1: a single grading lives on the 5-point grid, so its threshold is shown rounded up to it. */
export function noiseLine(changes: Changes): string {
  const n = changes.noise
  const source = n.blindSource === 'measured' ? `measured from ${count(n.blindDf)} regrade degrees of freedom` : 'fallback, not enough regrades measured'
  const onGrid = Math.ceil(changes.gainThreshold / 5) * 5
  const drift = n.drift.gradings ? ` Live gradings keep the previous score ${pct(n.drift.equal)} of the time, raise it ${pct(n.drift.up)}, lower it ${pct(n.drift.down)}.` : ''
  return `Prior-blind grader noise sd ${n.blindSd.toFixed(1)} points (${source}); one blind grading must rise ${onGrid}+ points over one earlier to count as a gain.${drift}`
}

/**
 * Why the notification feed is (or is not) quiet (review S10): a toast needs a cited message at most
 * `recencyDays` older than the reading going live, so a grader working through a backlog silences it
 * whatever the learner does. Says so, with the lag, rather than leaving the silence to be read as
 * "nothing improved".
 */
export function feedLine(changes: Changes): string {
  const f = changes.feed
  const graded = `graded in the last ${plural(f.windowDays, 'day')}`
  if (!f.citedReadings) return `Notifications: no reading citing your messages was ${graded}, so there was nothing to announce.`
  const head = `Notifications: ${count(f.news)} of ${plural(f.citedReadings, 'reading')} citing your messages ${graded} could be announced; ${count(f.withinRecency)} cited a message from within ${plural(f.recencyDays, 'day')} of grading.`
  const lag = f.medianLagDays === null ? null : Math.round(f.medianLagDays)
  return lag !== null && lag > f.recencyDays
    ? `${head} Grading is running about ${plural(lag, 'day')} behind your messages, so the feed stays quiet until it catches up: this says nothing about your learning.`
    : head
}

const armsText = (e: Estimate) => `n = ${count(e.measuredTwice.taught)} taught, ${count(e.measuredTwice.heldOut)} held out`
const gradingsText = (e: Estimate) => (e.gradingsBetween.taught === null || e.gradingsBetween.heldOut === null ? '' : `; gradings between: taught ${e.gradingsBetween.taught.toFixed(1)}, held out ${e.gradingsBetween.heldOut.toFixed(1)}`)

/**
 * The holdout's line. The headline is the probe estimate (prior-blind answers to blind probes reach
 * both arms alike); only it may say taught concepts scored higher or lower. The opportunistic
 * estimate is shown with its opportunity gap and no verdict.
 */
export function efficacyLine(holdout: Holdout): string {
  const p = holdout.probe, e = holdout.estimate
  const baseline = (x: Estimate, what: string) => `${what}: setting baseline: ${count(x.measuredTwice.heldOut)} of ${count(x.minimumPerArm)} held-out concepts measured twice (taught: ${count(x.measuredTwice.taught)} of ${count(x.minimumPerArm)})`
  const headline = !p
    ? 'Teaching vs holdout (equal-opportunity probes): no probe answered yet'
    : p.state === 'setting_baseline'
      ? baseline(p, 'Teaching vs holdout (equal-opportunity probes)')
      : `Teaching vs holdout (equal-opportunity probes): ${signed(p.effect ?? 0)} points${p.interval ? ` (${range(p.interval)})` : ''}, adjusted for baseline, ${armsText(p)}: ${p.interval ? (p.interval.low > 0 ? 'taught concepts scored higher on probes beyond grader noise' : p.interval.high < 0 ? 'taught concepts scored lower on probes beyond grader noise' : VERDICT_NONE) : 'no interval yet'}`
  const opportunistic = e.state === 'setting_baseline'
    ? baseline(e, 'All readings')
    : `All readings: ${signed(e.effect ?? 0)} points${e.interval ? ` (${range(e.interval)})` : ''}, ${armsText(e)}${gradingsText(e)}; not a verdict: taught concepts get read more often`
  return `${headline}. ${opportunistic}.`
}

/** "Detectable now: 9.8 points at 80% power; 412 more concepts measured twice to detect 5 (about 30 weeks at the current pace)." */
export function powerLine(holdout: Holdout): string | null {
  const p = (holdout.probe ?? holdout.estimate).power
  if (p.minimumDetectableEffect === null && p.conceptsStillNeeded === null) return null
  const mde = p.minimumDetectableEffect === null ? 'not yet estimable' : `${p.minimumDetectableEffect.toFixed(1)} points`
  const pace = p.weeksToTarget === null ? ' (no concept was measured twice in the last four weeks)' : ` (about ${plural(p.weeksToTarget, 'week')} at the current pace)`
  const need = p.conceptsStillNeeded === null ? '' : p.conceptsStillNeeded === 0
    ? `; enough concepts to detect ${p.targetEffect}`
    : `; ${count(p.conceptsStillNeeded)} more concepts measured twice to detect ${p.targetEffect}${pace}`
  return `Smallest effect detectable today at 80% power: ${mde}${need}.`
}
