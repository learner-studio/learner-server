/**
 * Unified CLI agent abstraction for Claude, Codex, and Antigravity.
 *
 * One entry point (`runCliAgent`) + one registry (`AGENTS`) — every
 * caller in the app that shells out to an LLM CLI routes through here.
 * Keeps reasoning-level vocabulary, model defaults, argv construction,
 * stdout parsing, and error shapes in one place so we don't end up with
 * three slightly-different codex invocations sprinkled across modules.
 *
 * Public surface:
 *   import { runCliAgent, AGENTS, normalizeReasoning } from './cli-agents.js';
 *
 *   // One-shot review:
 *   const { stdout } = await runCliAgent({
 *     agent: AGENTS.CODEX,
 *     prompt: 'Review commit abc123 ...',
 *     reasoning: 'xhigh',
 *     cwd: '/root/biztools',
 *     outputFile: '/tmp/review.md',
 *     timeoutSec: 180,
 *   });
 *
 *   // Long-running detached reviewer (returns child PID + exit promise):
 *   const { child, done } = await runCliAgent({
 *     agent: AGENTS.AGY,
 *     prompt: '...',
 *     detach: true,
 *   });
 *
 * The canonical reasoning vocabulary is `off | minimal | low | medium |
 * high | xhigh | max | ultra`. Each agent's CLI accepts a subset, and on
 * codex and agy the subset depends on the MODEL rather than the CLI, so an
 * agent may also supply `resolveReasoning`/`resolveModel` to clamp a level
 * onto what the chosen model actually offers. Callers never think in
 * agent-specific language.
 *
 * @module lib/cli-agents
 */

import { spawn as spawnTyped } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fsModTyped from 'node:fs';
import * as osModTyped from 'node:os';
import * as pathModTyped from 'node:path';
import { validateCliInferenceLimits } from './cli-inference-limits.js';
import * as cliObserverRegistry from './cli-observer-registry.js';
import { langfuseCliSink } from './langfuse-cli-sink.js';
import { telemetryOutboxConfigured } from '../llm/langfuse-generation.js';
import { matchCatalogEntry, resolveHonoredSelection } from '../llm/model-catalog.js';

// Pristine used untyped imports for these builtins (spawn/fs/os/path were
// `any`). Preserve that looseness so the ESM conversion doesn't surface new
// strict-null diagnostics on child.stdout/stdin etc.
const spawn: any = spawnTyped;
const fsMod: any = fsModTyped;
const osMod: any = osModTyped;
const pathMod: any = pathModTyped;

// ---------------------------------------------------------------------------
// Agent scratch working directories
// ---------------------------------------------------------------------------
//
// The Antigravity CLI persists a project-registry pointer to a *cwd-relative*
// `cache/projects.json` on its first run in a directory (mapping that dir's
// absolute path to a UUID under ~/.gemini/config/projects/). When `agy` is
// spawned by the server without an explicit cwd it inherits the server's cwd
// — and if that is a git checkout (notably the production tree /root/biztools)
// the untracked `cache/projects.json` it writes makes the tree dirty and
// blocks the production deploy webhook, which refuses to deploy a dirty prod
// checkout.
//
// Fix: give agy a stable working directory OUTSIDE any git checkout so its
// cache write always lands in a throwaway location. Env-overridable via
// AGY_CLI_CWD; defaults to an XDG-style cache dir under the user's home.
function resolveCliScratchCwd(agentId: 'agy' | 'codex', overrideName: 'AGY_CLI_CWD' | 'CODEX_CLI_CWD'): string {
  const override = process.env[overrideName];
  if (override && override.trim()) return pathMod.resolve(override.trim());
  const base =
    (process.env.XDG_CACHE_HOME && process.env.XDG_CACHE_HOME.trim()) ||
    pathMod.join(osMod.homedir() || osMod.tmpdir(), '.cache');
  return pathMod.join(base, 'biztools-cli-agents', agentId);
}

const AGY_SCRATCH_CWD = resolveCliScratchCwd('agy', 'AGY_CLI_CWD');
const CODEX_SCRATCH_CWD = resolveCliScratchCwd('codex', 'CODEX_CLI_CWD');

// Grace period between SIGTERM and SIGKILL. A well-behaved CLI will
// flush its final message and exit on SIGTERM; a wedged one (trapping
// TERM, stuck in kernel I/O) needs the forced kill. Two seconds is
// enough for any legitimate flush we care about — the CLIs don't do
// heavy teardown — and tight enough that the caller's Promise settles
// within ~timeoutSec + 2s.
const KILL_GRACE_MS = 2000;

// ---------------------------------------------------------------------------
// Reasoning levels — canonical vocabulary + per-agent mappings
// ---------------------------------------------------------------------------

/** Every level the app is allowed to ask for, ordered low → high. */
const REASONING_LEVELS = Object.freeze([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  // codex-only, above `max`, and only on the Sol/Terra families. Absent from
  // this list a caller asking for it is silently downgraded to the fallback.
  'ultra',
]);

function normalizeReasoning(value: any, fallback: any = 'medium'): any {
  if (value === true) return 'high';
  if (value === false || value === null || value === undefined) return fallback;
  const normalized = String(value).toLowerCase().trim();
  if (REASONING_LEVELS.includes(normalized)) return normalized;
  // `on` is shorthand for `high` from older call-sites.
  if (normalized === 'on') return 'high';
  return fallback;
}

// Claude CLI accepts low/medium/high/xhigh/max natively; map the rest down.
const CLAUDE_REASONING_MAP = Object.freeze({
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'max',
});

// Codex effort is PER MODEL, not per CLI: the models cache gives gpt-5.6 Sol
// and Terra `max` (and an `ultra` above it) while gpt-5.4 and gpt-5.5 stop at
// xhigh. So this map only normalises the sub-`low` levels and leaves the rest
// alone; `resolveReasoning` below clamps to what the chosen model actually
// offers. Collapsing `max` here unconditionally — as this map used to — meant
// the top tier of the frontier models was unreachable.
const CODEX_REASONING_MAP = Object.freeze({
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
});

// Antigravity accepts `--effort low|medium|high` (per `agy --help`) and nothing
// above high. This map used to collapse EVERY level to `high`, so agy emitted
// an `--effort` flag that could never differ from the default — a caller
// asking for `off` (the extractor path does exactly that) silently paid for
// high reasoning. That is the same silently-discarded-option shape that
// `assertCliCanStructureOutput` exists to prevent, so it is now honoured.
const AGY_REASONING_MAP = Object.freeze({
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
  ultra: 'high',
});

