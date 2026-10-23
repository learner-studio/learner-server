export interface LLMErrorTypeMap {
	readonly RATE_LIMIT: "LLM_RATE_LIMIT";
	readonly NO_CREDITS: "LLM_NO_CREDITS";
	readonly TOKEN_LIMIT: "LLM_TOKEN_LIMIT";
	readonly TIMEOUT: "LLM_TIMEOUT";
	readonly UNAVAILABLE: "LLM_UNAVAILABLE";
	readonly PARSE_ERROR: "LLM_PARSE_ERROR";
	readonly AUTH_ERROR: "LLM_AUTH_ERROR";
	readonly ERROR: "LLM_ERROR";
}

export interface LLMCallOptions {
	model?: string;
	timeout?: number;
	thinking?: boolean | string | null;
	webSearch?: boolean;
	onProgress?: (msg: string) => void;
	backend?: string;
	killMs?: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	plugins?: any[];
}

import https from 'node:https';
import http from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { generateText } from 'ai';
import { claudeCode } from 'ai-sdk-provider-claude-code';
import { logEvent } from '../../services/observability.js';
import { recordGeneration } from './langfuse-generation.js';
import { getCurrentCliScope } from '../cli/cli-observer-registry.js';

type LLMConfig = {
  ADMIN_CLI_BACKEND?: string;
  AGY_CLI_DEFAULT_MODEL?: string;
  LLM_BACKEND?: string;
  EXTRACTOR_LLM_BACKEND?: string;
  EXTRACTOR_MODEL?: string;
  EXTRACTOR_REASONING?: string;
  EXTRACTOR_INPUT_BUDGET_TOKENS?: string;
  EXTRACTOR_LLM_TIMEOUT_SEC?: string;
  /** Curriculum authoring seam — see `curriculumAuthoringCallOptions`. */
  CURRICULUM_LLM_BACKEND?: string;
  CURRICULUM_MODEL?: string;
  CURRICULUM_REASONING?: string;
  CURRICULUM_LLM_TIMEOUT_SEC?: string;
  INTELLIGENCE_MODEL?: string;
  PERSONA_CONSOLIDATION_MODEL?: string;
  /** Warning-diagnosis seam — see `qualityInvestigationCallOptions`. */
  QUALITY_INVESTIGATION_BACKEND?: string;
  QUALITY_INVESTIGATION_MODEL?: string;
  QUALITY_INVESTIGATION_REASONING?: string;
  QUALITY_INVESTIGATION_LLM_TIMEOUT_SEC?: string;
  WEB_SEARCH_MODEL?: string;
  LLM_DEFAULT_REASONING?: string;
  OPENROUTER_API_KEY?: string;
  /** Comma-separated: the operator's emails and auth user ids, whose calls run on the admin CLI backend. */
  LEARNER_ADMIN_EMAILS?: string;
  LEARNER_ADMIN_USER_IDS?: string;
};

let injectedConfig: LLMConfig = {};

export function configureLLM(cfg: LLMConfig) {
  injectedConfig = { ...injectedConfig, ...cfg };
}

const cfg = (k: keyof LLMConfig): string | undefined =>
  injectedConfig[k] ?? process.env[k];

interface LlmUserContextStore {
  email?: string
  userId?: string
  openrouterApiKey?: string | null
}
const llmUserContext = new AsyncLocalStorage<LlmUserContextStore>();

