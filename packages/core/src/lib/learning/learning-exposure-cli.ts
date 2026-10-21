import { createHash } from "node:crypto";
import { isAbsolute, normalize, sep } from "node:path";

import {
  LearningExposureObservation,
  type ExposureObservation,
} from "./learning-exposure-schemas.js";

type Provider = "codex" | "claude" | "antigravity";
type JsonRecord = Record<string, unknown>;

/** A rewind is only an upgrade from the legacy projection, never a downgrade. */
export const isCliProjectionRevisionUpgrade = (previous: unknown, next: number = 2): boolean =>
  next === 2 && (previous === undefined || previous === null || previous === 0 || previous === 1);

export type CliExposureContext = {
  sourceId: string;
  versionId: string;
  sourceOrder: number;
  generation?: number;
  sessionId?: string;
  /** Exact enclosing Codex `turn_context.payload.turn_id`, when present. */
  codexTurnId?: string;
  originator?: string;
  isSubagent?: boolean;
};

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const canonical = (value: unknown): string => {
  if (value instanceof Uint8Array)
    return JSON.stringify({
      $bytes: Buffer.from(value).toString("base64"),
    });
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const item = record(value);
  if (item) {
    return `{${Object.keys(item)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(item[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
};

const sha256 = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const deterministicUuid = (value: string): string => {
  const bytes = Buffer.from(sha256(value).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values)
    if (typeof value === "string" && value.length > 0) return value;
  return null;
};

const timestamp = (
  ...values: unknown[]
): { observedAt: string; gaps: ExposureObservation["gaps"] } => {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const parsed = new Date(value);
    if (Number.isFinite(parsed.valueOf()))
      return { observedAt: parsed.toISOString(), gaps: [] };
  }
  return {
    observedAt: "1970-01-01T00:00:00.000Z",
    gaps: [
      {
        code: "missing-native-timestamp",
        detail:
          "The CLI record had no valid native timestamp; epoch is a deterministic placeholder",
      },
    ],
  };
};

const fallbackNativeIdentity = (context: CliExposureContext): string =>
  `${context.sourceId}:generation-${context.generation ?? 0}:order-${context.sourceOrder}`;

const safeRelativePath = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || isAbsolute(value))
    return undefined;
  const path = normalize(value);
  if (path === ".." || path.startsWith(`..${sep}`)) return undefined;
  return path;
};

const mediaKind = (type: string, mimeType?: string): string | null => {
  const lower = type.toLowerCase();
  const mime = mimeType?.toLowerCase() ?? "";
  if (lower.includes("image") || mime.startsWith("image/")) return "image";
  if (lower.includes("audio") || mime.startsWith("audio/")) return "audio";
  if (lower.includes("video") || mime.startsWith("video/")) return "video";
  if (lower.includes("document") || mime === "application/pdf")
    return "document";
  if (lower.includes("file") || mime.length > 0) return "file";
  return null;
};

const MAX_EMBEDDED_MEDIA_BYTES = 64 * 1024 * 1024;

type EmbeddedBytes =
  | { status: "none" }
  | { status: "invalid" | "over-limit"; locator: string; mimeType?: string }
  | {
      status: "decoded";
      bytes: Uint8Array;
      locator: string;
      mimeType?: string;
    };

const decodeBase64 = (
  encoded: string,
  locator: string,
  mimeType?: string,
): EmbeddedBytes => {
  // Check encoded size before allocating decoded bytes. Buffer.from(base64)
  // deliberately accepts malformed input, so syntax and padding are pinned.
  if (
    encoded.length === 0 ||
    encoded.length > Math.ceil(MAX_EMBEDDED_MEDIA_BYTES / 3) * 4 + 4 ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    return { status: "invalid", locator, ...(mimeType ? { mimeType } : {}) };
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength > MAX_EMBEDDED_MEDIA_BYTES)
    return { status: "over-limit", locator, ...(mimeType ? { mimeType } : {}) };
  return {
    status: "decoded",
    bytes,
    locator,
    ...(mimeType ? { mimeType } : {}),
  };
};

const decodeDataUrl = (value: string, locator: string): EmbeddedBytes => {
  if (!value.toLowerCase().startsWith("data:")) return { status: "none" };
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]*)$/.exec(value);
  if (!match) return { status: "invalid", locator };
  return decodeBase64(match[2]!, locator, match[1]);
};

const embeddedBytes = (block: JsonRecord, locator: string): EmbeddedBytes => {
  if (block.bytes instanceof Uint8Array)
    return block.bytes.byteLength > MAX_EMBEDDED_MEDIA_BYTES
      ? { status: "over-limit", locator: `${locator}/bytes` }
      : { status: "decoded", bytes: block.bytes, locator: `${locator}/bytes` };
  if (block.data instanceof Uint8Array)
    return block.data.byteLength > MAX_EMBEDDED_MEDIA_BYTES
      ? { status: "over-limit", locator: `${locator}/data` }
      : { status: "decoded", bytes: block.data, locator: `${locator}/data` };

  const source = record(block.source);
  if (source?.type === "base64") {
    if (typeof source.data !== "string")
      return { status: "invalid", locator: `${locator}/source/data` };
    return decodeBase64(
      source.data,
      `${locator}/source/data`,
      firstString(source.media_type, source.mimeType) ?? undefined,
    );
  }
  const imageUrl = record(block.image_url);
  const candidates: Array<[unknown, string]> = [
    [block.image_url, `${locator}/image_url`],
    [imageUrl?.url, `${locator}/image_url/url`],
    [block.url, `${locator}/url`],
    [block.uri, `${locator}/uri`],
  ];
  for (const [candidate, candidateLocator] of candidates) {
    if (typeof candidate !== "string") continue;
    const decoded = decodeDataUrl(candidate, candidateLocator);
    if (decoded.status !== "none") return decoded;
  }
  return { status: "none" };
};

const contentParts = (
  content: unknown,
  locatorRoot: string,
): {
  parts: ExposureObservation["parts"];
  gaps: ExposureObservation["gaps"];
} => {
  const values = Array.isArray(content) ? content : [content];
  const parts: ExposureObservation["parts"] = [];
  const gaps: ExposureObservation["gaps"] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value === "string") {
      parts.push({
        ordinal: parts.length,
        type: "text",
        text: value,
        captureStatus: "embedded",
      });
      continue;
    }
    const block = record(value);
    if (!block) continue;
    const type = String(block.type ?? "unknown");
    if (
      ["text", "input_text", "output_text"].includes(type) &&
      typeof block.text === "string"
    ) {
      parts.push({
        ordinal: parts.length,
        type: "text",
        text: block.text,
        captureStatus: "embedded",
      });
      continue;
    }
    const source = record(block.source);
    const declaredMime =
      firstString(
        block.mimeType,
        block.media_type,
        source?.media_type,
        source?.mimeType,
      ) ?? undefined;
    const kind = mediaKind(type, declaredMime);
    if (!kind) continue;
    const embedded = embeddedBytes(block, `${locatorRoot}/${index}`);
    const bytes = embedded.status === "decoded" ? embedded.bytes : null;
    const relativePath = safeRelativePath(block.spoolRelativePath);
    const nestedImageUrl = record(block.image_url)?.url;
    const hasRemoteReference = [
      block.image_url,
      nestedImageUrl,
      block.url,
      block.uri,
      source?.url,
    ].some(
      (candidate) =>
        typeof candidate === "string" &&
        !candidate.toLowerCase().startsWith("data:"),
    );
    const captureStatus =
      embedded.status === "invalid" || embedded.status === "over-limit"
        ? ("refused" as const)
        : bytes
          ? ("embedded" as const)
          : relativePath
            ? ("captured" as const)
            : hasRemoteReference
              ? ("remote-pending" as const)
              : ("missing" as const);
    const gapCode =
      embedded.status === "invalid"
        ? "invalid-embedded-base64"
        : embedded.status === "over-limit"
          ? "embedded-media-over-64mib-limit"
          : captureStatus === "remote-pending"
            ? "remote-media-not-captured"
            : captureStatus === "missing"
              ? "media-bytes-missing"
              : undefined;
    parts.push({
      ordinal: parts.length,
      type: "media",
      ...(bytes ? { sha256: sha256(bytes), byteLength: bytes.byteLength } : {}),
      ...((embedded.status !== "none" && embedded.mimeType) || declaredMime
        ? {
            mimeType:
              embedded.status !== "none" && embedded.mimeType
                ? embedded.mimeType
                : declaredMime,
          }
        : {}),
      mediaKind: kind,
      ...(embedded.status !== "none"
        ? { embeddedLocator: embedded.locator }
        : {}),
      ...(relativePath ? { spoolRelativePath: relativePath } : {}),
      captureStatus,
      ...(gapCode ? { gapCode } : {}),
    });
    if (gapCode)
      gaps.push({
        code: gapCode,
        detail:
          embedded.status === "invalid"
            ? `${kind} embedded base64 was invalid and was not decoded`
            : embedded.status === "over-limit"
              ? `${kind} embedded bytes exceeded the 64 MiB projection limit; the raw source remains archived`
              : `${kind} bytes were not present in the captured CLI record`,
      });
  }
  return { parts, gaps };
};

const buildObservation = (
  provider: Provider,
  nativeDiscriminator: string,
  recordValue: unknown,
  context: CliExposureContext,
  fields: Omit<
    ExposureObservation,
    "schemaVersion" | "observationId" | "dedupeKey" | "observedAt"
  > & { observedAt?: string },
): ExposureObservation => {
  const payloadHash = sha256(canonical(recordValue));
  const projection = {
    schemaVersion: 1,
    observedAt: fields.observedAt ?? "1970-01-01T00:00:00.000Z",
    hook: fields.hook,
    logicalMessageKey: fields.logicalMessageKey,
    direction: fields.direction,
    stage: fields.stage,
    authorship: fields.authorship,
    visibility: fields.visibility,
    correlation: {
      ...fields.correlation,
      // Additive projection revisions supersede earlier derived rows while the
      // immutable archive/raw observations remain untouched.
      cliProjectionRevision: 2,
      provider,
      sourceId: context.sourceId,
      sourceOrder: context.sourceOrder,
      generation: context.generation ?? 0,
      ...(context.sessionId ? { sessionId: context.sessionId } : {}),
      nativeDiscriminator,
      payloadSha256: payloadHash,
    },
    parts: fields.parts,
    gaps: fields.gaps,
  };
  // Native bytes identify the source record, not a derived projection. A new
  // revision/context can add turn linkage while retaining the same raw bytes.
  // Include the complete projection so an immutable identity never names two
  // different payloads; keep logicalMessageKey for canonical-message ranking.
  const identity = `${provider}\0${context.sourceId}\0${nativeDiscriminator}\0${payloadHash}\0projection-v2\0${sha256(canonical(projection))}`;
  return LearningExposureObservation.parse({
    ...projection,
    observationId: deterministicUuid(identity),
    dedupeKey: `cli:${sha256(identity)}`,
  });
};

const codexObservation = (
  row: JsonRecord,
  context: CliExposureContext,
): ExposureObservation | null => {
  if (row.type !== "response_item") return null;
  const payload = record(row.payload);
  if (!payload) return null;
  const type = String(payload.type ?? "unknown");
  const nativeId = firstString(payload.id);
  const passthrough = record(
    payload.internal_chat_message_metadata_passthrough,
  );
  const turnId = firstString(passthrough?.turn_id, context.codexTurnId);
  const native = nativeId ?? fallbackNativeIdentity(context);
  const internal = (
    exposureClass: string,
    content: unknown = [],
  ): ExposureObservation => {
    const extracted = contentParts(content, "/payload/content");
    const time = timestamp(row.timestamp);
    return buildObservation("codex", native, row, context, {
      hook: `cli.codex.${type}`,
      logicalMessageKey: null,
      direction: "internal",
      stage: type === "reasoning" ? "model_output" : "received",
      authorship: "agent",
      visibility: "internal",
      correlation: {
        exposureClass,
        ...(nativeId ? { messageId: nativeId } : {}),
        ...(context.sessionId ? { codexThreadId: context.sessionId } : {}),
        ...(turnId ? { codexTurnId: turnId } : {}),
      },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
      observedAt: time.observedAt,
    });
  };
  if (type === "reasoning") return internal("analysis", payload.content);
  if (type === "agent_message") return internal("subagent", payload.content);
  if (type.includes("tool") || type.includes("call")) return internal("tool");
  if (type !== "message") return null;

  const role = String(payload.role ?? "unknown");
  if (role === "developer" || role === "system")
    return internal("system", payload.content);
  if (role !== "user" && role !== "assistant") return null;

  // SDK/user-agent message streams can be mirrored through another transport.
  // Without an explicit native handoff key they are not projected as exposure.
  if (context.originator !== "codex-tui") return null;
  const kinds = Array.isArray(passthrough?.content_item_kinds)
    ? passthrough.content_item_kinds.map(String)
    : [];
  const thread = context.sessionId ?? context.sourceId;
  const logicalMessageKey = `codex:${thread}:${turnId ?? "-"}:${role}:${native}`;
  const extracted = contentParts(payload.content, "/payload/content");
  const time = timestamp(row.timestamp);
  if (role === "user") {
    const explicitlyHuman = kinds.includes("user.text");
    return buildObservation("codex", native, row, context, {
      hook: "cli.codex.user_message",
      logicalMessageKey,
      direction: explicitlyHuman ? "user_to_model" : "unknown",
      stage: "received",
      authorship: explicitlyHuman ? "human" : "unknown",
      visibility: explicitlyHuman ? "intended" : "unknown",
      correlation: {
        exposureClass: explicitlyHuman ? "user-authored" : "unknown",
        phase: "input",
        contentItemKinds: kinds,
        ...(nativeId ? { messageId: nativeId } : {}),
        ...(context.sessionId ? { codexThreadId: context.sessionId } : {}),
        ...(turnId ? { codexTurnId: turnId } : {}),
      },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
      observedAt: time.observedAt,
    });
  }
  if (payload.phase !== "commentary" && payload.phase !== "final_answer")
    return internal("unknown-assistant-phase", payload.content);
  return buildObservation("codex", native, row, context, {
    hook: `cli.codex.assistant_${String(payload.phase)}`,
    logicalMessageKey,
    direction: "model_to_user",
    stage: "user_facing",
    authorship: "agent",
    visibility: "intended",
    correlation: {
      exposureClass: "assistant-user-facing",
      phase: payload.phase,
      rendered: "not-observed",
      ...(nativeId ? { messageId: nativeId } : {}),
      ...(context.sessionId ? { codexThreadId: context.sessionId } : {}),
      ...(turnId ? { codexTurnId: turnId } : {}),
    },
    parts: extracted.parts,
    gaps: [...extracted.gaps, ...time.gaps],
    observedAt: time.observedAt,
  });
};

const claudeObservation = (
  row: JsonRecord,
  context: CliExposureContext,
): ExposureObservation | null => {
  const message = record(row.message);
  const attachment = record(row.attachment);
  const attachmentOrigin = record(attachment?.origin);
  const queuedHuman =
    row.type === "attachment" &&
    attachment?.type === "queued_command" &&
    attachment.commandMode === "prompt" &&
    attachmentOrigin?.kind === "human" &&
    typeof attachment.prompt === "string";
  const role =
    message?.role === "user" || message?.role === "assistant"
      ? message.role
      : queuedHuman
        ? "user"
        : null;
  const content = queuedHuman ? attachment?.prompt : message?.content;
  const extracted = contentParts(
    content,
    queuedHuman ? "/attachment/prompt" : "/message/content",
  );
  const contentTypes = Array.isArray(message?.content)
    ? message.content
        .map(record)
        .filter((item): item is JsonRecord => item !== null)
        .map((item) => String(item.type))
    : [];
  const sidechain =
    context.isSubagent === true ||
    row.isSidechain === true ||
    typeof row.agentId === "string";
  const nativeId = firstString(row.uuid, message?.id);
  const native = nativeId ?? fallbackNativeIdentity(context);
  const thread =
    firstString(row.sessionId, context.sessionId) ?? context.sourceId;
  const logicalMessageKey = role ? `claude:${thread}:${role}:${native}` : null;
  const time = timestamp(row.timestamp);
  const parentUuid = firstString(row.parentUuid);
  const replyTo = firstString(row.replyTo, row.reply_to, message?.replyTo);
  const correlationLinks = {
    ...(nativeId ? { messageId: nativeId } : {}),
    ...(parentUuid ? { parentUuid } : {}),
    ...(replyTo ? { replyTo } : {}),
  };
  const common = {
    hook: `cli.claude.${String(row.type ?? "unknown")}`,
    logicalMessageKey,
    observedAt: time.observedAt,
  };
  if (sidechain) {
    return buildObservation("claude", native, row, context, {
      ...common,
      direction: "internal",
      stage: "received",
      authorship: "agent",
      visibility: "internal",
      correlation: { exposureClass: "subagent", ...correlationLinks },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
    });
  }
  if (role === "assistant" && contentTypes.includes("text")) {
    return buildObservation("claude", native, row, context, {
      ...common,
      direction: "model_to_user",
      stage: "user_facing",
      authorship: "agent",
      visibility: "intended",
      correlation: {
        exposureClass: "assistant-user-facing",
        rendered: "not-observed",
        ...correlationLinks,
      },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
    });
  }
  if (role === "assistant" && contentTypes.includes("thinking")) {
    return buildObservation("claude", native, row, context, {
      ...common,
      direction: "internal",
      stage: "model_output",
      authorship: "agent",
      visibility: "internal",
      correlation: { exposureClass: "analysis", ...correlationLinks },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
    });
  }
  if (
    contentTypes.includes("tool_use") ||
    contentTypes.includes("tool_result")
  ) {
    return buildObservation("claude", native, row, context, {
      ...common,
      direction: "internal",
      stage: "received",
      authorship: "agent",
      visibility: "internal",
      correlation: { exposureClass: "tool", ...correlationLinks },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
    });
  }
  if (role === "user") {
    const originKind = firstString(record(row.origin)?.kind);
    const explicitlyHuman =
      queuedHuman || row.promptSource === "typed" || originKind === "human";
    return buildObservation("claude", native, row, context, {
      ...common,
      direction: explicitlyHuman ? "user_to_model" : "unknown",
      stage: "received",
      authorship: explicitlyHuman ? "human" : "unknown",
      visibility: explicitlyHuman ? "intended" : "unknown",
      correlation: {
        exposureClass: explicitlyHuman ? "user-authored" : "unknown",
        promptSource: firstString(row.promptSource) ?? "missing",
        ...correlationLinks,
      },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
    });
  }
  if (row.type === "system" || row.promptSource === "system") {
    return buildObservation("claude", native, row, context, {
      ...common,
      direction: "internal",
      stage: "received",
      authorship: "system",
      visibility: "internal",
      correlation: { exposureClass: "system", ...correlationLinks },
      parts: extracted.parts,
      gaps: [...extracted.gaps, ...time.gaps],
    });
  }
  return null;
};

type ProtoField = {
  number: number;
  wireType: number;
  value: number | Uint8Array;
};

const protoFields = (value: Uint8Array | null): ProtoField[] => {
  if (!value) return [];
  const bytes = Buffer.from(value);
  const fields: ProtoField[] = [];
  let offset = 0;
  const varint = (): number => {
    let result = 0;
    let shift = 0;
    for (let count = 0; count < 10 && offset < bytes.length; count += 1) {
      const byte = bytes[offset++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
    throw new Error("Invalid protobuf varint");
  };
  while (offset < bytes.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wireType = key % 8;
    if (number < 1) throw new Error("Invalid protobuf field number");
    if (wireType === 0) fields.push({ number, wireType, value: varint() });
    else if (wireType === 1 || wireType === 5) {
      const width = wireType === 1 ? 8 : 4;
      if (offset + width > bytes.length)
        throw new Error("Truncated protobuf field");
      fields.push({
        number,
        wireType,
        value: bytes.subarray(offset, offset + width),
      });
      offset += width;
    } else if (wireType === 2) {
      const length = varint();
      if (offset + length > bytes.length)
        throw new Error("Truncated protobuf bytes");
      fields.push({
        number,
        wireType,
        value: bytes.subarray(offset, offset + length),
      });
      offset += length;
    } else throw new Error(`Unsupported protobuf wire type ${wireType}`);
  }
  return fields;
};

const protoBytes = (
  fields: ProtoField[],
  number: number,
): Uint8Array | null => {
  const field = fields.find(
    (item) => item.number === number && item.wireType === 2,
  );
  return field && typeof field.value !== "number" ? field.value : null;
};

const protoText = (fields: ProtoField[], number: number): string => {
  const bytes = protoBytes(fields, number);
  return bytes ? Buffer.from(bytes).toString("utf8") : "";
};

const protoNumber = (fields: ProtoField[], number: number): number | null => {
  const field = fields.find(
    (item) => item.number === number && item.wireType === 0,
  );
  return field && typeof field.value === "number" ? field.value : null;
};

const antigravityTimestamp = (
  metadata: Uint8Array | null,
): { observedAt: string; gaps: ExposureObservation["gaps"] } => {
  try {
    const fields = protoFields(protoBytes(protoFields(metadata), 1));
    const seconds = protoNumber(fields, 1);
    const nanos = protoNumber(fields, 2) ?? 0;
    return seconds === null
      ? timestamp(null)
      : {
          observedAt: new Date(
            seconds * 1_000 + nanos / 1_000_000,
          ).toISOString(),
          gaps: [],
        };
  } catch {
    return timestamp(null);
  }
};

const antigravityObservation = (
  row: JsonRecord,
  context: CliExposureContext,
): ExposureObservation | null => {
  const stepType = Number(row.step_type);
  const index = Number(row.idx);
  if (!Number.isSafeInteger(stepType) || !Number.isSafeInteger(index))
    return null;
  const payload =
    row.step_payload instanceof Uint8Array ? row.step_payload : null;
  const metadata = row.metadata instanceof Uint8Array ? row.metadata : null;
  let nativeId: string | null = null;
  let text = "";
  try {
    nativeId = protoText(protoFields(metadata), 12) || null;
    const outer = protoFields(payload);
    if (stepType === 14)
      text = protoText(protoFields(protoBytes(outer, 19)), 2);
    if (stepType === 15)
      text = protoText(protoFields(protoBytes(outer, 20)), 1);
  } catch {
    // Preserve an unclassified observation without inventing decoded content.
  }
  const native = nativeId ?? fallbackNativeIdentity(context);
  const thread = context.sessionId ?? context.sourceId;
  const parts = text
    ? ([
        { ordinal: 0, type: "text", text, captureStatus: "embedded" },
      ] satisfies ExposureObservation["parts"])
    : [];
  const role = stepType === 14 ? "user" : stepType === 15 ? "assistant" : null;
  const time = antigravityTimestamp(metadata);
  return buildObservation("antigravity", native, row, context, {
    hook: `cli.antigravity.step_${stepType}`,
    observedAt: time.observedAt,
    logicalMessageKey: role ? `antigravity:${thread}:${role}:${native}` : null,
    direction:
      stepType === 14
        ? "user_to_model"
        : stepType === 15
          ? "model_to_user"
          : "unknown",
    stage:
      stepType === 14
        ? "model_input"
        : stepType === 15
          ? "user_facing"
          : "received",
    authorship: stepType === 15 ? "agent" : "unknown",
    visibility: stepType === 14 || stepType === 15 ? "intended" : "unknown",
    correlation: {
      exposureClass:
        stepType === 14
          ? "user-role-authorship-unknown"
          : stepType === 15
            ? "assistant-user-facing"
            : "unclassified",
      stepType,
      hasSubtrajectory: row.has_subtrajectory === 1,
      rendered: "not-observed",
      ...(nativeId ? { messageId: nativeId } : {}),
    },
    parts,
    gaps: [
      ...time.gaps,
      ...(stepType === 14 || stepType === 15
        ? []
        : [
            {
              code: "unknown-antigravity-step-type",
              detail: `Step type ${stepType} has no pinned semantic mapping`,
            },
          ]),
    ],
  });
};

export const projectCliExposureRecord = (
  provider: Provider,
  recordValue: unknown,
  context: CliExposureContext,
): ExposureObservation | null => {
  if (!Number.isSafeInteger(context.sourceOrder) || context.sourceOrder < 0)
    throw new Error("CLI exposure sourceOrder must be a non-negative integer");
  const row = record(recordValue);
  if (!row) return null;
  if (provider === "codex") return codexObservation(row, context);
  if (provider === "claude") return claudeObservation(row, context);
  return antigravityObservation(row, context);
};
