/**
 * Every event of one `runCliAgent` invocation carries the same `callId`, so a
 * sink watching several concurrent calls (eight speaker windows at once) can
 * pair each `exit` with its own `start` and `result`. The adapter stamps it;
 * observers never set it.
 */
export type CliTelemetryEvent = { readonly callId?: string } & (
	| {
			readonly kind: "start";
			readonly agent: string;
			readonly model: string;
			readonly reasoning: string;
			readonly timeoutSec: number;
			readonly promptChars: number;
			readonly prompt?: string;
	  }
	| {
			readonly kind: "first-byte";
			readonly stream: "stdout" | "stderr";
			readonly elapsedMs: number;
	  }
	| {
			readonly kind: "heartbeat";
			readonly elapsedMs: number;
			readonly stdoutBytes: number;
			readonly stderrBytes: number;
	  }
	| {
			readonly kind: "exit";
			readonly elapsedMs: number;
			readonly exitCode: number | null;
			readonly signal: string | null;
			readonly stdoutBytes: number;
			readonly stderrBytes: number;
			readonly timedOut: boolean;
	  }
	| {
			readonly kind: "error";
			readonly elapsedMs: number;
			readonly errorType: string;
			readonly message: string;
	  }
	| {
			readonly kind: "assistant-message";
			readonly elapsedMs: number;
			readonly textChars: number;
			readonly thinkingChars: number;
			readonly toolNames: readonly string[];
	  }
	| {
			readonly kind: "tool-result";
			readonly elapsedMs: number;
			readonly isError: boolean;
	  }
	| {
			readonly kind: "result";
			readonly elapsedMs: number;
			readonly numTurns: number;
			readonly durationApiMs: number | null;
			readonly inputTokens: number | null;
			readonly outputTokens: number | null;
			readonly costUsd: number | null;
			readonly isError: boolean;
			/** The model the CLI says it ran, when it says; Langfuse prices this name. */
			readonly model?: string;
			/** Cached tokens, never included in inputTokens. */
			readonly cacheReadTokens?: number | null;
			readonly cacheWriteTokens?: number | null;
	  }
	| {
			readonly kind: "final-output";
			readonly elapsedMs: number;
			readonly output: string;
			readonly outputChars: number;
			readonly stdoutBytes: number;
			readonly stderrBytes: number;
	  }
);

export type CliTelemetryObserver = (event: CliTelemetryEvent) => void;

export interface CliTelemetryContext {
	readonly jobId?: string;
	readonly queueName?: string;
	readonly userId?: string;
	readonly briefingId?: number;
	readonly label?: string;
}

export type CliTelemetrySink = (
	event: CliTelemetryEvent,
	ctx: CliTelemetryContext,
) => void | Promise<void>;