const configList = (k: 'LEARNER_ADMIN_EMAILS' | 'LEARNER_ADMIN_USER_IDS'): string[] =>
  (cfg(k) ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Admin CLI backend: 'claude', 'codex', or 'agy'.
 * Set ADMIN_CLI_BACKEND (env or injected config) to switch. Defaults to 'claude'.
 *
 * Lazy: reads injected config at call time so configureLLM() (from the DI
 * wrapper) can set it after this module loads.
 */
function adminCliBackend() {
  return (cfg('ADMIN_CLI_BACKEND') || 'claude').toLowerCase();
}

/**
 * CLI model mappings are now inline in _getCliMapping() which handles
 * supported CLI backends for primary calls and fallback.
 *
 * Claude Code: opus 4.6 (1M context, all operations)
 * Codex CLI: requested GPT-5 model with native reasoning
 * Antigravity CLI: selected Gemini 3.5 Flash (High) config via agy.
 */

/**
 * Set user context for the current async scope.
 * Call this in request handlers before any LLM calls.
 *
 * @param {string} email - User email
 * @param {Function} fn - Async function to run within this context
 * @returns {Promise<*>} Result of fn
 */
function setLLMUserContext(userInfo: any, fn: any) {
  const info = typeof userInfo === 'string'
    ? { email: userInfo }
    : userInfo;
  return llmUserContext.run(info, fn);
}

/**
 * Check if the current request should use Claude CLI instead of OpenRouter
 */
/** Label, user and session for a non-CLI generation, from the enclosing telemetry scope. */
function traceIdentity(): { label: string; userId?: string; sessionId?: string } {
  const ctx = (getCurrentCliScope()?.context ?? {}) as { label?: string; queueName?: string; jobId?: string; userId?: string };
  const userId = ctx.userId ?? llmUserContext.getStore()?.userId;
  return { label: ctx.label ?? ctx.queueName ?? 'llm-call', ...(userId ? { userId: String(userId) } : {}), ...(ctx.jobId ? { sessionId: ctx.jobId } : {}) };
}

function shouldUseAdminCLI() {
  const ctx = llmUserContext.getStore();
  return (!!ctx?.email && configList('LEARNER_ADMIN_EMAILS').includes(ctx.email.toLowerCase()))
    || (!!ctx?.userId && configList('LEARNER_ADMIN_USER_IDS').includes(ctx.userId.toLowerCase()));
}

/**
 * Concurrency limiter for admin CLI calls (Claude Code / Codex).
 *
 * Each call spawns a local child process — memory + CPU cost is non-
 * trivial and the CLIs themselves rate-limit beyond a certain
 * parallelism. Cap is read per-call from lib/llm-limits so it can be
 * tuned in prod via LLM_CLI_MAX_CONCURRENT without a code change.
 * Default = 3.
 *
 * OpenRouter-backed calls are intentionally uncapped (the upstream
 * provider rate-limits us and the job-queue dedup mutex gates at the
 * job level). See lib/llm-limits for the full rationale.
 */
import { getCliMaxConcurrent } from './llm-limits.js';
import { AGY_DEFAULT_MODEL } from '../cli/cli-agents.js';
import { matchCatalogEntry, resolveExtractorInputBudgetChars, resolveHonoredSelection, type ExtractorInputBudgetStep } from './model-catalog.js';
let _cliActiveCount = 0;
const _cliWaitQueue: Array<(value: unknown) => void> = [];

function acquireCliSlot() {
  if (_cliActiveCount < getCliMaxConcurrent()) {
    _cliActiveCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => _cliWaitQueue.push(resolve));
}

function releaseCliSlot() {
  if (_cliWaitQueue.length > 0) {
    const next = _cliWaitQueue.shift();
    next?.(undefined);
  } else {
    _cliActiveCount--;
  }
}

/**
 * Call admin CLI — always uses ADMIN_CLI_BACKEND (claude).
 * No cross-backend fallback: if Claude fails, the error is marked retryable
 * so callLLMWithStructuredOutput's retry loop retries the same model rather
 * than degrading to codex (which returns unusable output for extraction tasks).
 */
async function callAdminCLI(prompt: any, options: any = {}) {
  await acquireCliSlot();
  try {
    // Per-call override: a single call may request a specific CLI backend
    // (e.g. 'agy') via options.backend without changing the global default.
    // When omitted, fall back to ADMIN_CLI_BACKEND (unchanged behavior).
    // An invalid backend errors via _spawnCLI's existing resolveAgent check
    // (no silent fallback).
    //
    // Errors propagate unchanged, deliberately: non-retryable errors
    // (missing binary, unknown backend, hard non-zero exit) must not be
    // retried here — retrying those just wastes a spawn and delays the
    // real error. Transient failures (timeout, empty output) already
    // carry retryable:true from lib/cli-agents and pass through unchanged.
    return await _spawnCLI(prompt, options, options.backend || adminCliBackend());
  } finally {
    releaseCliSlot();
  }
}

/**
 * Get CLI model + reasoning mapping for a given backend.
 *
 * Both CLIs support extended thinking. Codex CLI uses `model_reasoning_effort`
 * in its config (via `-c`), Claude CLI uses the top-level `--effort` flag.
 * `reasoningLevel` is our canonical level; map it to each CLI's vocabulary.
 */
function _getCliMapping(model: any, backend: any, reasoningLevel: any = DEFAULT_REASONING) {
  const level = normalizeReasoning(reasoningLevel);

  // The catalogue is consulted FIRST for every backend, because it is the one
  // place that knows a model's real effort set — that `gemini-3.1-pro` has no
  // medium, that `gpt-5.6-sol` has an `ultra` nothing else does, that agy's
  // borrowed claude/gpt-oss models accept no effort variant at all. Clamping
  // through `resolveEffortForModel` is what stops us emitting an effort the
  // CLI would reject.
  const matched = matchCatalogEntry(model);
  if (matched && matched.entry.backend === backend) {
    const honored = resolveHonoredSelection(matched.entry, level as any, matched.slugEffort);
    return { model: honored.model, reasoning: honored.effort };
  }

  if (backend === 'codex') {
    const codexEffort = level === 'off' || level === 'minimal' ? 'low' : level === 'max' ? 'xhigh' : level;
    return { model: /^gpt-5/i.test(String(model)) ? model : 'gpt-5.6-sol', reasoning: codexEffort };
  }
  if (backend === 'agy') {
    // Honour an explicitly requested Antigravity model. This used to return the
    // default unconditionally, so `model: MODELS.WEB_SEARCH` was accepted and
    // then discarded — the log read `--model Gemini 3.5 Flash (High) (mapped
    // from gemini-3.7-flash-high)`, i.e. the config said one model and the run
    // used another.
    //
    // Only an Antigravity-shaped name is passed through: callers routinely carry
    // an OpenRouter id (`anthropic/claude-opus-4.6`) that agy cannot resolve, and
    // handing that over would break every existing agy call. Antigravity accepts
    // either the slug (`gemini-3.7-flash-high`) or the display name
    // (`Gemini 3.7 Flash (High)`).
    //
    // Reasoning is pinned to the model slug's own suffix here rather than to
    // the caller's level: an un-catalogued agy name carries no effort contract
    // we can clamp against, and agy rejects an effort a slug does not offer.
    const requested = String(model || '');
    const isAgyModel = /^gemini-[\d.]+-/i.test(requested) || /^Gemini\s/i.test(requested);
    return {
      model: isAgyModel ? requested : cfg('AGY_CLI_DEFAULT_MODEL') || AGY_DEFAULT_MODEL,
      reasoning: 'high',
    };
  }

  // Claude CLI. The model used to be pinned to `opus` UNCONDITIONALLY here, so
  // a caller naming `sonnet` was accepted and silently run on opus — the same
  // fail-open shape `assertCliCanWebSearch` exists to prevent, but with no
  // assertion and no log line. A catalogued claude model is now honoured by the
  // branch above; anything else still falls back to opus, because an
  // uncatalogued string is routinely an OpenRouter id
  // (`anthropic/claude-opus-4.6`) the CLI cannot resolve.
  return { model: 'opus', reasoning: (REASONING_TO_CLAUDE_CLI as any)[level] || 'medium' };
}

/**
 * Spawn a single CLI process via the unified
 * `lib/cli-agents` runner and return its plain-text output.
 *
 * All argv construction, reasoning-level mapping, and stdout parsing
 * lives in `lib/cli-agents` — this function only owns the LLM-service-
 * specific bits (concurrency gating, error-type translation, log-line
 * format). Adding a third CLI backend or changing an argv shape means
 * editing `lib/cli-agents`, not this file.
 */
async function _spawnCLI(prompt: any, options: any = {}, backend: any) {
  const { resolveAgent, normalizeReasoning, runCliAgent } = await import('../cli/cli-agents.js');
  const { model = DEFAULT_MODEL, timeout = 60, webSearch, thinking, sessionId, killMs, structuredOutput, outputSchema, signal, chatOnly, inferenceLimits } = options;

  const agent = resolveAgent(backend);
  if (!agent) {
    throw {
      type: LLMErrorTypes.ERROR,
      message: `Unknown CLI backend: "${backend}" (expected claude|codex|agy|gemini)`,
      retryable: false,
    };
  }
  // Fail loud rather than spawn a CLI that will drop the web-search request:
  // agy/gemini's argv builder ignores webSearch, so honouring it here would be a
  // silent memory-mode answer. Throws BEFORE any subprocess is spawned.
  assertCliCanWebSearch(agent.id, webSearch);
  assertCliCanStructureOutput(agent.id, structuredOutput);
  assertCliCanUseOutputSchema(agent.id, outputSchema);

  // Alias routing: 'opus' → claude model slug, 'gpt-5.*' → codex model slug.
  const mapping = _getCliMapping(model, agent.id, thinking);
  const canonicalReasoning = normalizeReasoning(mapping.reasoning || thinking);

  const startTime = Date.now();
  const reasoningLabel = canonicalReasoning ? `, reasoning: ${canonicalReasoning}` : '';
  const webSearchLabel = webSearch ? ', web search: on' : '';
  console.log(
    `[LLM-CLI] Calling ${agent.id} --model ${mapping.model}${reasoningLabel}${webSearchLabel} `
    + `(mapped from ${model}, prompt ${prompt.length} chars, queue: ${_cliActiveCount}/${getCliMaxConcurrent()})`,
  );

  try {
    const { stdout, stderr, durationMs, telemetryResult } = await runCliAgent({
      agent,
      prompt,
      model: mapping.model,
      reasoning: canonicalReasoning,
      webSearch,
	      timeoutSec: timeout,
	      killMs,
	      sessionId,
	      structuredOutput,
	      outputSchema,
	      signal,
	      chatOnly,
	      inferenceLimits,
	    });
    // Surface stderr even on successful runs — auth warnings,
    // rate-limit notices, and degraded-mode banners go there while the
    // final text still comes back on stdout. Dropping them silently
    // robs ops of a leading indicator when a backend starts to wobble.
    if (stderr && stderr.trim()) {
      console.warn(
        `[LLM-CLI] ${agent.id} stderr (non-fatal, ${stderr.length} chars): ${stderr.slice(0, 500).trim()}`,
      );
    }
    console.log(
      `[LLM-CLI] ${agent.id} response (${durationMs}ms, ${stdout.length} chars, model: ${mapping.model})`,
    );
    if (telemetryResult) {
      const usage = {
        agent: agent.id,
        model: mapping.model,
        reasoning: canonicalReasoning,
        durationMs,
        durationApiMs: telemetryResult.durationApiMs,
        inputTokens: telemetryResult.inputTokens,
        outputTokens: telemetryResult.outputTokens,
        costUsd: telemetryResult.costUsd,
        outputChars: stdout.length,
      };
      console.log(`[LLM-CLI-USAGE] ${JSON.stringify(usage)}`);
      if (typeof options.onUsage === 'function') options.onUsage(usage);
    }
    return stdout;
  } catch (errRaw) {
    const err = errRaw as any;
    // Translate the cli-agents error shape into llm-service's
    // LLMErrorTypes. PARSE_ERROR is the signal
    // callLLMWithStructuredOutput uses to decide whether the upstream
    // prompt-repair retry path is worth attempting.
    const durationMs = Date.now() - startTime;
    if (err && err.type === 'cli_agent.empty_output') {
      throw {
        type: LLMErrorTypes.PARSE_ERROR,
        message: err.message,
        retryable: true,
        stderr: err.stderr,
      };
    }
    console.error(
      `[LLM-CLI] ${agent.id} failure (${durationMs}ms, type: ${err?.type}): ${err?.message}`,
    );
    throw {
      type: LLMErrorTypes.ERROR,
      message: (err && err.message) || `${agent.id} CLI failed`,
      retryable: Boolean(err && err.retryable),
    };
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Available model markers for central CLI routing. */
const MODELS = {
  OPUS: 'anthropic/claude-opus-4.6',
  OPUS_46: 'anthropic/claude-opus-4.6',
  // Env-driven routing seams. Extraction defaults to the fast Codex model;
  // operators can still redirect it without changing individual call sites.
  //
  // These two keys were referenced silently from multiple callers
  // (extractors/ai-comparison, verticals, website-assessment, llm-
  // extractor, lib/briefing-worker, extractors/site-leads) where they
  // resolved to `undefined` and fell through to DEFAULT_MODEL via the
  // callLLM `options.model || DEFAULT_MODEL` coalesce. Defining them
  // here ends the silent no-op without introducing a production
  // routing swap.
  //
  // Getters (not eager consts): read injected config at property-access
  // time so configureLLM() (from the DI wrapper) takes effect after this
  // module loads. `MODELS.EXTRACTOR` access syntax is unchanged for
  // consumers.
  get EXTRACTOR(): string {
    return cfg('EXTRACTOR_MODEL') || EXTRACTOR_DEFAULT_MODEL;
  },
  get INTELLIGENCE(): string {
    return cfg('INTELLIGENCE_MODEL') || 'gpt-5.6-sol';
  },
  get PERSONA_CONSOLIDATION(): string {
    return cfg('PERSONA_CONSOLIDATION_MODEL') || 'gpt-5.4-mini';
  },
  /** Curriculum concept + prerequisite authoring. See
   * `curriculumAuthoringCallOptions` for why this is not the extractor. */
  get CURRICULUM_AUTHORING(): string {
    return cfg('CURRICULUM_MODEL') || 'gpt-6-astra';
  },
  /**
   * The web-search workhorse: a Gemini Flash on the Antigravity (`agy`) CLI,
   * whose built-in `search_web` / `read_url_content` tools do the fetching.
   *
   * Named here rather than inlined at each call site so "which model does our
   * web research" is ONE answer for the whole app. Pairs with
   * `backend: 'agy'` — a model string alone does not route.
   *
   * Flash rather than Pro deliberately: the work is fetch-and-report, the
   * expensive judgement happens in our own gate, and this runs per-item across
   * a batch. Override with `WEB_SEARCH_MODEL`.
   */
  get WEB_SEARCH(): string {
    return cfg('WEB_SEARCH_MODEL') || AGY_DEFAULT_MODEL;
  },
};

const DEFAULT_MODEL = MODELS.INTELLIGENCE;
const INTELLIGENCE_DEFAULT_REASONING = 'high';

/**
 * Canonical reasoning levels.
 *
 * Two tiers of "more than medium" exist:
 *   - `high`   — OpenRouter's unified `effort: 'high'`. Synthesis/analysis uses this for
 *                cross-provider calls.
 *   - `xhigh`  — An explicit exceptional override. OpenRouter exposes only
 *                low/medium/high, but the Claude and Codex CLIs accept xhigh.
 *                Normal intelligence synthesis defaults to high.
 *   - `max`    — Reserved. Not currently used by any callsite.
 */
// `ultra` sits above `max` and exists on only two codex families (Sol, Terra).
// It is in the canonical list so it can be ASKED for: a level absent from this
// array is not rejected, it is silently rewritten to the project default, so
// omitting `ultra` meant a caller requesting it quietly got `medium` — and a
// probe "testing ultra" would have been testing medium.
const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * Default reasoning effort for uncategorized LLM calls.
 *
 * Categorized work does not use this value: extractor calls are forced to
 * GPT-5.4 mini/low by `extractorCallOptions`, while intelligence generation
 * defaults to GPT-5.6/high at the routing boundary.
 *
 * Override the PROJECT default via LLM_DEFAULT_REASONING env var. Valid
 * values: off | minimal | low | medium | high | xhigh | max. Invalid values
 * log a warning at module load and fall back to 'medium'.
 */
const DEFAULT_REASONING = validateDefaultReasoningEnv();

function validateDefaultReasoningEnv() {
  const raw = cfg('LLM_DEFAULT_REASONING');
  if (!raw) return 'medium';
  const normalized = String(raw).toLowerCase().trim();
  if (REASONING_LEVELS.includes(normalized)) return normalized;
  console.warn(
    `[LLM] LLM_DEFAULT_REASONING="${raw}" is not a recognized level ` +
    `(expected: ${REASONING_LEVELS.join(', ')}). Falling back to 'medium'.`
  );
  return 'medium';
}

/**
 * Map our canonical reasoning level to the OpenRouter unified `effort` value.
 * OpenRouter exposes only low|medium|high — we collapse xhigh/max down to
 * 'high' (the ceiling) and 'minimal' up to 'low'. This is used only when
 * a caller did NOT pass a numeric budget; numeric budgets are sent as
 * `reasoning.max_tokens` with no `effort` (see makeOpenRouterRequest).
 *
 * Reference: https://openrouter.ai/docs/use-cases/reasoning-tokens — the
 * `effort` field and `max_tokens` field are mutually exclusive; sending
 * both silently favors `effort` on most providers. So we send ONE or the
 * OTHER, never both.
 */
const REASONING_TO_OPENROUTER_EFFORT = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high', // OpenRouter ceiling is 'high'
  max: 'high'
};

/**
 * Map our canonical reasoning level to the Claude Code CLI `--effort` flag.
 * The CLI accepts: low | medium | high | xhigh | max. We map 'minimal' and
 * 'off' to 'low' since the CLI has no disable switch — setting effort to
 * 'low' is the closest we can get to "no extended thinking" on the CLI path.
 * xhigh and max pass through to the CLI natively (these tiers are where
 * the admin path gets more reasoning than the OpenRouter path can express).
 */
const REASONING_TO_CLAUDE_CLI = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  // The claude CLI's ceiling is `max`; `ultra` is codex-only.
  ultra: 'max'
};

/**
 * Normalize various legacy reasoning/thinking values to our canonical levels.
 * Accepts booleans, strings like 'on'/'off'/'high'/'medium'/etc., and
 * null/undefined (falls back to the project default).
 *
 * Legacy values seen in the codebase:
 *   - `thinking: 'off'`     → 'off'
 *   - `thinking: 'on'`      → default (medium)
 *   - `thinking: 'high'`    → 'high' (explicit override preserved)
 *   - `thinking: 'xhigh'`   → 'xhigh' (synthesis/analysis callsites)
 *   - `thinking: true`      → default
 *   - `thinking: false`     → 'off'
 */
function normalizeReasoning(value: any) {
  if (value == null) return DEFAULT_REASONING;
  if (value === false) return 'off';
  if (value === true) return DEFAULT_REASONING;
  const s = String(value).toLowerCase().trim();
  if (s === 'on' || s === 'default' || s === '') return DEFAULT_REASONING;
  if (REASONING_LEVELS.includes(s)) return s;
  // Unknown string — fall back to default rather than silently disabling.
  return DEFAULT_REASONING;
}

/**
 * OpenRouter API configuration
 */
const OPENROUTER_CONFIG = {
  baseUrl: 'https://openrouter.ai/api/v1/chat/completions',
  // Getter (not eager): read injected config at access time so configureLLM()
  // can set OPENROUTER_API_KEY after this module loads. Access syntax
  // (`OPENROUTER_CONFIG.apiKey`) is unchanged for the two readers
  // (makeOpenRouterRequest, isLLMAvailable).
  get apiKey(): string | undefined {
    return cfg('OPENROUTER_API_KEY');
  },
};

/**
 * Retry configuration for transient failures
 */
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 10000
};

