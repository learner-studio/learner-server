import { describe, expect, test } from "bun:test";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, sep } from "node:path";
import { Database } from "bun:sqlite";

import { isCliProjectionRevisionUpgrade, projectCliExposureRecord } from "./learning-exposure-cli.js";
import { exposureIsVisible } from "../../services/learning-exposure-service.js";

type JsonRecord = Record<string, unknown>;
type Exposure =
  | "user-authored"
  | "assistant-user-facing"
  | "analysis"
  | "tool"
  | "subagent"
  | "system"
  | "unknown";

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;

const exposureContext = {
  sourceId: "11111111-1111-4111-8111-111111111111",
  versionId: "22222222-2222-4222-8222-222222222222",
  sourceOrder: 7,
  sessionId: "native-session",
  originator: "codex-tui",
};

test('revision-aware projection identity supersedes legacy rows and remains stable on exact replay', () => {
  const raw = { type: 'response_item', timestamp: '2026-09-06T00:00:00Z', payload: { type: 'message', role: 'assistant', id: 'projection-revision-regression', phase: 'final_answer', content: [{ type: 'output_text', text: 'Source bytes stay unchanged.' }] } }
  const current = projectCliExposureRecord('codex', raw, exposureContext)!
  const c = current.correlation
  const legacyBytes = Buffer.from(createHash('sha256').update(`${c.provider}\0${c.sourceId}\0${c.nativeDiscriminator}\0${c.payloadSha256}`).digest('hex').slice(0,32), 'hex')
  legacyBytes[6] = (legacyBytes[6]! & 0x0f) | 0x50
  legacyBytes[8] = (legacyBytes[8]! & 0x3f) | 0x80
  const h = legacyBytes.toString('hex')
  const legacyId = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
  expect(current.observationId).not.toBe(legacyId)
  expect(current.correlation.cliProjectionRevision).toBe(2)
  expect(projectCliExposureRecord('codex', raw, exposureContext)).toEqual(current)
  expect(current.logicalMessageKey).toBe('codex:native-session:-:assistant:projection-revision-regression')
  const linked = projectCliExposureRecord('codex', raw, { ...exposureContext, sourceOrder: exposureContext.sourceOrder + 1 })!
  expect(linked.logicalMessageKey).toBe(current.logicalMessageKey)
  expect(linked.observationId).not.toBe(current.observationId)
  expect(linked.parts).toEqual(current.parts)
})

test('projection cursor may rewind only for an explicit legacy-to-v2 upgrade', () => {
  expect(isCliProjectionRevisionUpgrade(undefined)).toBe(true)
  expect(isCliProjectionRevisionUpgrade(1)).toBe(true)
  expect(isCliProjectionRevisionUpgrade(2)).toBe(false)
  expect(isCliProjectionRevisionUpgrade(3)).toBe(false)
  expect(isCliProjectionRevisionUpgrade(1, 1)).toBe(false)
  expect(isCliProjectionRevisionUpgrade('invalid')).toBe(false)
})

const blocks = (value: unknown): JsonRecord[] =>
  Array.isArray(value)
    ? value.map(record).filter((item): item is JsonRecord => item !== null)
    : [];

const increment = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const codexExposure = (
  row: JsonRecord,
  originator: string | null,
): Exposure => {
  if (row.type !== "response_item") return "unknown";
  const payload = record(row.payload);
  const type = String(payload?.type ?? "");
  if (type === "reasoning") return "analysis";
  if (type === "agent_message") return "subagent";
  if (type.includes("tool") || type.includes("call")) return "tool";
  if (type !== "message") return "unknown";
  if (payload?.role === "assistant") {
    return payload.phase === "commentary" || payload.phase === "final_answer"
      ? "assistant-user-facing"
      : "unknown";
  }
  if (payload?.role === "developer" || payload?.role === "system")
    return "system";
  if (payload?.role !== "user") return "unknown";
  const passthrough = record(
    payload.internal_chat_message_metadata_passthrough,
  );
  const kinds = Array.isArray(passthrough?.content_item_kinds)
    ? passthrough.content_item_kinds.map(String)
    : [];
  if (originator === "codex-tui" && kinds.includes("user.text"))
    return "user-authored";
  return kinds.includes("user.text") ? "subagent" : "system";
};

