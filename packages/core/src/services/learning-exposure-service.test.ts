import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { ExposureObservation } from "../lib/learning/learning-exposure-schemas.js";
import type { DB } from "../types/db.types.js";
import {
  LearningLosslessArchiveService,
  type CapturedArchiveBytes,
} from "./learning-lossless-archive-service.js";
import {
  exposureIsVisible,
  LearningExposureService,
} from "./learning-exposure-service.js";
import { LearningExposureIngestService } from "./learning-exposure-ingest-service.js";

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const observation = (
  fields: Partial<ExposureObservation> &
    Pick<
      ExposureObservation,
      "direction" | "stage" | "authorship" | "visibility"
    >,
): ExposureObservation => ({
  schemaVersion: 1,
  observationId: randomUUID(),
  dedupeKey: null,
  hook: "test.learning-exposure",
  observedAt: "2026-09-05T12:00:00.000Z",
  logicalMessageKey: `message:${randomUUID()}`,
  correlation: {},
  parts: [
    { ordinal: 0, type: "text", text: "same text", captureStatus: "embedded" },
  ],
  gaps: [],
  ...fields,
});

describe("learning exposure visibility", () => {
  test("requires canonical human receipt or proven agent delivery/user-facing intent", () => {
    const human = observation({
      direction: "user_to_model",
      stage: "received",
      authorship: "human",
      visibility: "intended",
    });
    expect(exposureIsVisible(human)).toBe(true);
    expect(exposureIsVisible({ ...human, stage: "model_input" })).toBe(false);
    expect(exposureIsVisible({ ...human, authorship: "agent" })).toBe(false);

    const agent = observation({
      direction: "model_to_user",
      stage: "delivered",
      authorship: "agent",
      visibility: "delivered",
    });
    expect(exposureIsVisible(agent)).toBe(true);
    expect(exposureIsVisible({ ...agent, stage: "model_output" })).toBe(false);
    expect(exposureIsVisible({ ...agent, stage: "failed" })).toBe(false);
    expect(exposureIsVisible({ ...agent, logicalMessageKey: null })).toBe(
      false,
    );
  });
});

const integrationUrl = process.env.LEARNING_EXPOSURE_TEST_DATABASE_URL;
const describePostgres = integrationUrl ? describe : describe.skip;

