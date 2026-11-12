/**
 * A CLI agent call that survives the death of the process waiting for it.
 *
 * The call runs in a small wrapper process (durable-cli-wrapper.ts) started DETACHED (its own session and
 * process group, stdio to files), so a `bun --watch` reload or a SIGKILL of the worker does not take the CLI
 * child with it. The wrapper writes the call's outcome to `<dir>/result.json` (temp file + rename), where `<dir>`
 * is unique to one call of one reserved attempt. Whoever holds the attempt next, the same process or a restarted
 * one:
 *   - finds `result.json`            -> ADOPTS it (no new call);
 *   - finds a live wrapper           -> WAITS for it;
 *   - finds neither (owner and child dead, no result) -> starts the call again.
 * Repeating is only reached by callers whose backend is repeat-free (backend-cost.ts) and whose attempt lease
 * they hold; this module does not decide that.
 *
 * Under systemd a stop kills the whole control group, wrapper included. LEARNER_LLM_CHILD_SCOPE=systemd-run
 * starts each wrapper in its own transient scope so a service restart leaves it running too
 * (docs/operations/reactive-grading-runbook.md, "Restarts"). Without it a restart costs a re-run, never a loss.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, closeSync, accessSync, constants, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DURABLE_RESULT = 'result.json'
export const DURABLE_REQUEST = 'request.json'
export const DURABLE_PID = 'wrapper.pid'
const WRAPPER = join(import.meta.dir, 'durable-cli-wrapper.ts')

/** Where per-attempt call directories live: LEARNER_LLM_ATTEMPT_DIR, else /var/lib/learner/llm-attempts, else the temp dir. */
function attemptRoot(env: Record<string, string | undefined> = process.env): string {
  if (env.LEARNER_LLM_ATTEMPT_DIR) return env.LEARNER_LLM_ATTEMPT_DIR
  for (const base of ['/var/lib/learner', tmpdir()]) {
    try {
      mkdirSync(base, { recursive: true })
      accessSync(base, constants.W_OK)
      return join(base, base === tmpdir() ? 'learner-llm-attempts' : 'llm-attempts')
    } catch { /* next */ }
  }
  return join(tmpdir(), 'learner-llm-attempts')
}

/** The directory of one reserved attempt (its calls are numbered under it). The key is hashed: it names, it never parses. */
export const attemptDirectory = (attemptKey: string, root = attemptRoot()) =>
  join(root, createHash('sha256').update(attemptKey).digest('hex').slice(0, 32))

/**
 * Passed as `durable` in LLM call options: each CLI call made under it takes the next numbered directory, so a
 * grading's first call and its validator retry are `call-1` and `call-2`, the same numbers on a replay.
 */
/**
 * `lost`: a call under this plan ended with its wrapper dead and no result (a control-group stop, OOM, a wrapper
 * that never started). Its outcome is UNKNOWN, not failed: whoever holds the attempt must not record the error
 * the caller turned it into (llm-attempt-lease.ts driveAttempt releases the attempt for a takeover instead).
 */
export interface DurableCallPlan { next(): string; lost: boolean }
export function durableCallPlan(attemptKey: string, root = attemptRoot()): DurableCallPlan {
  const dir = attemptDirectory(attemptKey, root)
  let calls = 0
  return { lost: false, next: () => join(dir, `call-${++calls}`) }
}
/** Remove an attempt's files once its receipt is durable. Never throws. */
export function discardAttempt(attemptKey: string, root = attemptRoot()) {
  try { rmSync(attemptDirectory(attemptKey, root), { recursive: true, force: true }) } catch { /* best effort */ }
}
/** Remove attempt directories untouched for `maxAgeMs` (an attempt whose receipt write never came). */
export function sweepAttemptDirectories(maxAgeMs = 7 * 864e5, root = attemptRoot(), now = Date.now()) {
  let removed = 0
  try {
    for (const name of readdirSync(root)) {
      const path = join(root, name)
      try { if (now - statSync(path).mtimeMs > maxAgeMs) { rmSync(path, { recursive: true, force: true }); removed++ } } catch { /* raced */ }
    }
  } catch { /* no root yet */ }
  return removed
}

/** The serializable part of a runCliAgent call (the agent goes by id; signals and observers stay in-process). */
export interface DurableCliRequest {
  agentId: string; prompt: string; model?: string; reasoning?: string; webSearch?: boolean; timeoutSec?: number; killMs?: number
  sessionId?: string; structuredOutput?: unknown; outputSchema?: unknown; chatOnly?: boolean; inferenceLimits?: unknown
}
type DurableCliResult =
  | { ok: true; stdout: string; stderr: string; durationMs: number; telemetryResult: unknown; finishedAt: string }
  | { ok: false; error: { type?: string; message: string; retryable?: boolean; stderr?: string }; finishedAt: string }

