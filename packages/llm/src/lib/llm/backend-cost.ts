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
 * Unknown backends are metered (fail safe). An operator running a CLI on a per-token API key instead of a
 * subscription declares it metered with LEARNER_METERED_BACKENDS=codex[,claude,...].
 */
export type LlmBackendKind = 'local-child' | 'remote-metered'
export interface LlmBackendCost { backend: string; kind: LlmBackendKind; repeatIsFree: boolean }

const LOCAL_CHILD_BACKENDS = new Set(['codex', 'claude', 'agy', 'gemini', 'antigravity'])

export function llmBackendCost(backend: string | null | undefined, env: Record<string, string | undefined> = process.env): LlmBackendCost {
  const id = String(backend ?? '').trim().toLowerCase()
  const declaredMetered = new Set((env.LEARNER_METERED_BACKENDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
  const local = LOCAL_CHILD_BACKENDS.has(id) && !declaredMetered.has(id)
  return { backend: id, kind: local ? 'local-child' : 'remote-metered', repeatIsFree: local }
}

/** The backends that are repeat-free under `env`, for SQL that must decide per stored run. */
export function repeatFreeBackends(env: Record<string, string | undefined> = process.env): string[] {
  return [...LOCAL_CHILD_BACKENDS].filter((b) => llmBackendCost(b, env).repeatIsFree).sort()
}
