/** Read-only, explicitly bounded playground report export; never includes wire/session credentials. */
import { writeFileSync } from 'node:fs'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { PLAYGROUND_RUNS } from '@learner/core/lib/learning/learning-playground.js'
import { openLearnerDatabase, usage } from './_db.js'

const [since, destination] = process.argv.slice(2).filter((arg) => !arg.startsWith('-'))
usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/playground-export.ts ISO_START NEW_JSON_PATH
Writes every learningPlaygroundWorkflow run created since ISO_START (with its
steps, owner ids removed) to NEW_JSON_PATH, which must not exist. Read-only.`,
!since || Number.isNaN(Date.parse(since)) || !destination)

const handle = openLearnerDatabase({ readOnly: true })
try {
  const rows = (await metaDbQuery(
    `SELECT workflow_run_id,status,input,output,error,created_at,updated_at
     FROM learner_workflow_runs WHERE workflow=$1 AND created_at >= $2::timestamptz
     ORDER BY created_at`, ['learningPlaygroundWorkflow', since],
  )).rows
  const parse = (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value
  const runs = []
  for (const row of rows) {
    const input = parse(row.input)
    if (!PLAYGROUND_RUNS.some((id) => input.fixtureId.startsWith(`${id}:`))) continue
    const { userId: _owner, ...publicInput } = input
    const steps = (await metaDbQuery(
      `SELECT step_name,status,result,error,current_attempt,created_at,updated_at
       FROM learner_workflow_steps WHERE workflow_run_id=$1 ORDER BY created_at`, [row.workflow_run_id],
    )).rows.map((step) => ({ ...step, result: parse(step.result) }))
    runs.push({ ...row, input: publicInput, output: parse(row.output), steps })
  }
  const data = { exportedAt: new Date().toISOString(), since, sourceRuns: PLAYGROUND_RUNS,
    note: 'Native persisted workflow data. Fixture replies and injected faults are simulations; live replies invoke the existing CLI runner. Workflow/session wire metadata and owner IDs omitted.', runs }
  const serialized = JSON.stringify(data, null, 2)
  if (/(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(serialized)) throw new Error('Potential secret detected: review privately before export')
  writeFileSync(destination!, serialized, { mode: 0o600, flag: 'wx' })
  console.log(JSON.stringify({ exported: runs.length, live: runs.filter((run) => run.input.mode === 'live').length, destination }))
} finally { await handle.close() }
