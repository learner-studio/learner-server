/**
 * Coverage and false-positive rates of the blind-probe comparison on a simulated learner
 * (docs/specs/blind-probes.md, "How the analysis was checked"). Synthetic: reads no database.
 *
 *   bun scripts/probe-simulation.ts [replications=2000] [seed=20261111]
 */
import { probeCoverage, type ProbeWorld } from '../packages/core/src/lib/learning/learning-blind-probes.simulation.js'
import type { ProbeReading } from '../packages/core/src/lib/learning/learning-blind-probes.js'

const replications = Number(process.argv[2] ?? 2000), seed = Number(process.argv[3] ?? 20261111)
const worlds: Array<[string, Omit<ProbeWorld, 'probes'>]> = [
  ['no effect', {}],
  ['no effect, ability rises with centrality', { centrality: 0.5 }],
  ['no effect, testing effect 0.3 per probe', { testing: 0.3 }],
  ['no effect, testing 0.3 and centrality', { testing: 0.3, centrality: 0.5 }],
  ['no effect, learning trend +1 logit over the run', { trend: 1 }],
  ['no effect, trend +1 and centrality', { trend: 1, centrality: 0.5 }],
  ['true effect 0.15', { effect: 0.15 }],
  ['true effect 0.15, testing 0.3 per probe', { effect: 0.15, testing: 0.3 }],
]
const table: Array<Record<string, string | number>> = []
for (const [name, world] of worlds) for (const probes of [30, 60, 120, 300]) for (const reading of ['first', 'all', 'concept'] as ProbeReading[]) {
  const c = probeCoverage({ ...world, probes }, reading, replications, seed)
  table.push({ world: name, probes, reading, compared: c.compared, bias: c.bias.toFixed(3), spread: c.spread.toFixed(3), 'mean se': c.meanSe.toFixed(3), 'coverage %': (100 * c.coverage).toFixed(1), 'excludes 0 %': (100 * c.excludesZero).toFixed(1), 'se = 0': c.zeroSe })
}
console.table(table)
