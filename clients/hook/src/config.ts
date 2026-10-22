import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { createLearnerClient } from '@learner/contract'

/**
 * Where the hook finds its server, key, settings and local state. Every path
 * can be overridden by env, so tests and a second install never share state
 * with the live hook.
 */
export const paths = {
  config: process.env.LEARNER_HOOK_CONFIG ?? '/root/.claude/learning-hook.json',
  traceDir: process.env.LEARNER_HOOK_TRACE_DIR ?? '/root/.claude/learner-hook-traces',
}

/**
 * `serverUrl` and `keyFile` let one settings file point a hook at a remote
 * Learner; the env variables still win, so tests and a second install never
 * touch it.
 */
export const Config = z.object({
  foundationFirst: z.boolean(), timeoutMs: z.number().int().min(500).max(5000), liveFeedback: z.boolean().default(false),
  serverUrl: z.string().url().optional(), keyFile: z.string().optional(),
})
export const loadConfig = async () => Config.parse(JSON.parse(await readFile(paths.config, 'utf8')))
/** Connection settings never depend on the rest of the file parsing. */
const connection = async () => {
  const parsed = Config.pick({ serverUrl: true, keyFile: true }).safeParse(await readFile(paths.config, 'utf8').then(JSON.parse).catch(() => ({})))
  return parsed.success ? parsed.data : {}
}
export const serverUrl = async () => process.env.LEARNER_URL ?? (await connection()).serverUrl ?? 'http://127.0.0.1:3010'

/** `LEARNER_API_KEY=…` from the key file; the value never leaves this process except as the request header. */
async function apiKey() {
  if (process.env.LEARNER_API_KEY) return process.env.LEARNER_API_KEY
  const keyFile = process.env.LEARNER_HOOK_KEY_FILE ?? (await connection()).keyFile ?? '/etc/learner/agent-key.env'
  const text = await readFile(keyFile, 'utf8')
  const key = text.match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (!key) throw new Error('Learning credential unavailable')
  return key
}

let client: ReturnType<typeof createLearnerClient> | undefined
export async function learner() {
  client ??= createLearnerClient({ baseUrl: await serverUrl(), apiKey: await apiKey() })
  return client
}
