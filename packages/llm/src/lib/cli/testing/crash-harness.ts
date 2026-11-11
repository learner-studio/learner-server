import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The ONE crash-recovery harness (docs/operations/restart-safety.md, "The test every change ships"): start a real
 * process (a worker, or a stand-in for one), catch it mid-step on a fake slow model CLI that counts every (paid) invocation, kill it, and wait for
 * the replay. Every crash test uses it (durable-cli-call.test.ts, runtime-pikku restart-recovery); a database
 * comes from ownTestDatabaseUrl(kind).
 */
export const FAKE_CODEX = fileURLToPath(new URL('./fake-codex.ts', import.meta.url))

/**
 * The env that makes `codex` the fake (answering `answer` after `sleepMs`), and the count of its invocations so far.
 * cli-agents.ts reads CODEX_CLI_BIN when it is first imported: an in-process test sets it (FAKE_CODEX) before
 * importing the code under test; a spawned process gets it from this env.
 */
export function fakeCli(scratch: string, name: string, answer: string, sleepMs: number, extra: Record<string, string> = {}) {
  const count = join(scratch, `calls-${name}`)
  return {
    env: { CODEX_CLI_BIN: FAKE_CODEX, FAKE_CODEX_COUNT: count, FAKE_CODEX_SLEEP_MS: String(sleepMs), FAKE_CODEX_ANSWER: answer, LEARNER_LLM_CHILD_SCOPE: '', ...extra },
    calls: () => existsSync(count) ? readFileSync(count, 'utf8').trim().split('\n').length : 0,
  }
}

export type Crashable = { proc: ReturnType<typeof Bun.spawn>; log: () => string; stop: (signal: 'SIGKILL' | 'SIGTERM') => Promise<void> }

/** A child process whose output is kept for failure messages; `stop` signals it and waits for the exit. */
export function spawnCrashable(cmd: string[], options: { cwd?: string; env: Record<string, string | undefined> }): Crashable {
  let out = ''
  const proc = Bun.spawn(cmd, { cwd: options.cwd, env: options.env, stdout: 'pipe', stderr: 'pipe' })
  for (const stream of [proc.stdout, proc.stderr] as ReadableStream<Uint8Array>[]) void (async () => {
    const reader = stream.getReader()
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) out += new TextDecoder().decode(chunk.value)
  })()
  return { proc, log: () => out, stop: async (signal) => { proc.kill(signal); await proc.exited } }
}

/** Poll until `ok`; on timeout (or when `child` exits first) fail with the child's log tail. */
export async function until(ok: () => boolean | Promise<boolean>, ms: number, what: string, child?: Crashable) {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end || (child && child.proc.exitCode !== null && child.proc.signalCode === null)) {
      throw new Error(`timed out waiting for ${what}${child ? `\n--- process log ---\n${child.log().slice(-3000)}` : ''}`)
    }
    await Bun.sleep(50)
  }
}
