/**
 * Langfuse sink for CLI telemetry: one OTLP generation span per CLI call.
 *
 * `runCliAgent` emits start / result / exit events per invocation, each
 * stamped with a `callId`; this sink folds those into one span and admits it
 * to the shared durable outbox when the call ends. Remote delivery is independent
 * of the model call. `withCliTelemetry` awaits admission at its scope boundary.
 * No credentials are read by the producer; worker delivery resolves them.
 */
import {enqueueLangfuseWrite} from "../llm/learning-experiment-langfuse-transport.js";
import { generationSpan, type GenerationRecord } from "../llm/langfuse-generation.js";

import type { CliTelemetryContext, CliTelemetryEvent, CliTelemetrySink } from "./cli-telemetry-types.js";

export const LANGFUSE_OTEL_TRACES_URL = "http://127.0.0.1:3100/experiments/api/public/otel/v1/traces";

export interface LangfuseCliSinkOptions {
	readonly enqueue?: typeof enqueueLangfuseWrite;
	readonly now?: () => number;
	readonly warn?: (message: string) => void;
}

/** The start fields the span needs; the event's full `prompt` is deliberately not kept. */
type StartFacts = Pick<Extract<CliTelemetryEvent, { kind: "start" }>, "agent" | "model" | "reasoning" | "timeoutSec" | "promptChars">;

interface CallState {
	start?: StartFacts;
	startedAt: number;
	result?: Extract<CliTelemetryEvent, { kind: "result" }>;
	error?: Extract<CliTelemetryEvent, { kind: "error" }>;
}

/**
 * Pure: one CLI call's events plus the observer context become one generation.
 * The model is the one the CLI reports it ran when it says (Claude answers an
 * alias like `opus` with `claude-opus-5-5`), because that is the name Langfuse
 * prices; the requested model otherwise.
 */
const cliGenerationRecord = (
	terminal: Extract<CliTelemetryEvent, { kind: "exit" | "error" }>,
	state: CallState,
	ctx: CliTelemetryContext,
	callId: string,
): GenerationRecord => {
	const { start, result } = state;
	const elapsedMs = terminal.elapsedMs;
	const timedOut = terminal.kind === "exit" ? terminal.timedOut : false;
	const exitCode = terminal.kind === "exit" ? terminal.exitCode : null;
	const signal = terminal.kind === "exit" ? terminal.signal : null;
	// A signal is a failure whatever the flags say: a workflow cancellation
	// SIGTERMs the child (exit code null, timedOut false) and a crash SIGKILLs it.
	const failed = terminal.kind === "error" || timedOut || signal !== null || (exitCode !== null && exitCode !== 0);
	const statusMessage = terminal.kind === "error"
		? `${terminal.errorType}: ${terminal.message}`
		: timedOut
			? `cli_agent.timeout after ${Math.round(elapsedMs / 1000)}s${signal ? ` (${signal})` : ""}`
			: state.error
				? `${state.error.errorType}: ${state.error.message}`
				: signal
					? `terminated by ${signal}`
					: failed
						? `exit code ${exitCode}`
						: null;
	const agent = start?.agent ?? "unknown";
	const label = ctx.label ?? ctx.queueName ?? "cli-call";
	return {
		callId,
		system: agent,
		model: result?.model ?? start?.model ?? "unknown",
		startedAt: state.startedAt,
		endedAt: state.startedAt + elapsedMs,
		usage: result
			? { input: result.inputTokens, output: result.outputTokens, cacheRead: result.cacheReadTokens, cacheWrite: result.cacheWriteTokens, cacheWriteTtl: agent === "claude" ? "1h" : "5m" }
			: null,
		failed,
		statusMessage,
		label,
		tags: ["cli"],
		...(ctx.userId ? { userId: ctx.userId } : {}),
		...(ctx.jobId ? { sessionId: ctx.jobId } : {}),
		metadata: {
			callId: terminal.callId ?? null,
			requestedModel: start?.model ?? null,
			reasoning: start?.reasoning ?? null,
			timeoutSec: start?.timeoutSec ?? null,
			promptChars: start?.promptChars ?? null,
			elapsedMs,
			exitCode,
			signal,
			timedOut,
			stdoutBytes: terminal.kind === "exit" ? terminal.stdoutBytes : null,
			stderrBytes: terminal.kind === "exit" ? terminal.stderrBytes : null,
			numTurns: result?.numTurns ?? null,
			durationApiMs: result?.durationApiMs ?? null,
			// The CLI's own figure, kept to cross-check Langfuse's price, never used as the cost.
			cliReportedCostUsd: result?.costUsd ?? null,
			briefingId: ctx.briefingId ?? null,
		},
	};
};

const FAILURE_WARN_INTERVAL_MS = 10 * 60_000;

export const createLangfuseCliSink = (options: LangfuseCliSinkOptions = {}): CliTelemetrySink => {
	const enqueue = options.enqueue ?? enqueueLangfuseWrite;
	const now = options.now ?? Date.now;
	const warn = options.warn ?? ((message: string) => console.warn(`[langfuse-cli-sink] ${message}`));
	const calls = new Map<string, CallState>();

	// Re-armed after FAILURE_WARN_INTERVAL_MS: an outage minutes into a run
	// would otherwise drop every later span behind one log line (review of
	// 49c16302). Missing credentials stay warn-once, and the null is cached for
	// the process, so writing the env file needs a learner-api restart.
	let failureWarnedAt = Number.NEGATIVE_INFINITY;

	const flush = (terminal: Extract<CliTelemetryEvent, { kind: "exit" | "error" }>, callId: string, ctx: CliTelemetryContext) => {
		// No state means no `start` was seen or the call already closed (the
		// adapter's force-settle backstop emits an exit that a late `close`
		// repeats): one span per call, never a phantom.
		const state = calls.get(callId);
		if (!state) return;
		calls.delete(callId);
		const payload = generationSpan(cliGenerationRecord(terminal, state, ctx, callId));
		return enqueue('/api/public/otel/v1/traces', payload).then(() => undefined).catch(() => {
			const at = now();
			if (at - failureWarnedAt >= FAILURE_WARN_INTERVAL_MS) {
				failureWarnedAt = at;
				warn('durable telemetry admission failed; export not acknowledged');
			}
			throw new Error('Durable CLI telemetry admission failed');
		});
	};
	return (event, ctx) => {
		const callId = event.callId;
		if (!callId) return;
		switch (event.kind) {
			case "start": {
				const { agent, model, reasoning, timeoutSec, promptChars } = event;
				calls.set(callId, { start: { agent, model, reasoning, timeoutSec, promptChars }, startedAt: now() });
				return;
			}
			case "result": {
				const state = calls.get(callId);
				if (state) state.result = event;
				return;
			}
			case "error": {
				// A timeout error is followed by the kill's `exit`; only a spawn
				// failure ends the call without one.
				if (event.errorType === "cli_agent.spawn_error") return flush(event, callId, ctx);
				const state = calls.get(callId);
				if (state) state.error = event;
				return;
			}
			case "exit":
				return flush(event, callId, ctx);
			default:
				return;
		}
	};
};

/** Process-wide sink. `runCliAgent` feeds it every call, so no caller installs it. */
export const langfuseCliSink: CliTelemetrySink = createLangfuseCliSink();
