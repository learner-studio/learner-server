/**
 * Power of the drift rule (docs/specs/mastery-change-statistics.md, "Power, restated"): per ρ, k, lane
 * and drift-panel size, over 100 fixed-seed simulated learners with NO true drift and equal per-concept
 * probe rates (PROBES_PER_WEEK, default 0.4 a week, both arms, as the scheduler since 829754b; review 4, S3): how often "rose" is said before
 * and under the drift rule, how often it is withheld, and the per-concept gain rule before → after its
 * drift half (`blindGain`). Pure: no database. Prints a markdown table.
 *
 *   bun scripts/mastery-drift-power.ts
 */
import { simulateLearner, learnerVerdicts, simulatedDriftPanel } from '../packages/core/src/lib/learning/mastery-known-truth.ts'
import { blindDrift } from '../packages/core/src/lib/learning/mastery-change-statistics.ts'
import { GAIN_MIN_POINTS } from '../packages/core/src/lib/learning/mastery-notifications.ts'
const SD = 6.74, N = 100
const argv = process.argv.slice(2)
const PROBES_PER_WEEK = Number(argv.includes("--probes-per-week") ? argv[argv.indexOf("--probes-per-week") + 1] : 0.4)
console.log('| ρ | k | lane | panel | drift ± | rose | rose under rule | withheld | gains/eligible noise → rule | true +20 announced noise → rule |')
for (const rho of [0, 0.34, 0.7]) for (const k of [2, 3]) for (const lane of ['none', 'slow', 'fast'] as const) for (const panel of [[30, 8], [60, 8]] as const) {
  let rose = 0, roseRuled = 0, withheld = 0, halfSum = 0
  const g = { e: 0, n: 0, c: 0, t: 0, th: 0, tc: 0 }
  for (let i = 0; i < N; i++) {
    const seed = 9100 + i
    const s = simulateLearner({ lane, seed, k, taughtReadMultiplier: 2, probesPerWeek: PROBES_PER_WEEK, evidenceSd: SD * Math.sqrt(rho / (1 - rho)) })
    const drift = blindDrift(simulatedDriftPanel(seed, 0, panel[0], panel[1]), SD)
    halfSum += (drift.interval![1] - drift.interval![0]) / 2
    const v = learnerVerdicts(s, SD, GAIN_MIN_POINTS, 300, { drift })
    const a = v.blind
    const up = !!a.changeInterval && a.changeInterval[0] > 0
    if (up) rose++
    if (up && a.conclusive) roseRuled++
    if (a.withheldForDrift) withheld++
    g.e += v.gains.eligible; g.n += v.gains.announced; g.c += v.gains.clearOfDrift!; g.t += v.gains.trueGainAtLeast20; g.th += v.gains.trueGainAnnounced; g.tc += v.gains.trueGainClearOfDrift!
  }
  const pct = (x: number, d: number) => (d ? `${(100 * x / d).toFixed(1)} %` : '–')
  console.log(`| ${rho} | ${k} | ${lane} | ${panel[0]} × ${panel[1]} | ${(halfSum / N).toFixed(2)} | ${rose} % | ${roseRuled} % | ${withheld} % | ${pct(g.n, g.e)} → ${pct(g.c, g.e)} | ${pct(g.th, g.t)} → ${pct(g.tc, g.t)} |`)
}
