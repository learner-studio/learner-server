import { readFileSync } from 'node:fs'
import { Client } from 'pg'

/**
 * Compare per-table row counts in `learner` with the counts the copy recorded
 * from the source snapshot (`source-counts.json`). Prints a markdown table;
 * exits 1 on any mismatch.
 *   bun --env-file=/etc/learner/db.env scripts/verify-copy.ts [/var/tmp/learner-copy/source-counts.json]
 */
const file = process.argv[2] ?? '/var/tmp/learner-copy/source-counts.json'
const { snapshot, counts } = JSON.parse(readFileSync(file, 'utf8')) as { snapshot: string; counts: Record<string, number> }
const db = new Client({ connectionString: process.env.LEARNER_DATABASE_URL ?? process.env.DATABASE_URL })
await db.connect()
const rows: Array<{ table: string; source: number; target: number }> = []
for (const [table, source] of Object.entries(counts)) {
  const sql = table === '@workflow_runs(learning*)'
    ? `SELECT count(*)::bigint AS n FROM learner_workflow_runs WHERE workflow ILIKE 'learning%'`
    : table === '@workflow_steps(copied)'
      ? `SELECT count(*)::bigint AS n FROM learner_workflow_steps`
      : `SELECT count(*)::bigint AS n FROM public."${table}"`
  rows.push({ table, source, target: Number((await db.query(sql)).rows[0].n) })
}
await db.end()
const bad = rows.filter((r) => r.source !== r.target)
console.log(`Source snapshot ${snapshot}: ${rows.length} tables, ${rows.reduce((a, r) => a + r.source, 0).toLocaleString()} rows, ${bad.length} mismatches\n`)
console.log('| table | source | learner | match |\n|---|---:|---:|---|')
for (const r of rows) console.log(`| ${r.table} | ${r.source} | ${r.target} | ${r.source === r.target ? 'yes' : `NO (${r.target - r.source > 0 ? '+' : ''}${r.target - r.source})`} |`)
process.exitCode = bad.length ? 1 : 0
