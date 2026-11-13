/**
 * Historical cleanup of learning_concept_assessment_runs (2026-11-13, ~24 GB): rewrites each current-revision live run
 * that still holds its whole input into the slim shape prepareProvided has written since 93efac0 (evidence references,
 * the prompt's sha256, no text), but ONLY when frozenRun rebuilds that slim row into exactly the stored snapshot.
 * A run that does not rebuild is left whole and listed by id. Earlier-revision runs are never touched: the current
 * code cannot rebuild them, so slimming one would destroy its only prompt.
 *
 * Run it after 93efac0 has soaked for days, not hours: code before 93efac0 cannot read a slim row.
 *
 *   bun --env-file=/etc/learner/db.env scripts/slim-live-assessment-runs.ts --dry-run [--sample N]
 *   bun --env-file=/etc/learner/db.env scripts/slim-live-assessment-runs.ts [--batch 200] [--vacuum-rows 5000] [--skipped FILE]
 *
 * - Candidates are materialised once into learning_ops_slim_live_runs (read from the digest, no snapshot is opened).
 * - Batches go by keyset over that table; each batch's rewrites and its outcomes commit in ONE transaction, so a kill
 *   at any point loses at most the batch in flight and a restart carries on from the first row without an outcome.
 * - The write skips the immutability trigger with `SET LOCAL session_replication_role = replica` (superuser), which
 *   takes no table lock, unlike ALTER TABLE ... DISABLE TRIGGER, so live grading keeps inserting; `lock_timeout` bounds
 *   any wait. The digest trigger is INSERT-only, so digests are untouched.
 * - A plain VACUUM every --vacuum-rows rewritten rows lets the freed TOAST be reused (no VACUUM FULL: it would stall grading).
 * - --dry-run opens a read-only session, writes nothing (no work table), and only counts.
 * Output is ids and counts only, never message text.
 */
import { appendFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { Client } from 'pg'
import type { MetaPgQueryFn } from '../packages/core/src/lib/db-metadata/_shared.js'
import { LIVE_INCREMENTAL_VARIANT } from '../packages/core/src/lib/learning/learning-live-incremental-variant.js'
import { frozenRun, promptSha256 } from '../packages/core/src/lib/learning/learning-vector-part-input.js'

const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const dryRun = args.includes('--dry-run'), batch = Number(option('batch') ?? 200), vacuumRows = Number(option('vacuum-rows') ?? 5000)
const sample = option('sample') ? Number(option('sample')) : Infinity, skippedFile = option('skipped') ?? '/var/tmp/slim-live-assessment-runs.skipped'
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (bun --env-file=/etc/learner/db.env)')

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
await client.query(`SET statement_timeout = '60s'`)
if (dryRun) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
const readOnly = (await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only')).rows[0]!.transaction_read_only === 'on'
if (dryRun !== readOnly) throw new Error(dryRun ? 'A dry run must hold a read-only session' : 'The session is read-only; cannot write')
const superuser = (await client.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0]!.rolsuper
if (!dryRun && !superuser) throw new Error('session_replication_role needs a superuser; nothing was changed')

// The four parts of a pass rebuild from the same pass row and the same canonical messages: remember the last few reads.
const recent = new Map<string, Promise<{ rows: unknown[]; rowCount: number }>>()
const query: MetaPgQueryFn = (text, params) => {
  const key = `${text}\0${JSON.stringify(params ?? [])}`
  if (!recent.has(key)) {
    recent.set(key, client.query(text, params ? [...params] : []).then((r) => ({ rows: r.rows, rowCount: r.rowCount ?? 0 })))
    if (recent.size > 16) recent.delete(recent.keys().next().value!)
  }
  return recent.get(key)! as never
}

type Candidate = { run_id: string; experiment_id: string; part: number }
const CANDIDATES = `SELECT a.run_id, a.experiment_id::text AS experiment_id, a.part
  FROM learning_vector_turn_assessments a
  JOIN learning_vector_turn_experiments e ON e.run_id = a.experiment_id AND e.config->>'purpose' = 'live'
  JOIN learning_concept_assessment_run_digests d ON d.run_id = a.run_id AND d.prompt_revision = $1`
type Whole = Omit<Parameters<typeof frozenRun>[1]['snapshot'], 'evidence'> & { prompt: string; evidence: Array<{ id: string; role?: string; occurredAt?: string | null; sourceVersion?: string }> }
type Row = Candidate & { concept_id: string; input_hash: string; snapshot: Whole; bytes: number }
type Outcome = { run_id: string; outcome: string; stored_bytes: number; slim_bytes: number; slim?: unknown }

/** The run in the slim shape, kept only when frozenRun turns it back into exactly the stored snapshot. */
async function judge(row: Row): Promise<Outcome> {
  const s = row.snapshot, base = { run_id: row.run_id, stored_bytes: row.bytes, slim_bytes: 0 }
  if (typeof s.prompt !== 'string') return { ...base, outcome: 'already-slim' }
  const { prompt, context, evidence, ...rest } = s
  const slim = { ...rest, part: row.part, promptSha256: promptSha256(prompt), context: { nodeStates: context.nodeStates },
    evidence: evidence.map(({ id, role, occurredAt, sourceVersion }) => ({ id, role, occurredAt, sourceVersion })) }
  try {
    const { part: _part, promptSha256: _sha, ...rebuilt } = await frozenRun(query, { concept_id: row.concept_id, input_hash: row.input_hash, snapshot: slim })
    if (!isDeepStrictEqual(rebuilt, s)) return { ...base, outcome: 'skip:differs' }
    return { ...base, outcome: 'converted', slim, slim_bytes: Buffer.byteLength(JSON.stringify(slim)) }
  } catch (error) {
    const m = String((error as Error).message)
    return { ...base, outcome: m.includes('pass this run') ? 'skip:pass-gone' : m.includes('missing from the immutable') ? 'skip:source-gone' : m.includes('differs from the one') ? 'skip:refused' : 'skip:error' }
  }
}

const read = async (ids: Candidate[]) => (await client.query<Row>(`SELECT c.run_id, c.experiment_id, c.part, r.concept_id, r.input_hash, r.snapshot, pg_column_size(r.snapshot) AS bytes
  FROM jsonb_to_recordset($1::jsonb) AS c(run_id text, experiment_id text, part int) JOIN learning_concept_assessment_runs r USING (run_id)
  ORDER BY c.experiment_id, c.run_id`, [JSON.stringify(ids)])).rows
const tally = new Map<string, number>(), bytes = { stored: 0, slim: 0 }
const count = (outcomes: Outcome[]) => {
  for (const o of outcomes) {
    tally.set(o.outcome, (tally.get(o.outcome) ?? 0) + 1)
    if (o.outcome === 'converted') { bytes.stored += o.stored_bytes; bytes.slim += o.slim_bytes }
    if (o.outcome.startsWith('skip:')) appendFileSync(skippedFile, `${o.run_id} ${o.outcome}\n`)
  }
}
const report = (candidates: number, examined: number) => {
  const scale = examined ? candidates / examined : 0, gb = (n: number) => (n / 1e9).toFixed(2)
  console.log(JSON.stringify({ dryRun, superuser, revision: LIVE_INCREMENTAL_VARIANT.revision, candidates, examined, outcomes: Object.fromEntries(tally),
    convertedStoredGB: gb(bytes.stored), slimRawGB: gb(bytes.slim), estimatedFreedGB: gb((bytes.stored - bytes.slim) * scale), skippedIdsIn: skippedFile }))
}

if (dryRun) {
  const all = (await client.query<Candidate>(`${CANDIDATES} ORDER BY a.experiment_id, a.run_id`, [LIVE_INCREMENTAL_VARIANT.revision])).rows
  // A sample takes whole passes spread evenly over the candidates.
  const passes: Candidate[][] = []
  for (const c of all) c.experiment_id === passes.at(-1)?.[0]!.experiment_id ? passes.at(-1)!.push(c) : passes.push([c])
  const step = sample === Infinity ? 1 : Math.max(1, Math.floor(all.length / sample))
  const picked = passes.filter((_, i) => i % step === 0), perRead = Math.max(1, Math.floor(batch / 4))
  let examined = 0
  for (let i = 0; i < picked.length && examined < sample; i += perRead) {
    const rows = await read(picked.slice(i, i + perRead).flat())
    const outcomes: Outcome[] = []
    for (const row of rows) outcomes.push(await judge(row))
    count(outcomes); examined += rows.length
  }
  report(all.length, examined)
} else {
  await client.query(`CREATE TABLE IF NOT EXISTS learning_ops_slim_live_runs(experiment_id text NOT NULL, run_id text NOT NULL, part int NOT NULL,
    outcome text, stored_bytes int, slim_bytes int, PRIMARY KEY (experiment_id, run_id))`)
  if (!(await client.query('SELECT 1 FROM learning_ops_slim_live_runs LIMIT 1')).rowCount) {
    await client.query(`SET statement_timeout = '15min'`)
    await client.query(`INSERT INTO learning_ops_slim_live_runs(run_id, experiment_id, part) ${CANDIDATES} ON CONFLICT DO NOTHING`, [LIVE_INCREMENTAL_VARIANT.revision])
    await client.query(`SET statement_timeout = '60s'`)
  }
  let after = ['', ''], sinceVacuum = 0
  const vacuum = async () => { await client.query(`SET statement_timeout = 0`); await client.query('VACUUM learning_concept_assessment_runs'); await client.query(`SET statement_timeout = '60s'`); sinceVacuum = 0 }
  for (;;) {
    const ids = (await client.query<Candidate>(`SELECT run_id, experiment_id, part FROM learning_ops_slim_live_runs WHERE outcome IS NULL AND (experiment_id, run_id) > ($1, $2)
      ORDER BY experiment_id, run_id LIMIT $3`, [after[0], after[1], batch])).rows
    if (!ids.length) break
    const outcomes: Outcome[] = []
    for (const row of await read(ids)) outcomes.push(await judge(row))
    const converted = outcomes.filter((o) => o.outcome === 'converted')
    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL session_replication_role = replica`)
      await client.query(`SET LOCAL lock_timeout = '5s'`)
      // `snapshot ? 'prompt'`: a row already rewritten (a restart after a lost COMMIT acknowledgement) is left as it is.
      await client.query(`UPDATE learning_concept_assessment_runs r SET snapshot = v.slim FROM jsonb_to_recordset($1::jsonb) AS v(run_id text, slim jsonb)
        WHERE r.run_id = v.run_id AND r.snapshot ? 'prompt'`, [JSON.stringify(converted.map(({ run_id, slim }) => ({ run_id, slim })))])
      await client.query(`UPDATE learning_ops_slim_live_runs w SET outcome = v.outcome, stored_bytes = v.stored_bytes, slim_bytes = v.slim_bytes
        FROM jsonb_to_recordset($1::jsonb) AS v(run_id text, outcome text, stored_bytes int, slim_bytes int) WHERE w.run_id = v.run_id`,
        [JSON.stringify(outcomes.map(({ slim: _slim, ...o }) => o))])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    count(outcomes)
    after = [ids.at(-1)!.experiment_id, ids.at(-1)!.run_id]
    if ((sinceVacuum += converted.length) >= vacuumRows) await vacuum()
    console.log(JSON.stringify({ at: new Date().toISOString(), after: after[1], outcomes: Object.fromEntries(tally) }))
  }
  await vacuum()
  // Every session's outcomes, not only this one's (the table is the record; drop it once the ids of skipped runs are kept).
  tally.clear()
  const all = (await client.query<{ outcome: string; n: number; stored: string; slim: string }>(`SELECT outcome, count(*)::int AS n, COALESCE(sum(stored_bytes) FILTER (WHERE outcome = 'converted'), 0) AS stored,
    COALESCE(sum(slim_bytes) FILTER (WHERE outcome = 'converted'), 0) AS slim FROM learning_ops_slim_live_runs GROUP BY outcome`)).rows
  bytes.stored = bytes.slim = 0
  for (const o of all) { tally.set(o.outcome ?? 'pending', o.n); bytes.stored += Number(o.stored); bytes.slim += Number(o.slim) }
  const total = all.reduce((n, o) => n + o.n, 0)
  report(total, total)
}
await client.end()
