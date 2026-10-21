/**
 * The one correct way to turn an unknown `catch` binding into a string.
 *
 * WHY THIS EXISTS. The idiom it replaces —
 * `error instanceof Error ? error.message : String(error)` — appears ~94 times
 * in this codebase and is wrong for the single most common non-Error thrown
 * here. `llm-service.ts` deliberately throws plain object literals
 * (`{ type, message, retryable }`) so callers can branch on `error.type`
 * against `LLMErrorTypes` without an `instanceof` check that would not survive
 * a module boundary. `String({ type, message })` is `"[object Object]"`: the
 * else-branch that looks like a safe fallback is the branch that throws the
 * message away.
 *
 * That is not hypothetical. The warning-diagnosis worker recorded a real
 * failure as `[unexplained] diagnosis failed: [object Object]` — a durable row
 * naming a defect it could no longer describe.
 *
 * ORDER MATTERS. A thrown object may carry BOTH a `message` and a `type`; the
 * type is the part a reader needs to tell a rate limit from a parse failure,
 * so it is prefixed rather than dropped.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message

  if (typeof error === 'object' && error !== null) {
    const { message, type } = error as { message?: unknown; type?: unknown }
    if (typeof message === 'string' && message.length > 0) {
      return typeof type === 'string' && type.length > 0 ? `${type}: ${message}` : message
    }
    // No `message` to read. JSON is still strictly more informative than
    // "[object Object]", and the try/catch covers a cyclic or non-serializable
    // value — which must not turn an error report into a second error.
    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json
    } catch {
      // fall through to String()
    }
  }

  return String(error)
}

/**
 * Did this throw come with an explicit "try again" flag?
 *
 * Lives beside `errorMessage` because it answers the other half of the same
 * question — what can be learned from an unknown `catch` binding — and because
 * the thrown-object shape it reads is the same one that defeats `String()`.
 *
 * DELIBERATELY NARROW. Only an explicit `retryable: true` counts. Guessing
 * retryability from a message substring is how a permanent configuration
 * error turns into an infinite retry loop, so an error that does not say it
 * is retryable is treated as final.
 */
export function isRetryableError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === true
  )
}
