/**
 * What repeating a call whose outcome is unknown costs, per LLM backend.
 *
 * The rule "a reserved call with no receipt is never made again" protects money: it exists for a backend that is
 * remote and billed per call, where a process that died mid-call may already have been charged and the provider
 * still holds the answer. It is wrong for a LOCAL CHILD process on a flat-rate subscription (the Codex, Claude and
 * Antigravity CLIs as Learner runs them): when the worker dies, the child's result is either on disk or knowably
 * lost, and a repeat costs nothing. Applying the metered rule to it turned every service restart into a concept
 * blocked for a person (2026-11-11: 12 passes on one day, 32 of 216 blocked concepts).
 *
 * So the rule is a property of the backend, not a global one:
 *  - `local-child`: repeatIsFree. A reservation whose owner is provably dead and has no result may be re-run.
 *  - `remote-metered`: never repeated without a receipt; the unknown outcome waits for reconciliation.
 *
 * Unknown backends are metered (fail safe). A CLI is metered when the auth it will use is a per-token API key
 * (review S1: the binary's name says nothing about how it is billed): an API key in the environment, or a Codex
 * auth.json in API-key mode. An operator can also declare one metered with LEARNER_METERED_BACKENDS=codex[,claude].
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Env = Record<string, string | undefined>
const codexAuthMode = (env: Env) => {
  try { return JSON.parse(readFileSync(join(env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'), 'auth.json'), 'utf8')).auth_mode as string | undefined } catch { return undefined }
}
/** Each local CLI is on a flat-rate subscription unless this says it would use a per-token API key. */
const ON_API_KEY: Record<string, (env: Env) => boolean> = {
  codex: (env) => !!(env.OPENAI_API_KEY || env.CODEX_API_KEY) || (codexAuthMode(env) ?? 'chatgpt') !== 'chatgpt',
  claude: (env) => !!env.ANTHROPIC_API_KEY,
  gemini: (env) => !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
  agy: () => false,
  antigravity: () => false,
}

/** True for a local-child backend (repeat-free), false for a remote-metered one (never repeated without a receipt). */
export function repeatIsFree(backend: string | null | undefined, env: Env = process.env): boolean {
  const id = String(backend ?? '').trim().toLowerCase()
  const onApiKey = ON_API_KEY[id]
  return !!onApiKey && !onApiKey(env) && !(env.LEARNER_METERED_BACKENDS ?? '').split(',').some((s) => s.trim().toLowerCase() === id)
}
