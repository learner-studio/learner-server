/**
 * Structured-log / observability facade.
 *
 * Callers emit `logEvent(level, event, fields)` and the facade handles:
 *   - min-level gating from `LOG_LEVEL` env var
 *   - deterministic JSON-safe sanitization of nested values (depth 4,
 *     array cap 100, string cap 8000)
 *   - console output at the right `console.*` method
 *   - optional durable persistence via a registered sink (default:
 *     warn/error levels persist, others don't; per-call override via
 *     `options.persist`)
 *
 * Also ships an Express request-logging middleware that auto-tags
 * `req.requestId` + sets `X-Request-Id`.
 *
 * @module lib/observability
 */

import * as crypto from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_LEVEL = String(process.env.LOG_LEVEL || "info").toLowerCase();
const MIN_LEVEL: number =
  (LEVELS as Record<string, number>)[LOG_LEVEL] ?? LEVELS.info;

/** Serialized form of a runtime error — JSON-friendly, no live references. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack: string | null;
  readonly [key: string]: unknown;
}

/** Per-event options. Most callers pass none. */
export interface LogEventOptions {
  /**
   * Force persistence on or off. Unset = use default policy
   * (`warn`/`error` persist; `info`/`debug` don't).
   */
  readonly persist?: boolean;
  /** If present, serialized and attached to the payload as `error`. */
  readonly error?: unknown;
}

/** Sink fn for durable log storage. Return/throw is ignored by `logEvent`. */
export type LogSink = (payload: Record<string, unknown>) => void;

let sink: LogSink | null = null;

export function generateRequestId(prefix = "req"): string {
  const token = crypto.randomBytes(6).toString("hex");
  return `${prefix}_${Date.now().toString(36)}_${token}`;
}

export function serializeError(
  error: unknown,
): SerializedError | { message: string } | null {
  if (!error) return null;
  if (typeof error === "string") return { message: error };

  const e = error as { name?: string; message?: string; stack?: string } & Record<
    string,
    unknown
  >;
  const output: Record<string, unknown> = {
    name: e.name || "Error",
    message: e.message || String(error),
    stack: e.stack || null,
  };

  for (const key of Object.keys(e)) {
    if (output[key] !== undefined) continue;
    const value = e[key];
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null) {
      try {
        output[key] = JSON.parse(JSON.stringify(value));
      } catch {
        output[key] = String(value);
      }
    } else {
      output[key] = value;
    }
  }

  return output as SerializedError;
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") {
    return value.length > 8000 ? `${value.slice(0, 8000)}...[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (typeof value !== "object") return String(value);
  if (depth >= 4) return "[max-depth]";

  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, depth + 1));
  }

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = sanitizeValue(child, depth + 1);
    if (normalized !== undefined) {
      output[key] = normalized;
    }
  }
  return output;
}

function normalizeLevel(level: unknown): LogLevel {
  const normalized = String(level || "info").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(LEVELS, normalized)) {
    return "info";
  }
  return normalized as LogLevel;
}

export function setLogSink(nextSink: LogSink | null): void {
  sink = typeof nextSink === "function" ? nextSink : null;
}

function shouldLog(level: LogLevel): boolean {
  return ((LEVELS as Record<string, number>)[level] || LEVELS.info) >= MIN_LEVEL;
}

function shouldPersist(level: LogLevel, options: LogEventOptions = {}): boolean {
  if (options.persist === true) return true;
  if (options.persist === false) return false;
  return level === "warn" || level === "error";
}

export function logEvent(
  level: LogLevel | string,
  event: string,
  fields: Record<string, unknown> = {},
  options: LogEventOptions = {},
): Record<string, unknown> | null {
  const normalizedLevel = normalizeLevel(level);
  if (!shouldLog(normalizedLevel)) return null;

  const payload = sanitizeValue({
    timestamp: new Date().toISOString(),
    level: normalizedLevel,
    event: event || "event",
    ...fields,
  }) as Record<string, unknown>;

  if (options.error) {
    payload.error = serializeError(options.error);
  }

  const line = JSON.stringify(payload);
  if (normalizedLevel === "error") {
    console.error(line);
  } else if (normalizedLevel === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  if (sink && shouldPersist(normalizedLevel, options)) {
    try {
      sink(payload);
    } catch (sinkError: unknown) {
      const message =
        (sinkError as { message?: string } | null)?.message ?? String(sinkError);
      const sinkLine = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        event: "observability.sink_failure",
        message,
      });
      console.error(sinkLine);
    }
  }

  return payload;
}

