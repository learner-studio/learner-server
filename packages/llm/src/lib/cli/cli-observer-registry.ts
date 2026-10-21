// Leaf module — hosts the AsyncLocalStorage that propagates a CLI observer
// across nested async calls, plus the heartbeat-cadence constant. Owns no
// imports from the extraction SCC, so the cli-agents → cli-telemetry edge can
// flip to cli-agents → cli-observer-registry without pulling cli-telemetry's
// formatter/sink chain into the cycle.
//
// cli-telemetry imports `withObserver` and re-exports `getCurrentCliObserver`
// + `CLI_HEARTBEAT_INTERVAL_MS` so existing callers (and tests) keep working
// against the cli-telemetry surface unchanged.

import { AsyncLocalStorage } from "async_hooks";

// Loosely-typed observer signature so the registry stays domain-agnostic.
// cli-telemetry casts to its internal `CliTelemetryObserver` at the
// composition boundary.
export type ObserverFunction = (event: unknown) => void;

/** The context the scope was opened with, and where to park a promise the scope must await. */
export type CliScope = {
	readonly observer: ObserverFunction;
	readonly context?: Readonly<Record<string, unknown>>;
	readonly track?: (pending: Promise<unknown>) => void;
};

const store = new AsyncLocalStorage<CliScope>();

export function withObserver<T>(
	observer: ObserverFunction,
	fn: () => Promise<T>,
	scope: Omit<CliScope, "observer"> = {},
): Promise<T> {
	return store.run({ observer, ...scope }, fn);
}

export function getCurrentCliObserver(): ObserverFunction | null {
	return store.getStore()?.observer ?? null;
}

export function getCurrentCliScope(): CliScope | null {
	return store.getStore() ?? null;
}

// Heartbeat cadence — 4× per minute is the sweet spot for the chat-stream UI
// (12 heartbeats per 3-minute LLM turn). Exported here so cli-agents can read
// it without taking a cli-telemetry dependency.
export const CLI_HEARTBEAT_INTERVAL_MS = 15_000;