/**
 * The Antigravity model every agy-backed call uses unless one is passed.
 *
 * Antigravity accepts either the slug (`gemini-3.7-flash-high`) or the display
 * name (`Gemini 3.7 Flash (High)`); the slug is used here because it is what
 * `agy models` prints in its first column and so is the stable identifier.
 * Override per-deployment with `AGY_CLI_DEFAULT_MODEL`.
 *
 * Exported so the LLM model registry (lib/llm/llm-service.ts `MODELS.AGY_WEB`)
 * names the same string — one model list for the whole app rather than a
 * constant per call site.
 */
export const AGY_DEFAULT_MODEL = 'gemini-3.7-flash-high';

// ---------------------------------------------------------------------------
// Agent registry
// ---------------------------------------------------------------------------

/**
 * Each agent carries its binary path, default model, the argv builder,
 * a stdout parser, and the reasoning-level mapping. Adding a fourth
 * agent means adding one entry here and nothing else.
 */
const AGENTS = Object.freeze({
  CLAUDE: Object.freeze({
    id: 'claude',
    bin: process.env.CLAUDE_CLI_BIN || 'claude',
    defaultModel: process.env.CLAUDE_CLI_DEFAULT_MODEL || 'opus',
    reasoningMap: CLAUDE_REASONING_MAP,
    // stream-json gives us per-turn visibility (tool_use, assistant text,
    // result) — text mode buffers everything until exit, which made a
    // multi-minute LLM call look identical to a hang from outside. The
    // richer stream also drives the CLI-telemetry pipeline that mirrors
    // turn events into job_logs.
    buildArgv({ model, reasoning, webSearch, sessionId, outputSchemaJson, chatOnly }: any) {
      if (chatOnly && webSearch) throw new Error('chatOnly cannot enable webSearch');
      const args = [
        '-p', '-',
        '--output-format', 'stream-json',
        // stream-json requires --verbose when combined with --print.
        '--verbose',
        '--model', model,
        // Pin the default output style. The admin LLM backend expects raw JSON;
        // if the spawning machine's configured style is `explanatory`/`learning`
        // the child injects `★ Insight` commentary that breaks JSON.parse in the
        // extractors (e.g. verticals-phase parse failures). Override regardless
        // of machine settings.
        '--settings', '{"outputStyle":"default"}',
      ];
      if (reasoning && reasoning !== 'off') args.push('--effort', reasoning);
      if (webSearch) args.push('--allowed-tools', 'WebSearch');
      if (outputSchemaJson) args.push('--json-schema', outputSchemaJson);
      if (chatOnly) args.push('--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '');
      // When the caller supplies a session UUID we pass it as --session-id
      // so Claude persists the turn under that id. Later, the chat-side
      // session manager resumes the same id via --resume, giving the user
      // a conversation that shares scrollback with the generation path.
      if (typeof sessionId === 'string' && sessionId) {
        args.push('--session-id', sessionId);
      }
      return args;
    },
    /**
     * Extract the canonical final output from a stream-json transcript.
     *
     * stream-json emits one JSON object per line across several types
     * (system, assistant, user, result). The final answer the caller
     * wants lives in the `result` event's `result` field — that's the
     * synthesized text, free of tool-use noise. Fall back to
     * concatenating assistant-text deltas if no result event arrived
     * (unusual — typically indicates the CLI was killed mid-stream).
     * Last fallback: treat `raw` as plain text, for robustness if the
     * flag combo ever fails closed to text mode.
     */
    parseStdout(raw: any, { outputSchema }: any = {}) {
      const text = String(raw || '');
      const lines = text.split('\n').filter((l) => l.trim());
      const explicitSchema = outputSchema !== undefined;
      if (lines.length === 0) {
        if (explicitSchema) throw new Error('Claude structured_output is missing from terminal result');
        return '';
      }

      const firstLine: any = lines[0];
      if (!firstLine.startsWith('{')) {
        if (explicitSchema) throw new Error('Claude structured_output is missing from terminal result');
        // Not NDJSON — treat as plain text (defensive fallback).
        return text.trim();
      }

      let resultText = null;
      let structuredOutput;
      let terminalError = false;
      const assistantDeltas = [];
      for (const line of lines) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'result') {
          terminalError ||= event.is_error === true || String(event.subtype || '').toLowerCase().includes('error');
          if (event.structured_output !== undefined && event.structured_output !== null) {
            structuredOutput = event.structured_output;
          } else if (!explicitSchema && typeof event.result === 'string') {
            resultText = event.result;
          }
          // Keep scanning — if multiple result events arrive, the last wins.
          continue;
        }
        if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
          for (const part of event.message.content) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              assistantDeltas.push(part.text);
            }
          }
        }
      }

      if (explicitSchema) {
        if (terminalError) throw new Error('Claude structured output terminal error');
        if (structuredOutput === undefined) throw new Error('Claude structured_output is missing from terminal result');
        return JSON.stringify(structuredOutput);
      }
      if (structuredOutput !== undefined) return JSON.stringify(structuredOutput);
      if (resultText !== null) return resultText.trim();
      if (assistantDeltas.length > 0) return assistantDeltas.join('').trim();
      return text.trim();  // last-ditch
    },
    /**
     * Parse one NDJSON line into a CLI-telemetry event (or null for
     * uninteresting/malformed lines). Called by `runCliAgent` per line
     * as stdout streams in, so the observer sees turn-by-turn events
     * while the CLI is still running.
     */
    onStreamLine(line: any, elapsedMs: any) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event || typeof event.type !== 'string') return null;

      if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
        let textChars = 0;
        let thinkingChars = 0;
        const toolNames = [];
        for (const part of event.message.content) {
          if (!part || typeof part !== 'object') continue;
          if (part.type === 'text' && typeof part.text === 'string') {
            textChars += part.text.length;
          } else if (part.type === 'tool_use' && typeof part.name === 'string') {
            toolNames.push(part.name);
          } else if (part.type === 'thinking' && typeof part.thinking === 'string') {
            // Extended-thinking block (reasoning>=medium). Not user-visible
            // but hugely useful for telemetry — this is where most of the
            // "silent" time goes on synthesis tasks.
            thinkingChars += part.thinking.length;
          }
        }
        return { kind: 'assistant-message', elapsedMs, textChars, thinkingChars, toolNames };
      }

      if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
        // Tool results arrive as user events containing tool_result parts.
        let hadToolResult = false;
        let isError = false;
        for (const part of event.message.content) {
          if (part && part.type === 'tool_result') {
            hadToolResult = true;
            if (part.is_error === true) isError = true;
          }
        }
        if (hadToolResult) {
          return { kind: 'tool-result', elapsedMs, isError };
        }
        return null;
      }

      if (event.type === 'result') {
        const usage = event.usage || {};
        const inputTokens = Number.isFinite(usage.input_tokens) ? usage.input_tokens : null;
        const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : null;
        const costUsd = Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null;
        const durationApiMs = Number.isFinite(event.duration_api_ms) ? event.duration_api_ms : null;
        const numTurns = Number.isFinite(event.num_turns) ? event.num_turns : 0;
        // `modelUsage` is keyed by the model Claude actually ran (an `opus` request
        // answers as `claude-opus-5-5`); the one that produced most output is the call's.
        const served = Object.entries(event.modelUsage && typeof event.modelUsage === 'object' ? event.modelUsage : {})
          .sort((a: any, b: any) => (Number(b[1]?.outputTokens) || 0) - (Number(a[1]?.outputTokens) || 0))[0]?.[0];
        return {
          kind: 'result',
          elapsedMs,
          numTurns,
          durationApiMs,
          inputTokens,
          outputTokens,
          costUsd,
          isError: event.is_error === true || event.subtype === 'error',
          ...(served ? { model: served } : {}),
          cacheReadTokens: Number.isFinite(usage.cache_read_input_tokens) ? usage.cache_read_input_tokens : null,
          cacheWriteTokens: Number.isFinite(usage.cache_creation_input_tokens) ? usage.cache_creation_input_tokens : null,
        };
      }

      return null;
    },
  }),

  CODEX: Object.freeze({
    id: 'codex',
    bin: process.env.CODEX_CLI_BIN || 'codex',
    defaultModel: process.env.CODEX_CLI_DEFAULT_MODEL || 'gpt-5.6-sol',
    reasoningMap: CODEX_REASONING_MAP,
    // Extraction and other one-shot calls must not inherit a large application
    // checkout. Besides making accidental file inspection possible, repo
    // context caused one 3.8k-character extraction prompt to consume 281k
    // input tokens. Explicit repository-scoped reviewers still override cwd.
    scratchCwd: CODEX_SCRATCH_CWD,
    // Clamp the effort to the chosen model's own supported set. An
    // uncatalogued model keeps the historical ceiling of xhigh, because
    // nothing then tells us whether it has a `max` tier.
    resolveReasoning(model: string, reasoning: string) {
      const matched = matchCatalogEntry(model);
      if (!matched || matched.entry.backend !== 'codex') {
        return reasoning === 'max' ? 'xhigh' : reasoning;
      }
      return resolveHonoredSelection(matched.entry, reasoning as any, null).effort;
    },
    buildArgv({ model, reasoning, webSearch, outputFile, outputSchemaFile, chatOnly, inferenceLimits }: any) {
      if (chatOnly && webSearch) throw new Error('chatOnly cannot enable webSearch');
      const args = [
        'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', '--sandbox', 'read-only',
      ];
      // Built-in provider IDs cannot be overridden in Codex 0.154. A distinct
      // provider is required; retain Codex's normal OAuth-aware endpoint selection.
      // This suppresses HTTP/stream retries, NOT successful agent continuations.
      if (inferenceLimits?.providerRetries === 0) {
        args.push('-c', 'model_provider="biztools_no_retry"');
        args.push('-c', 'model_providers.biztools_no_retry.name="OpenAI"');
        args.push('-c', 'model_providers.biztools_no_retry.wire_api="responses"');
        args.push('-c', 'model_providers.biztools_no_retry.requires_openai_auth=true');
        args.push('-c', 'model_providers.biztools_no_retry.request_max_retries=0');
        args.push('-c', 'model_providers.biztools_no_retry.stream_max_retries=0');
        args.push('-c', 'model_providers.biztools_no_retry.supports_websockets=false');
      }
      args.push('-c', `model="${model}"`); args.push('-c', 'model_auto_compact_token_limit=1000000000'); // Codex 0.152.1 clamps this to 90% of the resolved context window; no disable sentinel exists.
      if (reasoning && reasoning !== 'off') {
        args.push('-c', `model_reasoning_effort="${reasoning}"`);
      }
      // Codex enables web search by DEFAULT (0.154 probed 2026-09-14), so the option is a
      // switch in both directions: an extraction window that never asked for it was measured
      // spending its whole timeout on web_search items for names it was meant to read off the
      // corpus. A crawled page is untrusted text, and a CLI that can search while it reads
      // one is an exfiltration path, so "off" has to reach the CLI as a disable.
      args.push('-c', webSearch ? 'tools.web_search=true' : 'web_search="disabled"');
      if (chatOnly) args.push('--disable', 'shell_tool', '--disable', 'multi_agent', '--disable', 'code_mode', '--disable', 'code_mode_host');
      if (outputFile) args.push('-o', outputFile);
      if (outputSchemaFile) args.push('--output-schema', outputSchemaFile);
      args.push('-');  // read prompt from stdin
      return args;
    },
    parseStdout(raw: any) {
      // Full-auto emits plain text; `exec --json` emits one JSON event
      // per line. We disambiguate by parsing the first non-blank line
      // as JSON and checking for the event shape — substring scanning
      // for `"item.completed"` false-positives on plain-text answers
      // that happen to quote the phrase (e.g. "the item completed its
      // lifecycle"). If the first-line probe fails, we fall through to
      // plain-text handling.
      const text = String(raw || '');
      const firstLine = (text.split('\n').find((l) => l.trim()) || '').trim();
      let isJsonStream = false;
      if (firstLine.startsWith('{')) {
        try {
          const probe = JSON.parse(firstLine);
          if (probe && typeof probe === 'object' && typeof probe.type === 'string') {
            isJsonStream = true;
          }
        } catch {
          /* not JSON; fall through to plain-text */
        }
      }
      if (!isJsonStream) return text.trim();

      const parts = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'item.completed' && event.item?.text) {
            parts.push(event.item.text);
          }
        } catch {
          /* diagnostic / partial lines: skip */
        }
      }
      if (parts.length <= 1) return (parts[0] || '').trim();
      // Prefer a chunk that looks like JSON payload (codex emits both
      // reasoning-trace events and the final structured output — the
      // caller wants the output).
      const json = parts.find((t) => /^\s*[{[]/.test(t));
      return (json || parts.join('\n')).trim();
    },
    onStreamLine(line: any, elapsedMs: any) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('{')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }

      if (event.type === 'item.completed' && event.item && event.item.type === 'agent_message') {
        const text = typeof event.item.text === 'string' ? event.item.text : '';
        return {
          kind: 'assistant-message',
          elapsedMs,
          textChars: text.length,
          thinkingChars: 0,
          toolNames: [],
        };
      }

      if (event.type === 'turn.completed' && event.usage) {
        // Codex counts cached tokens inside input_tokens; report them apart.
        const cached = event.usage.cached_input_tokens || 0;
        return {
          kind: 'result',
          elapsedMs,
          numTurns: 1,
          durationApiMs: 0,
          inputTokens: Math.max(0, (event.usage.input_tokens || 0) - cached),
          outputTokens: event.usage.output_tokens || 0,
          cacheReadTokens: cached,
          costUsd: null,
          isError: false,
        };
      }
      return null;
    },
  }),

  AGY: Object.freeze({
    id: 'agy',
    bin: process.env.AGY_CLI_BIN || process.env.GEMINI_CLI_BIN || 'agy',
    defaultModel: process.env.AGY_CLI_DEFAULT_MODEL || AGY_DEFAULT_MODEL,
    reasoningMap: AGY_REASONING_MAP,
    // Force agy to run in a stable scratch dir outside any git checkout so its
    // cwd-relative `cache/projects.json` write can never dirty a checkout (which
    // would block the production deploy webhook). See resolveAgyScratchCwd above.
    scratchCwd: AGY_SCRATCH_CWD,
    defaultEnv: Object.freeze({
      AGY_CLI_HIDE_ACCOUNT_INFO: '1',
    }),
    // Antigravity encodes effort in the model slug, so the slug and the
    // `--effort` flag have to agree. The catalogue is what makes that safe:
    // a hand-rolled suffix rewrite would happily synthesise
    // `gemini-3.1-pro-medium`, which `agy models` does not list — that family
    // ships only low and high. An uncatalogued name (a borrowed
    // `claude-sonnet-4-6`, an OpenRouter id) is passed through untouched.
    resolveModel(model: string, reasoning: string, chatOnly = false) {
      const matched = matchCatalogEntry(model);
      if (!matched || matched.entry.backend !== 'agy' || !matched.entry.effortInSlug) {
        return String(model);
      }
      return resolveHonoredSelection(matched.entry, reasoning as any, chatOnly ? null : matched.slugEffort).model;
    },
    buildArgv({ model, reasoning, timeoutSec, webSearch, structuredOutput, outputSchemaFile, chatOnly }: any = {}) {
      if (chatOnly && webSearch) throw new Error('chatOnly cannot enable webSearch');
      const promptTimeoutSec = Number.isFinite(Number(timeoutSec))
        ? Math.max(60, Math.ceil(Number(timeoutSec) * 2))
        : 240;
      const promptTimeoutMinutes = Math.max(1, Math.ceil(promptTimeoutSec / 60));
      const argv = [
        '--model', model,
        '--effort', reasoning,
        '--print-timeout',
        `${promptTimeoutMinutes}m`,
        '--print=',
        '--input-format', 'stream-json',
        '--output-format', 'stream-json',
      ];
      // agy's web reach is its built-in `search_web` / `read_url_content` TOOLS,
      // not a model flag — and a tool call in `--print` mode waits for an
      // approval nobody can give, so without this the search silently never
      // happens and the model answers from memory. That is the fail-open bug
      // assertCliCanWebSearch exists to prevent; here the flag is the fix.
      if (webSearch) argv.unshift('--dangerously-skip-permissions');
      // AGY exposes a restricted plan/sandbox mode, NOT a tools-disabled mode.
      // Callers must not describe this option as a cross-provider security sandbox.
      if (chatOnly) argv.push('--sandbox', '--mode', 'plan', '--disable-slash-commands');
      if (outputSchemaFile) {
        argv.push('--json-schema', outputSchemaFile);
      } else if (structuredOutput) {
        argv.push('--json-schema', JSON.stringify({
          type: 'object',
          properties: {
            result: { oneOf: [{ type: 'object' }, { type: 'array', items: {} }] },
          },
          required: ['result'],
          additionalProperties: false,
        }));
      }
      return argv;
    },
    parseStdout(raw: any, { outputSchema }: any = {}) {
      const text = String(raw || '');
      const explicitSchema = outputSchema !== undefined;
      let response = '';
      let structuredOutput;
      let terminalError = false;
      let terminalErrorDetail = '';
      for (const line of text.split('\n')) {
        try {
          const event = JSON.parse(line);
          if (event?.event === 'result') {
            terminalError ||= String(event.result?.status || '').toUpperCase() !== 'SUCCESS';
            if (String(event.result?.status || '').toUpperCase() !== 'SUCCESS') {
              terminalErrorDetail = String(event.result?.error?.message || event.result?.error || event.result?.response || event.result?.status || '').slice(0, 500);
            }
            if (typeof event.result?.response === 'string') response = event.result.response;
            const native = event.result.structured_output;
            if (explicitSchema) {
              if (native !== undefined && native !== null) structuredOutput = native;
            } else if (typeof event.result?.response === 'string') {
              structuredOutput = native?.result;
            }
          }
        } catch { /* ignore diagnostics and partial lines */ }
      }
      if (explicitSchema) {
        if (terminalError) throw new Error(`AGY structured output terminal error${terminalErrorDetail ? `: ${terminalErrorDetail}` : ''}`);
        // Some large-schema AGY calls return the schema-conforming JSON in
        // `response` but omit the duplicate `structured_output` field. Accept
        // only a bare JSON object/array here; the caller's schema parser still
        // performs the authoritative structural and semantic validation.
        if (structuredOutput === undefined && response) {
          try {
            const parsed = JSON.parse(response);
            if (parsed && (Array.isArray(parsed) || typeof parsed === 'object')) structuredOutput = parsed;
          } catch { /* fail closed below */ }
        }
        if (structuredOutput === undefined) throw new Error('AGY structured_output is missing and response is not bare JSON');
        return JSON.stringify(structuredOutput);
      }
      if (Array.isArray(structuredOutput) || (structuredOutput && typeof structuredOutput === 'object')) {
        return JSON.stringify(structuredOutput);
      }
      return response.trim();
    },
    onStreamLine(line: any, elapsedMs: any) {
      const trimmed = String(line || '').trim();
      if (!trimmed.startsWith('{')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (event?.event !== 'result') return null;
      const result = event.result || {};
      // AGY can emit a recoverable result event before its own structured
      // output continuation. Only SUCCESS is terminal for process cleanup.
      if (String(result.status || '').toUpperCase() !== 'SUCCESS') return null;
      return {
        kind: 'result',
        elapsedMs,
        numTurns: Number(result.num_turns || 1),
        durationApiMs: Number(result.duration_seconds || 0) * 1000,
        inputTokens: Number(result.usage?.input_tokens || 0),
        outputTokens: Number(result.usage?.output_tokens || 0),
        costUsd: null,
        isError: result.status !== 'SUCCESS',
      };
    },
    formatStdin(prompt: string, { outputSchema }: any = {}) {
      return `${JSON.stringify({
        event: 'user',
        message: {
          role: 'user',
          content: outputSchema === undefined
            ? `Follow the requested output format exactly. For JSON, put only the requested value in the top-level result property required by the output schema.\n\n${prompt}`
            : `Follow the requested output format exactly. Return the object required by the supplied JSON Schema without adding a wrapper.\n\n${prompt}`,
        },
      })}\n`;
    },
  }),

  get GEMINI() {
    return this.AGY;
  },
});

