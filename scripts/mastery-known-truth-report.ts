/**
 * The known-truth recovery study's report (docs/specs/mastery-change-statistics.md, "Known-truth
 * recovery"): per lane (none / slow / medium / fast = 0 / 1 / 2.5 / 5 points a week) and per k (policy
 * gradingReplicates 1, 2, 3), over fixed-seed simulated learners graded by the grader calibrated on
 * the live one (data/mastery-grader-calibration.json), read by the same statistics as a real learner.
 * Pure: no database. The seeded-rows integration test holds the server's SQL to the same numbers.
 *
 *   bun scripts/mastery-known-truth-report.ts [--learners 200] [--probes-per-week 0.4] [--out FILE]
 *
 * The generator's error model is independent of the estimator's (review round 2, S-a): each reading's
 * evidence error is shared by all of its gradings, at ρ = σ_e²/(σ_e² + σ_g²) of 0, 0.34 and 0.7 (dev),
 * and the estimator is told only σ_g: it estimates σ_e from the measurements, as the server does. Both
 * arms are probed at the same per-concept rate (PROBES_PER_WEEK), as the real scheduler does since
 * 829754b (a uniform pick over all candidates; review7 S1), while both arms learn at the lane rate.
 * The default 0.4 a week is the design comparison (the old run's total probes, spread equally; the
 * real graph gives about 0.5); one learner at the default policy on dev gets about 0.03 (review 4, S3).
 * No drift is planted or passed: the gains are beyond grader noise, before the drift rule
 * (the drift-rule figures come from simulated panels, docs/specs/mastery-change-statistics.md).
 *
 * Per lane and k:
 * - coverage / bias: the change interval against the true change over the measured spans; the
 *   velocity interval against the true slope at the measured times (trueMeanSlope);
 * - rose: share of learners told "readings rose beyond grader noise" (the FPR in lane none, the
 *   power elsewhere); upward per-concept flags after BH per concept measured twice;
 * - gains: toast/strip gains announced per eligible measurement (the FPR in lane none), and the share
 *   of true +20 gains announced (notification sensitivity); per LEARNER, gains announced and gains the feed
 *   reports after the chance gate (`gainTrials(...).reported`, review 6, S1), and the share of learners with one;
 * - probe: share of learners whose probe headline says taught concepts scored higher (no teaching
 *   effect is planted, so this is an FPR in every lane);
 * - rank: mean velocity per lane and the probability a random learner of the faster lane shows a
 *   higher velocity than one of the next slower lane;
 * - anchored: the live scores' mean change, which rises on its own.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { conceptChanges, measurementNoise } from '../packages/core/src/lib/learning/mastery-change-statistics.js'
import { GRADER_CALIBRATION, KNOWN_TRUTH_LANE_ORDER, KNOWN_TRUTH_LANES, learnerVerdicts, simMeasurements, simulateLearner, type KnownTruthLane, type LearnerVerdicts } from '../packages/core/src/lib/learning/mastery-known-truth.js'
import { GAIN_MIN_POINTS } from '../packages/core/src/lib/learning/mastery-notifications.js'

const args = process.argv.slice(2)
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const LEARNERS = Number(arg('--learners') ?? 200)
const out = arg('--out')
const SEED0 = 5001
const KS = [1, 2, 3] as const
const RHOS = [0, 0.34, 0.7] as const
const SD = GRADER_CALIBRATION.blind.sd
/** Blind probe answers per concept per week, both arms. */
const PROBES_PER_WEEK = Number(arg('--probes-per-week') ?? 0.4)
const evidenceSdAt = (rho: number) => SD * Math.sqrt(rho / (1 - rho))
const r3 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const share = (xs: boolean[]) => (xs.length ? xs.filter(Boolean).length / xs.length : null)

type Run = { v: LearnerVerdicts; upFlags: number; measuredTwice: number }
const runs = (lane: KnownTruthLane, k: number, rho: number): Run[] => Array.from({ length: LEARNERS }, (_, i) => {
  const s = simulateLearner({ lane, seed: SEED0 + i, k, taughtReadMultiplier: 2, probesPerWeek: PROBES_PER_WEEK, evidenceSd: evidenceSdAt(rho) })
  const v = learnerVerdicts(s, SD, GAIN_MIN_POINTS, 300)
  const flags = conceptChanges(simMeasurements(s).blind, measurementNoise(SD, v.evidence))
  return { v, upFlags: flags.filter((c) => c.beyondNoise && c.delta > 0).length, measuredTwice: flags.length }
})

