/**
 * Historical cleanup of learning_concept_assessment_runs (2026-11-13, ~24 GB): rewrites each settled current-revision
 * live run that still holds its whole input into the slim shape prepareProvided has written since 93efac0 (evidence
 * references, the prompt's sha256, no text), but ONLY when frozenRun rebuilds that slim row into exactly the stored
 * snapshot, checked before the write and again on the written row inside the same transaction. A run that does not
 * rebuild is left whole and listed by id. Earlier-revision runs are never candidates: the current code cannot rebuild
 * them. Every whole snapshot it may rewrite is first archived (zstd) and the archive verified, so the change can be undone.
 *
 * Run it after 93efac0 has soaked for days, not hours: code before 93efac0 cannot read a slim row.
 *
 *   bun --env-file=/etc/learner/db.env scripts/slim-live-assessment-runs.ts --dry-run [--sample N]
 *   DATABASE_URL=<a role allowed to SET session_replication_role> bun scripts/slim-live-assessment-runs.ts \
 *     --archive /var/lib/learner/assessment-runs-whole.tsv.zst [--batch 200] [--vacuum-rows 5000] [--skipped FILE]
 *
 * - Candidates (live pass, current revision by the digest, a receipt: settled) are materialised once into
 *   learning_ops_slim_live_runs; no snapshot is opened for that.
 * - Archive: one line per candidate still holding its prompt, `run_id<TAB>snapshot`, through `zstd -9`. It is then read
 *   back whole: every line parses, holds a prompt, and the ids are exactly the rows left to process. Its sha256 is
 *   recorded in learning_ops_slim_live_archive; a restart re-hashes the file and refuses to write if it differs or is
 *   missing. Restore a row with: zstd -dc FILE | grep '^<run_id>\t' | cut -f2- (then UPDATE in a replica session).
 * - Batches go by keyset; each batch's rewrites, the re-verification and its outcomes commit in ONE transaction (any
 *   mismatch rolls it back and stops), so a kill loses at most the batch in flight and a restart carries on.
 * - The write skips the immutability trigger with `SET LOCAL session_replication_role = replica`, which takes no table
 *   lock, unlike ALTER TABLE ... DISABLE TRIGGER; `lock_timeout` bounds any wait. The digest trigger is INSERT-only.
 * - A plain VACUUM every --vacuum-rows rewritten rows lets the freed TOAST be reused. It does not shrink the file:
 *   only VACUUM FULL (ACCESS EXCLUSIVE, stalls grading; pause admission first) or pg_repack returns the disk.
 * - --dry-run opens a read-only session, writes nothing (no work table, no archive), and only counts.
 * Output is ids and counts only, never message text.
 */
import { appendFileSync, chmodSync, createReadStream, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Client } from 'pg'
import type { MetaPgQueryFn } from '../packages/core/src/lib/db-metadata/_shared.js'
import { LIVE_INCREMENTAL_VARIANT } from '../packages/core/src/lib/learning/learning-live-incremental-variant.js'
import { frozenRun, promptSha256 } from '../packages/core/src/lib/learning/learning-vector-part-input.js'

const args = process.argv.slice(2)
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1] }
const dryRun = args.includes('--dry-run'), batch = Number(option('batch') ?? 200), vacuumRows = Number(option('vacuum-rows') ?? 5000)
const sample = option('sample') ? Number(option('sample')) : Infinity, skippedFile = option('skipped') ?? '/var/tmp/slim-live-assessment-runs.skipped'
const archive = option('archive')
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required (bun --env-file=/etc/learner/db.env)')
if (!dryRun && !archive) throw new Error('--archive FILE is required: nothing is rewritten before its whole snapshot is archived and verified')

const client = new Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
await client.query(`SET statement_timeout = '60s'`)
if (dryRun) await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY')
const readOnly = (await client.query<{ transaction_read_only: string }>('SHOW transaction_read_only')).rows[0]!.transaction_read_only === 'on'
if (dryRun !== readOnly) throw new Error(dryRun ? 'A dry run must hold a read-only session' : 'The session is read-only; cannot write')
const canReplicate = (await client.query<{ ok: boolean }>(`SELECT has_parameter_privilege(current_user, 'session_replication_role', 'SET') AS ok`)).rows[0]!.ok
if (!dryRun && !canReplicate) throw new Error('This role may not SET session_replication_role (superuser, or GRANT SET ON PARAMETER); nothing was changed')

const direct: MetaPgQueryFn = async (text, params) => { const r = await client.query(text, params ? [...params] : []); return { rows: r.rows, rowCount: r.rowCount ?? 0 } }
// The four parts of a pass rebuild from the same pass row and the same canonical messages: remember the last few reads.
// Only for judging; the in-transaction re-verification reads directly.
const recent = new Map<string, ReturnType<MetaPgQueryFn>>()
const query: MetaPgQueryFn = (text, params) => {
  const key = `${text}\0${JSON.stringify(params ?? [])}`
  if (!recent.has(key)) {
    recent.set(key, direct(text, params))
    if (recent.size > 16) recent.delete(recent.keys().next().value!)
  }
  return recent.get(key)! as never
}

