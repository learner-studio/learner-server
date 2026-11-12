/**
 * Is the 75th-percentile rule a fair date for an UNCITED reading? (review N7 and "(c)";
 * mastery-notifications.ts READINGS). Reads the database READ-ONLY and prints numbers only: no
 * message text, no quotes, no ids, no absolute dates.
 *
 *   bun --env-file=/etc/learner/db.env scripts/uncited-dating-evaluation.ts [--out FILE]
 *
 * Population: every learner's independent counted readings (INDEPENDENT; medium or high, with a
 * percent). A reading is CITED when its assessment cites a learner message among its evidence; its
 * truth is the newest such message. UNCITED readings (evidence_basis 'evidence_set') are the ones
 * the rule dates. The scoring is in uncited-dating.ts: in-sample per quantile, split half (2,000
 * random halves), and transferred to cited readings cut down to the uncited readings' message
 * counts and spans.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Pool } from 'pg'
import { INDEPENDENT } from '../packages/core/src/lib/learning/mastery-notifications.js'
import { scoreQuantile, shapeOf, splitHalf, uncitedLike, type DatingCase } from '../packages/core/src/lib/learning/uncited-dating.js'

const args = process.argv.slice(2)
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : null
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (--env-file=/etc/learner/db.env)')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: '-c default_transaction_read_only=on -c statement_timeout=300000' })
const QUANTILES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1]
const SPLITS = 2000
const DRAWS = 5000
const SEED = 20261111
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d
const DAY = 86_400_000

/** Per counted reading: its learner messages' times (ms) and the newest learner message its assessment cites. */
const CASES = `
  SELECT v.evidence_basis,
    array_agg(e.ms ORDER BY e.ms) FILTER (WHERE e.role = 'user') AS learner,
    max(e.ms) FILTER (WHERE e.role = 'user' AND e.id = ANY(cid.ids)) AS cited
  FROM (${INDEPENDENT}) v
  CROSS JOIN LATERAL (SELECT ARRAY(SELECT c->>'sourceId' FROM learning_concept_assessment_receipts t,
      jsonb_array_elements(CASE WHEN jsonb_typeof(t.receipt #> '{assessment,demonstrated}') = 'array' THEN t.receipt #> '{assessment,demonstrated}' ELSE '[]'::jsonb END) c
      WHERE t.run_id = v.run_id) AS ids) cid
  JOIN learning_concept_assessment_runs u ON u.run_id = v.run_id
  CROSS JOIN LATERAL (SELECT m->>'id' AS id, m->>'role' AS role, extract(epoch FROM (m->>'occurredAt')::timestamptz) * 1000 AS ms
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(u.snapshot->'evidence') = 'array' THEN u.snapshot->'evidence' ELSE '[]'::jsonb END) m
      WHERE m->>'occurredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') e
  WHERE v.confidence IN ('medium','high') AND v.understanding_percent IS NOT NULL AND e.ms >= 31536000000
  GROUP BY v.run_id, v.evidence_basis`

async function main() {
  const users = (await pool.query<{ user_id: string }>('SELECT DISTINCT user_id FROM learning_mastery_readings WHERE NOT learner_test_user(user_id)')).rows
  const cases: Array<DatingCase & { basis: string }> = []
  for (const { user_id } of users) {
    const rows = (await pool.query<{ evidence_basis: string; learner: number[] | null; cited: number | null }>(CASES, [user_id])).rows
    for (const r of rows) cases.push({ basis: r.evidence_basis, learnerAt: (r.learner ?? []).map(Number), citedAt: r.cited === null ? null : Number(r.cited) })
  }
  const cited = cases.filter((c) => c.citedAt !== null && c.learnerAt.length > 0)
  const uncited = cases.filter((c) => c.citedAt === null && c.basis === 'evidence_set' && c.learnerAt.length > 0)
  const shape = (cs: DatingCase[]) => {
    const n = cs.map((c) => c.learnerAt.length).sort((a, b) => a - b)
    const span = cs.map((c) => (Math.max(...c.learnerAt) - Math.min(...c.learnerAt)) / DAY).sort((a, b) => a - b)
    const med = (s: number[]) => (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2)
    return { readings: cs.length, medianLearnerMessages: med(n), medianSpanDays: round(med(span), 2) }
  }
  const score = (cs: DatingCase[]) => QUANTILES.map((q) => {
    const s = scoreQuantile(cs, q)
    return { quantile: q, n: s.n, meanDays: round(s.meanDays, 2), medianAbsDays: round(s.medianAbsDays, 2), meanAbsDays: round(s.meanAbsDays, 2) }
  })
  const like = uncitedLike(cited, uncited.map(shapeOf), DRAWS, SEED)
  const sh = splitHalf(cited, QUANTILES, SPLITS, SEED)
  const report = {
    population: { cited: shape(cited), uncited: shape(uncited), uncitedLike: shape(like) },
    inSample: score(cited),
    splitHalf: { splits: sh.splits, chosen: sh.chosen.map((c) => ({ quantile: c.quantile, share: round(c.share) })), heldOutBias: { median: round(sh.heldOutBias.median, 2), low: round(sh.heldOutBias.low, 2), high: round(sh.heldOutBias.high, 2) } },
    transferred: { draws: like.length, seed: SEED, scores: score(like) },
  }
  const text = JSON.stringify(report, null, 2)
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, `${text}\n`) }
  console.log(text)
}

main().finally(() => pool.end())