describePostgres("LearningExposureService PostgreSQL contract", () => {
  let kysely: Kysely<DB>;
  let exposure: LearningExposureService;
  let archive: LearningLosslessArchiveService;
  let rawVersionId: string;

  beforeAll(async () => {
    kysely = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: integrationUrl!, max: 3 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    exposure = new LearningExposureService(kysely);
    archive = new LearningLosslessArchiveService(kysely);
    const bytes = Buffer.from("owned learning exposure raw fixture");
    const encodedBytes = gzipSync(bytes);
    const capture: CapturedArchiveBytes = {
      captureKind: "opaque-complete",
      consistency: "stable-file",
      coverage: "complete",
      source: {
        deviceId: "7401",
        inodeId: "7402",
        mode: 0o600,
        size: bytes.length,
        mtimeNs: "7403",
        ctimeNs: "7404",
      },
      captureStartedAt: "2026-09-05T11:59:58.000Z",
      captureEndedAt: "2026-09-05T11:59:59.000Z",
      offset: 0,
      rawLength: bytes.length,
      rawSha256: digest(bytes),
      chunks: [
        {
          ordinal: 0,
          offset: 0,
          rawLength: bytes.length,
          rawSha256: digest(bytes),
          codec: "gzip",
          codecVersion: "rfc1952",
          encodedLength: encodedBytes.length,
          encodedSha256: digest(encodedBytes),
          encodedBytes,
        },
      ],
      limitations: [],
    };
    const source = await archive.registerSource({
      host: "learning-exposure-test",
      provider: "codex",
      rootPath: "/tmp/learning-exposure-test",
      relativePath: `raw-${randomUUID()}.jsonl`,
      fileKind: "jsonl",
      deviceId: capture.source.deviceId,
      inodeId: capture.source.inodeId,
      sourceSize: bytes.length,
      sourceMtimeNs: capture.source.mtimeNs,
      sourceCtimeNs: capture.source.ctimeNs,
      observedAt: "2026-09-05T11:59:58.000Z",
      metadata: { ownedTestFixture: true },
    });
    const claim = await archive.claimSource({
      sourceId: source.sourceId,
      generation: source.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Exposure test could not claim raw fixture");
    const committed = await archive.commitCapture({
      claim,
      expectedCursor: 0,
      checkpointCursorAfter: bytes.length,
      capture,
    });
    rawVersionId = committed.versionId;
  });

  beforeEach(async () => {
    await sql`TRUNCATE learning_exposure_observations, learning_exposure_imports, learning_exposure_projection_cursors`.execute(
      kysely,
    );
  });

  const registerProjectionSource = async (
    provider: "codex" | "antigravity",
    fileKind: "jsonl" | "sqlite",
    byteLength: number,
  ) => {
    const identity = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    ).toString();
    return archive.registerSource({
      host: "learning-exposure-test",
      provider,
      rootPath: "/tmp/learning-exposure-projection-test",
      relativePath: `${randomUUID()}.${fileKind === "sqlite" ? "db" : "jsonl"}`,
      fileKind,
      deviceId: identity,
      inodeId: `${identity}1`,
      sourceSize: byteLength,
      sourceMtimeNs: `${identity}2`,
      sourceCtimeNs: `${identity}3`,
      observedAt: "2026-09-05T11:59:58.000Z",
      metadata: {
        rootId:
          provider === "antigravity"
            ? "antigravity-conversations"
            : "codex-sessions",
        ownedTestFixture: true,
      },
    });
  };

  const stagedSqliteVersion = async (
    source: Awaited<ReturnType<typeof registerProjectionSource>>,
    bytes: Buffer,
    expectedCursor: number,
  ) => {
    const claim = await archive.claimSource({
      sourceId: source.sourceId,
      generation: source.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Could not claim SQLite projection fixture");
    const encodedBytes = gzipSync(bytes);
    const staged = await archive.beginStagedCapture({
      claim,
      expectedCursor,
      captureKind: "consistent-sqlite-snapshot",
      consistencyStatus: "logical-sqlite-snapshot",
      coverageStatus: "complete",
      source: {
        deviceId: source.deviceId!,
        inodeId: source.inodeId!,
        mode: 0o600,
        size: bytes.length,
        mtimeNs: "9001",
        ctimeNs: "9002",
      },
      captureStartedAt: new Date().toISOString(),
      limitations: ["logical test snapshot"],
      stagingKey: randomUUID(),
      expectedRawLength: bytes.length,
      expectedAggregateSha256: digest(bytes),
    });
    await archive.appendStagedChunk({
      claim,
      versionId: staged.versionId,
      expectedOffset: 0,
      chunk: {
        ordinal: 0,
        offset: 0,
        rawLength: bytes.length,
        rawSha256: digest(bytes),
        codec: "gzip",
        codecVersion: "rfc1952",
        encodedLength: encodedBytes.length,
        encodedSha256: digest(encodedBytes),
        encodedBytes,
      },
    });
    await archive.sealStagedCapture({
      claim,
      versionId: staged.versionId,
      checkpointCursorAfter: Math.max(expectedCursor, bytes.length),
      captureEndedAt: new Date().toISOString(),
    });
    return staged.versionId;
  };

  afterAll(async () => {
    await kysely?.destroy();
  });

  test("collapses gateway receipt and model-input echo into one canonical user with count two", async () => {
    const key = "gateway:discord:message:user-1";
    const runId = "run-explicit-1";
    const received = observation({
      logicalMessageKey: key,
      direction: "user_to_model",
      stage: "received",
      authorship: "human",
      visibility: "intended",
      correlation: {
        runId,
        guildId: "guild-1",
        channelId: "channel-1",
        chatId: "chat-1",
        sessionId: "session-1",
      },
    });
    const echo = observation({
      logicalMessageKey: key,
      direction: "user_to_model",
      stage: "model_input",
      authorship: "agent",
      visibility: "internal",
      observedAt: "2026-09-05T12:00:01.000Z",
      correlation: { runId, transport: "model-context-echo" },
    });
    await exposure.ingestObservation(received, rawVersionId);
    await exposure.ingestObservation(echo, rawVersionId);

    const page = await exposure.query({});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.logicalMessageKey).toBe(key);
    expect(page.items[0]?.observation.authorship).toBe("human");
    expect(page.items[0]?.observationCount).toBe(2);

    const exchanges = await exposure.queryExchanges({});
    expect(exchanges.items).toHaveLength(1);
    expect(exchanges.items[0]).toMatchObject({
      exchangeId: `openclaw-run:${runId}`,
      linkage: "explicit",
      user: {
        text: "same text",
        meta: {
          guildId: "guild-1",
          channelId: "channel-1",
          chatId: "chat-1",
          sessionId: "session-1",
          observationCount: 2,
          rawVersionId,
          readByUser: "unknown",
        },
      },
      agent: [],
    });
  });

  test("retains equal text under different native message keys as two users", async () => {
    for (const logicalMessageKey of ["native:user:1", "native:user:2"]) {
      await exposure.ingestObservation(
        observation({
          logicalMessageKey,
          direction: "user_to_model",
          stage: "received",
          authorship: "human",
          visibility: "intended",
        }),
        rawVersionId,
      );
    }
    const page = await exposure.query({ direction: "user_to_model" });
    expect(page.items).toHaveLength(2);
    expect(new Set(page.items.map((item) => item.logicalMessageKey))).toEqual(
      new Set(["native:user:1", "native:user:2"]),
    );
    const exchanges = await exposure.queryExchanges({
      direction: "user_to_model",
    });
    expect(exchanges.items).toHaveLength(2);
    expect(exchanges.items.every((item) => item.linkage === "unpaired")).toBe(
      true,
    );
  });

  test("indexes a message copied into a forked thread once, keeping the original turn whole", async () => {
    // A resumed/forked Claude session copies the parent's rows under a new thread
    // with the SAME native ids and timestamps; a Codex child thread copies them
    // with later timestamps. The copy is not new evidence. The original thread
    // sorts last by name so a name tiebreak alone would pick the fork.
    const user = { direction: "user_to_model", stage: "received", authorship: "human", visibility: "intended" } as const;
    const agent = { direction: "model_to_user", stage: "delivered", authorship: "agent", visibility: "delivered" } as const;
    const rows = [
      ["claude:z-original:user:native-1", "2026-09-05T12:00:00.000Z", user],
      ["claude:z-original:assistant:native-r1", "2026-09-05T12:00:30.000Z", agent],
      ["claude:a-fork:user:native-1", "2026-09-05T12:00:00.000Z", user],
      ["claude:a-fork:assistant:native-r1", "2026-09-05T12:00:30.000Z", agent],
      ["claude:a-fork:user:native-2", "2026-09-05T13:00:00.000Z", user],
      ["codex:child-b:turn-1:user:msg_1", "2026-09-05T12:00:05.000Z", user],
      ["codex:child-a:turn-1:user:msg_1", "2026-09-05T12:00:00.000Z", user],
      ["discord:account-a:channel:1", "2026-09-05T12:00:00.000Z", user],
      ["discord:account-b:channel:1", "2026-09-05T12:00:00.000Z", user],
    ] as const;
    const ids = new Map<string, string>();
    for (const [logicalMessageKey, observedAt, shape] of rows) {
      const item = observation({ logicalMessageKey, observedAt, ...shape });
      ids.set(logicalMessageKey, item.observationId);
      await exposure.ingestObservation(item, rawVersionId);
    }
    const manifest = new Set((await exposure.canonicalIndexManifest()).map((row) => row.id));
    expect(manifest).toEqual(new Set([
      "claude:z-original:user:native-1",
      "claude:z-original:assistant:native-r1",
      "claude:a-fork:user:native-2",
      "codex:child-a:turn-1:user:msg_1",
      "discord:account-a:channel:1",
      "discord:account-b:channel:1",
    ].map((key) => ids.get(key)!)));
  });

  test("does not guess pairing when one run contains multiple real user inputs", async () => {
    const runId = "run-with-two-inputs";
    for (const logicalMessageKey of [
      "native:multi:user:1",
      "native:multi:user:2",
    ]) {
      await exposure.ingestObservation(
        observation({
          logicalMessageKey,
          direction: "user_to_model",
          stage: "received",
          authorship: "human",
          visibility: "intended",
          correlation: { runId },
        }),
        rawVersionId,
      );
    }
    await exposure.ingestObservation(
      observation({
        logicalMessageKey: "native:multi:agent:1",
        direction: "model_to_user",
        stage: "delivered",
        authorship: "agent",
        visibility: "delivered",
        correlation: { runId },
      }),
      rawVersionId,
    );
    const exchanges = await exposure.queryExchanges({});
    expect(exchanges.items).toHaveLength(3);
    expect(exchanges.items.every((item) => item.linkage === "unpaired")).toBe(
      true,
    );
    expect(exchanges.items.filter((item) => item.user !== null)).toHaveLength(
      2,
    );
    expect(
      exchanges.items.filter((item) => item.agent.length > 0),
    ).toHaveLength(1);
    expect(
      exchanges.items.some(
        (item) => item.user !== null && item.agent.length > 0,
      ),
    ).toBe(false);
    await expect(
      exposure.explicitUserIdentityIsUnique({ runId }),
    ).resolves.toBe(false);
  });

  test("does not pair a run when another real user input exists beyond the requested page", async () => {
    const runId = "run-with-input-outside-page";
    const fixtures = [
      observation({
        observationId: "00000000-0000-4000-8000-000000000001",
        logicalMessageKey: "native:paged:user:1",
        direction: "user_to_model",
        stage: "received",
        authorship: "human",
        visibility: "intended",
        correlation: { runId },
      }),
      observation({
        observationId: "00000000-0000-4000-8000-000000000002",
        logicalMessageKey: "native:paged:agent:1",
        direction: "model_to_user",
        stage: "delivered",
        authorship: "agent",
        visibility: "delivered",
        correlation: { runId },
      }),
      observation({
        observationId: "ffffffff-ffff-4fff-bfff-ffffffffffff",
        logicalMessageKey: "native:paged:user:2",
        direction: "user_to_model",
        stage: "received",
        authorship: "human",
        visibility: "intended",
        correlation: { runId },
      }),
    ];
    for (const fixture of fixtures)
      await exposure.ingestObservation(fixture, rawVersionId);

    const exchanges = await exposure.queryExchanges({ limit: 2 });
    expect(exchanges.nextCursor).not.toBeNull();
    expect(exchanges.items).toHaveLength(2);
    expect(exchanges.items.every((item) => item.linkage === "unpaired")).toBe(
      true,
    );
    expect(
      exchanges.items.some(
        (item) => item.user !== null && item.agent.length > 0,
      ),
    ).toBe(false);
  });

  test("exact parent lookup pairs a distinct reply key and keeps recovered media over an earlier failure", async () => {
    const parentKey = "discord:account:channel:parent-message";
    const replyKey = "openclaw:assistant:distinct-reply";
    await exposure.ingestObservation(
      observation({
        logicalMessageKey: parentKey,
        direction: "user_to_model",
        stage: "received",
        authorship: "human",
        visibility: "intended",
        correlation: { transcriptEventId: "parent-native" },
      }),
      rawVersionId,
    );
    await exposure.ingestObservation(
      observation({
        logicalMessageKey: replyKey,
        direction: "model_to_user",
        stage: "failed",
        authorship: "agent",
        visibility: "unknown",
        observedAt: "2026-09-05T12:00:01.000Z",
        correlation: { parentLogicalMessageKey: parentKey },
        parts: [
          {
            ordinal: 1,
            type: "media",
            role: "original",
            sha256: "b".repeat(64),
            byteLength: 86_037,
            mediaKind: "image",
            captureStatus: "refused",
            gapCode: "media-archive-verification-failed",
          },
        ],
      }),
      rawVersionId,
    );
    await exposure.ingestObservation(
      observation({
        logicalMessageKey: replyKey,
        direction: "model_to_user",
        stage: "delivered",
        authorship: "agent",
        visibility: "delivered",
        observedAt: "2026-09-05T12:00:02.000Z",
        correlation: {
          parentLogicalMessageKey: parentKey,
          parentTranscriptEventId: "parent-native",
        },
        parts: [
          {
            ordinal: 1,
            type: "media",
            role: "original",
            sha256: "b".repeat(64),
            byteLength: 86_037,
            mediaKind: "image",
            archiveVersionId: rawVersionId,
            captureStatus: "captured",
          },
        ],
      }),
      rawVersionId,
    );

    const exchanges = await exposure.queryExchanges({
      logicalMessageKey: parentKey,
    });
    expect(exchanges.items).toHaveLength(1);
    expect(exchanges.items[0]).toMatchObject({
      exchangeId: `parent-message:${parentKey}`,
      linkage: "explicit",
      user: { meta: { logicalMessageKey: parentKey } },
      agent: [
        {
          meta: {
            logicalMessageKey: replyKey,
            parentLogicalMessageKey: parentKey,
          },
          media: [
            {
              ordinal: 1,
              role: "original",
              captureStatus: "captured",
              archiveVersionId: rawVersionId,
            },
          ],
        },
      ],
    });
    expect(exchanges.items[0]!.agent[0]!.media).toHaveLength(1);
  });

  test("corrected historical eligibility supersedes a formerly visible trace without deleting provenance", async () => {
    const key = `history-correction:${randomUUID()}`;
    await exposure.ingestObservation(observation({ logicalMessageKey: key,
      direction: "model_to_user", stage: "user_facing", authorship: "agent", visibility: "intended",
    }), rawVersionId);
    await exposure.ingestObservation(observation({ logicalMessageKey: key,
      direction: "model_to_user", stage: "model_output", authorship: "agent", visibility: "internal",
      correlation: { historyProjectionRevision: 3 },
    }), rawVersionId);
    expect((await exposure.query({ logicalMessageKey: key })).items).toHaveLength(0);
    const audit = await exposure.query({ logicalMessageKey: key, includeUnknown: true });
    expect(audit.items).toHaveLength(1);
    expect(audit.items[0]!.observationCount).toBe(2);
    expect(audit.items[0]!.observation.visibility).toBe("internal");
  });

  test("prefers an additive CLI projection revision over an older derived row", async () => {
    const key = `cli-correction:${randomUUID()}`;
    await exposure.ingestObservation(observation({ logicalMessageKey: key,
      direction: "model_to_user", stage: "user_facing", authorship: "agent", visibility: "intended",
      correlation: { codexTurnId: "old-turn" },
    }), rawVersionId);
    await exposure.ingestObservation(observation({ logicalMessageKey: key,
      direction: "model_to_user", stage: "user_facing", authorship: "agent", visibility: "intended",
      observedAt: "2026-09-05T11:00:00.000Z",
      correlation: { codexTurnId: "exact-native-turn", cliProjectionRevision: 2 },
    }), rawVersionId);
    const page = await exposure.query({ logicalMessageKey: key });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.observationCount).toBe(2);
    expect(page.items[0]!.observation.correlation).toMatchObject({
      codexTurnId: "exact-native-turn",
      cliProjectionRevision: 2,
    });
  });

  test("excludes internal traces and selects delivered agent evidence over output and failure", async () => {
    await exposure.ingestObservation(
      observation({
        logicalMessageKey: null,
        direction: "internal",
        stage: "model_output",
        authorship: "agent",
        visibility: "internal",
        correlation: { traceType: "reasoning" },
      }),
      rawVersionId,
    );
    const key = "native:assistant:1";
    for (const [stage, visibility, observedAt] of [
      ["model_output", "internal", "2026-09-05T12:00:01.000Z"],
      ["failed", "unknown", "2026-09-05T12:00:03.000Z"],
      ["delivered", "delivered", "2026-09-05T12:00:02.000Z"],
    ] as const) {
      await exposure.ingestObservation(
        observation({
          logicalMessageKey: key,
          direction: "model_to_user",
          stage,
          authorship: "agent",
          visibility,
          observedAt,
          correlation: { runId: "run-agent-1", agentId: "agent-1" },
        }),
        rawVersionId,
      );
    }
    const page = await exposure.query({});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.observation.stage).toBe("delivered");
    expect(page.items[0]?.observation.visibility).toBe("delivered");
    expect(page.items[0]?.observationCount).toBe(3);
    expect((await exposure.queryExchanges({})).items[0]?.user).toBeNull();
    expect((await exposure.queryExchanges({})).items[0]?.agent).toHaveLength(1);
    const auditExchanges = await exposure.queryExchanges({
      includeUnknown: true,
    });
    expect(auditExchanges.items).toHaveLength(1);
    expect(auditExchanges.items[0]?.user).toBeNull();
    expect(auditExchanges.items[0]?.agent).toHaveLength(1);
  });

  test("preserves complete channel, agent, session and verified media metadata", async () => {
    const mediaVersionId = rawVersionId;
    const value = observation({
      logicalMessageKey: "gateway:discord:agent-2",
      direction: "model_to_user",
      stage: "delivered",
      authorship: "agent",
      visibility: "delivered",
      correlation: {
        runId: "run-meta-1",
        guildId: "guild-meta",
        channelId: "channel-meta",
        chatId: "chat-meta",
        agentId: "agent-meta",
        sessionId: "session-meta",
      },
      parts: [
        {
          ordinal: 0,
          type: "text",
          text: "agent text",
          captureStatus: "embedded",
        },
        {
          ordinal: 1,
          type: "media",
          sha256: "a".repeat(64),
          byteLength: 12,
          mimeType: "image/png",
          mediaKind: "image",
          spoolRelativePath: "media/owned.png",
          archiveVersionId: mediaVersionId,
          captureStatus: "captured",
        },
      ],
    });
    await exposure.ingestObservation(value, rawVersionId);
    const exchanges = await exposure.queryExchanges({});
    expect(exchanges.items).toHaveLength(1);
    expect(exchanges.items[0]?.agent[0]).toMatchObject({
      text: "agent text",
      media: [
        {
          mediaKind: "image",
          sha256: "a".repeat(64),
          byteLength: 12,
          archiveVersionId: mediaVersionId,
          captureStatus: "captured",
        },
      ],
      meta: {
        guildId: "guild-meta",
        channelId: "channel-meta",
        chatId: "chat-meta",
        agentId: "agent-meta",
        sessionId: "session-meta",
        rawVersionId,
      },
    });
  });

  test("archives an owned spool event and media exactly before exposing metadata", async () => {
    const spoolRoot = await mkdtemp(join(tmpdir(), "learning-exposure-spool-"));
    const eventsDirectory = join(spoolRoot, "events");
    const mediaDirectory = join(spoolRoot, "media");
    await Promise.all([
      mkdir(eventsDirectory, { recursive: true }),
      mkdir(mediaDirectory, { recursive: true }),
    ]);
    const mediaPath = join(mediaDirectory, "owned.bin");
    const mediaBytes = Buffer.concat([
      Buffer.from("owned-media\r\n"),
      Buffer.from([0, 0xff, 0x80, 7]),
    ]);
    await writeFile(mediaPath, mediaBytes, { mode: 0o600 });
    const value = observation({
      logicalMessageKey: "gateway:discord:media-agent",
      direction: "model_to_user",
      stage: "delivered",
      authorship: "agent",
      visibility: "delivered",
      correlation: {
        runId: "run-media-1",
        guildId: "guild-media",
        channelId: "channel-media",
        chatId: "chat-media",
        agentId: "agent-media",
        sessionId: "session-media",
      },
      parts: [
        {
          ordinal: 0,
          type: "text",
          text: "media response",
          captureStatus: "embedded",
        },
        {
          ordinal: 1,
          type: "media",
          sha256: digest(mediaBytes),
          byteLength: mediaBytes.length,
          mimeType: "application/octet-stream",
          mediaKind: "binary",
          spoolRelativePath: "media/owned.bin",
          captureStatus: "missing",
        },
      ],
    });
    const eventPath = join(eventsDirectory, "owned-event.json");
    await writeFile(eventPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const eventBefore = digest(await readFile(eventPath));
    const mediaBefore = digest(await readFile(mediaPath));
    const archive = new LearningLosslessArchiveService(kysely);
    const ingest = new LearningExposureIngestService(
      kysely,
      archive,
      exposure,
      { enabled: true, spoolRoot },
    );
    try {
      await expect(ingest.ingestSpool()).resolves.toEqual({
        processed: 1,
        pending: 0,
        gaps: 0,
      });
      const page = await exposure.query({ mediaKind: "binary" });
      expect(page.items).toHaveLength(1);
      const item = page.items[0]!;
      const media = item.media[0]!;
      expect(media).toMatchObject({
        sha256: digest(mediaBytes),
        byteLength: mediaBytes.length,
        mediaKind: "binary",
        spoolRelativePath: "media/owned.bin",
        captureStatus: "captured",
      });
      expect(media.archiveVersionId).toBeDefined();
      expect(media.archiveVersionId).not.toBe(item.rawVersionId);
      await expect(
        archive.verifyVersion(media.archiveVersionId!),
      ).resolves.toMatchObject({
        sha256: digest(mediaBytes),
        rawLength: mediaBytes.length,
      });
      expect(digest(await readFile(eventPath))).toBe(eventBefore);
      expect(digest(await readFile(mediaPath))).toBe(mediaBefore);
      await expect(ingest.ingestSpool()).resolves.toEqual({
        processed: 0,
        pending: 0,
        gaps: 0,
      });
    } finally {
      await rm(spoolRoot, { recursive: true, force: true });
    }
  });

  test("reprojects SQLite idx zero from a new immutable snapshot and retains malformed JSONL gap receipts", async () => {
    const malformed = Buffer.from("{not-json}\n", "utf8");
    const jsonSource = await registerProjectionSource(
      "codex",
      "jsonl",
      malformed.length,
    );
    const jsonClaim = await archive.claimSource({
      sourceId: jsonSource.sourceId,
      generation: jsonSource.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (!jsonClaim) throw new Error("Could not claim JSONL projection fixture");
    const malformedEncoded = gzipSync(malformed);
    const malformedVersion = await archive.commitCapture({
      claim: jsonClaim,
      expectedCursor: 0,
      checkpointCursorAfter: malformed.length,
      capture: {
        captureKind: "opaque-complete",
        consistency: "stable-file",
        coverage: "complete",
        source: {
          deviceId: jsonSource.deviceId!,
          inodeId: jsonSource.inodeId!,
          mode: 0o600,
          size: malformed.length,
          mtimeNs: "9101",
          ctimeNs: "9102",
        },
        captureStartedAt: new Date().toISOString(),
        captureEndedAt: new Date().toISOString(),
        offset: 0,
        rawLength: malformed.length,
        rawSha256: digest(malformed),
        chunks: [
          {
            ordinal: 0,
            offset: 0,
            rawLength: malformed.length,
            rawSha256: digest(malformed),
            codec: "gzip",
            codecVersion: "rfc1952",
            encodedLength: malformedEncoded.length,
            encodedSha256: digest(malformedEncoded),
            encodedBytes: malformedEncoded,
          },
        ],
        limitations: [],
      },
    });

    const makeSqlite = async (payloadByte: number): Promise<Buffer> => {
      const directory = await mkdtemp(
        join(tmpdir(), "exposure-sqlite-version-"),
      );
      const path = join(directory, "fixture.db");
      try {
        const database = new Database(path, { create: true, strict: true });
        try {
          database.exec(
            "CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB, metadata BLOB, has_subtrajectory INTEGER)",
          );
          database
            .query("INSERT INTO steps VALUES (0,15,?,?,0)")
            .run(Buffer.from([payloadByte]), Buffer.alloc(0));
        } finally {
          database.close();
        }
        return await readFile(path);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    };
    const firstBytes = await makeSqlite(1);
    const sqliteSource = await registerProjectionSource(
      "antigravity",
      "sqlite",
      firstBytes.length,
    );
    const firstVersion = await stagedSqliteVersion(sqliteSource, firstBytes, 0);
    const emptySpool = await mkdtemp(join(tmpdir(), "exposure-empty-spool-"));
    await mkdir(join(emptySpool, "events"));
    const ingest = new LearningExposureIngestService(
      kysely,
      archive,
      exposure,
      {
        enabled: true,
        spoolRoot: emptySpool,
      },
    );
    try {
      const firstPass = await ingest.ingestSpool();
      expect(firstPass.gaps).toBe(1);
      const gapReceipt = await sql<{ status: string; gapCode: string }>`
        SELECT status,gap_code AS "gapCode" FROM learning_exposure_imports
        WHERE import_key=${`cli-record:${malformedVersion.versionId}:0`}`.execute(
        kysely,
      );
      expect(gapReceipt.rows[0]).toEqual({
        status: "gap",
        gapCode: "invalid-jsonl-record",
      });
      expect(await exposure.status()).toMatchObject({
        importGaps: [{ code: "invalid-jsonl-record", count: 1 }],
      });
      expect(
        (
          await sql<{
            count: string;
          }>`SELECT count(*) AS count FROM learning_exposure_observations WHERE raw_version_id=${firstVersion}::uuid`.execute(
            kysely,
          )
        ).rows[0]?.count,
      ).toBe("1");

      const checkpoint = await archive.getCheckpoint(sqliteSource.sourceId);
      const secondBytes = await makeSqlite(2);
      const secondVersion = await stagedSqliteVersion(
        sqliteSource,
        secondBytes,
        checkpoint!.cursorOffset,
      );
      expect(secondVersion).not.toBe(firstVersion);
      await ingest.ingestSpool();
      const projected = await sql<{
        rawVersionId: string;
      }>`SELECT raw_version_id AS "rawVersionId"
        FROM learning_exposure_observations WHERE raw_version_id IN (${firstVersion}::uuid,${secondVersion}::uuid)
        ORDER BY raw_version_id`.execute(kysely);
      expect(new Set(projected.rows.map((row) => row.rawVersionId))).toEqual(
        new Set([firstVersion, secondVersion]),
      );
      const cursor = await sql<{
        cursorOffset: string;
        sqliteVersionId: string;
      }>`SELECT cursor_offset AS "cursorOffset",
        parser_state->>'sqliteVersionId' AS "sqliteVersionId" FROM learning_exposure_projection_cursors
        WHERE source_id=${sqliteSource.sourceId}::uuid AND generation=${sqliteSource.generation}`.execute(
        kysely,
      );
      expect(cursor.rows[0]).toEqual({
        cursorOffset: "1",
        sqliteVersionId: secondVersion,
      });
    } finally {
      await rm(emptySpool, { recursive: true, force: true });
    }
  });

  test("is idempotent for identical observations and rejects reused identity with changed payload", async () => {
    const value = observation({
      observationId: "44444444-4444-4444-8444-444444444444",
      dedupeKey: "stable-transport-id",
      direction: "user_to_model",
      stage: "received",
      authorship: "human",
      visibility: "intended",
    });
    await expect(
      exposure.ingestObservation(value, rawVersionId),
    ).resolves.toMatchObject({ inserted: true });
    await expect(
      exposure.ingestObservation(value, rawVersionId),
    ).resolves.toMatchObject({ inserted: false });
    await expect(
      exposure.ingestObservation(
        {
          ...value,
          parts: [
            {
              ordinal: 0,
              type: "text",
              text: "changed payload",
              captureStatus: "embedded",
            },
          ],
        },
        rawVersionId,
      ),
    ).rejects.toThrow(
      "Exposure observation identity was reused with different content",
    );
  });
});