type Candidate = { run_id: string; experiment_id: string; part: number }
const CANDIDATES = `SELECT a.run_id, a.experiment_id::text AS experiment_id, a.part
  FROM learning_vector_turn_assessments a
  JOIN learning_vector_turn_experiments e ON e.run_id = a.experiment_id AND e.config->>'purpose' = 'live'
  JOIN learning_concept_assessment_run_digests d ON d.run_id = a.run_id AND d.prompt_revision = $1
  WHERE EXISTS (SELECT 1 FROM learning_concept_assessment_receipts t WHERE t.run_id = a.run_id)`
type Whole = Omit<Parameters<typeof frozenRun>[1]['snapshot'], 'evidence'> & { prompt: string; evidence: Array<{ id: string; role?: string; occurredAt?: string | null; sourceVersion?: string }> }
type Row = Candidate & { concept_id: string; input_hash: string; snapshot: Whole; bytes: number }
type Outcome = { run_id: string; outcome: string; stored_bytes: number; slim_bytes: number; slim?: unknown; whole?: Whole }

/** Whether the slim row rebuilds into exactly `whole`: frozenRun's input-hash and prompt-sha checks, then every field. */
const rebuildsTo = async (q: MetaPgQueryFn, run: { concept_id: string; input_hash: string; snapshot: Parameters<typeof frozenRun>[1]['snapshot'] }, whole: Whole) => {
  const { part: _part, promptSha256: _sha, ...rebuilt } = await frozenRun(q, run)
  return isDeepStrictEqual(rebuilt, whole)
}