// ---------------------------------------------------------------------------
// Core runner
// ---------------------------------------------------------------------------

/**
 * Run a CLI agent.
 *
 * @param {object} opts
 * @param {object} opts.agent      One of `AGENTS.CLAUDE | CODEX | AGY`.
 * @param {string} opts.prompt     The prompt (sent over stdin).
 * @param {string} [opts.model]    Model override (falls back to agent.defaultModel).
 * @param {string} [opts.reasoning] Canonical reasoning level (see REASONING_LEVELS).
 * @param {string} [opts.cwd]      Working directory for the child process.
 * @param {boolean} [opts.webSearch] Enable the agent's web-search tool where supported.
 * @param {number}  [opts.timeoutSec=120] Wall-clock timeout before SIGTERM.
 * @param {string}  [opts.outputFile] Agent-native final-message output path (codex only today).
 * @param {object}  [opts.env]     Extra env vars merged over process.env.
 * @param {AbortSignal} [opts.signal] Cancels the active subprocess.
 * @param {function} [opts.observer] Optional telemetry observer — a pure function
 *                                   `(event) => void` that receives lifecycle
 *                                   events (`start`, `first-byte`, `heartbeat`,
 *                                   `exit`, `error`) while the CLI runs. Falls
 *                                   back to the AsyncLocalStorage observer
 *                                   installed by `withCliTelemetry(...)` in
 *                                   lib/cli-telemetry.ts, or a no-op if none.
 *                                   Observer failures are swallowed so a
 *                                   broken sink never tears down the CLI.
 *
 * @returns {Promise<{stdout: string, stderr: string, durationMs: number, exitCode: number, agent: string, model: string, reasoning: string}>}
 * @throws {{type, message, retryable, agent, exitCode?, stderr?}}
 */