const claudeExposure = (row: JsonRecord, sourcePath = "session.jsonl") => {
  const message = record(row.message);
  const contentTypes = blocks(message?.content).map((item) =>
    String(item.type),
  );
  const sidechain =
    row.isSidechain === true ||
    typeof row.agentId === "string" ||
    sourcePath.includes(`${sep}subagents${sep}`);
  const attachment = record(row.attachment);
  const attachmentOrigin = record(attachment?.origin);
  if (
    row.type === "attachment" &&
    attachment?.type === "queued_command" &&
    attachment?.commandMode === "prompt" &&
    attachmentOrigin?.kind === "human"
  ) {
    return "user-authored" as const;
  }
  if (sidechain) return "subagent" as const;
  if (row.type === "assistant" && message?.role === "assistant") {
    if (contentTypes.includes("text")) return "assistant-user-facing" as const;
    if (contentTypes.includes("thinking")) return "analysis" as const;
    if (contentTypes.includes("tool_use")) return "tool" as const;
  }
  if (
    row.type === "user" &&
    message?.role === "user" &&
    (row.promptSource === "typed" || record(row.origin)?.kind === "human")
  ) {
    return "user-authored" as const;
  }
  if (contentTypes.includes("tool_result")) return "tool" as const;
  if (row.type === "system" || row.promptSource === "system")
    return "system" as const;
  return "unknown" as const;
};

const filesBelow = async (root: string, suffix: string): Promise<string[]> => {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, {
      withFileTypes: true,
      encoding: "utf8",
    }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(path);
    }
  };
  await visit(root);
  return found.sort();
};

const jsonLines = async (
  path: string,
  inspect: (row: JsonRecord) => void,
): Promise<number> => {
  let malformed = 0;
  const lines = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    try {
      const row = record(JSON.parse(line));
      if (row) inspect(row);
    } catch {
      malformed += 1;
    }
  }
  return malformed;
};

