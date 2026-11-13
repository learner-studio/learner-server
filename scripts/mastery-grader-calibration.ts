/**
 * The grader calibration the known-truth recovery study runs on (docs/specs/mastery-change-statistics.md,
 * "Known-truth recovery"), read from the dev database READ-ONLY and written as numbers only: no message
 * text, no quotes, no concept or user ids, no absolute dates.
 *
 *   bun --env-file=/etc/learner/db.env scripts/mastery-grader-calibration.ts [--out FILE]
 *
 * What it measures, all over completed gradings of the live grader model:
 * - `blind`: pooled within-group sd of PRIOR-BLIND gradings (the prompt carries no numeric current
 *   estimate) of identical evidence: concept, evidence ids, prompt revision.
 * - `anchored`: the same for gradings that DO carry a numeric prior, grouped also by that prior
 *   (identical prompt as far as the digest can tell).
 * - `moves`: every anchored grading's move from its prior (equal / up / down shares, up sizes).
 * - `response`: how an anchored grading moves as a function of the gap G = (mean prior-blind grade
 *   of the same evidence) − prior, in 10-point buckets. This is the anchoring and the ratchet in one
 *   table: the grader rises a little whatever the gap, follows a positive gap partly, and almost never
 *   follows a negative one down.
 * - `cadence`: for every concept with a counted live reading, the days (evidence time, from the
 *   concept's densest 8-week window) of its fresh live readings and whether each was counted.
 * - `firstLevels`: each such concept's first counted level.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Pool } from 'pg'
import { LIVE_GRADER_MODEL } from '../packages/core/src/lib/learning/grader-noise.js'

const args = process.argv.slice(2)
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'packages/core/src/lib/learning/data/mastery-grader-calibration.json'
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (--env-file=/etc/learner/db.env)')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, options: '-c default_transaction_read_only=on -c statement_timeout=300000' })
const q = async <T>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows as T[]
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d
const DAY = 86_400_000
const WINDOW_DAYS = 56

// The prior a prompt carries (digest column, migrations 0031 and 0042: a live run stores no prompt text).
const GRADED = `
  SELECT r.concept_id, d.evidence_ids, d.prompt_revision, (t.receipt #>> '{assessment,understandingPercent}')::numeric AS p, d.prior_percent AS prior
  FROM learning_concept_assessment_runs r
  JOIN learning_concept_assessment_run_digests d USING (run_id)
  JOIN learning_concept_assessment_receipts t USING (run_id)
  WHERE d.model = $1 AND t.receipt->>'status' = 'completed' AND jsonb_typeof(t.receipt #> '{assessment,understandingPercent}') = 'number'`

const pooled = async (anchored: boolean) => (await q<{ sd: string; df: string; groups: string }>(
  `WITH g AS (${GRADED}), grp AS (
     SELECT count(*) - 1 AS df, (count(*) - 1) * var_samp(p) AS ss FROM g WHERE (prior IS NOT NULL) = $2
     GROUP BY concept_id, evidence_ids, prompt_revision, prior HAVING count(*) > 1)
   SELECT sqrt(sum(ss) / sum(df)) AS sd, sum(df) AS df, count(*) AS groups FROM grp`, [LIVE_GRADER_MODEL, anchored]))[0]!

const blind = await pooled(false)
const anchored = await pooled(true)

const moves = (await q<{ n: string; equal: string; up: string; down: string; up5: string; up10: string; up15plus: string; mean: string; sd: string }>(
  `WITH g AS (${GRADED}) SELECT count(*) n, avg((p = prior)::int) equal, avg((p > prior)::int) up, avg((p < prior)::int) down,
     avg((p - prior = 5)::int) up5, avg((p - prior = 10)::int) up10, avg((p - prior >= 15)::int) up15plus, avg(p - prior) mean, stddev(p - prior) sd
   FROM g WHERE prior IS NOT NULL`, [LIVE_GRADER_MODEL]))[0]!

const response = await q<{ gap: string; n: string; up: string; down: string; move: string; up_move: string }>(
  `WITH g AS (${GRADED}),
   blind AS (SELECT concept_id, evidence_ids, prompt_revision, avg(p) AS b FROM g WHERE prior IS NULL GROUP BY 1, 2, 3),
   x AS (SELECT g.p - g.prior AS mv, b.b - g.prior AS gap FROM g JOIN blind b USING (concept_id, evidence_ids, prompt_revision) WHERE g.prior IS NOT NULL)
   SELECT avg(gap) gap, count(*) n, avg((mv > 0)::int) up, avg((mv < 0)::int) down, avg(mv) move, avg(mv) FILTER (WHERE mv > 0) up_move
   FROM x GROUP BY width_bucket(gap, -40, 40, 8) ORDER BY 1`, [LIVE_GRADER_MODEL])

const rows = await q<{ concept_id: string; at: Date; counted: boolean; p: string | null }>(
  `SELECT concept_id, evidence_at AS at, (confidence IN ('medium','high') AND understanding_percent IS NOT NULL) AS counted, understanding_percent AS p
   FROM learning_mastery_readings WHERE status = 'completed' AND NOT learner_test_user(user_id) ORDER BY concept_id, evidence_at, completed_at`)
const byConcept = new Map<string, typeof rows>()
for (const r of rows) (byConcept.get(r.concept_id) ?? byConcept.set(r.concept_id, []).get(r.concept_id)!).push(r)
const cadence: Array<Array<[number, 0 | 1]>> = []
const firstLevels: number[] = []
for (const list of byConcept.values()) {
  const first = list.find((r) => r.counted)
  if (!first) continue
  firstLevels.push(Number(first.p))
  // The window of WINDOW_DAYS holding the most readings, from the reading that opens it.
  let best = 0, bestCount = 0
  list.forEach((r, i) => {
    const n = list.filter((x) => x.at.getTime() >= r.at.getTime() && x.at.getTime() - r.at.getTime() <= WINDOW_DAYS * DAY).length
    if (n > bestCount) { best = i; bestCount = n }
  })
  const t0 = list[best]!.at.getTime()
  cadence.push(list.filter((x) => x.at.getTime() >= t0 && x.at.getTime() - t0 <= WINDOW_DAYS * DAY)
    .map((x) => [round((x.at.getTime() - t0) / DAY, 2), x.counted ? 1 : 0] as [number, 0 | 1]))
}

const calibration = {
  description: 'Grader calibration for the known-truth recovery study (scripts/mastery-grader-calibration.ts). Numbers only.',
  extracted: new Date().toISOString().slice(0, 10),
  model: LIVE_GRADER_MODEL,
  blind: { sd: round(Number(blind.sd)), df: Number(blind.df), groups: Number(blind.groups) },
  anchored: { sd: round(Number(anchored.sd)), df: Number(anchored.df), groups: Number(anchored.groups) },
  moves: Object.fromEntries(Object.entries(moves).map(([k, v]) => [k, k === 'n' ? Number(v) : round(Number(v), 4)])),
  response: response.map((r) => ({ gap: round(Number(r.gap), 2), n: Number(r.n), up: round(Number(r.up), 4), down: round(Number(r.down), 4), move: round(Number(r.move), 3), upMove: r.up_move === null ? null : round(Number(r.up_move), 3) })),
  windowDays: WINDOW_DAYS,
  cadence,
  firstLevels,
}
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(calibration)}\n`)
console.log(JSON.stringify({ out, blind: calibration.blind, anchored: calibration.anchored, moves: calibration.moves, response: calibration.response, concepts: cadence.length, readings: cadence.reduce((a, c) => a + c.length, 0) }))
await pool.end()