export function readDurableResult(dir: string): DurableCliResult | null {
  try { return JSON.parse(readFileSync(join(dir, DURABLE_RESULT), 'utf8')) as DurableCliResult } catch { return null }
}
export function writeDurableResult(dir: string, result: DurableCliResult) {
  const temporary = join(dir, `${DURABLE_RESULT}.${process.pid}.tmp`)
  writeFileSync(temporary, JSON.stringify(result), { mode: 0o600 })
  renameSync(temporary, join(dir, DURABLE_RESULT))
}

/** True while the wrapper that owns `dir` runs: the pid is alive, not a zombie, and its command line names `dir`. */
export function wrapperAlive(dir: string): boolean {
  let pid: number
  try { pid = Number(readFileSync(join(dir, DURABLE_PID), 'utf8').trim()) } catch { return false }
  if (!Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0) } catch { return false }
  try {
    if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir)
  } catch { return true } // no /proc: trust the signal probe
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** End a wrapper and its CLI child (its process group). */
function stopWrapper(dir: string) {
  try { const pid = Number(readFileSync(join(dir, DURABLE_PID), 'utf8')); if (pid > 1 && wrapperAlive(dir)) process.kill(-pid, 'SIGTERM') } catch { /* gone */ }
}

function startWrapper(dir: string, request: DurableCliRequest) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const stale of [DURABLE_RESULT, DURABLE_PID]) rmSync(join(dir, stale), { force: true })
  writeFileSync(join(dir, `${DURABLE_REQUEST}.tmp`), JSON.stringify(request), { mode: 0o600 })
  renameSync(join(dir, `${DURABLE_REQUEST}.tmp`), join(dir, DURABLE_REQUEST))
  const log = openSync(join(dir, 'wrapper.log'), 'a', 0o600)
  const base = [process.execPath, WRAPPER, dir]
  const scoped = process.env.LEARNER_LLM_CHILD_SCOPE === 'systemd-run' && existsSync('/usr/bin/systemd-run')
  const argv = scoped ? ['/usr/bin/systemd-run', '--scope', '--quiet', '--collect', `--unit=learner-llm-${createHash('sha256').update(dir).digest('hex').slice(0, 16)}`, '--', ...base] : base
  try {
    const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ['ignore', log, log], env: process.env })
    child.on('error', () => undefined)
    child.unref()
    // Written by the spawner, in the same tick: a takeover inside the start grace sees this wrapper and waits for
    // it, never starts a second one (`systemd-run --scope` execs the wrapper under the same pid).
    if (child.pid) writeFileSync(join(dir, DURABLE_PID), String(child.pid), { mode: 0o600 })
  } finally { closeSync(log) }
}

/**
 * Run (or adopt, or wait for) one durable CLI call. Resolves with runCliAgent's success shape; rejects with its
 * error shape. `signal` stops WAITING and kills the wrapper's process group (only an owner that gives the attempt up).
 */
export async function runDurableCliCall(dir: string, request: DurableCliRequest, options: { signal?: AbortSignal; pollMs?: number; startGraceMs?: number; log?: (m: string) => void } = {}) {
  const { pollMs = 200, startGraceMs = 15_000, log = (m: string) => console.log(m) } = options
  // `finishedAt` and `adopted` (a call this process did not start: read from disk or waited for) let the owner trace
  // the call once (llm-service.ts): the wrapper has no telemetry outbox.
  let adopted = true
  const settle = (result: DurableCliResult) => {
    if (result.ok) return { stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, telemetryResult: result.telemetryResult, finishedAt: result.finishedAt, adopted }
    throw { ...result.error, durable: true, finishedAt: result.finishedAt, adopted }
  }
  // Adopt or wait only for the SAME request: a reload that changed the prompt or the model mapping starts it anew.
  let same = false
  try { same = readFileSync(join(dir, DURABLE_REQUEST), 'utf8') === JSON.stringify(request) } catch { /* no call yet */ }
  const finished = same ? readDurableResult(dir) : null
  if (finished) { log(`[LLM-CLI] adopted the finished result in ${dir}`); return settle(finished) }
  if (same && wrapperAlive(dir)) log(`[LLM-CLI] waiting for the live call in ${dir}`)
  else { stopWrapper(dir); startWrapper(dir, request); adopted = false }
  const started = Date.now()
  let seenAlive = false
  for (;;) {
    const result = readDurableResult(dir)
    if (result) return settle(result)
    if (options.signal?.aborted) {
      stopWrapper(dir)
      throw { type: 'cli_agent.cancelled', message: 'durable call abandoned by its owner', retryable: false }
    }
    if (wrapperAlive(dir)) seenAlive = true
    else if (seenAlive || Date.now() - started > startGraceMs) {
      // One last read: the wrapper renames its result just before it exits.
      const last = readDurableResult(dir)
      if (last) return settle(last)
      throw { type: 'cli_agent.wrapper_died', message: `durable call wrapper in ${dir} ended without a result`, retryable: true }
    }
    await sleep(pollMs)
  }
}
