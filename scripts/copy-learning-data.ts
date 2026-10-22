// One-shot data copy: the previous host's app database (READ ONLY, named by
// COPY_SOURCE_DB) -> learner. Run as the postgres OS user.
// Every read happens inside ONE exported repeatable-read snapshot, so the per-table
// counts written to counts.json describe exactly the rows that were copied.
import { Client } from 'pg'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const SOURCE = process.env.COPY_SOURCE_DB ?? '', TARGET = 'learner', OUT = '/var/tmp/learner-copy'
if (!SOURCE) throw new Error('COPY_SOURCE_DB is required')
const src = new Client({ host: '/var/run/postgresql', database: SOURCE, application_name: 'learner-copy-snapshot' })
await src.connect()
await src.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
const snapshot = (await src.query('SELECT pg_export_snapshot() AS s')).rows[0].s as string
const tables = (await src.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND (c.relname LIKE 'learning%' OR c.relname='telemetry_outbox') ORDER BY 1`)).rows.map(r => r.relname as string)
const learningWorkflows = (alias = '') => `(${alias}workflow ILIKE 'learning%')`
const log = (event: string, extra: object = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...extra }))
log('snapshot', { snapshot, tables: tables.length })
const run = (cmd: string, args: string[], stdin?: NodeJS.ReadableStream) => new Promise<NodeJS.ReadableStream>((resolve) => {
  const p = spawn(cmd, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'inherit'] }); if (stdin) stdin.pipe(p.stdin!); resolve(p.stdout!)
})
const pipeline = (a: [string, string[]], b: [string, string[]]) => new Promise<void>((resolve, reject) => {
  const left = spawn(a[0], a[1], { stdio: ['ignore', 'pipe', 'inherit'] })
  const right = spawn(b[0], b[1], { stdio: ['pipe', 'inherit', 'inherit'] })
  left.stdout.pipe(right.stdin)
  let codes: number[] = []
  const done = (c: number | null) => { codes.push(c ?? 1); if (codes.length === 2) codes.every(x => x === 0) ? resolve() : reject(new Error(`exit ${codes}`)) }
  left.on('exit', done); right.on('exit', done)
})
// 0. counts in the SAME snapshot, recorded before any copying so a failed phase still leaves them
const counts: Record<string, number> = {}
for (const t of tables) counts[t] = Number((await src.query(`SELECT count(*)::bigint AS n FROM public."${t}"`)).rows[0].n)
counts['@workflow_runs(learning*)'] = Number((await src.query(`SELECT count(*) AS n FROM workflow_runs WHERE ${learningWorkflows()}`)).rows[0].n)
// Steps: every step of a run that was not terminal (a resumable run needs them), plus the playground's
// historical steps, which its run exports read back. Other terminal runs' steps are not copied.
const copiedSteps = `${learningWorkflows('r.')} AND (r.status NOT IN ('completed','failed','cancelled') OR r.workflow = 'learningPlaygroundWorkflow')`
counts['@workflow_steps(copied)'] = Number((await src.query(`SELECT count(*) AS n FROM workflow_step s JOIN workflow_runs r USING(workflow_run_id) WHERE ${copiedSteps}`)).rows[0].n)
writeFileSync(`${OUT}/source-counts.json`, JSON.stringify({ snapshot, counts }, null, 1))
log('counts-written', { tables: Object.keys(counts).length })
// --reset: empty every target table first, so a re-run replaces rather than duplicates.
if (process.argv.includes('--reset')) {
  const tgt = new Client({ host: '/var/run/postgresql', database: TARGET })
  await tgt.connect()
  await tgt.query(`TRUNCATE ${[...tables.map(t => `public."${t}"`), 'learner_workflow_step_history', 'learner_workflow_step_history', 'learner_workflow_steps', 'learner_workflow_runs'].join(', ')}`)
  await tgt.end()
  log('target-reset')
}
// 1. table data
const tArgs = tables.flatMap(t => ['-t', `public.${t}`])
log('dump-start')
await pipeline(['pg_dump', ['--data-only', '--disable-triggers', `--snapshot=${snapshot}`, '-d', SOURCE, ...tArgs]],
               ['psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', TARGET]])
log('dump-done')
// 2. Learning workflow runs (+ the steps chosen by copiedSteps) into the durable tables
const cols = 'workflow_run_id,workflow,status,input,output,error,state,wire,created_at,updated_at'
const scols = 'workflow_step_id,workflow_run_id,step_name,rpc_name,data,status,result,error,retries,retry_delay,current_attempt,created_at,updated_at'
const tx = (q: string) => ['-q', '-d', SOURCE, '-c', `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshot}'; COPY (${q}) TO STDOUT; COMMIT;`]
await pipeline(['psql', tx(`SELECT ${cols} FROM workflow_runs WHERE ${learningWorkflows()}`)],
               ['psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', TARGET, '-c', `COPY learner_workflow_runs(${cols}) FROM STDIN`]])
await pipeline(['psql', tx(`SELECT ${scols.split(',').map(c => 's.' + c).join(',')} FROM workflow_step s JOIN workflow_runs r USING(workflow_run_id) WHERE ${copiedSteps}`)],
               ['psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-d', TARGET, '-c', `COPY learner_workflow_steps(${scols}) FROM STDIN`]])
log('workflows-done')
await src.query('COMMIT'); await src.end()
log('done')