// =============================================================================
// STRUCTURED OUTPUT + TRACE LOGGING
// =============================================================================

function createLLMTraceId(label = 'llm') {
  const safeLabel = String(label || 'llm')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return `${safeLabel || 'llm'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function logLLMTrace(traceId: any, level: any, message: any, meta: any = {}, onProgress: any = null) {
  const prefix = `[LLM:${traceId}]`;
  const details = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const line = `${prefix} ${message}${details}`;
  logEvent(level, 'llm.trace', {
    source: 'llm-service',
    traceId,
    message,
    ...meta
  }, { persist: level === 'warn' || level === 'error' });
  if (typeof onProgress === 'function') {
    onProgress(`${line}`);
  }
}

/**
 * One LLM policy for site extractors and event enrichment. Callers retain only
 * operational differences such as timeout and whether web search is required.
 */
/** CLI backends extraction may be pointed at. */
const EXTRACTOR_BACKENDS: ReadonlySet<string> = new Set(['claude', 'codex', 'agy']);

/**
 * Which CLI backend extraction runs on.
 *
 * This used to be the bare literal 'agy'. A hardcoded provider is a single
 * point of failure with no way out that does not require a code change: when
 * the agy account hit its quota ("Individual quota reached ... Resets in
 * 144h") EVERY extraction failed with "agy CLI returned empty output" and
 * there was no supported way to route around it, even though `.env` already
 * said LLM_BACKEND=claude-code.
 *
 * An unknown value THROWS rather than falling back — a typo'd backend must
 * never quietly send extraction to a different provider than the operator
 * asked for.
 */
function extractorBackend(): string {
  const configured = String(cfg('EXTRACTOR_LLM_BACKEND') ?? '').trim().toLowerCase();
  if (!configured) return EXTRACTOR_DEFAULT_BACKEND;
  if (!EXTRACTOR_BACKENDS.has(configured)) {
    throw new Error(
      `EXTRACTOR_LLM_BACKEND must be one of ${[...EXTRACTOR_BACKENDS].join(', ')}; got "${configured}"`,
    );
  }
  return configured;
}

// Operator decision 2026-09-07 (evening): extraction runs on Codex GPT-5.6
// Luna at HIGH effort with a 400k-token payload throttle (model-catalog
// LUNA_INPUT_BUDGET_TOKENS). It replaced Antigravity's Gemini Flash (3.7 then
// 3.8, medium) after marker probes showed the agy CLI silently keeps only the
// first ~200k chars of stdin. All three remain env-overridable
// (EXTRACTOR_LLM_BACKEND / EXTRACTOR_MODEL / EXTRACTOR_REASONING) so a quota
// outage is a config change, not a deploy.
const EXTRACTOR_DEFAULT_BACKEND = 'codex';
const EXTRACTOR_DEFAULT_MODEL = 'gpt-5.6-luna';
const EXTRACTOR_DEFAULT_REASONING = 'high';

/** Extractor reasoning level; the catalogue clamps it to what the model offers. */
function extractorReasoning(): string {
  const configured = String(cfg('EXTRACTOR_REASONING') ?? '').trim().toLowerCase();
  return configured || EXTRACTOR_DEFAULT_REASONING;
}

/** Env name of a workflow step's own payload throttle: `EXTRACTOR_INPUT_BUDGET_TOKENS_JOBS`, `…_EVENTS`, …. */
export function extractorStepBudgetEnvName(type: string): string {
  return `EXTRACTOR_INPUT_BUDGET_TOKENS_${type.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Characters of corpus ONE extraction prompt may carry — the batch size every
 * extractor windows or bounds its corpus to. Resolved from the catalogue for
 * the extractor backend + model selected above, so switching backends in
 * `.env` re-sizes every prompt with it. Two levels of throttle sit above the
 * catalogue (most specific wins, see `resolveExtractorInputBudgetTokens`):
 *   - provider:      `EXTRACTOR_INPUT_BUDGET_TOKENS` in env
 *   - workflow step: `EXTRACTOR_INPUT_BUDGET_TOKENS_<TYPE>` in env, then the
 *                    `inputBudgetTokens` the extraction-type registry entry
 *                    declares — passed in as `step` by the extraction spine.
 */
function extractorInputBudgetChars(step?: ExtractorInputBudgetStep | null): number {
  return resolveExtractorInputBudgetChars({
    backend: extractorBackend(),
    model: MODELS.EXTRACTOR,
    overrideTokens: cfg('EXTRACTOR_INPUT_BUDGET_TOKENS'),
    step: step
      ? {
          ...step,
          overrideTokens:
            step.overrideTokens ??
            (injectedConfig as Record<string, string | undefined>)[extractorStepBudgetEnvName(step.type)] ??
            process.env[extractorStepBudgetEnvName(step.type)],
        }
      : null,
  });
}

/**
 * Seconds one extraction prompt is allowed before the CLI is terminated, as
 * a FLOOR under whatever the extractor asked for. Extractors ask for 60-180s,
 * numbers tuned when a window was 240k chars; a Luna window is up to 984k
 * chars and a 559k-char jobs prompt measured 101s at high effort
 * (2026-09-07), so the floor scales with the provider-level input budget:
 * one second per `EXTRACTOR_CHARS_PER_TIMEOUT_SECOND` characters of budget
 * (984k → 394s). `EXTRACTOR_LLM_TIMEOUT_SEC` in env pins the floor outright.
 */
const EXTRACTOR_CHARS_PER_TIMEOUT_SECOND = 2_500;
export function extractorTimeoutFloorSec(): number {
  const pinned = String(cfg('EXTRACTOR_LLM_TIMEOUT_SEC') ?? '').trim();
  if (pinned) {
    const seconds = Number(pinned);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      throw new Error(`EXTRACTOR_LLM_TIMEOUT_SEC must be a positive integer number of seconds; got "${pinned}"`);
    }
    return seconds;
  }
  return Math.ceil(extractorInputBudgetChars() / EXTRACTOR_CHARS_PER_TIMEOUT_SECOND);
}

/**
 * One centralized policy for extractor CLI, model, and reasoning. Individual
 * extractors supply only operational options such as timeout and web search.
 * Provider/model/reasoning are authoritative here; call sites may supply only
 * operational options such as timeout, usage callbacks, and web search.
 */
function extractorCallOptions(options: any = {}) {
  const requested = Number.isFinite(Number(options.timeout)) ? Math.max(1, Number(options.timeout)) : 60;
  const timeout = Math.max(requested, extractorTimeoutFloorSec());
  return {
    ...options,
    timeout,
    // Extractors already retry per corpus window. Do not let one wedged CLI
    // consume the generic runner's additional two-minute startup allowance;
    // terminate shortly after the extractor's own logical timeout so the same
    // pure window can retry through the existing shared loop.
    // A caller's own kill timer is honoured only when it is not SHORTER than
    // the floored timeout: events-extractor passed killMs 125_000 against a
    // 394s floor (2026-09-07, yseop.com), so every 300k-char Luna call died
    // at 125s while the error blamed a 394s timeout. The floor wins.
    killMs: Math.max(Number(options.killMs) || 0, (timeout + 15) * 1000),
    backend: extractorBackend(),
    model: MODELS.EXTRACTOR,
    thinking: extractorReasoning(),
    // An extraction prompt carries a crawled page — untrusted text — and reads facts off it.
    // The CLI backends default to an agentic toolset (shell, sub-agents, web search), which an
    // extraction has no use for: RAPS run 5 (2026-09-14) measured a talk window spending its
    // whole 394s budget on web searches for the speakers in its own corpus, and a page that
    // tells the model to fetch a URL is an exfiltration path while the shell can read .env.
    // Only a caller that asks for the web (event verification) keeps its tools.
    chatOnly: !options.webSearch,
  };
}

/**
 * Curriculum authoring — a DIFFERENT trade from extraction, and the reason it
 * is its own policy rather than a model argument at the call site.
 *
 * Extraction reads a large corpus and pulls facts out of it, so its default
 * (Luna, 400k-token payload, high) is tuned for input size. Writing a
 * curriculum's concept network is the opposite shape: the prompt is one lane of
 * an already-approved outline — small — and the work is authoring judgement
 * about what the ideas in a field ARE and how they depend on each other. Run
 * aa35c90b (2026-09-09) wrote 38 concepts over 22 modules where the hand-built
 * seed carries 4.99 per module, and the concept names were transcribed session
 * headings. The prompt is the larger half of that fix; the model is the rest.
 *
 * Env-overridable like every other backend seam (runbook, LLM Backend
 * Requirements #1): a quota outage is routed around in `.env`, never in code.
 *
 * The timeout is generous and deliberately NOT the extractor floor, which is
 * derived from the INPUT budget and so says nothing about a call whose cost is
 * all output: one lane now returns five times the concepts it used to.
 */
function curriculumAuthoringCallOptions(options: any = {}) {
  const requested = Number.isFinite(Number(options.timeout)) ? Math.max(1, Number(options.timeout)) : 0;
  const pinned = Number(cfg('CURRICULUM_LLM_TIMEOUT_SEC'));
  const timeout = Math.max(requested, Number.isFinite(pinned) && pinned > 0 ? pinned : 900);
  return {
    ...options,
    timeout,
    killMs: Math.max(Number(options.killMs) || 0, (timeout + 15) * 1000),
    backend: cfg('CURRICULUM_LLM_BACKEND') || 'codex',
    model: MODELS.CURRICULUM_AUTHORING,
    thinking: cfg('CURRICULUM_REASONING') || 'high',
  };
}

/** Cheap semantic grouping is distinct from evidence synthesis. */
function personaConsolidationCallOptions(options: any = {}) {
  return {
    ...options,
    backend: 'codex',
    model: MODELS.PERSONA_CONSOLIDATION,
    thinking: 'off',
  };
}

/**
 * Web-grounded triage for deterministic extraction quality warnings.
 *
 * ALL FOUR SEAMS ARE ENV-OVERRIDABLE, like every other backend seam (runbook,
 * LLM Backend Requirements #1): a quota outage is routed around in `.env`,
 * never in code. Until 2026-10-21 only the MODEL was — backend and effort were
 * literals — and that combination is worse than no override at all, because
 * `_getCliMapping` rewrites a non-`gpt-5*` model to `gpt-5.6-sol` when the
 * backend is codex. Setting `QUALITY_INVESTIGATION_MODEL=opus` against the
 * pinned codex backend therefore did not fail; it silently ran the old model,
 * which is the shape of change that looks applied in `.env` and is not.
 *
 * The timeout is a seam for the same reason the others are: effort and timeout
 * are not independent. A `high`-effort call reasons for longer before it emits
 * anything, so raising the effort without raising the ceiling converts a better
 * answer into a kill at 90 s.
 */
function qualityInvestigationCallOptions(options: any = {}) {
  const requested = Number.isFinite(Number(options.timeout)) ? Math.max(1, Number(options.timeout)) : 0;
  const pinned = Number(cfg('QUALITY_INVESTIGATION_LLM_TIMEOUT_SEC'));
  const timeout = Math.max(requested, Number.isFinite(pinned) && pinned > 0 ? pinned : 90);
  return {
    ...options,
    policy: 'quality-investigation',
    backend: cfg('QUALITY_INVESTIGATION_BACKEND') || 'codex',
    model: cfg('QUALITY_INVESTIGATION_MODEL') || 'gpt-5.6-sol',
    thinking: cfg('QUALITY_INVESTIGATION_REASONING') || 'medium',
    webSearch: true,
    killMs: Math.max(Number(options.killMs) || 0, (timeout + 15) * 1000),
    timeout,
  };
}

/**
 * How many times a structured-output call is re-sent after the CLI was killed
 * by its own timeout. ONE, for every caller (env LLM_TIMEOUT_RETRIES): the
 * jobs extractor on nice.com and vocca.com (2026-09-07) failed their whole
 * workflow on a single 120 s agy timeout that a second try answers in
 * seconds — the timeout was the process under load, not the prompt. The old
 * rule ("never retry a timeout, it only burns another window") was written
 * when one window was 45 min of Chromium; an extractor window is two minutes.
 */
export const DEFAULT_TIMEOUT_RETRIES = Math.max(0, Number.parseInt(process.env.LLM_TIMEOUT_RETRIES || '1', 10) || 0);

const CLI_TIMEOUT_FAILURE = /exit(ed)? with code 143|SIGTERM|SIGKILL|timed out|cli_agent\.timeout/i;
/**
 * The provider (not the prompt) failed: a 5xx / UNAVAILABLE / rate limit from
 * the model service surfaced through the CLI's error envelope. Seen 2026-09-07
 * on Orange events window 6/14 — `Eligibility check failed: UNAVAILABLE (code
 * 503)` — which was then "retried with stricter JSON" (nothing to be stricter
 * about) and the window was dropped. Retried with the SAME prompt after a short
 * backoff, on its own budget, never spending a parse retry.
 */
const CLI_TRANSIENT_FAILURE = /UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|\(code (?:429|500|502|503|504|529)\)|status[" :]+(?:429|500|502|503|504|529)\b|overloaded|rate.?limit|ECONNRESET|ETIMEDOUT|socket hang up/i;
export const DEFAULT_TRANSIENT_RETRIES = Math.max(0, Number.parseInt(process.env.LLM_TRANSIENT_RETRIES || '2', 10) || 0);
const TRANSIENT_RETRY_BACKOFF_MS = 4_000;

/**
 * Pure retry policy for callLLMWithStructuredOutput. A timeout is retried with
 * the ORIGINAL prompt up to `timeoutRetries` times and does not spend a parse
 * retry; a parse/validation failure is retried with the stricter prompt up to
 * `maxParseRetries` times. Mutates `state` so the loop can build the next prompt.
 */
export function structuredOutputRetryDecision(
  state: { parseFailures: number; timeouts: number; lastWasTimeout: boolean; transients?: number },
  message: string,
  limits: { maxParseRetries: number; timeoutRetries: number; transientRetries?: number },
): 'retry-timeout' | 'retry-transient' | 'retry-parse' | 'stop' {
  if (CLI_TIMEOUT_FAILURE.test(message)) {
    state.lastWasTimeout = true;
    if (state.timeouts >= limits.timeoutRetries) return 'stop';
    state.timeouts += 1;
    return 'retry-timeout';
  }
  if (CLI_TRANSIENT_FAILURE.test(message)) {
    // Same prompt again (lastWasTimeout doubles as "re-send the original").
    state.lastWasTimeout = true;
    const used = state.transients ?? 0;
    if (used >= (limits.transientRetries ?? DEFAULT_TRANSIENT_RETRIES)) return 'stop';
    state.transients = used + 1;
    return 'retry-transient';
  }
  state.lastWasTimeout = false;
  if (state.parseFailures >= limits.maxParseRetries) return 'stop';
  state.parseFailures += 1;
  return 'retry-parse';
}

/**
 * Call LLM and parse structured output with one parse retry + trace logging.
 *
 * Source of truth pattern for LLM usage:
 * - Always use this helper for structured outputs (JSON/object/array).
 * - parseFn MUST throw if output is invalid or schema checks fail.
 * - This wrapper logs a trace id to console for auditability and also
 *   forwards those same trace lines to onProgress for UI visibility.
 *
 * @param {Object} params
 * @param {string} params.prompt
 * @param {Function} params.parseFn - Must throw on parse/validation failure
 * @param {string} params.label
 * @param {Object} params.callOptions
 * @param {string} [params.callOptions.effort] - Canonical CLI effort. This is
 *   an explicit alias for the legacy `thinking` field and takes precedence.
 * @param {Function} [params.onProgress]
 * @param {number} [params.maxParseRetries] - Default 1 (one retry)
 * @param {string} [params.retryPromptSuffix] - Additional instruction for retry
 * @param {boolean} [params.includeParseFailureFeedback] - Include the rejected
 *   response and bounded validator error in parse-repair retries. Opt in only
 *   for prompts whose source material is already present in the request.
 * @returns {Promise<*>} Parsed result
 */
export function structuredOutputAttemptLimit(maxParseRetries:number,timeoutRetries:number,maxAttempts?:number) {
  const policyLimit=1+Math.max(0,maxParseRetries)+Math.max(0,timeoutRetries)+DEFAULT_TRANSIENT_RETRIES;
  if(maxAttempts===undefined)return policyLimit;
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1)throw new Error('maxAttempts must be a positive integer');
  return Math.min(policyLimit,maxAttempts);
}

async function callLLMWithStructuredOutput({
  prompt,
  parseFn,
  label = 'structured-output',
  callOptions = {},
  outputSchema,
  onProgress = null,
  maxParseRetries = 1,
  retryPromptSuffix = 'IMPORTANT: Return ONLY valid JSON. Do not include extra text, markdown, or code fences.',
  includeParseFailureFeedback = false,
  timeoutRetries = DEFAULT_TIMEOUT_RETRIES
  // Without this annotation, the default `onProgress = null` causes tsc to
  // narrow the exported param type to `null`. `any` keeps the runtime
  // unchanged and the exported signature permissive.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}: any = {}): Promise<any> {
  const traceId = createLLMTraceId(label);
  const requestedCallOptions = {
    ...callOptions,
    ...(callOptions.effort ? { thinking: callOptions.effort } : {}),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
  const requestedModel = requestedCallOptions?.model || DEFAULT_MODEL;
  const effectiveCallOptions = requestedCallOptions.policy === 'quality-investigation'
    ? qualityInvestigationCallOptions(requestedCallOptions)
    // An explicit backend/model/effort selection is a benchmark or
    // configurator decision, not an invocation of the default extractor role.
    // Preserve it instead of silently applying extractorCallOptions (`off`).
    : requestedModel === MODELS.EXTRACTOR && !requestedCallOptions.backend
      ? extractorCallOptions(requestedCallOptions)
      : requestedModel === MODELS.INTELLIGENCE
        ? { thinking: INTELLIGENCE_DEFAULT_REASONING, ...requestedCallOptions, model: MODELS.INTELLIGENCE }
        : requestedCallOptions;
  const model = effectiveCallOptions?.model || DEFAULT_MODEL;
  const timeout = effectiveCallOptions?.timeout || 60;
  const backend = effectiveCallOptions?.backend
    || (model === MODELS.EXTRACTOR ? extractorBackend()
      : model === MODELS.INTELLIGENCE ? 'codex'
        : cfg('LLM_BACKEND') === 'claude-code' ? 'claude-code'
          : shouldUseAdminCLI() ? adminCliBackend()
            : getLLMProvider());
  const requestedThinking = effectiveCallOptions?.thinking || DEFAULT_REASONING;
  const thinking = ['codex', 'claude', 'agy', 'gemini'].includes(backend)
    ? _getCliMapping(model, backend === 'gemini' ? 'agy' : backend, requestedThinking).reasoning
    : normalizeReasoning(requestedThinking);
  const totalAttempts = structuredOutputAttemptLimit(maxParseRetries,timeoutRetries,callOptions.maxAttempts);
  const trace = (level: string, message: string, meta: Record<string, unknown> = {}) =>
    logLLMTrace(traceId, level, message, { backend, model, thinking, ...meta }, onProgress);

  trace('info', `${label} start`, { timeout, attempts: totalAttempts });

  let lastError = null;
  let rejectedResponse = null;
  const retryState = { parseFailures: 0, timeouts: 0, lastWasTimeout: false, transients: 0 };

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const repairContext = includeParseFailureFeedback && attempt > 1 && !retryState.lastWasTimeout && rejectedResponse !== null
      ? `\n\nYour previous response failed validation. Correct the complete JSON object without weakening or evading the stated constraints.\nVALIDATION ERROR:\n${String(lastError?.message || lastError || 'unknown validation failure').slice(0, 4_000)}\nPREVIOUS REJECTED RESPONSE:\n${String(rejectedResponse).slice(0, 6_000)}`
      : '';
    // A timeout retry re-sends the ORIGINAL prompt: nothing was parsed, so
    // there is nothing to be stricter about.
    const retryPrompt = attempt === 1 || retryState.lastWasTimeout
      ? prompt
      : `${prompt}\n\n${retryPromptSuffix}${repairContext}`;
    trace('info', `${label} attempt ${attempt}/${totalAttempts}`, { timeout });
    try {
      // Keep AGY's legacy boolean envelope only when the caller did not supply
      // an explicit schema. Explicit schemas travel unchanged to every CLI
      // backend that advertises native enforcement.
      const response = await callLLM(retryPrompt, {
        ...effectiveCallOptions,
        structuredOutput: outputSchema === undefined && ['agy', 'gemini'].includes(String(backend).toLowerCase()),
      });
      rejectedResponse = typeof response === 'string'
        ? response
        : (typeof response?.content === 'string' ? response.content : JSON.stringify(response));
      const responseLength = typeof response === 'string'
        ? response.length
        : (typeof response?.content === 'string' ? response.content.length : 0);
      trace('info', `${label} response received`, { length: responseLength });
      const parsed = parseFn(response);
      trace('info', `${label} parse success`, { attempt });
      return parsed;
    } catch (errorRaw) {
      const error = errorRaw as any;
      lastError = error;
      trace('warn', `${label} parse failed`, { attempt, error: error.message || String(error) });
      const decision = structuredOutputRetryDecision(retryState, error.message || String(error), {
        maxParseRetries,
        timeoutRetries,
      });
      if (decision === 'stop') {
        trace('error', `${label} failed after ${attempt} attempts`);
        break;
      }
      if (decision === 'retry-timeout') {
        trace('warn', `${label} killed by timeout — retrying once with the same prompt (${retryState.timeouts}/${timeoutRetries})`);
        continue;
      }
      if (decision === 'retry-transient') {
        const backoffMs = TRANSIENT_RETRY_BACKOFF_MS * retryState.transients;
        trace('warn', `${label} provider unavailable — retrying the same prompt in ${backoffMs}ms (${retryState.transients}/${DEFAULT_TRANSIENT_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      trace('info', `${label} retrying with stricter JSON`);
    }
  }

  throw lastError || new Error(`${label} parse failed`);
}

// =============================================================================
// ERROR TYPES
// =============================================================================

/**
 * Error types for LLM service failures
 * Use these to handle specific error conditions
 */
const LLMErrorTypes = {
  RATE_LIMIT: 'LLM_RATE_LIMIT',
  NO_CREDITS: 'LLM_NO_CREDITS', 
  TOKEN_LIMIT: 'LLM_TOKEN_LIMIT',
  TIMEOUT: 'LLM_TIMEOUT',
  UNAVAILABLE: 'LLM_UNAVAILABLE',
  PARSE_ERROR: 'LLM_PARSE_ERROR',
  AUTH_ERROR: 'LLM_AUTH_ERROR',
  ERROR: 'LLM_ERROR'
};

// =============================================================================
// WEB-SEARCH CAPABILITY GUARD
// =============================================================================

/**
 * CLI backends whose argv builder actually enables a web-search tool:
 * `claude` (`--allowed-tools WebSearch`), `codex` (`-c tools.web_search=true`)
 * and `agy` (`--dangerously-skip-permissions`, which lets its built-in
 * `search_web` / `read_url_content` TOOLS run — in `--print` mode a tool call
 * otherwise waits for an approval nobody can give) — all in lib/cli/cli-agents.ts.
 *
 * `gemini` is NOT here: the standalone gemini CLI is unusable on this host (the
 * API key's free tier reports `limit: 0`, so every model 429s). The repo aliases
 * `gemini` to AGENTS.AGY anyway, so Gemini models are reached through agy.
 *
 * Verified for agy on 2026-08-20 rather than assumed: asked it to list the
 * outbound links on a known page and it returned a calendly slug byte-identical
 * to a Firecrawl scrape — unguessable from parametric memory — plus four
 * JS-rendered links the scrape missed.
 *
 * Anything absent from this set that is handed `webSearch: true` THROWS
 * (assertCliCanWebSearch) rather than silently answering from memory. That is
 * the fail-open bug this allowlist exists to prevent; the `ai-sdk-provider-
 * claude-code` path (`callClaudeCodeSdk`) runs `generateText` with no tools and
 * is routed to the claude CLI instead.
 */
const WEBSEARCH_CAPABLE_CLI: ReadonlySet<string> = new Set(['claude', 'codex', 'agy']);

export function cliBackendSupportsWebSearch(agentId: string): boolean {
  return WEBSEARCH_CAPABLE_CLI.has(String(agentId || '').toLowerCase());
}

/**
 * Fail LOUD when `webSearch: true` is requested but the resolved CLI backend
 * cannot honour it. A requested capability that is unavailable must be an ERROR,
 * not a silent downgrade — degrading to a memory-mode answer is exactly the
 * fail-open bug that produced confident, hallucinated results while every caller
 * believed it had searched. No-ops when web search was not requested.
 */
export function assertCliCanWebSearch(agentId: string, webSearch: unknown): void {
  if (!webSearch) return;
  if (cliBackendSupportsWebSearch(agentId)) return;
  throw {
    type: LLMErrorTypes.ERROR,
    message:
      `Web search requested (webSearch: true) but CLI backend "${agentId}" cannot honour it — `
      + `only claude/codex enable a web-search tool. Refusing to answer from model memory `
      + `(fail-open capability downgrade).`,
    retryable: false,
  };
}

/**
 * Backends supporting the legacy boolean structuredOutput envelope. Codex's
 * explicit outputSchema is separate and does not change boolean semantics.
 */
const STRUCTURED_OUTPUT_CAPABLE_CLI: ReadonlySet<string> = new Set(['agy']);
const OUTPUT_SCHEMA_CAPABLE_CLI: ReadonlySet<string> = new Set(['codex', 'claude', 'agy']);

export function cliBackendSupportsStructuredOutput(agentId: string): boolean {
  return STRUCTURED_OUTPUT_CAPABLE_CLI.has(String(agentId || '').toLowerCase());
}

export function cliBackendSupportsOutputSchema(agentId: string): boolean {
  const normalized = String(agentId || '').toLowerCase();
  return OUTPUT_SCHEMA_CAPABLE_CLI.has(normalized === 'gemini' ? 'agy' : normalized);
}

export function assertCliCanUseOutputSchema(agentId: string, outputSchema: unknown): void {
  if (outputSchema === undefined) return;
  if (cliBackendSupportsOutputSchema(agentId)) return;
  throw new Error(
    `outputSchema requested but CLI backend "${agentId || 'unknown'}" cannot enforce an explicit JSON Schema`,
  );
}

/**
 * Fail LOUD when `structuredOutput: true` is requested but the resolved CLI
 * backend would drop it.
 *
 * Same fail-open shape as `assertCliCanWebSearch`, one capability over, and the
 * one AGENTS.md names as still outstanding. A silently-ignored schema is worse
 * than a missing one: the call succeeds, returns prose where an object was
 * promised, and the failure surfaces later as a parse error somewhere that has
 * no idea a schema was ever requested.
 *
 * This guards the DIRECT `callLLM` path. `callLLMWithStructuredOutput` already
 * sends the legacy flag only to agy. Codex callers can separately provide an
 * outputSchema object for native enforcement; parseFn still validates semantics.
 */
export function assertCliCanStructureOutput(agentId: string, structuredOutput: unknown): void {
  if (!structuredOutput) return;
  if (cliBackendSupportsStructuredOutput(agentId)) return;
  throw {
    type: LLMErrorTypes.ERROR,
    message:
      `Structured output requested (structuredOutput: true) but CLI backend "${agentId}" cannot honour it — `
      + `only agy implements a --json-schema flag. Use callLLMWithStructuredOutput, which enforces the shape `
      + `with a parseFn instead (fail-open capability downgrade).`,
    retryable: false,
  };
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Sleep for a given number of milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay
 * @param {number} attempt - Current attempt number (0-indexed)
 * @returns {number} Delay in milliseconds
 */
function getBackoffDelay(attempt: number) {
  const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(delay + jitter, RETRY_CONFIG.maxDelayMs);
}

/**
 * Classify OpenRouter error response
 * @param {number} statusCode - HTTP status code
 * @param {Object} body - Response body
 * @returns {Object} { type: LLMErrorType, message: string, retryable: boolean }
 */
function classifyError(statusCode: any, body: any) {
  const errorMessage = body?.error?.message || body?.error || 'Unknown error';
  
  // Rate limiting
  if (statusCode === 429) {
    return {
      type: LLMErrorTypes.RATE_LIMIT,
      message: `Rate limit exceeded: ${errorMessage}`,
      retryable: true
    };
  }
  
  // Authentication errors
  if (statusCode === 401 || statusCode === 403) {
    return {
      type: LLMErrorTypes.AUTH_ERROR,
      message: `Authentication failed: ${errorMessage}`,
      retryable: false
    };
  }
  
  // Payment/credits errors
  if (statusCode === 402) {
    return {
      type: LLMErrorTypes.NO_CREDITS,
      message: `Payment required / out of credits: ${errorMessage}`,
      retryable: false
    };
  }
  
  // Token limit exceeded
  if (statusCode === 400 && errorMessage.toLowerCase().includes('token')) {
    return {
      type: LLMErrorTypes.TOKEN_LIMIT,
      message: `Token limit exceeded: ${errorMessage}`,
      retryable: false
    };
  }
  
  // Server errors (retryable)
  if (statusCode >= 500) {
    return {
      type: LLMErrorTypes.ERROR,
      message: `Server error (${statusCode}): ${errorMessage}`,
      retryable: true
    };
  }
  
  // Other client errors
  return {
    type: LLMErrorTypes.ERROR,
    message: `Request failed (${statusCode}): ${errorMessage}`,
    retryable: false
  };
}

// =============================================================================
// MAIN LLM CALL FUNCTION
// =============================================================================

/**
 * Make a request to OpenRouter API
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Configuration options
 * @returns {Promise<string>} The LLM response text
 */
function mergePlugins(plugins: any[] = [], webSearch: any = false) {
  const normalizedPlugins = Array.isArray(plugins)
    ? plugins.filter((plugin) => plugin && typeof plugin === 'object')
    : [];

  if (!webSearch) {
    return normalizedPlugins;
  }

  const webPluginConfig: Record<string, unknown> = (typeof webSearch === 'object' && webSearch !== null)
    ? { ...(webSearch as Record<string, unknown>) }
    : {};

  if (normalizedPlugins.some((plugin: any) => plugin.id === 'web')) {
    return normalizedPlugins;
  }

  return [
    ...normalizedPlugins,
    { id: 'web', ...webPluginConfig }
  ];
}

async function makeOpenRouterRequest(prompt: any, options: any = {}) {
  const {
    model = DEFAULT_MODEL,
    timeout = 60,
    thinking,
    reasoningMaxTokens,  // optional numeric budget override (rare)
    plugins = [],
    webSearch = false,
    returnMetadata = false,
    apiKeyOverride = null  // COM-4: user-provided key takes precedence over server key
  } = options;

  // COM-4: Use user's key if provided, otherwise fall back to server key.
  // If neither exists, the LLM is truly unavailable.
  const effectiveApiKey = apiKeyOverride || OPENROUTER_CONFIG.apiKey;
  if (!effectiveApiKey) {
    throw new Error(`${LLMErrorTypes.UNAVAILABLE}: No OpenRouter API key available (no server key and no user key)`);
  }

  // Loose any — OpenRouter request body has dynamic plugin/reasoning fields
  // assigned conditionally below. Tightening would require a full provider
  // schema; not in scope for this type-enforcement pilot.
  const requestBody: any = {
    model,
    messages: [
      { role: 'user', content: prompt }
    ],
    max_tokens: 16000,
    temperature: 0.7
  };

  const mergedPlugins = mergePlugins(plugins, webSearch);
  if (mergedPlugins.length > 0) {
    requestBody.plugins = mergedPlugins;
  }

  // Extended thinking / reasoning.
  //
  // OpenRouter's `reasoning` object accepts EITHER `effort` (unified preset:
  // low|medium|high) OR `max_tokens` (numeric budget for Anthropic) — not both.
  // https://openrouter.ai/docs/use-cases/reasoning-tokens
  //
  // Sending both silently has `effort` win on most providers and `max_tokens`
  // is ignored. So we send ONE or the OTHER:
  //   - Normal path: preset level → send `{ effort }` only.
  //   - Explicit numeric budget via `reasoningMaxTokens`: send `{ max_tokens }`.
  //
  // Default is DEFAULT_REASONING ('medium'). Callsites override via
  // `thinking: 'off'|'low'|'high'|'xhigh'|…` and the env var
  // LLM_DEFAULT_REASONING tunes the project default.
  //
  // Note: 'xhigh' and 'max' collapse to OpenRouter `effort: 'high'` (the
  // ceiling OpenRouter exposes). The Claude Code CLI path honors xhigh/max
  // natively via `--effort` — see _spawnCLI.
  const reasoningLevel = normalizeReasoning(thinking);
  if (reasoningLevel !== 'off') {
    if (Number.isFinite(reasoningMaxTokens) && reasoningMaxTokens > 0) {
      // Explicit numeric budget — rare, caller opted in.
      requestBody.reasoning = { max_tokens: Math.floor(reasoningMaxTokens) };
    } else {
      const effort = (REASONING_TO_OPENROUTER_EFFORT as any)[reasoningLevel] || 'medium';
      requestBody.reasoning = { effort };
    }
  }
  
  const requestData = JSON.stringify(requestBody);
  
  const urlObj = new URL(OPENROUTER_CONFIG.baseUrl);
  const requestOptions = {
    hostname: urlObj.hostname,
    port: urlObj.port || 443,
    path: urlObj.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestData),
      'Authorization': `Bearer ${effectiveApiKey}`,
      'HTTP-Referer': 'https://biz-tools.local',
      'X-Title': 'Biz Tools'
    },
    timeout: (timeout + 10) * 1000
  };
  
  // One Langfuse generation per request, priced by Langfuse from the usage the
  // provider reports. OpenRouter's prompt_tokens include cached tokens.
  const startedAt = Date.now();
  let served: any = null;
  const trace = (failed: boolean, statusMessage: string | null) => {
    const usage = served?.usage;
    const cached = Number(usage?.prompt_tokens_details?.cached_tokens) || 0;
    void recordGeneration({
      callId: randomUUID(), system: 'openrouter', model: served?.model || model, startedAt, endedAt: Date.now(),
      usage: usage ? { input: Math.max(0, (Number(usage.prompt_tokens) || 0) - cached), output: Number(usage.completion_tokens) || 0, cacheRead: cached, cacheWrite: Number(usage.prompt_tokens_details?.cache_write_tokens) || null } : null,
      failed, statusMessage, ...traceIdentity(), metadata: { requestedModel: model, providerReportedCostUsd: usage?.cost ?? null },
    });
  };

  return new Promise((resolve, reject) => {
    const transport = urlObj.protocol === 'https:' ? https : http;
    
    const req = transport.request(requestOptions, (res: any) => {
      let data = '';
      
      res.on('data', (chunk: any) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          served = parsed;
          
          // Check for API errors
          if (res.statusCode !== 200) {
            const errorInfo = classifyError(res.statusCode, parsed);
            reject({
              ...errorInfo,
              statusCode: res.statusCode,
              rawBody: data
            });
            return;
          }
          
          // Extract response content
          const message = parsed.choices?.[0]?.message || null;
          const rawContent = message?.content;
          const content = typeof rawContent === 'string'
            ? rawContent
            : (Array.isArray(rawContent)
                ? rawContent
                  .map((part) => {
                    if (typeof part === 'string') return part;
                    if (part && typeof part.text === 'string') return part.text;
                    return '';
                  })
                  .join('\n')
                  .trim()
                : '');
          
          if (!content) {
            reject({
              type: LLMErrorTypes.PARSE_ERROR,
              message: 'No content in response',
              retryable: false
            });
            return;
          }

          if (returnMetadata) {
            resolve({
              content,
              model: parsed.model || model,
              id: parsed.id || null,
              usage: parsed.usage || null,
              annotations: Array.isArray(message?.annotations) ? message.annotations : []
            });
            return;
          }

          resolve(content);
          
        } catch (parseErrorRaw) {
          const parseError = parseErrorRaw as any;
          reject({
            type: LLMErrorTypes.PARSE_ERROR,
            message: `Failed to parse response: ${parseError.message}`,
            retryable: false,
            rawBody: data
          });
        }
      });
    });
    
    req.on('error', (error: any) => {
      reject({
        type: LLMErrorTypes.ERROR,
        message: `Request error: ${error.message}`,
        retryable: true
      });
    });
    
    req.on('timeout', () => {
      req.destroy();
      reject({
        type: LLMErrorTypes.TIMEOUT,
        message: `Request timed out after ${timeout}s`,
        retryable: true
      });
    });
    
    req.write(requestData);
    req.end();
  }).then(
    (value) => { trace(false, null); return value; },
    (error: any) => { trace(true, `${error?.type ?? 'error'}: ${error?.message ?? 'request failed'}`); throw error; },
  );
}

/**
 * Call OpenRouter LLM with retry logic
 *
 * @param {string} prompt - The prompt to send
 * @param {Object} options - Configuration options
 * @param {string} options.model - Model to use (default: MODELS.INTELLIGENCE)
 * @param {number} options.timeout - Timeout in seconds (default: 60)
 * @param {string} [options.thinking] - Reasoning level: off|minimal|low|medium|high|xhigh|max.
 * @param {string} [options.effort] - Preferred name for CLI reasoning effort;
 *   when present it takes precedence over the legacy `thinking` option.
 *   Defaults to DEFAULT_REASONING ('medium'). Controlled by the call site, NOT
 *   by which API key (server default or per-user) authenticates the request —
 *   key controls auth/billing, call site controls model + reasoning. Legacy
 *   values ('on', true/false) are normalized via normalizeReasoning(). Note:
 *   'xhigh'/'max' collapse to OpenRouter `effort: 'high'` (the ceiling
 *   OpenRouter exposes) but pass through natively on the Claude CLI.
 * @param {Array<Object>} [options.plugins] - OpenRouter plugin list
 * @param {boolean|Object} [options.webSearch] - Enables OpenRouter web plugin
 * @param {boolean} [options.returnMetadata=false] - Return content + annotations
 * @returns {Promise<string|Object>} LLM response text or metadata bundle
 * @throws {Error} If request fails after retries
 *
 * @example
 * // Default: Codex + medium reasoning.
 * const response = await callLLM('Classify these URLs...');
 * // Explicit high reasoning for harder problems.
 * const analysis = await callLLM('Complex analysis...', { model: MODELS.INTELLIGENCE, timeout: 120, thinking: 'high' });
 */
// Map an OpenRouter model slug (e.g. 'anthropic/claude-opus-4.6') to a
// claude-code provider alias. The provider drives the Claude subscription, which
// exposes opus/sonnet/haiku tiers.
function _claudeCodeAlias(model: string): 'opus' | 'sonnet' | 'haiku' {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

// Subscription path: route a callLLM through the `ai` SDK + claude-code provider,
// which authenticates via the local Claude subscription (no OpenRouter key /
// credits). Returns the SAME shape as the OpenRouter/CLI paths: a string, or the
// {content,...} envelope when returnMetadata is set.
async function callClaudeCodeSdk(prompt: any, options: any = {}) {
  const { model = DEFAULT_MODEL, timeout = 60, returnMetadata = false, webSearch, thinking, sessionId, backend, structuredOutput, killMs } = options;
  // Web search is NOT wired through the ai-sdk provider call below —
  // `generateText` runs with no tools, so a webSearch request served here would
  // silently answer from parametric memory (the fail-open bug). Honour it by
  // routing to the Claude CLI, which enables the tool via `--allowed-tools
  // WebSearch` under the SAME subscription auth (proven path; also concurrency-
  // capped and, if ever pointed at a non-searching backend, throws via
  // assertCliCanWebSearch instead of degrading).
  if (webSearch) {
    // HONOUR the caller's backend. Hardcoding 'claude' here silently overrode an
    // explicit `backend: 'agy'` + Gemini model — the config said one thing and
    // the log said `Calling claude --model opus (mapped from
    // gemini-3.7-flash-high)`. A per-call routing choice that is accepted and
    // then ignored is the same class of lie as a dropped webSearch flag.
    // 'claude' remains the DEFAULT because it is the subscription-auth path this
    // branch exists to serve.
    const text = await callAdminCLI(prompt, { model, timeout, webSearch, thinking, sessionId, backend: backend || 'claude', structuredOutput, killMs });
    if (!returnMetadata) return text;
    return { content: text, model, id: null, usage: null, annotations: [] };
  }
  const alias = _claudeCodeAlias(model);
  const startedAt = Date.now();
  let result;
  try {
    result = await generateText({
      model: claudeCode(alias),
      prompt: String(prompt),
      abortSignal: AbortSignal.timeout(Math.max(1, timeout) * 1000),
    });
  } catch (error: any) {
    void recordGeneration({ callId: randomUUID(), system: 'claude-code-sdk', model: alias, startedAt, endedAt: Date.now(), failed: true, statusMessage: String(error?.message ?? error), ...traceIdentity(), metadata: { requestedModel: model } });
    throw error;
  }
  const { text, usage } = result;
  // inputTokens includes cache; the details split it. The served model id is what Langfuse prices.
  void recordGeneration({
    callId: randomUUID(), system: 'claude-code-sdk', model: result.response?.modelId || alias, startedAt, endedAt: Date.now(),
    usage: { input: usage?.inputTokenDetails?.noCacheTokens ?? usage?.inputTokens, output: usage?.outputTokens, cacheRead: usage?.inputTokenDetails?.cacheReadTokens, cacheWrite: usage?.inputTokenDetails?.cacheWriteTokens, cacheWriteTtl: '1h' },
    ...traceIdentity(), metadata: { requestedModel: model },
  });
  if (!returnMetadata) return text;
  return { content: text, model, id: null, usage: usage ?? null, annotations: [] };
}

async function callLLM(prompt: any, options: any = {}) {
  if (options.outputSchema !== undefined) {
    if (!options.backend) {
      throw new Error('outputSchema requires an explicit CLI backend (codex, claude, agy, or gemini)');
    }
    assertCliCanUseOutputSchema(String(options.backend), options.outputSchema);
  }
  const { model = DEFAULT_MODEL, timeout = 60, webSearch, thinking: legacyThinking, effort, sessionId, backend, structuredOutput, killMs } = options;
  const thinking = effort ?? legacyThinking;

  if (options.policy === 'quality-investigation') return callAdminCLI(prompt, qualityInvestigationCallOptions(options));
  if (model === MODELS.INTELLIGENCE) {
    return callAdminCLI(prompt, {
      thinking: INTELLIGENCE_DEFAULT_REASONING,
      ...options,
      model: MODELS.INTELLIGENCE,
      backend: backend || 'codex',
    });
  }
  // The extractor policy is authoritative for extractor calls, but it is keyed
  // on the MODEL STRING, so any caller that merely happens to choose
  // `gpt-5.4-mini` was silently handed extraction's backend and `thinking:
  // 'off'` — their own choice discarded. That matters now that a user-facing
  // selector can name that model: a briefing set to "GPT-5.4 Mini / high" would
  // have run at low effort with no indication. An explicit call-site backend
  // means the caller has already decided, so it wins.
  if (model === MODELS.EXTRACTOR && !backend) return callAdminCLI(prompt, extractorCallOptions(options));

  // A call-site backend is authoritative, including when the global runtime is
  // `claude-code`; otherwise extractorCallOptions({ backend: 'agy' }) is a lie.
  //
  // `...options` first: this branch used to forward a fixed subset, silently
  // dropping `onUsage` (cost telemetry), `signal` (cancellation) and `policy`
  // for every explicit-backend caller.
  if (backend) {
    return callAdminCLI(prompt, { ...options, model, timeout, webSearch, thinking, sessionId, backend, structuredOutput, killMs });
  }

  // Subscription backend: when LLM_BACKEND=claude-code, every call goes through
  // the Claude subscription via the `ai` SDK — bypassing OpenRouter entirely
  // (incl. the no-credits failure mode) for ALL callers, not just admin. This is
  // the path that lets background workflows run without OpenRouter credits.
  if (cfg('LLM_BACKEND') === 'claude-code') {
    return callClaudeCodeSdk(prompt, options);
  }

  // Admin bypass: route to Claude Code CLI instead of OpenRouter for
  // every call, regardless of options. When `webSearch` is requested,
  // we pass it through to _spawnCLI which enables the WebSearch tool
  // on the Claude CLI via `--allowed-tools WebSearch` (see args build
  // in _spawnCLI). That way admin users get real web search without
  // paying OpenRouter credits.
  //
  // `thinking` is also forwarded so the CLI path gets `--effort <level>`
  // at spawn time. Previously this option was dropped here, meaning admin
  // users silently got the CLI's default effort while non-admin users got
  // real extended thinking via OpenRouter `reasoning.effort`.
  //
  // `sessionId` is CLI-only — Claude persists the turn under that UUID so
  // a later `--resume <uuid>` picks up the same scrollback. OpenRouter has
  // no equivalent; non-admin callers passing `sessionId` get it silently
  // ignored on the OpenRouter path (no session tracking at all there).
  if (shouldUseAdminCLI()) {
    const tag = webSearch ? ` + WebSearch tool` : '';
    // `backend` is an optional per-call override forwarded to callAdminCLI,
    // which uses `options.backend || ADMIN_CLI_BACKEND`. Omitted → unchanged.
    const effectiveBackend = backend || adminCliBackend();
    console.log(`[LLM] Admin bypass active — routing to ${effectiveBackend} CLI (model: ${model}${tag})`);
    return callAdminCLI(prompt, { model, timeout, webSearch, thinking, sessionId, backend, structuredOutput, killMs });
  }

  // COM-4: Thread the user's OpenRouter key (if any) from AsyncLocalStorage
  // into each request. The key is loaded once per HTTP request in the route handler,
  // not here, to avoid a DB call on every LLM retry.
  const userCtx = llmUserContext.getStore();
  const apiKeyOverride = userCtx?.openrouterApiKey || null;

  let lastError = null;

  for (let attempt = 0; attempt < RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const response = await makeOpenRouterRequest(prompt, { ...options, apiKeyOverride });
      return response;
      
    } catch (errorRaw) {
      const error = errorRaw as any;
      lastError = error;

      logEvent(error.retryable ? 'warn' : 'error', 'llm.call.attempt_failed', {
        source: 'llm-service',
        model,
        timeout,
        attempt: attempt + 1,
        maxRetries: RETRY_CONFIG.maxRetries,
        errorType: error.type || null,
        retryable: !!error.retryable,
        statusCode: error.statusCode || null,
        message: error.message || error.type || 'Unknown error',
        providerBody: error.rawBody ? String(error.rawBody).slice(0, 6000) : null
      }, { persist: true });

      // Don't retry non-retryable errors
      if (!error.retryable) {
        break;
      }
      
      // Wait before retrying
      if (attempt < RETRY_CONFIG.maxRetries - 1) {
        const delay = getBackoffDelay(attempt);
        logEvent('info', 'llm.call.retry_scheduled', {
          source: 'llm-service',
          model,
          timeout,
          attempt: attempt + 1,
          delayMs: Math.round(delay)
        });
        await sleep(delay);
      }
    }
  }
  
  // Throw the final error
  const errorType = lastError?.type || LLMErrorTypes.ERROR;
  const errorMessage = lastError?.message || 'Unknown error';
  logEvent('error', 'llm.call.failed', {
    source: 'llm-service',
    model,
    timeout,
    errorType,
    message: errorMessage,
    statusCode: lastError?.statusCode || null,
    retryable: !!lastError?.retryable,
    providerBody: lastError?.rawBody ? String(lastError.rawBody).slice(0, 6000) : null
  }, { persist: true });
  throw new Error(`${errorType}: ${errorMessage}`);
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Check if OpenRouter LLM service is available
 * Verifies API key is configured
 * 
 * @returns {Promise<boolean>} True if LLM service appears available
 */
async function isLLMAvailable() {
  // COM-4: LLM is available if any key source exists: server-wide key,
  // admin CLI bypass, or a user-provided key in the current request context.
  return !!OPENROUTER_CONFIG.apiKey
    || shouldUseAdminCLI()
    || cfg('LLM_BACKEND') === 'claude-code'
    || !!llmUserContext.getStore()?.openrouterApiKey;
}

/**
 * Get LLM provider information
 * 
 * @returns {string} Provider identifier
 */
function getLLMProvider() {
  return 'openrouter';
}

/**
 * Check if an error is a specific LLM error type
 * 
 * @param {Error} error - The error to check
 * @param {string} type - The error type from LLMErrorTypes
 * @returns {boolean} True if error matches the type
 */
function isLLMError(error: { message?: string }, type?: string): boolean {
  // Every known caller passes 1 arg. When `type` is undefined,
  // `.startsWith(undefined)` coerces to the literal string "undefined"
  // and is almost always false. The `type?` annotation just makes tsc
  // accept the 1-arg call pattern that works at runtime.
  return !!error?.message && error.message.startsWith(type as string);
}

/**
 * Get model name for a specific operation type
 * Helper function for extractors
 *
 * @param {string} _operation - Ignored. All operations use the extractor marker.
 * @returns {string} Model identifier
 */
function getModelForOperation(_operation: any) {
  return MODELS.EXTRACTOR;
}

// =============================================================================
// EXPORTS
// =============================================================================

export {
  callLLM,
  callLLMWithStructuredOutput,
  createLLMTraceId,
  curriculumAuthoringCallOptions,
  extractorCallOptions,
  extractorInputBudgetChars,
  personaConsolidationCallOptions,
  qualityInvestigationCallOptions,
  isLLMAvailable,
  getLLMProvider,
  setLLMUserContext,
  LLMErrorTypes,
  isLLMError,
  getModelForOperation,
  MODELS,
  DEFAULT_REASONING,
  INTELLIGENCE_DEFAULT_REASONING,
  normalizeReasoning,
};