const rows: Array<Record<string, unknown>> = []
const slopes = new Map<string, number[]>()
for (const rho of RHOS) for (const k of KS) for (const lane of KNOWN_TRUTH_LANE_ORDER) {
  const rs = runs(lane, k, rho)
  const withInterval = rs.filter(({ v }) => v.blind.changeInterval && v.trueChange !== null)
  const withSlope = rs.filter(({ v }) => v.blind.slopeInterval && v.trueSlope !== null)
  const g = rs.reduce((a, { v }) => ({ e: a.e + v.gains.eligible, n: a.n + v.gains.announced, t: a.t + v.gains.trueGainAtLeast20, h: a.h + v.gains.trueGainAnnounced }), { e: 0, n: 0, t: 0, h: 0 })
  const probes = rs.filter(({ v }) => v.probe?.interval)
  const ests = withSlope.map(({ v }) => v.blind.meanSlopePerWeek!)
  slopes.set(`${rho}:${k}:${lane}`, ests)
  const measured = rs.filter(({ v }) => v.evidence.source === 'measured')
  rows.push({
    rho, plantedEvidenceSd: r3(evidenceSdAt(rho)), k, lane, rate: KNOWN_TRUTH_LANES[lane], learners: rs.length,
    verdicts: withInterval.length,
    changeCoverage: r3(share(withInterval.map(({ v }) => v.blind.changeInterval![0] <= v.trueChange! && v.trueChange! <= v.blind.changeInterval![1]))),
    changeBias: r3(mean(withInterval.map(({ v }) => v.blind.meanChange! - v.trueChange!))),
    slopeCoverage: r3(share(withSlope.map(({ v }) => v.blind.slopeInterval![0] <= v.trueSlope! && v.trueSlope! <= v.blind.slopeInterval![1]))),
    slopeBias: r3(mean(withSlope.map(({ v }) => v.blind.meanSlopePerWeek! - v.trueSlope!))),
    meanVelocity: r3(mean(ests)),
    rose: r3(share(rs.map(({ v }) => !!v.blind.changeInterval && v.blind.changeInterval[0] > 0))),
    upFlagsPerConcept: r3(rs.reduce((a, r) => a + r.upFlags, 0) / Math.max(1, rs.reduce((a, r) => a + r.measuredTwice, 0))),
    gainsPerEligible: r3(g.e ? g.n / g.e : null),
    gainsPerLearner: r3(mean(rs.map(({ v }) => v.gains.announced))), reportedGainsPerLearner: r3(mean(rs.map(({ v }) => v.gains.reported))),
    learnersWithReportedGain: r3(share(rs.map(({ v }) => v.gains.reported > 0))),
    trueGain20Announced: r3(g.t ? g.h / g.t : null), trueGains20: g.t,
    probeSaysTaughtHigher: r3(probes.length ? share(probes.map(({ v }) => v.probe!.interval![0] > 0)) : null), probeVerdicts: probes.length,
    evidenceMeasured: r3(measured.length / rs.length),
    estimatedEvidenceSd: r3(mean(measured.map(({ v }) => v.evidence.sd))),
    evidenceIntervalCoverage: r3(share(measured.map(({ v }) => v.evidence.interval![0] <= evidenceSdAt(rho) && evidenceSdAt(rho) <= v.evidence.interval![1]))),
    anchoredMeanChange: r3(mean(rs.map(({ v }) => v.anchored.meanChange).filter((x): x is number => x !== null))),
  })
}
// Rank order: P(velocity of a learner in the faster lane > one in the next slower lane).
const rank = RHOS.flatMap((rho) => KS.flatMap((k) => KNOWN_TRUTH_LANE_ORDER.slice(1).map((lane, i) => {
  const lo = slopes.get(`${rho}:${k}:${KNOWN_TRUTH_LANE_ORDER[i]}`)!, hi = slopes.get(`${rho}:${k}:${lane}`)!
  let wins = 0, pairs = 0
  for (const a of hi) for (const b of lo) { pairs++; wins += a > b ? 1 : a === b ? 0.5 : 0 }
  return { rho, k, slower: KNOWN_TRUTH_LANE_ORDER[i], faster: lane, pFasterHigher: r3(pairs ? wins / pairs : null) }
})))

const report = { learnersPerLane: LEARNERS, seeds: [SEED0, SEED0 + LEARNERS - 1], blindSd: SD, probesPerWeek: { taught: PROBES_PER_WEEK, heldOut: PROBES_PER_WEEK }, lanes: rows, rank }
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`) }
const cols = ['rho', 'k', 'lane', 'verdicts', 'changeCoverage', 'changeBias', 'slopeCoverage', 'slopeBias', 'meanVelocity', 'rose', 'upFlagsPerConcept', 'gainsPerEligible', 'gainsPerLearner', 'reportedGainsPerLearner', 'learnersWithReportedGain', 'trueGain20Announced', 'probeSaysTaughtHigher', 'probeVerdicts', 'estimatedEvidenceSd', 'evidenceIntervalCoverage']
console.log(`| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|`)
for (const r of rows) console.log(`| ${cols.map((c) => r[c] ?? '–').join(' | ')} |`)
console.log('\n| rho | k | slower | faster | P(faster shows higher velocity) |\n|---|---|---|---|---|')
for (const r of rank) console.log(`| ${r.rho} | ${r.k} | ${r.slower} | ${r.faster} | ${r.pFasterHigher ?? '–'} |`)
