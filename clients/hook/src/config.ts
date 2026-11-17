import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { z } from 'zod'
import { createLearnerClient } from '@learner/contract'

/**
 * Where the hook finds its server, key, settings and local state: under the
 * running user's `~/.claude`, so the same hook serves the server's own box and
 * a paired Mac. Every path can be overridden by env, so tests and a second
 * install never share state with the live hook.
 */
export const paths = {
  get config() { return process.env.LEARNER_HOOK_CONFIG ?? `${homedir()}/.claude/learning-hook.json` },
  get traceDir() { return process.env.LEARNER_HOOK_TRACE_DIR ?? `${homedir()}/.claude/learner-hook-traces` },
}

/**
 * `serverUrl` and `keyFile` let one settings file point a hook at a remote
 * Learner; the env variables still win, so tests and a second install never
 * touch it. `keyCommand` (an argv, never a shell line) prints the key instead,
 * for a machine whose key lives in a secret store (the Mac's Keychain).
 * `submitCommand` is the `--submit` line the model is told to run, for an
 * install whose hook is not at the default path.
 */
export const Config = z.object({
  foundationFirst: z.boolean(), timeoutMs: z.number().int().min(500).max(5000), liveFeedback: z.boolean().default(false),
  serverUrl: z.string().url().optional(), keyFile: z.string().optional(),
  keyCommand: z.array(z.string().min(1)).min(1).optional(), submitCommand: z.string().min(1).optional(),
})
export const loadConfig = async () => Config.parse(JSON.parse(await readFile(paths.config, 'utf8')))
/** Connection settings never depend on the rest of the file parsing. */
const connection = async () => {
  const parsed = Config.pick({ serverUrl: true, keyFile: true, keyCommand: true }).safeParse(await readFile(paths.config, 'utf8').then(JSON.parse).catch(() => ({})))
  return parsed.success ? parsed.data : {}
}
export const serverUrl = async () => process.env.LEARNER_URL ?? (await connection()).serverUrl ?? 'http://127.0.0.1:3010'

/** `LEARNER_API_KEY=…` from the key file; the value never leaves this process except as the request header. */
async function apiKey() {
  if (process.env.LEARNER_API_KEY) return process.env.LEARNER_API_KEY
  const { keyFile: configured, keyCommand } = await connection()
  if (keyCommand && !process.env.LEARNER_HOOK_KEY_FILE) {
    // The command's own output and errors never reach the hook's output: only "unavailable" does.
    const key = await promisify(execFile)(keyCommand[0]!, keyCommand.slice(1), { timeout: 3000 }).then((r) => r.stdout.trim(), () => '')
    if (!key) throw new Error('Learning credential unavailable')
    return key
  }
  const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? configured ?? '/etc/learner/agent-key.env'
  const text = await readFile(keyFile, 'utf8').catch(() => '')
  const key = text.match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (!key) throw new Error('Learning credential unavailable')
  return key
}

let client: ReturnType<typeof createLearnerClient> | undefined
export async function learner() {
  client ??= createLearnerClient({ baseUrl: await serverUrl(), apiKey: await apiKey() })
  return client
}
