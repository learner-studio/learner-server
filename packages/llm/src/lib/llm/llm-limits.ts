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
  if (governor.enabled) return governor.max;
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

/** A CLI failure that is the provider's rate limit (Codex: "exceeded retry limit, last status: 429 Too Many Requests"). */
export const CLI_RATE_LIMITED = /\b429\b|too many requests|rate.?limit/i;
/** The message of anything thrown: an Error, or the plain `{ type, message, retryable }` object `_spawnCLI` throws
 * (review 7 B1: `String()` of that object is "[object Object]", so no error-text match ever fired). */
export function thrownMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(error);
}

/**
 * The CLI rate-limit governor. Opt-in: the simulated-learner runner enables it; the product never does, so its cap
 * and behaviour are unchanged. Enabled, it owns the process's CLI concurrency cap (`max`, at most the `ceiling` it was
 * enabled with). A 429 pauses every new CLI call in the process for a doubling, jittered backoff (`baseMs` x
 * 2^(streak-1), capped at `capMs`, times a factor drawn from 0.5..1.5). A 429 that follows another with no success
 * between ("repeated") steps the cap down by one, never below `min`, and at most once per pause: the 429s of one burst
 * (the calls already in flight when the limit hit) count as one step (review 7 S5). `recoverAfter` successes in a row
 * step it back up by one, never above the ceiling. `rateLimited` counts every 429 seen.
 */
type CliGovernor = { enabled: boolean; max: number; ceiling: number; min: number; baseMs: number; capMs: number; recoverAfter: number; random: () => number;
  pausedUntil: number; stepBlockedUntil: number; streak: number; successes: number; rateLimited: number; stepDowns: number; stepUps: number };
const governor: CliGovernor = { enabled: false, max: DEFAULT_CLI_MAX_CONCURRENT, ceiling: DEFAULT_CLI_MAX_CONCURRENT, min: 1, baseMs: 30_000, capMs: 300_000, recoverAfter: 20, random: Math.random,
  pausedUntil: 0, stepBlockedUntil: 0, streak: 0, successes: 0, rateLimited: 0, stepDowns: 0, stepUps: 0 };
export function enableCliGovernor(o: { max: number; min?: number; baseMs?: number; capMs?: number; recoverAfter?: number; random?: () => number }) {
  if (!Number.isInteger(o.max) || o.max < 1) throw new Error('the CLI governor needs a positive integer max');
  Object.assign(governor, { enabled: true, min: 1, baseMs: 30_000, capMs: 300_000, recoverAfter: 20, random: Math.random, ...o, ceiling: o.max,
    pausedUntil: 0, stepBlockedUntil: 0, streak: 0, successes: 0, rateLimited: 0, stepDowns: 0, stepUps: 0 });
}
/** Back to the product's behaviour (governor off). Kept for the tests: the governor is module state, so each test
 * that enables it must turn it off again, or it would leak into the next test in the same process. */
export function disableCliGovernor() { governor.enabled = false; }
export function cliGovernorState() { const { random: _, ...state } = governor; return { ...state }; }
/** Record a 429: pause the pool and, when repeated, step the cap down (once per pause). Returns the pause in ms. */
export function noteCliRateLimited(now = Date.now()): number {
  if (!governor.enabled) return 0;
  governor.rateLimited++;
  governor.streak++;
  governor.successes = 0;
  const pause = Math.round(Math.min(governor.capMs, governor.baseMs * 2 ** (governor.streak - 1)) * (0.5 + governor.random()));
  governor.pausedUntil = Math.max(governor.pausedUntil, now + pause);
  if (governor.streak >= 2 && governor.max > governor.min && now >= governor.stepBlockedUntil) {
    governor.max--;
    governor.stepDowns++;
    governor.stepBlockedUntil = governor.pausedUntil;
  }
  return pause;
}
/** Record a success: the streak ends, and enough of them in a row give back one slot. */
export function noteCliSuccess() {
  if (!governor.enabled) return;
  governor.streak = 0;
  if (++governor.successes >= governor.recoverAfter && governor.max < governor.ceiling) { governor.max++; governor.stepUps++; governor.successes = 0; }
}
/** How long new CLI calls must still wait (0 when the governor is off or not paused). */
export function cliPauseMs(now = Date.now()): number { return governor.enabled ? Math.max(0, governor.pausedUntil - now) : 0; }