/** The run in the slim shape, kept only when frozenRun turns it back into exactly the stored snapshot. */
async function judge(row: Row): Promise<Outcome> {
  const s = row.snapshot, base = { run_id: row.run_id, stored_bytes: row.bytes, slim_bytes: 0 }
  if (typeof s.prompt !== 'string') return { ...base, outcome: 'already-slim' }
  const { prompt, context, evidence, ...rest } = s
  const slim = { ...rest, part: row.part, promptSha256: promptSha256(prompt), context: { nodeStates: context.nodeStates },
    evidence: evidence.map(({ id, role, occurredAt, sourceVersion }) => ({ id, role, occurredAt, sourceVersion })) }
  try {
    if (!await rebuildsTo(query, { concept_id: row.concept_id, input_hash: row.input_hash, snapshot: slim }, s)) return { ...base, outcome: 'skip:differs' }
    return { ...base, outcome: 'converted', slim, whole: s, slim_bytes: Buffer.byteLength(JSON.stringify(slim)) }
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
  console.log(JSON.stringify({ dryRun, canReplicate, revision: LIVE_INCREMENTAL_VARIANT.revision, candidates, examined, outcomes: Object.fromEntries(tally),
    convertedStoredGB: gb(bytes.stored), slimRawGB: gb(bytes.slim), estimatedFreedGB: gb((bytes.stored - bytes.slim) * scale), skippedIdsIn: skippedFile }))
}
const sha256File = async (path: string) => { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex') }
const pending = async () => new Set((await client.query<{ run_id: string }>('SELECT run_id FROM learning_ops_slim_live_runs WHERE outcome IS NULL')).rows.map((r) => r.run_id))

/** Write the archive of every pending row that still holds its prompt (the rest are marked already-slim), then read it back. */
async function archiveWholeSnapshots(path: string) {
  if (existsSync(path)) throw new Error(`${path} exists but no verified archive is recorded; move it away and re-run`)
  const zstd = Bun.spawn(['zstd', '-q', '-T0', '-9', '-o', path], { stdin: 'pipe', stdout: 'inherit', stderr: 'inherit' })
  let after = ['', '']
  for (;;) {
    const rows = (await client.query<{ run_id: string; experiment_id: string; text: string | null }>(`SELECT w.run_id, w.experiment_id, CASE WHEN r.snapshot ? 'prompt' THEN r.snapshot::text END AS text
      FROM learning_ops_slim_live_runs w JOIN learning_concept_assessment_runs r USING (run_id) WHERE w.outcome IS NULL AND (w.experiment_id, w.run_id) > ($1, $2)
      ORDER BY w.experiment_id, w.run_id LIMIT $3`, [after[0], after[1], batch])).rows
    if (!rows.length) break
    for (const r of rows) if (r.text !== null) zstd.stdin.write(`${r.run_id}\t${r.text}\n`)
    await zstd.stdin.flush()
    const slim = rows.filter((r) => r.text === null).map((r) => r.run_id)
    if (slim.length) await client.query(`UPDATE learning_ops_slim_live_runs SET outcome = 'already-slim' WHERE run_id = ANY($1::text[])`, [slim])
    after = [rows.at(-1)!.experiment_id, rows.at(-1)!.run_id]
  }
  await zstd.stdin.end()
  if (await zstd.exited !== 0) throw new Error('zstd failed; the archive is not usable')
  chmodSync(path, 0o600)
  // Read it back: every line a run id and a whole snapshot, exactly the rows left to rewrite.
  const expected = await pending(), seen = new Set<string>()
  const unzip = Bun.spawn(['zstd', '-dc', path], { stdout: 'pipe', stderr: 'inherit' })
  const decoder = new TextDecoder()
  let rest = ''
  const line = (l: string) => {
    const tab = l.indexOf('\t'), id = l.slice(0, tab)
    if (tab < 0 || typeof (JSON.parse(l.slice(tab + 1)) as { prompt?: unknown }).prompt !== 'string' || !expected.has(id) || seen.has(id)) throw new Error(`archive line ${seen.size + 1} is not a pending whole snapshot`)
    seen.add(id)
  }
  for (const reader = unzip.stdout.getReader(); ;) {
    const { done, value } = await reader.read()
    if (done) break
    const lines = (rest + decoder.decode(value, { stream: true })).split('\n')
    rest = lines.pop()!
    lines.forEach(line)
  }
  if (rest) line(rest)
  if (await unzip.exited !== 0 || seen.size !== expected.size) throw new Error(`archive holds ${seen.size} of ${expected.size} snapshots`)
  await client.query('INSERT INTO learning_ops_slim_live_archive(path, sha256, rows) VALUES ($1, $2, $3)', [path, await sha256File(path), seen.size])
  console.log(JSON.stringify({ archived: seen.size, path }))
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
  await client.query('CREATE TABLE IF NOT EXISTS learning_ops_slim_live_archive(path text NOT NULL, sha256 text NOT NULL, rows int NOT NULL, verified_at timestamptz NOT NULL DEFAULT now())')
  if (!(await client.query('SELECT 1 FROM learning_ops_slim_live_runs LIMIT 1')).rowCount) {
    await client.query(`SET statement_timeout = '15min'`)
    await client.query(`INSERT INTO learning_ops_slim_live_runs(run_id, experiment_id, part) ${CANDIDATES} ON CONFLICT DO NOTHING`, [LIVE_INCREMENTAL_VARIANT.revision])
    await client.query(`SET statement_timeout = '60s'`)
  }
  const recorded = (await client.query<{ path: string; sha256: string }>('SELECT path, sha256 FROM learning_ops_slim_live_archive')).rows[0]
  if (!recorded) await archiveWholeSnapshots(archive!)
  else if (recorded.path !== archive || !existsSync(archive) || await sha256File(archive) !== recorded.sha256) throw new Error('The recorded archive is missing or changed; nothing was rewritten')
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
      const written = await client.query<{ run_id: string; concept_id: string; input_hash: string; snapshot: Parameters<typeof frozenRun>[1]['snapshot'] }>(`UPDATE learning_concept_assessment_runs r
        SET snapshot = v.slim FROM jsonb_to_recordset($1::jsonb) AS v(run_id text, slim jsonb)
        WHERE r.run_id = v.run_id AND r.snapshot ? 'prompt' RETURNING r.run_id, r.concept_id, r.input_hash, r.snapshot`, [JSON.stringify(converted.map(({ run_id, slim }) => ({ run_id, slim })))])
      // The rows as written, rebuilt inside this transaction from what it sees now: anything but the archived whole rolls back.
      const wholeById = new Map(converted.map((o) => [o.run_id, o.whole!]))
      if (written.rowCount !== converted.length) throw new Error(`wrote ${written.rowCount} of ${converted.length} rows`)
      for (const w of written.rows) if (!await rebuildsTo(direct, w, wholeById.get(w.run_id)!)) throw new Error(`run ${w.run_id} no longer rebuilds after the write`)
      await client.query(`UPDATE learning_ops_slim_live_runs w SET outcome = v.outcome, stored_bytes = v.stored_bytes, slim_bytes = v.slim_bytes
        FROM jsonb_to_recordset($1::jsonb) AS v(run_id text, outcome text, stored_bytes int, slim_bytes int) WHERE w.run_id = v.run_id`,
        [JSON.stringify(outcomes.map(({ slim: _slim, whole: _whole, ...o }) => o))])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    count(outcomes)
    after = [ids.at(-1)!.experiment_id, ids.at(-1)!.run_id]
    if ((sinceVacuum += converted.length) >= vacuumRows) await vacuum()
    console.log(JSON.stringify({ at: new Date().toISOString(), after: after[1], outcomes: Object.fromEntries(tally) }))
  }
  await vacuum()
  // Every session's outcomes, not only this one's (the table is the record; drop both tables once the skipped ids are kept).
  tally.clear()
  const all = (await client.query<{ outcome: string | null; n: number; stored: string; slim: string }>(`SELECT outcome, count(*)::int AS n,
    COALESCE(sum(stored_bytes) FILTER (WHERE outcome = 'converted'), 0) AS stored, COALESCE(sum(slim_bytes) FILTER (WHERE outcome = 'converted'), 0) AS slim
    FROM learning_ops_slim_live_runs GROUP BY outcome`)).rows
  bytes.stored = bytes.slim = 0
  for (const o of all) { tally.set(o.outcome ?? 'pending', o.n); bytes.stored += Number(o.stored); bytes.slim += Number(o.slim) }
  const total = all.reduce((n, o) => n + o.n, 0)
  report(total, total)
}
await client.end()
