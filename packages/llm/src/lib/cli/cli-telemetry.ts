/**
 * CLI telemetry — one place to describe what a CLI child process is doing
 * while it's doing it.
 *
 * `runCliAgent` in lib/cli-agents.js buffers the full stdout/stderr and
 * only surfaces information after the process exits. For long Claude CLI
 * synthesis passes (briefing generation, 5-10 minute LLM turns) that's
 * the worst possible UX: the UI sits on a stale progress marker and we
 * can't tell from outside whether the handler is still producing tokens
 * or has wedged. Before this module, a 10-minute LLM pass was a 10-minute
 * black hole.
 *
 * Design:
 *   - One event-union type (`CliTelemetryEvent`) describes every signal
 *     the runner emits during a CLI run.
 *   - An observer is a pure function `(event) => void`. Creating one is
 *     `createCliObserver(ctx, sink)` — a factory that composes an
 *     immutable context with a sink.
 *   - `withCliTelemetry(ctx, fn)` installs an observer in an
 *     AsyncLocalStorage scope so every nested CLI call the worker makes
 *     gets instrumented without the caller threading a parameter through.
 *   - `defaultCliSink` writes via `observability.logEvent`, redacting raw
 *     prompt/output content first.
 *
 * Functional-programming conventions followed here:
 *   - No classes. Plain readonly types + factory functions.
 *   - Events are plain data; no hidden mutation.
 *   - Observer factories close over ctx + sink; ctx is frozen on entry.
 *   - The sink is the only permitted side effect; everything else is a
 *     pure transform from event → log payload.
 *
 * @module lib/cli-telemetry
 */

import type {
	CliTelemetryContext,
	CliTelemetryEvent,
	CliTelemetryObserver,
	CliTelemetrySink,
} from "./cli-telemetry-types.js";
export type {
	CliTelemetryContext,
	CliTelemetryEvent,
	CliTelemetryObserver,
	CliTelemetrySink,
} from "./cli-telemetry-types.js";

import { logEvent } from "../../services/observability.js";

// ---------------------------------------------------------------------------
// Heartbeat cadence
// ---------------------------------------------------------------------------

/**
 * How often `runCliAgent` emits a heartbeat while a CLI is alive. 15s is
 * short enough to catch a true hang within one UI poll cycle but long
 * enough to avoid flooding the log on a multi-minute run (12 heartbeats
 * per 3-minute LLM turn).
 *
 * Re-exported from `./cli-observer-registry` — the canonical home — so
 * existing callers like `lib/cli-agents.ts` keep working through cli-telemetry
 * during the registry migration window.
 */
import * as observerRegistry from "./cli-observer-registry.js";
export const CLI_HEARTBEAT_INTERVAL_MS = observerRegistry.CLI_HEARTBEAT_INTERVAL_MS;

// ---------------------------------------------------------------------------
// Default sink — redacts, then writes to structured logs
// ---------------------------------------------------------------------------


/**
 * Strip the two fields that carry raw model content — a `start` event's full
 * prompt and a `final-output` event's full answer — before the event reaches a
 * log line. The `*Chars` counters survive, so the log still says how big the
 * payload was without recording it.
 */
export function redactCliTelemetryEventForLog(
	event: CliTelemetryEvent,
): Record<string, unknown> {
	if (event.kind === "start") {
		const { prompt: _prompt, ...rest } = event;
		return rest;
	}
	if (event.kind === "final-output") {
		const { output: _output, ...rest } = event;
		return rest;
	}
	return event;
}

/**
 * Default sink — emits a redacted, structured `cli.telemetry.<kind>` logEvent
 * for every event. Log failures are swallowed: telemetry must never propagate
 * into the CLI runner.
 */
export const defaultCliSink: CliTelemetrySink = (event, ctx) => {
	try {
		logEvent("info", `cli.telemetry.${event.kind}`, {
			source: "cli-telemetry",
			...ctx,
			...redactCliTelemetryEventForLog(event),
		});
	} catch {
		/* structured-log failures are non-fatal */
	}
};

// ---------------------------------------------------------------------------
// Observer factory
// ---------------------------------------------------------------------------

/**
 * Build a telemetry observer from a frozen context and a sink. Pure
 * composition — the returned function closes over both and performs no
 * other side effects.
 */
export function createCliObserver(
	ctx: CliTelemetryContext,
	sink: CliTelemetrySink = defaultCliSink,
): CliTelemetryObserver {
	const frozenCtx: CliTelemetryContext = Object.freeze({ ...ctx });
	return (event) => sink(event, frozenCtx);
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage scope — owned by ./cli-observer-registry (a leaf), but
// re-exported here so cli-telemetry stays the public composition surface.
// The registry split exists so cli-agents can read the ambient observer
// without taking a ./cli-telemetry import dependency that would close a
// brittle init-order cycle.
// ---------------------------------------------------------------------------

/**
 * Run `fn` with a telemetry observer installed in AsyncLocalStorage.
 * Every `runCliAgent` call inside the async tree reads the observer via
 * `getCurrentCliObserver()` and emits events through it — no caller
 * threading required.
 */
export function withCliTelemetry<T>(
	ctx: CliTelemetryContext,
	fn: () => Promise<T>,
	sink: CliTelemetrySink = defaultCliSink,
): Promise<T> {
	const pending: Promise<void>[] = [];
	const observer = createCliObserver(ctx, (event, context) => {
		const admitted = sink(event, context);
		if (admitted) {
			// Attach rejection handling immediately; await it at the scope boundary.
			const promise = Promise.resolve(admitted);
			void promise.catch(() => undefined);
			pending.push(promise);
		}
	});
	return observerRegistry.withObserver(observer as unknown as (event: unknown) => void, async () => {
		try { return await fn(); }
		finally { await Promise.all(pending); }
	}, { context: Object.freeze({ ...ctx }), track: (promise) => { pending.push(promise as Promise<void>); } });
}

/** Returns the observer installed by the nearest `withCliTelemetry`, or null. */
export function getCurrentCliObserver(): CliTelemetryObserver | null {
	return observerRegistry.getCurrentCliObserver() as CliTelemetryObserver | null;
}
