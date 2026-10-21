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
  keyFile: process.env.LEARNER_HOOK_KEY_FILE ?? '/etc/learner/agent-key.env',
}
export const serverUrl = () => process.env.LEARNER_URL ?? 'http://127.0.0.1:3010'

export const Config = z.object({ foundationFirst: z.boolean(), timeoutMs: z.number().int().min(500).max(5000), liveFeedback: z.boolean().default(false) })
export const loadConfig = async () => Config.parse(JSON.parse(await readFile(paths.config, 'utf8')))

/** `LEARNER_API_KEY=…` from the key file; the value never leaves this process except as the request header. */
async function apiKey() {
  if (process.env.LEARNER_API_KEY) return process.env.LEARNER_API_KEY
  const text = await readFile(paths.keyFile, 'utf8')
  const key = text.match(/^LEARNER_API_KEY=(.+)$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (!key) throw new Error('Learning credential unavailable')
  return key
}

let client: ReturnType<typeof createLearnerClient> | undefined
export async function learner() {
  client ??= createLearnerClient({ baseUrl: serverUrl(), apiKey: await apiKey() })
  return client
}