async function runCliAgent(opts: any): Promise<any> {
  const inferenceLimits = validateCliInferenceLimits(opts?.inferenceLimits, String(opts?.agent?.id || 'unknown'));
  if (inferenceLimits?.maxCapturedOutputBytes !== undefined && (opts.detach || opts.outputFile)) {
    throw new Error('maxCapturedOutputBytes does not support detached execution or outputFile');
  }
  // Text-only Claude calls must not inherit the application's CLAUDE.md, hooks,
  // or skills. Real Learning delivery probes reproduced false injection refusals
  // with that ambient context. Explicit repository-scoped calls remain scoped.
  if (opts?.agent?.id === 'claude' && opts.chatOnly && !opts.cwd && !opts.detach) {
    const directory = fsModTyped.mkdtempSync(pathModTyped.join(osModTyped.tmpdir(), 'biztools-claude-chat-'));
    try {
      return await runCliAgentWithSchema({ ...opts, cwd: directory });
    } finally {
      fsModTyped.rmSync(directory, { recursive: true, force: true });
    }
  }
  return runCliAgentWithSchema(opts);
}

async function runCliAgentWithSchema(opts: any): Promise<any> {
  if (opts?.outputSchema === undefined) return runCliAgentInternal(opts);
  if (opts.detach) throw new Error('outputSchema does not support detached CLI execution');
  const agentId = String(opts?.agent?.id || '').toLowerCase();
  if (!['codex', 'claude', 'agy'].includes(agentId)) {
    throw new Error(`outputSchema is not supported by CLI backend "${agentId || 'unknown'}"`);
  }
  if (!opts.outputSchema || typeof opts.outputSchema !== 'object' || Array.isArray(opts.outputSchema)) {
    throw new Error('outputSchema must be a JSON Schema object');
  }
  const serialized = JSON.stringify(opts.outputSchema);
  if (agentId === 'claude') {
    // The claude CLI's validator has no draft 2020-12 meta-schema, so the `$schema`
    // header zod emits makes it exit 1 before any model call. The keywords are unchanged.
    const { $schema: _dialect, ...claudeSchema } = opts.outputSchema;
    return runCliAgentInternal({ ...opts, outputSchemaJson: JSON.stringify(claudeSchema) });
  }
  const directory = fsModTyped.mkdtempSync(pathModTyped.join(osModTyped.tmpdir(), 'biztools-cli-schema-'));
  try {
    const outputSchemaFile = pathModTyped.join(directory, 'schema.json');
    fsModTyped.writeFileSync(outputSchemaFile, serialized, { mode: 0o600 });
    return await runCliAgentInternal({ ...opts, outputSchemaFile });
  } finally {
    fsModTyped.rmSync(directory, { recursive: true, force: true });
  }
}

