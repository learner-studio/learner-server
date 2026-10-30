/**
 * Mastery notifications S0 (docs/specs/mastery-notifications.md): a read-only replay of
 * the notification rules on real data. No model calls, no writes: both pools run every
 * transaction read-only.
 *
 *   bun --env-file=/etc/learner/db.env scripts/mastery-replay.ts [--user ID] [--weeks 8] [--out FILE]
 *
 * Prints (1) the view-vs-cache gate (blocking: must be 100 %), (2) per week, live readings,
 * first clear readings and gains of +5/+10/+15 at medium or high confidence, (3) the spread
 * of repeated gradings of the same concept on the same evidence and prompt revision in non-live runs, (4) the
 * coach inputs, and (5) the S6 holdout check: held-out concepts delivered as targets or reported in
 * taughtConceptIds since the holdout started (both must be 0). Writes the 20 most recent qualifying gains with their quotes to --out for
 * labelling; the learner's own words, so the file is mode 600 and outside the repo.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Pool } from 'pg'
import type { QueryFn } from '../packages/core/src/db/handle.js'
import { coachArmCounts, coachBaseline, GAIN_MIN_POINTS, learningBaseline, masteryNotifications } from '../packages/core/src/lib/learning/mastery-notifications.js'
import { HOLDOUT_STARTED_AT, holdoutBucketSql } from '../packages/core/src/lib/learning/learning-concept-holdout.js'

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const weeks = Number(flag('--weeks') ?? 8)
const out = flag('--out') ?? `/var/lib/learner/mastery-replay/gains-${new Date().toISOString().slice(0, 10)}.md`

const readOnly = (url: string): QueryFn => {
  const pool = new Pool({ connectionString: url, max: 1, options: '-c default_transaction_read_only=on' })
  pools.push(pool)
  return (async (text: string, params?: ReadonlyArray<unknown>) => {
    const r = await pool.query(text, params ? [...params] : [])
    return { rows: r.rows, rowCount: r.rowCount ?? 0 }
  }) as QueryFn
}
const pools: Pool[] = []
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (--env-file=/etc/learner/db.env)')
const q = readOnly(process.env.DATABASE_URL)

const userId = flag('--user') ?? (await q<{ user_id: string }>('SELECT user_id FROM learning_mastery_readings GROUP BY user_id ORDER BY count(*) DESC LIMIT 1')).rows[0]?.user_id
if (!userId) throw new Error('no live readings')
const pct = (n: number, d: number) => (d ? `${(100 * n / d).toFixed(1)} %` : 'n/a')

// (1) Gate: every cache row's run is a view reading, and the latest reading per concept equals the cache.
const gate = (await q<{ cache: string; in_view: string; equal: string }>(`
  WITH latest AS (SELECT DISTINCT ON (user_id, concept_id) * FROM learning_mastery_readings ORDER BY user_id, concept_id, completed_at DESC, created_at DESC, run_id DESC)
  SELECT count(*) cache, count(v.run_id) in_view,
    count(*) FILTER (WHERE l.understanding_percent IS NOT DISTINCT FROM (c.assessment->>'understandingPercent')::numeric AND l.confidence = c.assessment->>'confidence') equal
  FROM learning_concept_assessment_cache c
  LEFT JOIN learning_mastery_readings v ON v.run_id = c.run_id
  LEFT JOIN latest l ON l.user_id = c.user_id AND l.concept_id = c.concept_id`)).rows[0]!
const [cache, inView, equal] = [Number(gate.cache), Number(gate.in_view), Number(gate.equal)]
const gatePassed = cache > 0 && inView === cache && equal === cache
console.log(`\n(1) view vs cache [BLOCKING]: ${inView}/${cache} cache runs in the view (${pct(inView, cache)}), ${equal}/${cache} latest readings equal (${pct(equal, cache)}) → ${gatePassed ? 'PASS' : 'FAIL'}`)

// (2) Per week: the same history rule the RPC uses, with three gain thresholds.
const weekly = (await q<Record<string, string>>(`
  WITH h AS (
    SELECT v.*, max(v.understanding_percent) FILTER (WHERE v.confidence IN ('medium','high')) OVER w AS best,
      COALESCE(bool_or(v.confidence = 'high') OVER w, false) AS had_clear
    FROM learning_mastery_readings v WHERE v.user_id = $1
    WINDOW w AS (PARTITION BY v.concept_id ORDER BY v.completed_at, v.created_at, v.run_id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING))
  SELECT to_char(date_trunc('week', completed_at), 'YYYY-MM-DD') week, count(*) readings,
    count(*) FILTER (WHERE understanding_percent IS NOT NULL AND confidence IN ('medium','high')) counted,
    count(*) FILTER (WHERE confidence = 'high' AND NOT had_clear AND understanding_percent IS NOT NULL) first_clear,
    count(*) FILTER (WHERE confidence IN ('medium','high') AND understanding_percent - best >= 5) gain5,
    count(*) FILTER (WHERE confidence IN ('medium','high') AND understanding_percent - best >= 10) gain10,
    count(*) FILTER (WHERE confidence IN ('medium','high') AND understanding_percent - best >= 15) gain15
  FROM h WHERE completed_at > now() - make_interval(weeks => $2) GROUP BY 1 ORDER BY 1`, [userId, weeks])).rows
console.log(`\n(2) live readings per week (last ${weeks}; gains are over the best earlier medium/high reading):`)
console.table(weekly.map((w) => ({ week: w.week, readings: +w.readings!, 'medium/high': +w.counted!, 'first clear': +w.first_clear!, '+5': +w.gain5!, '+10': +w.gain10!, '+15': +w.gain15! })))

// (3) Grader noise: the same concept graded more than once on the same evidence, outside live publication.
const noise = (await q<Record<string, string | null>>(`
  WITH graded AS (
    SELECT r.concept_id, md5(array_to_string(d.evidence_ids, ',')) evidence, d.prompt_revision, (t.receipt #>> '{assessment,understandingPercent}')::numeric p
    FROM learning_concept_assessment_runs r
    JOIN learning_concept_assessment_run_digests d USING (run_id)
    JOIN learning_concept_assessment_receipts t USING (run_id)
    WHERE t.receipt->>'status' = 'completed' AND t.receipt #>> '{assessment,understandingPercent}' IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM learning_mastery_readings v WHERE v.run_id = r.run_id)
  ), groups AS (SELECT concept_id, evidence, count(*) n, max(p) - min(p) spread, stddev_samp(p) sd FROM graded GROUP BY concept_id, evidence, prompt_revision HAVING count(*) > 1)
  SELECT count(*) groups, sum(n) gradings, percentile_cont(0.5) WITHIN GROUP (ORDER BY spread) p50,
    percentile_cont(0.9) WITHIN GROUP (ORDER BY spread) p90, max(spread) max, avg(sd) mean_sd,
    count(*) FILTER (WHERE spread >= $1) at_least_gain FROM groups`, [GAIN_MIN_POINTS])).rows[0]!
console.log(`\n(3) repeated gradings of one concept on identical evidence and prompt revision (non-live runs): ${noise.groups} groups, ${noise.gradings} gradings;`
  + ` spread p50 ${Number(noise.p50 ?? 0)} / p90 ${Number(noise.p90 ?? 0)} / max ${Number(noise.max ?? 0)} points, mean sd ${Number(noise.mean_sd ?? 0).toFixed(1)};`
  + ` ${noise.at_least_gain} groups (${pct(Number(noise.at_least_gain), Number(noise.groups))}) spread ≥ ${GAIN_MIN_POINTS}, i.e. noise alone could fire a gain`)

// (4) The 20 most recent qualifying gains, for labelling.
const gains = (await masteryNotifications(q, userId, { since: null, limit: 100 })).filter((n) => n.kind === 'gain').slice(0, 20)
mkdirSync(dirname(out), { recursive: true, mode: 0o700 })
writeFileSync(out, [
  `# Mastery gains to label (${new Date().toISOString()})`, '',
  'Mark each line real or not real: did this message show you understood the concept better than before?', '',
  '| # | label | concept | before → now | confidence | when | quote |', '|---|---|---|---|---|---|---|',
  ...gains.map((g, i) => `| ${i + 1} | ? | ${g.conceptName} | ${g.previousPercent} → ${g.percent} | ${g.confidence} | ${g.completedAt.slice(0, 16)} | ${(g.quote ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 240)} |`),
  '',
].join('\n'), { mode: 0o600 })
chmodSync(out, 0o600)
console.log(`\n(4) ${gains.length} recent gains with quotes → ${out} (mode 600, not in the repo)`)

// Coach inputs and pace.
const learning = await learningBaseline(q, userId)
console.log(`\nlearning baseline: ${learning.have}/${learning.need} tracking, ${learning.pacePerDay.toFixed(2)} new tracking concepts a day over 14 days, daysLeft ${learning.daysLeft ?? 'null'}`)
const clearPace = (await q<{ n: string }>(`
  WITH first AS (SELECT concept_id, min(completed_at) at FROM learning_mastery_readings WHERE user_id = $1 AND confidence = 'high' AND understanding_percent IS NOT NULL GROUP BY 1)
  SELECT count(*) n FROM first WHERE at > now() - interval '14 days'`, [userId])).rows[0]!
console.log(`new clear readings: ${clearPace.n} in 14 days (${(Number(clearPace.n) / 14).toFixed(2)} a day)`)
if (process.env.LEARNER_HABITS_DATABASE_URL) {
  const counts = await coachArmCounts(readOnly(process.env.LEARNER_HABITS_DATABASE_URL))
  const coach = coachBaseline(counts)
  console.log('coach (speech turns, confirmed_speech_span_v1, eligible, not suspect):')
  console.table(coach.arms.map((a) => {
    const c = counts.find((x) => x.arm === a.arm)
    return { arm: a.arm, rows: a.have, need: a.need, 'breach 30 s': c ? pct(c.breaches30, c.rows) : 'n/a', 'last 14 days': c?.rowsLast14Days ?? 0 }
  }))
  console.log(`p0 ${coach.baselineBreachRate.toFixed(3)} (${coach.baselineRateMeasured ? 'measured' : 'prior'}), ${coach.pacePerArmPerDay.toFixed(1)} turns per arm a day, daysLeft ${coach.daysLeft ?? 'null'}`)
} else console.log('coach: LEARNER_HABITS_DATABASE_URL not set; skipped')

// (5) osmosis-concept-holdout: since it started, no held-out concept was a delivered target or taught.
const holdout = (await q<{ turns: string; delivered: string; taught: string; taught_ids: string[] | null }>(`
  WITH t AS (SELECT * FROM learning_live_feedback_turns WHERE user_id = $1 AND created_at >= $2::timestamptz),
  taught AS (SELECT x AS concept_id FROM t, jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.feedback->'taughtConceptIds') = 'array' THEN t.feedback->'taughtConceptIds' ELSE '[]' END) x),
  delivered AS (SELECT review_concept_id AS concept_id FROM t WHERE review_concept_id IS NOT NULL)
  SELECT (SELECT count(*) FROM t) turns,
    (SELECT count(*) FROM delivered WHERE ${holdoutBucketSql('concept_id')} = 0) delivered,
    (SELECT count(*) FROM taught WHERE ${holdoutBucketSql('concept_id')} = 0) taught,
    (SELECT array_agg(DISTINCT concept_id) FROM taught WHERE ${holdoutBucketSql('concept_id')} = 0) taught_ids`, [userId, HOLDOUT_STARTED_AT])).rows[0]!
console.log(`\n(5) holdout since ${HOLDOUT_STARTED_AT}: ${holdout.turns} live turns; held-out concepts delivered as review ${holdout.delivered}, reported taught ${holdout.taught}${holdout.taught_ids ? ` (${holdout.taught_ids.join(', ')})` : ''}`)

await Promise.all(pools.map((p) => p.end()))
process.exit(gatePassed ? 0 : 1)
