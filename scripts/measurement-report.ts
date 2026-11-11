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
  const line = (label: string, d: ProbeDifference) => console.log(d.status === 'ok'
    ? `  ${label}: taught - held-out = ${num(d.difference)} (se ${num(d.se)}, df ${num(d.df, 1)}); concepts ${d.concepts.held_out} held-out / ${d.concepts.taught} taught; probes ${d.probes.held_out} / ${d.probes.taught}; strata ${d.strata} (+${d.strataDropped} dropped); if explained probes failed ${num(d.ifExplained.notDemonstrated)}, passed ${num(d.ifExplained.demonstrated)}; days gap ${num(d.daysGap, 1)}`
    : `  ${label}: not enough data (needs ${PROBE_MIN_CONCEPTS_PER_ARM} concepts per arm in a stratum; ${d.strataDropped} stratum(s) too thin)`)
  const headline = probeDifference(rows)
  console.log(`  delivered probes: ${rows.length}; not scored: held-out ${headline.unscored.held_out.noAnswer} no answer + ${headline.unscored.held_out.explained} explained, taught ${headline.unscored.taught.noAnswer} + ${headline.unscored.taught.explained}`)
  line('headline (per probe, weighted by candidates)', headline)
  line('sensitivity: concepts as the unit', probeDifference(rows, { unit: 'concept' }))
  line('sensitivity: first probes only', probeDifference(rows, { firstProbeOnly: true }))
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
