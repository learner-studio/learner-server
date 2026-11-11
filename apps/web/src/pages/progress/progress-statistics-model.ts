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
  // Review round 2, S-b: a verdict must also clear what the grader's own drift could do over the span.
  const head = `${signed(a.meanChange)} points (${range(a.changeInterval)}) ${across}`
  const d = a.drift
  // Review round 3, N1: a withheld verdict says what the interval did clear (grader noise) and what it did not.
  const beyondNoise = a.changeInterval.low > 0 ? 'readings rose beyond grader noise' : 'readings fell beyond grader noise'
  // Review round 3, S5: the drift is measured within one prompt revision; a revision change is a break.
  if (a.withheldForRevision) return `${head}: ${beyondNoise}, but the grader’s prompt changed between these readings (${count(a.promptRevisions ?? 0)} revisions) and its drift is measured within one revision only, so no verdict.`
  if (d && !d.interval && (a.changeInterval.low > 0 || a.changeInterval.high < 0)) return `${head}: ${beyondNoise} but not beyond the grader’s possible drift, which is not measured yet and could do this alone.`
  if (a.withheldForDrift && d?.expected) return `${head}: ${beyondNoise} but not beyond the grader’s possible drift (over ${d.spanWeeks.toFixed(1)} weeks it could move readings ${signed(d.expected.low)} to ${signed(d.expected.high)}).`
  return `${head}: ${verdict(a.changeInterval)}.`
}

/**
 * Velocity, in the grader's units (review round 3): on simulated learners with an exam as ground
 * truth, prior-blind readings sat about 30 points above the exam and moved about 0.46 points per
 * exam point, so a point here is a grader point, not a point of exam-measured knowledge. Under the
 * change line's drift rule (S3): a slope the grader's own drift could produce gets no direction.
 */
export const VELOCITY_UNITS = 'prior-blind grader points per week, not points of exam-measured knowledge (on simulated learners these readings moved about half a point per exam point)'
export function velocityLine(changes: Changes): string | null {
  const a = changes.aggregate
  if (a.meanSlopePerWeek === null) return null
  const value = `${signed(a.meanSlopePerWeek)} points per week${a.slopeInterval ? ` (${range(a.slopeInterval)})` : ''}`
  const di = a.drift?.interval
  const drift = a.drift ? (di ? `; the grader’s own drift: ${signed(di.low)} to ${signed(di.high)} per week` : '; the grader’s own drift is not measured yet') : ''
  const verdictText = a.withheldForRevision || (a.promptRevisions ?? 0) > 1 ? '; spans a grader prompt change: no direction'
    : a.slopeWithheldForDrift ? '; not beyond the grader’s possible drift' : ''
  return `${value}, ${VELOCITY_UNITS}${drift}${verdictText}`
}

/**
 * Per-concept flags with their multiplicity: "2 concepts beyond noise after correcting for 87 tests
 * (5 one at a time; about 4 expected by chance)". Review round 3, S3: a per-concept flag tests grader
 * noise only; the grader's drift over time is not applied to it, and the line says so.
 */
export const CONCEPTS_DRIFT_NOTE = 'these flags test grader noise only, not the grader’s drift over time'
export function conceptsLine(changes: Changes): string | null {
  const a = changes.aggregate
  if (!a.nConcepts) return null
  return `${plural(a.nBeyondNoise, 'concept')} beyond noise after correcting for ${count(a.nConcepts)} tests (${count(a.nBeyondNoiseUnadjusted)} one at a time; about ${a.expectedBeyondNoiseByChance.toFixed(0)} expected by chance); ${CONCEPTS_DRIFT_NOTE}.`
}

/** The live scores, described with what the grader alone does to them. */
export function anchoredLine(changes: Changes): string | null {
  const a = changes.anchored, d = changes.noise.drift
  if (a.meanChange === null) return null
  const gradings = a.meanGradingsBetween === null ? '' : ` over ${a.meanGradingsBetween.toFixed(1)} gradings on average`
  const drift = d.meanMove === null ? '' : `; the grader alone raises a score about ${signed(d.meanMove)} points per grading${a.expectedFromDrift === null ? '' : ` (${signed(a.expectedFromDrift)} here)`}`
  return `Your scores (each grading starts from the previous score) moved ${signed(a.meanChange)} points across ${plural(a.nConcepts, 'concept')}${gradings}${drift}, so they are not evidence of learning.`
}

/**
 * The grader's own noise and drift, so a reader can weigh the numbers. N1: a measurement's threshold
 * is shown rounded up to the 5-point grid. Review round 2: each reading's own evidence error (shared by
 * its replicates) is named, and the threshold is stated for the learner's usual gradings per
 * measurement, not for "one grading" (N-b).
 */
