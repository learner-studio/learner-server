/**
 * The measurement reports that have no screen yet: the blind-probe comparison
 * (docs/specs/blind-probes.md, "Analysis") and the randomized-injection comparison
 * (docs/specs/randomized-injection.md, "Analysis"). Read-only: the pool runs every transaction
 * read-only. Prints numbers only, never the learner's words.
 *
 *   bun --env-file=/etc/learner/db.env scripts/measurement-report.ts [--user ID] [--turns 3]
 */
import { Pool } from 'pg'
import { HOLDOUT_STARTED_AT } from '../packages/core/src/lib/learning/learning-concept-holdout.js'
import { PROBE_ANALYSIS_SQL, PROBE_LEAK_SQL, PROBE_MIN_CONCEPTS_PER_ARM, PROBE_ROWS_SQL, probeDifference, type ProbeDifference, type ProbeRow } from '../packages/core/src/lib/learning/learning-blind-probes.js'
import { injectionAnalysisSql } from '../packages/core/src/lib/learning/learning-intervention-policy.js'

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (--env-file=/etc/learner/db.env)')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, options: '-c default_transaction_read_only=on' })
const q = async <T>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as T[]

try {
  const userId = flag('--user') ?? (await q<{ user_id: string }>('SELECT user_id FROM learning_live_feedback_turns GROUP BY user_id ORDER BY count(*) DESC LIMIT 1'))[0]?.user_id
  if (!userId) throw new Error('No live turns')
  const turnsAhead = Number(flag('--turns') ?? 3)
  const num = (x: number | null, digits = 3) => (x === null ? 'n/a' : x.toFixed(digits))

  console.log(`Blind probes since ${HOLDOUT_STARTED_AT}`)
  const rows = await q<ProbeRow>(PROBE_ROWS_SQL, [userId, HOLDOUT_STARTED_AT])
  const pair = (x: { held_out: number; taught: number }) => `${x.held_out} held-out / ${x.taught} taught`
  const line = (label: string, d: ProbeDifference) => console.log(d.status === 'ok'
    ? `  ${label}: taught - held-out = ${num(d.difference)}, 95 % interval ${num(d.interval![0])} to ${num(d.interval![1])} (se ${num(d.se)}, df ${num(d.df, 1)})\n`
      + `      concepts ${pair(d.concepts)}; scored probes ${pair(d.probes)} of ${pair(d.delivered)} delivered`
      + ` (no answer ${pair({ held_out: d.unscored.held_out.noAnswer, taught: d.unscored.taught.noAnswer })}; explained ${pair({ held_out: d.unscored.held_out.explained, taught: d.unscored.taught.explained })}${d.reading === 'all' ? `; no candidate count ${pair(d.missingWeight)}` : ''})\n`
      + `      strata ${d.strata} (+${d.strataDropped} too thin, holding ${pair(d.deliveredInDroppedStrata)} delivered); if explained probes failed ${num(d.ifExplained.notDemonstrated)}, passed ${num(d.ifExplained.demonstrated)}\n`
      + `      balance, taught minus held-out: days into the holdout ${num(d.daysGap, 1)}; earlier probes of the same concept ${num(d.priorProbesGap, 2)}`
    : `  ${label}: not enough data (needs ${PROBE_MIN_CONCEPTS_PER_ARM} concepts per arm in a stratum; ${d.strataDropped} stratum(s) too thin, holding ${pair(d.deliveredInDroppedStrata)} delivered probes)`)
  console.log(`  delivered probes: ${rows.length}`)
  line('HEADLINE, first probe of each concept', probeDifference(rows))
  console.log('  Sensitivity readings. Both use repeat probes, and a held-out concept is asked more often than a taught one,')
  console.log('  so any effect of being asked pulls them towards zero (docs/specs/blind-probes.md, "The headline difference").')
  line('sensitivity, all probes (weighted by candidates)', probeDifference(rows, { reading: 'all' }))
  line('sensitivity, concept means over all probes', probeDifference(rows, { reading: 'concept' }))
  console.log('  by arm, met before, probe index (descriptive):')
  console.table(await q(PROBE_ANALYSIS_SQL, [userId, HOLDOUT_STARTED_AT]))
  console.log('  by whether the agent already had the concept in the session:')
  console.table(await q(PROBE_LEAK_SQL, [userId, HOLDOUT_STARTED_AT]))

  for (const unit of ['turn', 'session'] as const) {
    console.log(`Randomized injection, unit = ${unit}, evidence in the next ${turnsAhead} turns`)
    console.table(await q(injectionAnalysisSql(unit), [userId, turnsAhead]))
  }
} finally {
  await pool.end()
}
