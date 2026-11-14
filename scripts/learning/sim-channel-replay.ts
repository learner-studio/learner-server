/**
 * Revision 10, packet 2: replays a run's stored raw agent replies through today's fact channel (every sheet offered,
 * claims verified, each delivery's path recorded). 0 model calls; reads learner_sim read-only; writes nothing to it.
 *
 *   bun --env-file=/etc/learner/db.env scripts/learning/sim-channel-replay.ts --run RUN_ID [--fixture OUT.json]
 *
 * Prints the replay table per arm and budget, per arm and pooled (markdown). --fixture writes about 20 replies,
 * drawn by a seeded shuffle so that each path and an unverified claim are covered, with the channel's outputs pinned.
 */
import { writeFileSync } from 'node:fs'
import { Pool } from 'pg'
import { replayRow, replaySessions, replayTurn, type ReplayReply } from '../../packages/core/src/lib/learning/learning-sim-channel-replay.js'
import { seeded } from '../../packages/core/src/lib/learning/learning-sim-memory.js'
import { usage } from './_db.js'

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const runId = flag('--run')
usage(`Usage: bun --env-file=/etc/learner/db.env scripts/learning/sim-channel-replay.ts --run RUN_ID [--fixture OUT.json]`, !runId)

const url = new URL(process.env.DATABASE_URL ?? '')
url.pathname = '/learner_sim'
const pool = new Pool({ connectionString: url.toString(), max: 1, options: '-c default_transaction_read_only=on' })
type Row = { learner_id: string; arm: string; budget: number; session: number; seq: number; raw: string; claimed: string[] | null }
const rows = (await pool.query<Row>(`SELECT m.learner_id, l.arm, (l.config->>'factBudget')::int AS budget, m.session, m.seq, m.meta->>'raw' AS raw, m.meta->'claimedFactIds' AS claimed
  FROM learning_sim_messages m JOIN learning_sim_learners l USING (run_id, learner_id)
  WHERE m.run_id=$1 AND m.role='agent' AND m.meta ? 'raw' ORDER BY m.learner_id, m.session, m.seq`, [runId])).rows
await pool.end()

const armOf = new Map(rows.map((r) => [r.learner_id, r.arm]))
const replies: ReplayReply[] = rows.map((r) => ({ learnerId: r.learner_id, session: r.session, seq: r.seq, budget: r.budget, raw: r.raw, claimed: r.claimed ?? [] }))
// The channel never sees the arm: replayed blind, grouped by arm only for the table.
const replayed = replaySessions(replies)
const header = '| cell | replies | claims | delivered | claims the matcher missed | verified (0.4) | not verified | withheld (all) | matched | matched-claimed | attributed | unclaimed matcher hits | of which delivered | over budget kept |'
const line = (name: string, rs: typeof replayed) => {
  const x = replayRow(rs)
  const pct = (n: number) => (x.delivered ? `${n} (${Math.round((1000 * n) / x.delivered) / 10}%)` : `${n}`)
  return `| ${name} | ${x.replies} | ${x.claims} | ${x.delivered} | ${x.missedClaims} | ${x.verified} | ${x.unverified} | ${x.withheld} | ${pct(x.matched)} | ${pct(x.matchedClaimed)} | ${pct(x.attributed)} | ${x.unclaimedHits} | ${x.unclaimedHitsDelivered} | ${x.overBudgetKept} |`
}
const arms = [...new Set(rows.map((r) => r.arm))].sort()
const cells = [...new Set(replayed.map((r) => `${armOf.get(r.reply.learnerId)} / budget ${r.reply.budget}`))].sort()
console.log(`Run ${runId}: ${replayed.length} replies, every sheet offered while budget is left.\n`)
console.log([header, header.replace(/[^|]+/g, '---'),
  ...cells.map((c) => line(c, replayed.filter((r) => `${armOf.get(r.reply.learnerId)} / budget ${r.reply.budget}` === c))),
  ...arms.map((a) => line(`**${a}**`, replayed.filter((r) => armOf.get(r.reply.learnerId) === a))),
  line('**pooled**', replayed)].join('\n'))

const out = flag('--fixture')
if (out) {
  const rand = seeded(`rev10-p2-fixture|${runId}`)
  const order = replayed.map((r) => ({ r, k: rand() })).sort((a, b) => a.k - b.k).map((x) => x.r)
  const has = {
    attributed: (r: (typeof order)[number]) => r.out.channel.statedFacts.some((s) => s.path === 'attributed'),
    matchedClaimed: (r: (typeof order)[number]) => r.out.channel.statedFacts.some((s) => s.path === 'matched-claimed'),
    matched: (r: (typeof order)[number]) => r.out.channel.statedFacts.some((s) => s.path === 'matched'),
    unverified: (r: (typeof order)[number]) => r.out.unverified > 0,
    overBudget: (r: (typeof order)[number]) => r.out.channel.overBudget.length > 0,
  }
  const picked: typeof order = []
  for (const test of Object.values(has)) for (const r of order.filter((x) => test(x) && !picked.includes(x)).slice(0, 3)) picked.push(r)
  for (const r of order) if (picked.length < 20 && !picked.includes(r)) picked.push(r)
  const fixture = picked.map(({ turn }) => {
    const c = replayTurn(turn).channel
    return { ...turn, expect: { statedFacts: c.statedFacts, withheld: c.withheld, overBudget: c.overBudget, unoffered: c.unoffered, redacted: c.redacted } }
  })
  writeFileSync(out, `${JSON.stringify({ source: `learner_sim run ${runId}, meta.raw of agent replies; seeded draw rev10-p2-fixture`, replies: fixture }, null, 1)}\n`)
  console.log(`\nFixture: ${fixture.length} replies -> ${out}\n${fixture.map((f) => f.id).join(', ')}`)
}