export function noiseLine(changes: Changes): string {
  const n = changes.noise
  const source = n.blindSource === 'measured' ? `measured from ${count(n.blindDf)} regrade degrees of freedom` : 'fallback, not enough regrades measured'
  // Review round 3, S1/S2: σ_e per read-rate group, how each was estimated; the largest is used.
  const how = (st: Changes['noise']['evidenceStrata'][number]) => st.source === 'measured'
    ? `from ${plural(st.pairs, 'pair')}${st.interval ? `, 95% ${st.interval.low.toFixed(1)}–${st.interval.high.toFixed(1)}` : ''}`
    : st.source === 'upper_bound' ? `80% upper bound from ${plural(st.pairs, 'pair')}` : 'no pairs yet: fallback'
  const groups = n.evidenceStrata.map((st) => `${st.stratum === 'frequent' ? 'often-read' : 'rarely-read'} concepts ${st.sd.toFixed(1)}, ${how(st)}`)
  const evidence = `${groups.length ? `the larger of: ${groups.join('; ')}` : 'no concept measured twice yet: fallback'}${n.replicateCredit ? '' : '; extra gradings earn no precision until each group has 30 pairs'}`
  const onGrid = Math.ceil(changes.gainThreshold / 5) * 5
  const k = changes.gainThresholdGradings
  // N4: quoted for the learner's usual k; measurements of other k face a somewhat different bar.
  const rule = k <= 1 ? `one blind grading must rise about ${onGrid}+ points over one earlier` : `a blind measurement of ${k} gradings must rise about ${onGrid}+ points over one earlier of ${k}`
  const drift = n.drift.gradings ? ` Live gradings keep the previous score ${pct(n.drift.equal)} of the time, raise it ${pct(n.drift.up)}, lower it ${pct(n.drift.down)}.` : ''
  return `Prior-blind grader noise sd ${n.blindSd.toFixed(1)} points (${source}); each reading’s own evidence adds sd ${n.evidenceSd.toFixed(1)}, which extra gradings of it cannot average away (${evidence}); ${rule} to count as a gain. ${DRIFT_SCOPE}${drift}`
}

/** Review round 3, S5: what the drift rule covers, said on the page. */
export const DRIFT_SCOPE = 'The grader’s drift is measured by regrading the same messages under one prompt revision; it covers the change and velocity lines, and across a prompt change they give no verdict.'

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
  const head = `Notifications: of ${plural(f.citedReadings, 'reading')} citing your messages ${graded}, ${count(f.withinRecency)} cited a message from within ${plural(f.recencyDays, 'day')} of grading and ${count(f.news)} were news; only news can become a notification, and only when it is a first clear reading or a gain.`
  const lag = f.medianLagDays === null ? null : Math.round(f.medianLagDays)
  return lag !== null && lag > f.recencyDays
    ? `${head} Grading is running about ${plural(lag, 'day')} behind your messages, so the feed stays quiet until it catches up: this says nothing about your learning.`
    : head
}

const weeks = (w: number | null) => (w === null ? '–' : `${w.toFixed(1)} wk`)
const armsText = (e: Estimate) => `n = ${count(e.measuredTwice.taught)} taught, ${count(e.measuredTwice.heldOut)} held out`
const gradingsText = (e: Estimate) => (e.gradingsBetween.taught === null || e.gradingsBetween.heldOut === null ? '' : `; gradings between: taught ${e.gradingsBetween.taught.toFixed(1)}, held out ${e.gradingsBetween.heldOut.toFixed(1)}`)

/**
 * The holdout's line. The headline is the probe estimate: each probed concept's prior-blind answer to
 * its FIRST probe (it reaches both arms alike, and no earlier probe's practice is behind it); only it
 * may say taught concepts scored higher or lower. A first probe that produced no reading is counted
 * as such, never replaced by a later answer (review round 6, S-1). The opportunistic estimate is
 * shown with its opportunity gap and no verdict.
 */
export const PROBE_HEADLINE = 'Teaching vs holdout (answer to each concept’s first probe)'
export function efficacyLine(holdout: Holdout): string {
  const p = holdout.probe, e = holdout.estimate
  const baseline = (x: Estimate, what: string) => `${what}: setting baseline: ${count(x.measuredTwice.heldOut)} of ${count(x.minimumPerArm)} held-out concepts measured twice (taught: ${count(x.measuredTwice.taught)} of ${count(x.minimumPerArm)})`
  const lost = (x: Estimate) => (x.baselineOnly.taught + x.baselineOnly.heldOut ? `; first probe without a reading: taught ${count(x.baselineOnly.taught)}, held out ${count(x.baselineOnly.heldOut)}` : '')
  // Review round 2, S-d: the headline reads only probed concepts, and the arms are probed at different rates.
  const pr = holdout.probed
  const probedText = pr.taught.eligible + pr.heldOut.eligible ? `; probed so far: taught ${count(pr.taught.probed)} of ${count(pr.taught.eligible)}, held out ${count(pr.heldOut.probed)} of ${count(pr.heldOut.eligible)}` : ''
  const headline = !p
    ? `${PROBE_HEADLINE}: no first probe answered yet`
    : p.state === 'setting_baseline'
      ? `${baseline(p, PROBE_HEADLINE)}${lost(p)}${probedText}`
      : `${PROBE_HEADLINE}: ${signed(p.effect ?? 0)} points${p.interval ? ` (${range(p.interval)})` : ''}, adjusted for baseline${p.adjustedForElapsed ? ` and weeks to the answer (taught ${weeks(p.elapsedWeeks.taught)}, held out ${weeks(p.elapsedWeeks.heldOut)})` : ''}, ${armsText(p)}${lost(p)}${probedText}: ${p.interval ? (p.interval.low > 0 ? 'taught concepts scored higher on probes beyond grader noise' : p.interval.high < 0 ? 'taught concepts scored lower on probes beyond grader noise' : VERDICT_NONE) : 'no interval yet'}`
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
