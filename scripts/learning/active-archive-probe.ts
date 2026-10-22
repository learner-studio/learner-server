/** Explicit probe: replay one existing session signal twice concurrently and wait
 * for the single archive run it must start. Never fabricates chat or calls a model,
 * but it DOES enqueue an archive run on the target server.
 */
import { z } from 'zod'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { openLearnerDatabase, usage } from './_db.js'

const arg = process.argv.slice(2).find((value) => !value.startsWith('-'))
usage(`
Usage: bun --env-file=/etc/learner/db.env scripts/learning/active-archive-probe.ts SESSION_UUID
Posts notifyLearningTranscriptChanged twice for SESSION_UUID to LEARNER_URL
(default http://127.0.0.1:3010) with the agent key from LEARNER_AGENT_KEY_FILE
(default /etc/learner/agent-key.env), checks both calls return the same run, then
polls learner_workflow_runs until it completes (30 s).`, !z.string().uuid().safeParse(arg).success)

const sessionId = arg!
const invocationId = crypto.randomUUID()
const baseUrl = (process.env.LEARNER_URL ?? 'http://127.0.0.1:3010').replace(/\/+$/, '')
const credentials = await Bun.file(process.env.LEARNER_AGENT_KEY_FILE ?? '/etc/learner/agent-key.env').text()
const key = credentials.match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
if (!key) throw new Error('Missing agent key')
const handle = openLearnerDatabase({ readOnly: true })

async function signal() {
  const response = await fetch(`${baseUrl}/rpc/notifyLearningTranscriptChanged`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key! },
    body: JSON.stringify({ data: { sessionId, invocationId } }), signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`Signal HTTP ${response.status}`)
  return z.object({ runId: z.string().uuid() }).parse(await response.json())
}

try {
  const started = Date.now()
  const [first, replay] = await Promise.all([signal(), signal()])
  if (first.runId !== replay.runId) throw new Error('Concurrent replay created duplicate workflows')
  for (let attempt = 0; attempt < 30; attempt++) {
    const run = (await metaDbQuery<{ status: string; error: unknown; output: unknown }>(
      'SELECT status,error,output FROM learner_workflow_runs WHERE workflow_run_id=$1', [first.runId])).rows[0]
    if (run?.status === 'completed') {
      console.log(JSON.stringify({ at: new Date().toISOString(), sessionId, invocationId, runId: first.runId, replayDeduplicated: true, wallMs: Date.now() - started, ...run }, null, 2))
      process.exit(0)
    }
    if (run?.status === 'failed' || run?.error) throw new Error(`Archive failed: ${JSON.stringify(run)}`)
    await Bun.sleep(1000)
  }
  throw new Error(`Archive probe timed out: ${first.runId}`)
} finally { await handle.close() }