describe("installed CLI exposure metadata", () => {
  test("projects only explicit human and user-facing records as visible", () => {
    const user = projectCliExposureRecord(
      "codex",
      {
        type: "response_item",
        timestamp: "2026-09-05T12:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          id: "user-1",
          content: [{ type: "input_text", text: "same text" }],
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-1",
            content_item_kinds: ["user.text"],
          },
        },
      },
      exposureContext,
    );
    expect(user?.authorship).toBe("human");
    expect(user?.direction).toBe("user_to_model");
    expect(exposureIsVisible(user!)).toBe(true);
    expect(user?.correlation).toMatchObject({
      cliProjectionRevision: 2,
      sessionId: "native-session",
      codexThreadId: "native-session",
      codexTurnId: "turn-1",
      messageId: "user-1",
    });

    const commentary = projectCliExposureRecord(
      "codex",
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "assistant-commentary",
          phase: "commentary",
          content: [{ type: "output_text", text: "visible progress" }],
        },
      },
      exposureContext,
    );
    const final = projectCliExposureRecord(
      "codex",
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "assistant-final",
          phase: "final_answer",
          content: [{ type: "output_text", text: "visible result" }],
        },
      },
      exposureContext,
    );
    expect(exposureIsVisible(commentary!)).toBe(true);
    expect(exposureIsVisible(final!)).toBe(true);
    expect(commentary?.visibility).toBe("intended");
    expect(final?.visibility).toBe("intended");
    const inheritedTurn = projectCliExposureRecord(
      "codex",
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "assistant-inherited-turn",
          phase: "final_answer",
          content: [{ type: "output_text", text: "native turn result" }],
        },
      },
      { ...exposureContext, codexTurnId: "enclosing-native-turn" },
    );
    expect(inheritedTurn?.correlation).toMatchObject({
      cliProjectionRevision: 2,
      codexTurnId: "enclosing-native-turn",
    });
    expect(inheritedTurn?.logicalMessageKey).toContain(
      ":enclosing-native-turn:assistant:",
    );
    expect(commentary?.gaps).toContainEqual(
      expect.objectContaining({ code: "missing-native-timestamp" }),
    );

    const analysis = projectCliExposureRecord(
      "codex",
      {
        type: "response_item",
        payload: { type: "reasoning", id: "analysis-1" },
      },
      exposureContext,
    );
    expect(analysis?.direction).toBe("internal");
    expect(exposureIsVisible(analysis!)).toBe(false);
    expect(
      projectCliExposureRecord(
        "codex",
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            id: "sdk-echo",
            content: [{ type: "input_text", text: "mirrored input" }],
          },
        },
        { ...exposureContext, originator: "codex_exec" },
      ),
    ).toBeNull();
  });

  test("excludes Claude sidechains and distinguishes output from delivery", () => {
    const main = projectCliExposureRecord(
      "claude",
      {
        type: "assistant",
        uuid: "main-1",
        parentUuid: "parent-1",
        replyTo: "reply-1",
        sessionId: "claude-session",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "same response" }],
        },
      },
      exposureContext,
    );
    const sidechain = projectCliExposureRecord(
      "claude",
      {
        type: "assistant",
        uuid: "child-1",
        sessionId: "claude-session",
        isSidechain: true,
        agentId: "child",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "same response" }],
        },
      },
      exposureContext,
    );
    expect(exposureIsVisible(main!)).toBe(true);
    expect(main?.correlation).toMatchObject({
      sessionId: "native-session",
      messageId: "main-1",
      parentUuid: "parent-1",
      replyTo: "reply-1",
    });
    expect(sidechain?.direction).toBe("internal");
    expect(exposureIsVisible(sidechain!)).toBe(false);
    expect(exposureIsVisible({ ...main!, stage: "model_output" })).toBe(false);
    expect(
      exposureIsVisible({
        ...main!,
        stage: "delivered",
        visibility: "delivered",
      }),
    ).toBe(true);
  });

  test("retains equal text under distinct native identities and never emits media URLs", () => {
    const make = (id: string) =>
      projectCliExposureRecord(
        "codex",
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            id,
            phase: "final_answer",
            content: [
              { type: "output_text", text: "identical" },
              { type: "input_image", url: "https://private.invalid/a.png" },
              { type: "file", spoolRelativePath: "spool/captured.bin" },
              { type: "audio", path: "/private/source.wav" },
            ],
          },
        },
        exposureContext,
      )!;
    const first = make("native-1");
    const second = make("native-2");
    const replayFromLaterRawVersion = projectCliExposureRecord(
      "codex",
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "native-1",
          phase: "final_answer",
          content: [
            { type: "output_text", text: "identical" },
            { type: "input_image", url: "https://private.invalid/a.png" },
            { type: "file", spoolRelativePath: "spool/captured.bin" },
            { type: "audio", path: "/private/source.wav" },
          ],
        },
      },
      {
        ...exposureContext,
        versionId: "33333333-3333-4333-8333-333333333333",
      },
    )!;
    expect(first.observationId).not.toBe(second.observationId);
    expect(first.logicalMessageKey).not.toBe(second.logicalMessageKey);
    expect(replayFromLaterRawVersion.observationId).toBe(first.observationId);
    expect(replayFromLaterRawVersion.logicalMessageKey).toBe(
      first.logicalMessageKey,
    );
    const withoutNativeId = (generation: number) =>
      projectCliExposureRecord(
        "codex",
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            phase: "final_answer",
            content: [{ type: "output_text", text: "fallback" }],
          },
        },
        { ...exposureContext, generation },
      )!;
    expect(withoutNativeId(0).observationId).not.toBe(
      withoutNativeId(1).observationId,
    );
    expect(first.parts.filter((part) => part.type === "text")).toHaveLength(1);
    expect(first.parts.filter((part) => part.type === "media")).toHaveLength(3);
    expect(first.parts[1]).toMatchObject({
      mediaKind: "image",
      captureStatus: "remote-pending",
      gapCode: "remote-media-not-captured",
    });
    expect(first.parts[2]).toMatchObject({
      mediaKind: "file",
      captureStatus: "captured",
      spoolRelativePath: "spool/captured.bin",
    });
    expect(first.parts[3]).toMatchObject({
      mediaKind: "audio",
      captureStatus: "missing",
      gapCode: "media-bytes-missing",
    });
    expect(JSON.stringify(first)).not.toContain("private.invalid");
    expect(JSON.stringify(first)).not.toContain("/private/source.wav");
    expect(
      projectCliExposureRecord("codex", first, exposureContext),
    ).toBeNull();
  });

  test("projects strict bounded embedded Codex and Claude media with raw-record locators", () => {
    const pngBytes = Buffer.from([1, 2, 3, 4]);
    const pngDataUrl = `data:image/png;base64,${pngBytes.toString("base64")}`;
    const codex = projectCliExposureRecord(
      "codex",
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          id: "embedded-codex",
          phase: "final_answer",
          content: [
            { type: "output_text", text: "image" },
            { type: "input_image", image_url: pngDataUrl },
            {
              type: "input_image",
              image_url: { url: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" },
            },
            { type: "input_image", image_url: "data:image/png;base64,%%%" },
          ],
        },
      },
      exposureContext,
    )!;
    expect(codex.parts[1]).toMatchObject({
      type: "media",
      mediaKind: "image",
      mimeType: "image/png",
      captureStatus: "embedded",
      embeddedLocator: "/payload/content/1/image_url",
      byteLength: 4,
      sha256: createHash("sha256").update(pngBytes).digest("hex"),
    });
    expect(codex.parts[2]).toMatchObject({
      captureStatus: "embedded",
      embeddedLocator: "/payload/content/2/image_url/url",
      mimeType: "image/gif",
    });
    expect(codex.parts[3]).toMatchObject({
      captureStatus: "refused",
      embeddedLocator: "/payload/content/3/image_url",
      gapCode: "invalid-embedded-base64",
    });
    expect(codex.gaps).toContainEqual(
      expect.objectContaining({ code: "invalid-embedded-base64" }),
    );

    const claude = projectCliExposureRecord(
      "claude",
      {
        type: "assistant",
        uuid: "embedded-claude",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "media" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/webp",
                data: "AQID",
              },
            },
            {
              type: "audio",
              source: {
                type: "base64",
                media_type: "audio/ogg",
                data: "BAUG",
              },
            },
            {
              type: "video",
              source: {
                type: "base64",
                media_type: "video/mp4",
                data: "BwgJ",
              },
            },
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: "CgsM",
              },
            },
          ],
        },
      },
      exposureContext,
    )!;
    expect(claude.parts.slice(1).map((part) => part.mediaKind)).toEqual([
      "image",
      "audio",
      "video",
      "document",
    ]);
    expect(
      claude.parts
        .slice(1)
        .every(
          (part) =>
            part.captureStatus === "embedded" &&
            part.embeddedLocator?.startsWith("/message/content/") === true &&
            typeof part.sha256 === "string" &&
            part.byteLength === 3,
        ),
    ).toBe(true);
  });

  test("keeps SDK user echoes and unknown AGY enums out of visible exposure", () => {
    const sdkEcho = projectCliExposureRecord(
      "claude",
      {
        type: "user",
        uuid: "sdk-echo",
        promptSource: "sdk",
        entrypoint: "sdk-cli",
        message: {
          role: "user",
          content: [{ type: "text", text: "agent supplied" }],
        },
      },
      exposureContext,
    );
    expect(sdkEcho?.direction).toBe("unknown");
    expect(sdkEcho?.authorship).toBe("unknown");
    expect(exposureIsVisible(sdkEcho!)).toBe(false);

    const unknownAgy = projectCliExposureRecord(
      "antigravity",
      {
        idx: 19,
        step_type: 132,
        has_subtrajectory: 0,
        metadata: new Uint8Array(),
        step_payload: new Uint8Array(),
      },
      exposureContext,
    );
    expect(unknownAgy?.direction).toBe("unknown");
    expect(unknownAgy?.visibility).toBe("unknown");
    expect(unknownAgy?.gaps).toContainEqual({
      code: "unknown-antigravity-step-type",
      detail: "Step type 132 has no pinned semantic mapping",
    });
    expect(unknownAgy?.gaps).toContainEqual(
      expect.objectContaining({ code: "missing-native-timestamp" }),
    );
    expect(exposureIsVisible(unknownAgy!)).toBe(false);
  });

  test("classifies provider record shapes without reading message meaning", () => {
    expect(
      codexExposure(
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: {
              content_item_kinds: ["user.text"],
            },
          },
        },
        "codex-tui",
      ),
    ).toBe("user-authored");
    expect(
      codexExposure(
        {
          type: "response_item",
          payload: { type: "message", role: "assistant", phase: "commentary" },
        },
        "codex-tui",
      ),
    ).toBe("assistant-user-facing");
    expect(
      codexExposure(
        { type: "response_item", payload: { type: "reasoning" } },
        "codex-tui",
      ),
    ).toBe("analysis");
    expect(
      codexExposure(
        { type: "response_item", payload: { type: "custom_tool_call" } },
        "codex-tui",
      ),
    ).toBe("tool");
    expect(
      codexExposure(
        { type: "response_item", payload: { type: "agent_message" } },
        "codex-tui",
      ),
    ).toBe("subagent");

    expect(
      claudeExposure({
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "text" }] },
      }),
    ).toBe("assistant-user-facing");
    expect(
      claudeExposure({
        type: "assistant",
        isSidechain: false,
        message: { role: "assistant", content: [{ type: "thinking" }] },
      }),
    ).toBe("analysis");
    expect(
      claudeExposure({
        type: "assistant",
        isSidechain: true,
        agentId: "child",
        message: { role: "assistant", content: [{ type: "text" }] },
      }),
    ).toBe("subagent");
    expect(
      claudeExposure({
        type: "attachment",
        attachment: {
          type: "queued_command",
          commandMode: "prompt",
          origin: { kind: "human" },
        },
      }),
    ).toBe("user-authored");
  });

  const liveTest =
    process.env.LEARNING_EXPOSURE_CLI_PROBE === "yes" ? test : test.skip;
  liveTest(
    "reports metadata-only exposure counts from installed transcript stores",
    async () => {
      const codexFiles = [
        ...(await filesBelow("/root/.codex/sessions", ".jsonl")),
        ...(await filesBelow("/root/.codex/archived_sessions", ".jsonl")),
      ];
      const codex = {
        files: codexFiles.length,
        records: 0,
        malformed: 0,
        userAuthored: 0,
        assistantUserFacing: 0,
        assistantCommentary: 0,
        assistantFinal: 0,
        analysis: 0,
        tool: 0,
        subagent: 0,
        system: 0,
        unknown: 0,
      };
      for (const path of codexFiles) {
        let originator: string | null = null;
        codex.malformed += await jsonLines(path, (row) => {
          codex.records += 1;
          if (row.type === "session_meta") {
            const payload = record(row.payload);
            originator =
              typeof payload?.originator === "string"
                ? payload.originator
                : originator;
            return;
          }
          const exposure = codexExposure(row, originator);
          increment(
            codex,
            exposure === "user-authored"
              ? "userAuthored"
              : exposure === "assistant-user-facing"
                ? "assistantUserFacing"
                : exposure,
          );
          const payload = record(row.payload);
          if (
            exposure === "assistant-user-facing" &&
            payload?.phase === "commentary"
          )
            codex.assistantCommentary += 1;
          if (
            exposure === "assistant-user-facing" &&
            payload?.phase === "final_answer"
          )
            codex.assistantFinal += 1;
        });
      }

      const claudeFiles = await filesBelow("/root/.claude/projects", ".jsonl");
      const claude = {
        files: claudeFiles.length,
        records: 0,
        malformed: 0,
        userAuthored: 0,
        assistantUserFacing: 0,
        analysis: 0,
        tool: 0,
        subagent: 0,
        sidechainAssistantText: 0,
        system: 0,
        unknown: 0,
      };
      for (const path of claudeFiles) {
        claude.malformed += await jsonLines(path, (row) => {
          claude.records += 1;
          const exposure = claudeExposure(row, path);
          const message = record(row.message);
          if (
            exposure === "subagent" &&
            row.type === "assistant" &&
            message?.role === "assistant" &&
            blocks(message.content).some((item) => item.type === "text")
          ) {
            claude.sidechainAssistantText += 1;
          }
          increment(
            claude,
            exposure === "user-authored"
              ? "userAuthored"
              : exposure === "assistant-user-facing"
                ? "assistantUserFacing"
                : exposure,
          );
        });
      }

      const agyDirectory = "/root/.gemini/antigravity-cli/conversations";
      const agyFiles = await filesBelow(agyDirectory, ".db");
      const agy = {
        databases: 0,
        steps: 0,
        userRoleStep14: 0,
        assistantStep15: 0,
        step17Unclassified: 0,
        step132Unclassified: 0,
        otherUnclassified: 0,
        hasSubtrajectory: 0,
        trajectoryRows: 0,
      };
      for (const path of agyFiles) {
        const database = new Database(path, { readonly: true, strict: true });
        try {
          const rows = database
            .query<
              { step_type: number; has_subtrajectory: number; count: number },
              []
            >(
              "SELECT step_type, has_subtrajectory, COUNT(*) AS count FROM steps GROUP BY step_type, has_subtrajectory",
            )
            .all();
          agy.databases += 1;
          for (const row of rows) {
            agy.steps += row.count;
            if (row.has_subtrajectory) agy.hasSubtrajectory += row.count;
            if (row.step_type === 14) agy.userRoleStep14 += row.count;
            else if (row.step_type === 15) agy.assistantStep15 += row.count;
            else if (row.step_type === 17) agy.step17Unclassified += row.count;
            else if (row.step_type === 132)
              agy.step132Unclassified += row.count;
            else agy.otherUnclassified += row.count;
          }
          agy.trajectoryRows += Number(
            database
              .query<{ count: number }, []>(
                "SELECT COUNT(*) AS count FROM trajectory_meta",
              )
              .get()?.count ?? 0,
          );
        } finally {
          database.close();
        }
      }

      expect(codex.userAuthored).toBeGreaterThan(0);
      expect(codex.assistantUserFacing).toBeGreaterThan(0);
      expect(codex.analysis).toBeGreaterThan(0);
      expect(codex.tool).toBeGreaterThan(0);
      expect(codex.subagent).toBeGreaterThan(0);
      expect(claude.userAuthored).toBeGreaterThan(0);
      expect(claude.assistantUserFacing).toBeGreaterThan(0);
      expect(claude.analysis).toBeGreaterThan(0);
      expect(claude.tool).toBeGreaterThan(0);
      expect(claude.subagent).toBeGreaterThan(0);
      expect(agy.userRoleStep14).toBeGreaterThan(0);
      expect(agy.assistantStep15).toBeGreaterThan(0);
      expect(agy.step17Unclassified + agy.step132Unclassified).toBeGreaterThan(
        0,
      );

      console.info(
        `LEARNING_EXPOSURE_CLI_EVIDENCE ${JSON.stringify({ codex, claude, agy })}`,
      );
    },
    60_000,
  );
});
