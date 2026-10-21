/**
 * LLM concurrency limits — the single source of truth for how many
 * simultaneous LLM calls the server will run in each backend class.
 *
 * There are two classes, with different constraints:
 *
 *   CLI (admin bypass — Claude Code CLI / Codex CLI)
 *     Each call spawns a local child process. Memory + CPU cost is
 *     non-trivial and the CLIs themselves rate-limit beyond a certain
 *     parallelism. Hard ceiling = 3 concurrent by default.
 *
 *   OpenRouter (regular users with their own API key)
 *     No local resource cost; the upstream provider owns rate limiting
 *     and will 429 us cleanly if we exceed their per-key budget.
 *     Un-capped here on purpose — gating happens at the job-queue
 *     level (e.g. a single AI-comparison job runs sequential rounds
 *     internally; one-per-user dedup mutex on the enqueue side).
 *
 * Overrides come from environment variables so the value can be tuned
 * in production without a code change:
 *
 *   LLM_CLI_MAX_CONCURRENT            integer ≥ 1   (default 3)
 *   LLM_OPENROUTER_MAX_CONCURRENT     integer ≥ 1   (default unlimited)
 *
 * Unset / empty / non-numeric / <1 values fall back to the default.
 *
 * @module lib/llm-limits
 */

export const DEFAULT_CLI_MAX_CONCURRENT = 3;
// `Infinity` is the sentinel for "no cap". Callers that build bounded
// queues should branch on `Number.isFinite(limit)` rather than using a
// magic number.
export const DEFAULT_OPENROUTER_MAX_CONCURRENT: number = Infinity;

export interface LLMLimits {
  /** Positive integer ≥ 1. Bounded because each call spawns a child process. */
  readonly cli: number;
  /**
   * Positive integer ≥ 1, or `Infinity` (the "no cap" sentinel).
   * Callers should test with `Number.isFinite(limit)` rather than
   * comparing against a magic number.
   */
  readonly openrouter: number;
}

/**
 * Parse an env var as a positive integer; return fallback if unset,
 * empty, non-numeric, or < 1.
 */
function parsePositiveInt(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

/** Read the CLI (local process) concurrency cap. Returns a positive integer ≥ 1. */
export function getCliMaxConcurrent(): number {
  return parsePositiveInt(
    process.env.LLM_CLI_MAX_CONCURRENT,
    DEFAULT_CLI_MAX_CONCURRENT,
  );
}

/**
 * Read the OpenRouter concurrency cap. Returns `Infinity` by default
 * to signal "no cap".
 */
export function getOpenRouterMaxConcurrent(): number {
  const raw = process.env.LLM_OPENROUTER_MAX_CONCURRENT;
  if (raw == null || raw === "") return DEFAULT_OPENROUTER_MAX_CONCURRENT;
  return parsePositiveInt(raw, DEFAULT_OPENROUTER_MAX_CONCURRENT);
}

/** Snapshot of all limits. Handy for `/api/health/llm-limits` or startup logs. */
export function getLLMLimits(): LLMLimits {
  return {
    cli: getCliMaxConcurrent(),
    openrouter: getOpenRouterMaxConcurrent(),
  };
}
