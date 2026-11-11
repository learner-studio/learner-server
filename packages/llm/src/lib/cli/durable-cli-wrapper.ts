// The detached half of a durable CLI call (durable-cli-call.ts): runs one runCliAgent call described by
// <dir>/request.json and writes its outcome to <dir>/result.json, whatever happens to the process that started it.
//   bun durable-cli-wrapper.ts <dir>
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DURABLE_REQUEST, writeDurableResult, type DurableCliRequest } from './durable-cli-call.js'
import { resolveAgent, runCliAgent } from './cli-agents.js'

const dir = process.argv[2]
if (!dir) { console.error('usage: durable-cli-wrapper.ts <dir>'); process.exit(2) }
// SIGTERM ends the call: its CLI child is in this process group and receives the same group signal.
process.on('SIGTERM', () => process.exit(143))
const request = JSON.parse(readFileSync(join(dir, DURABLE_REQUEST), 'utf8')) as DurableCliRequest
const finishedAt = () => new Date().toISOString()
try {
  const agent = resolveAgent(request.agentId)
  if (!agent) throw { type: 'llm.error', message: `Unknown CLI backend: "${request.agentId}"`, retryable: false }
  const { agentId: _id, ...opts } = request
  const out = await runCliAgent({ ...opts, agent })
  writeDurableResult(dir, { ok: true, stdout: out.stdout, stderr: String(out.stderr ?? '').slice(-4000), durationMs: out.durationMs, telemetryResult: out.telemetryResult ?? null, finishedAt: finishedAt() })
} catch (raw) {
  const e = (raw ?? {}) as { type?: string; message?: string; retryable?: boolean; stderr?: string; signal?: string | null }
  // The CLI was killed from outside (a control-group stop reached it before this wrapper): its outcome is UNKNOWN,
  // not failed. Write nothing, so the owner sees a dead wrapper and re-runs it (review B1). A timeout is ours, and a
  // crash signal (SIGSEGV, SIGABRT) is the CLI's own failure: both recorded.
  if (e.type === 'cli_agent.nonzero_exit' && ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP'].includes(String(e.signal))) process.exit(1)
  writeDurableResult(dir, { ok: false, error: { type: e.type, message: String(e.message ?? raw), retryable: e.retryable, stderr: e.stderr?.slice(0, 2000) }, finishedAt: finishedAt() })
}
process.exit(0)