async function runCliAgentInternal(opts: any): Promise<any> {
  if (!opts || !opts.agent) {
    throw new Error('runCliAgent: `agent` is required (use AGENTS.CLAUDE/CODEX/AGY)');
  }
  if (typeof opts.prompt !== 'string' || !opts.prompt.trim()) {
    throw new Error('runCliAgent: `prompt` must be a non-empty string');
  }
  if (opts.signal?.aborted) {
    throw {
      type: 'cli_agent.cancelled',
      agent: opts.agent.id,
      message: `${opts.agent.id} CLI cancelled before spawn`,
      retryable: false,
    };
  }

  const agent = opts.agent;
  const requestedModel = opts.model || agent.defaultModel;
  const canonicalReasoning = normalizeReasoning(opts.reasoning);
  const mappedReasoning = agent.reasoningMap[canonicalReasoning];
  // Effort is a property of the MODEL on both codex and agy, so the per-agent
  // map alone cannot produce a valid pairing — the agent gets to clamp.
  const agentReasoning = typeof agent.resolveReasoning === 'function'
    ? agent.resolveReasoning(requestedModel, mappedReasoning)
    : mappedReasoning;
  const model = typeof agent.resolveModel === 'function'
    ? agent.resolveModel(requestedModel, agentReasoning, Boolean(opts.chatOnly))
    : requestedModel;
  const timeoutSec = Number.isFinite(Number(opts.timeoutSec)) ? Number(opts.timeoutSec) : 120;
  const webSearch = Boolean(opts.webSearch);
  // Working directory resolution:
  //   1. explicit opts.cwd always wins (reviewer runs scoped to a repo, etc.)
  //   2. else the agent's scratchCwd, if it declares one (agy/codex)
  //   3. else undefined → child inherits the parent process cwd (claude)
  // We mkdir -p the chosen scratch
  // cwd so spawn doesn't ENOENT on a fresh machine; failures are non-fatal
  // (we fall back to inheriting the parent cwd rather than crashing the call).
  let cwd = opts.cwd;
  if (!cwd && agent && typeof agent.scratchCwd === 'string' && agent.scratchCwd) {
    cwd = agent.scratchCwd;
  }
  if (cwd && cwd === agent?.scratchCwd) {
    try {
      fsMod.mkdirSync(cwd, { recursive: true });
    } catch (mkdirErr: any) {
      console.warn(
        `[cli-agents] could not create scratch cwd for ${agent.id} (${cwd}): ${mkdirErr.message}; inheriting parent cwd`,
      );
      cwd = undefined;
    }
  }
  const outputFile = opts.outputFile;

  // If the caller asks us to write to an output file on an agent that
  // doesn't natively support -o (claude, agy), we still honor it by
  // mirroring parsed stdout into the file after exit.
  const agentWritesOutputFile = agent.id === 'codex' && !!outputFile;

  const argv = agent.buildArgv({
    model,
    reasoning: agentReasoning,
    webSearch,
    outputFile,
    outputSchemaFile: opts.outputSchemaFile,
    outputSchemaJson: opts.outputSchemaJson,
    sessionId: opts.sessionId,
    timeoutSec,
    structuredOutput: opts.structuredOutput,
    chatOnly: opts.chatOnly,
    inferenceLimits: opts.inferenceLimits,
  });

  // Some CLIs take the prompt on argv; claude+codex read it from stdin.
  // promptArg=null means append the prompt as a positional argument.
  const prompt = opts.prompt;
  const finalArgv = agent.usesArgvPrompt
    ? agent.promptArg === null
      ? [...argv, prompt]
      : [...argv, agent.promptArg || '-p', prompt]
    : argv;

  // Kill-timer is generous by default: CLI startup (auth refresh,
  // model init) can add 10-30s on top of logical latency, so we give
  // at least timeoutSec*2 and a 120s floor. Tests pass `killMs`
  // directly to exercise the SIGTERM→SIGKILL escalation without
  // waiting out the production buffer.
  const killMs = Number.isFinite(Number(opts.killMs))
    ? Number(opts.killMs)
    : Math.max(timeoutSec * 2 * 1000, (timeoutSec + 120) * 1000);

  // Telemetry observer — caller-supplied opt wins, else fall back to the
  // AsyncLocalStorage observer installed by withCliTelemetry() in
  // lib/cli-telemetry.ts, else no-op. All calls to the observer are
  // wrapped in try/catch so a broken sink can't crash the CLI runner.
  let ambientObserver = null;
  try {
    ambientObserver = cliObserverRegistry.getCurrentCliObserver();
  } catch { /* registry not available (e.g. test import order) */ }
  const rawObserver = typeof opts.observer === 'function'
    ? opts.observer
    : ambientObserver;
  // One id per invocation: concurrent calls under one observer (the speaker
  // step runs eight windows at once) are otherwise indistinguishable.
  const callId = randomUUID();
  // Every call reaches Langfuse exactly once, whatever observer is installed:
  // the observer is for the caller, this is the process-wide record of calls.
  // Admission joins the enclosing withCliTelemetry scope but never rejects it.
  const scope = cliObserverRegistry.getCurrentCliScope();
  const trace = telemetryOutboxConfigured()
    ? (event: any) => {
      const admitted = langfuseCliSink(event, scope?.context ?? {});
      if (admitted) scope?.track?.(Promise.resolve(admitted).catch(() => undefined));
    }
    : () => {};
  const emit = (event: any) => {
    try { trace({ ...event, callId }); } catch { /* telemetry never tears down the CLI */ }
    if (rawObserver) try { rawObserver({ ...event, callId }); } catch { /* sink errors are non-fatal */ }
  };

  // Heartbeat cadence — imported from cli-observer-registry (leaf) so this
  // file doesn't take a cli-telemetry dependency that would close a brittle
  // init-order cycle. Hard-coded fallback for the test harness.
  let HEARTBEAT_MS = 15_000;
  try {
    if (Number.isFinite(cliObserverRegistry.CLI_HEARTBEAT_INTERVAL_MS)) {
      HEARTBEAT_MS = cliObserverRegistry.CLI_HEARTBEAT_INTERVAL_MS;
    }
  } catch { /* keep fallback */ }

  const startedAt = Date.now();
  emit({
    kind: 'start',
    agent: agent.id,
    model,
    reasoning: canonicalReasoning,
    timeoutSec,
    promptChars: prompt.length,
    prompt,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(agent.bin, finalArgv, {
      // TERM=dumb silences ANSI escape sequences in CLI output that
      // otherwise pollute our parsed strings.
      env: { ...process.env, TERM: 'dumb', ...(agent.defaultEnv || {}), ...(opts.env || {}),
        ...(agent.id === 'agy' && opts.inferenceLimits?.providerRetries === 0 ? { AGY_CLI_MODEL_API_MAX_RETRIES: '0' } : {}),
      },
      stdio: agent.usesArgvPrompt ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLines = 0;
    let lastStdoutAt = 0;
    let firstStdoutAt = 0;
    let firstStderrAt = 0;
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let outputLimitExceeded = false;
    let terminalResult: any = null;
    let softKillTimer: any = null;
    let hardKillTimer: any = null;
    let forceSettleTimer: any = null;
    let heartbeatTimer: any = null;
    let onAbort: (() => void) | null = null;

    const clearTimers = () => {
      if (softKillTimer) { clearTimeout(softKillTimer); softKillTimer = null; }
      if (hardKillTimer) { clearTimeout(hardKillTimer); hardKillTimer = null; }
      if (forceSettleTimer) { clearTimeout(forceSettleTimer); forceSettleTimer = null; }
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (postResultSoftTimer) { clearTimeout(postResultSoftTimer); postResultSoftTimer = null; }
      if (postResultHardTimer) { clearTimeout(postResultHardTimer); postResultHardTimer = null; }
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
    };
    const settleResolve = (value: any) => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve(value);
    };
    const settleReject = (reason: any) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(reason);
    };

    // Partial-line buffer for per-line stream parsing. Agents that emit
    // NDJSON (Claude with stream-json, Codex with --json) can set
    // `agent.onStreamLine(line, elapsedMs) → CliTelemetryEvent | null`
    // and their events are routed to the observer as lines complete.
    // We never invoke the parser on partial lines — a half-object would
    // fail JSON.parse and drop telemetry.
    let stdoutLineBuf = '';
    const streamParser = typeof agent.onStreamLine === 'function' ? agent.onStreamLine.bind(agent) : null;

    // Post-result kill machinery. Claude CLI in stream-json mode emits a
    // `result` event when the LLM turn is canonically complete, and then
    // spends additional (sometimes many-minutes-long) time in shutdown
    // chores — session hooks, auto-memory flushes, analytics posts,
    // background prefetches. We have the output the moment the result
    // arrives, so on that signal we schedule a SIGTERM after a short
    // grace period and escalate to SIGKILL just like the main timeout
    // path does. Only the FIRST terminal event triggers — subsequent
    // ones are no-ops to avoid double-kill race.
    let terminalSeen = false;
    let postResultSoftTimer: any = null;
    let postResultHardTimer: any = null;
    const POST_RESULT_GRACE_MS = 3000;
    const scheduleEarlyKill = () => {
      if (terminalSeen) return;
      terminalSeen = true;
      postResultSoftTimer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        postResultHardTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, KILL_GRACE_MS);
      }, POST_RESULT_GRACE_MS);
    };

    if (opts.signal) {
      onAbort = () => {
        if (settled || cancelled) return;
        cancelled = true;
        if (softKillTimer) { clearTimeout(softKillTimer); softKillTimer = null; }
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        hardKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, KILL_GRACE_MS);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      if (opts.signal.aborted) onAbort();
    }

    // Bound host capture before decoding/retaining the next chunk. This is NOT
    // a limit on remote reasoning/generation: cancellation may arrive too late.
    const acceptOutputChunk = (bytes: number) => {
      if (outputLimitExceeded || settled) return false;
      const cap = opts.inferenceLimits?.maxCapturedOutputBytes;
      if (cap !== undefined && stdoutBytes + stderrBytes + bytes > cap) {
        outputLimitExceeded = true;
        emit({ kind: 'error', elapsedMs: Date.now() - startedAt, errorType: 'cli_agent.output_limit', message: `${agent.id} CLI captured output exceeded ${cap} bytes` });
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        return false;
      }
      return true;
    };
    child.stdout.on('data', (chunk: any) => {
      if (!acceptOutputChunk(chunk.length)) return;
      const text = chunk.toString('utf8');
      stdout += text;
      stdoutBytes += chunk.length;
      stdoutLines += (text.match(/\n/g) ?? []).length;
      lastStdoutAt = Date.now();
      if (firstStdoutAt === 0) {
        firstStdoutAt = Date.now();
        emit({ kind: 'first-byte', stream: 'stdout', elapsedMs: firstStdoutAt - startedAt });
      }
      if (!streamParser) return;
      stdoutLineBuf += text;
      let nl;
      while ((nl = stdoutLineBuf.indexOf('\n')) !== -1) {
        const line = stdoutLineBuf.slice(0, nl);
        stdoutLineBuf = stdoutLineBuf.slice(nl + 1);
        if (!line) continue;
        const elapsedMs = Date.now() - startedAt;
        let evt;
        try { evt = streamParser(line, elapsedMs); } catch { evt = null; }
        if (!evt) continue;
        emit(evt);
        // A `result` event means the LLM turn is canonically complete —
        // the full final text is already in our stdout buffer. Kick off
        // the early-kill so we don't sit through 10+ minutes of post-
        // result shutdown work.
        if (evt.kind === 'result') {
          terminalResult = evt;
          scheduleEarlyKill();
        }
      }
    });
    child.stderr.on('data', (chunk: any) => {
      if (!acceptOutputChunk(chunk.length)) return;
      stderr += chunk;
      stderrBytes += chunk.length;
      if (firstStderrAt === 0) {
        firstStderrAt = Date.now();
        emit({ kind: 'first-byte', stream: 'stderr', elapsedMs: firstStderrAt - startedAt });
      }
    });

    // Heartbeat — emitted every HEARTBEAT_MS so the caller can tell the
    // difference between "CLI is still producing tokens" and "CLI hung".
    // Silently no-ops when no observer is attached.
    heartbeatTimer = setInterval(() => {
      emit({
        kind: 'heartbeat',
        elapsedMs: Date.now() - startedAt,
        stdoutBytes,
        stderrBytes,
      });
    }, HEARTBEAT_MS);
    // Node keeps the process alive for timers by default — unref so the
    // heartbeat never delays shutdown when a long CLI is orphaned.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    // `spawn({timeout})` sends SIGTERM, which a child can trap. Well-
    // behaved CLIs honor SIGTERM; wedged ones don't, and that path used
    // to leak a concurrency slot forever (the `close` event never fired).
    // We run the timer ourselves so we can escalate to SIGKILL after a
    // short grace period.
    if (!cancelled) {
      softKillTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        hardKillTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }, KILL_GRACE_MS);
      }, killMs);
    }
    // Defensive backstop for rare process/zombie states where the child has
    // exited or been killed but Node never delivers `close`. Without this,
    // callers can leak the CLI concurrency slot and PgBoss workers can sit
    // forever inside one LLM call.
    forceSettleTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      const durationMs = Date.now() - startedAt;
      emit({
        kind: 'error',
        elapsedMs: durationMs,
        errorType: 'cli_agent.timeout',
        message: `${agent.id} CLI did not close after timeout`,
      });
      // `close` may never come (that is why this timer exists), so the call
      // is terminated here for observers too; a late `close` emits a second
      // exit that sinks ignore once the call is closed.
      emit({
        kind: 'exit',
        elapsedMs: durationMs,
        exitCode: null,
        signal: 'SIGKILL',
        stdoutBytes,
        stderrBytes,
        timedOut: true,
      });
      settleReject({
        type: 'cli_agent.timeout',
        agent: agent.id,
        exitCode: null,
        signal: 'SIGKILL',
        message: `${agent.id} CLI timed out after ${timeoutSec}s and did not close after forced kill`,
        retryable: true,
        stderr: stderr.slice(0, 2000),
        durationMs,
      });
    }, killMs + KILL_GRACE_MS + 5000);

    // stdin needs its own error handler — if the child dies before we
    // finish writing, Node emits EPIPE on the stream, which crashes the
    // process without a listener. We also want backpressure handling
    // for large prompts (chat system prompts >16KiB highWaterMark).
    if (!agent.usesArgvPrompt) {
      child.stdin.on('error', (err: any) => {
        // EPIPE just means the child closed its end — expected on
        // timeout/kill paths. Other errors we surface via the close
        // handler below, which always runs after the child exits.
        if (err && err.code !== 'EPIPE') {
          // non-fatal: the close handler will reject with the real cause
        }
      });
      const ok = child.stdin.write(
        typeof agent.formatStdin === 'function'
          ? agent.formatStdin(prompt, { outputSchema: opts.outputSchema })
          : prompt,
      );
      if (!ok) {
        child.stdin.once('drain', () => {
          try { child.stdin.end(); } catch { /* already closed */ }
        });
      } else {
        try { child.stdin.end(); } catch { /* already closed */ }
      }
    }

    child.on('error', (error: any) => {
      const durationMs = Date.now() - startedAt;
      emit({
        kind: 'error',
        elapsedMs: durationMs,
        errorType: 'cli_agent.spawn_error',
        message: error.message,
      });
      settleReject({
        type: 'cli_agent.spawn_error',
        agent: agent.id,
        message: `${agent.id} CLI spawn error: ${error.message}`,
        retryable: false,
        stderr: stderr.slice(0, 500),
      });
    });

    child.on('exit', (exitCode: any, signal: any) => {
      // Once the child process itself exits, wait a tiny bit to let streams flush,
      // and then destroy them so grandchild processes do not keep the pipe open and hang the close event.
      setTimeout(() => {
        try { child.stdout.destroy(); } catch {}
        try { child.stderr.destroy(); } catch {}
      }, 50);
    });

    child.on('close', (exitCode: any, signal: any) => {
      const durationMs = Date.now() - startedAt;
      emit({
        kind: 'exit',
        elapsedMs: durationMs,
        exitCode,
        signal: signal ?? null,
        stdoutBytes,
        stderrBytes,
        timedOut,
      });

      if (outputLimitExceeded) {
        settleReject({ type: 'cli_agent.output_limit', agent: agent.id, retryable: false, message: `${agent.id} CLI captured output limit exceeded`, durationMs });
        return;
      }
      if (cancelled) {
        settleReject({
          type: 'cli_agent.cancelled',
          agent: agent.id,
          exitCode,
          signal,
          message: `${agent.id} CLI cancelled`,
          retryable: false,
          stderr: stderr.slice(0, 2000),
          durationMs,
        });
        return;
      }

      if (timedOut) {
        // What the CLI was doing when it was killed. RAPS run 4 (2026-09-14):
        // 25 of 65 identical-size talk-window calls sat for the whole 394s
        // ceiling, and most answered in 30s on the identical retry. A bare
        // "timed out" cannot tell a silent stall from a reasoning spiral
        // from an upstream error the CLI kept retrying; the last event line
        // and how far into the call it arrived can.
        const lastLine = stdout.slice(-600).trimEnd().split('\n').filter(Boolean).at(-1) ?? '';
        const lastOutput = lastStdoutAt ? `last output ${Math.round((lastStdoutAt - startedAt) / 1000)}s in` : 'no output';
        const stderrTail = stderr.trim().slice(-200).replace(/\s+/g, ' ');
        settleReject({
          type: 'cli_agent.timeout',
          agent: agent.id,
          exitCode,
          signal,
          message: `${agent.id} CLI timed out after ${timeoutSec}s (killed with ${signal || 'SIGKILL'}); stdout ${stdoutLines} lines/${stdoutBytes} bytes, ${lastOutput}: ${lastLine.slice(-240).replace(/\s+/g, ' ')}${stderrTail ? `; stderr tail: ${stderrTail}` : ''}`,
          retryable: true,  // timeouts are typically transient
          stderr: stderr.slice(0, 2000),
          durationMs,
        });
        return;
      }

      // Early-kill-after-result path: we SIGTERM'd the child because the
      // stream-json `result` event told us the LLM is canonically done.
      // The exitCode in that case is null/0 (killed by signal) but we
      // have the full output already — fall through to parseStdout. Only
      // treat non-zero exits as failure when we DIDN'T trigger them.
      if (!terminalSeen && exitCode !== 0) {
        settleReject({
          type: 'cli_agent.nonzero_exit',
          agent: agent.id,
          exitCode,
          signal,
          message: `${agent.id} CLI exited with code ${exitCode}: ${stderr.slice(0, 200) || stdout.slice(0, 200)}`,
          retryable: false,
          stderr: stderr.slice(0, 2000),
          durationMs,
        });
        return;
      }

      let parsed;
      try {
        parsed = agent.parseStdout(stdout, { outputSchema: opts.outputSchema });
      } catch (parseErr: any) {
        settleReject({
          type: 'cli_agent.invalid_structured_output',
          agent: agent.id,
          message: `${agent.id} CLI returned invalid structured output: ${parseErr?.message || parseErr}`,
          retryable: false,
          stderr: stderr.slice(0, 2000),
          durationMs,
        });
        return;
      }
      if (!parsed) {
        settleReject({
          type: 'cli_agent.empty_output',
          agent: agent.id,
          message: `${agent.id} CLI returned empty output`,
          retryable: true,
          stderr: stderr.slice(0, 2000),
          durationMs,
        });
        return;
      }

      emit({
        kind: 'final-output',
        elapsedMs: durationMs,
        output: parsed,
        outputChars: String(parsed).length,
        stdoutBytes,
        stderrBytes,
      });

      // Mirror parsed stdout into the requested output file for agents
      // that don't support native -o. This is a convenience; the stdout
      // return value is canonical. Log write failures so ops can notice
      // disk-full or permission issues instead of them being invisible.
      if (outputFile && !agentWritesOutputFile) {
        try {
          fsMod.writeFileSync(outputFile, parsed);
        } catch (writeErr: any) {
          console.warn(
            `[cli-agents] outputFile mirror failed for ${agent.id} → ${outputFile}: ${writeErr.message}`,
          );
        }
      }

      settleResolve({
        stdout: parsed,
        stderr,
        durationMs,
        exitCode,
        agent: agent.id,
        model,
        reasoning: canonicalReasoning,
        telemetryResult: terminalResult,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// String-key lookup (for env-driven selection + HTTP callers)
// ---------------------------------------------------------------------------

const AGENT_BY_KEY = Object.freeze({
  claude: AGENTS.CLAUDE,
  codex: AGENTS.CODEX,
  agy: AGENTS.AGY,
  antigravity: AGENTS.AGY,
  gemini: AGENTS.AGY,
});

/**
 * Resolve an agent by its string id (case-insensitive). Used by the
 * HTTP surface and env-driven selectors where the choice is data.
 */
function resolveAgent(key: any): any {
  if (!key) return null;
  return (AGENT_BY_KEY as any)[String(key).toLowerCase()] || null;
}

export {
  AGENTS,
  AGENT_BY_KEY,
  REASONING_LEVELS,
  CLAUDE_REASONING_MAP,
  CODEX_REASONING_MAP,
  AGY_REASONING_MAP,
  AGY_REASONING_MAP as GEMINI_REASONING_MAP,
  normalizeReasoning,
  resolveAgent,
  runCliAgent,
};

export default {
  AGENTS,
  AGENT_BY_KEY,
  REASONING_LEVELS,
  CLAUDE_REASONING_MAP,
  CODEX_REASONING_MAP,
  AGY_REASONING_MAP,
  GEMINI_REASONING_MAP: AGY_REASONING_MAP,
  normalizeReasoning,
  resolveAgent,
  runCliAgent,
};
