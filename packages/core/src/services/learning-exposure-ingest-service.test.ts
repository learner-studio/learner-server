import { Database } from "bun:sqlite";
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import type { DB } from "../types/db.types.js";
import {
  LearningLosslessArchiveService,
  type ArchiveClaim,
  type CapturedArchiveBytes,
} from "./learning-lossless-archive-service.js";
import { LearningExposureService } from "./learning-exposure-service.js";
import { LearningExposureIngestService } from "./learning-exposure-ingest-service.js";

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Records the owner every source lease is taken under, then delegates. */
class OwnerRecordingArchiveService extends LearningLosslessArchiveService {
  readonly leaseOwners: string[] = [];
  override async claimSource(input: {
    sourceId: string;
    generation: number;
    ownerId: string;
    leaseMs: number;
  }): Promise<ArchiveClaim | null> {
    this.leaseOwners.push(input.ownerId);
    return super.claimSource(input);
  }
}

const integrationUrl = process.env.LEARNING_EXPOSURE_TEST_DATABASE_URL;
const describePostgres = integrationUrl ? describe : describe.skip;

describePostgres("LearningExposureIngestService projection bookkeeping", () => {
  let kysely: Kysely<DB>;
  let archive: LearningLosslessArchiveService;
  let exposure: LearningExposureService;

  beforeAll(() => {
    kysely = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: integrationUrl!, max: 3 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    archive = new LearningLosslessArchiveService(kysely);
    exposure = new LearningExposureService(kysely);
  });

  beforeEach(async () => {
    await sql`TRUNCATE learning_exposure_observations, learning_exposure_imports,
      learning_exposure_projection_cursors, learning_exposure_work`.execute(
      kysely,
    );
    await sql`TRUNCATE learning_archive_version_chunks, learning_archive_versions,
      learning_archive_checkpoints, learning_archive_blobs, learning_archive_sources CASCADE`.execute(
      kysely,
    );
  });

  const registerSource = async (
    provider: "codex" | "antigravity",
    fileKind: "jsonl" | "sqlite",
    byteLength: number,
  ) => {
    const identity = BigInt(
      `0x${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    ).toString();
    return archive.registerSource({
      host: "learning-exposure-ingest-test",
      provider,
      rootPath: "/tmp/learning-exposure-ingest-test",
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

  const commitVersion = async (
    source: Awaited<ReturnType<typeof registerSource>>,
    bytes: Buffer,
  ): Promise<string> => {
    const claim = await archive.claimSource({
      sourceId: source.sourceId,
      generation: source.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Could not claim the projection fixture");
    const encodedBytes = gzipSync(bytes);
    const capture: CapturedArchiveBytes = {
      captureKind: "opaque-complete",
      consistency: "stable-file",
      coverage: "complete",
      source: {
        deviceId: source.deviceId!,
        inodeId: source.inodeId!,
        mode: 0o600,
        size: bytes.length,
        mtimeNs: "9001",
        ctimeNs: "9002",
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
    const committed = await archive.commitCapture({
      claim,
      expectedCursor: 0,
      checkpointCursorAfter: bytes.length,
      capture,
    });
    await archive.releaseClaim(claim);
    return committed.versionId;
  };

  /** A sealed version is immutable, so an oversized one must be committed as
   * real bytes rather than widened afterwards. */
  const commitOversizeVersion = async (
    source: Awaited<ReturnType<typeof registerSource>>,
    totalBytes: number,
  ): Promise<{ versionId: string; byteLength: number }> => {
    const chunkLength = 4 * 1024 * 1024;
    const count = Math.ceil(totalBytes / chunkLength);
    const aggregate = createHash("sha256");
    // Blobs deduplicate by digest, so every chunk carries distinct bytes.
    const chunks = Array.from({ length: count }, (_, ordinal) => {
      const chunkRaw = Buffer.alloc(chunkLength, 0x61);
      chunkRaw.writeUInt32BE(ordinal, 0);
      const chunkEncoded = gzipSync(chunkRaw);
      aggregate.update(chunkRaw);
      return {
        ordinal,
        offset: ordinal * chunkLength,
        rawLength: chunkLength,
        rawSha256: digest(chunkRaw),
        codec: "gzip" as const,
        codecVersion: "rfc1952" as const,
        encodedLength: chunkEncoded.length,
        encodedSha256: digest(chunkEncoded),
        encodedBytes: chunkEncoded,
      };
    });
    const rawLength = count * chunkLength;
    const claim = await archive.claimSource({
      sourceId: source.sourceId,
      generation: source.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (!claim) throw new Error("Could not claim the oversize fixture");
    const committed = await archive.commitCapture({
      claim,
      expectedCursor: 0,
      checkpointCursorAfter: rawLength,
      capture: {
        captureKind: "opaque-complete",
        consistency: "stable-file",
        coverage: "complete",
        source: {
          deviceId: source.deviceId!,
          inodeId: source.inodeId!,
          mode: 0o600,
          size: rawLength,
          mtimeNs: "9101",
          ctimeNs: "9102",
        },
        captureStartedAt: "2026-09-05T11:59:58.000Z",
        captureEndedAt: "2026-09-05T11:59:59.000Z",
        offset: 0,
        rawLength,
        rawSha256: aggregate.digest("hex"),
        chunks,
        limitations: [],
      },
    });
    await archive.releaseClaim(claim);
    return { versionId: committed.versionId, byteLength: rawLength };
  };

  const emptySpool = async (): Promise<string> => {
    const spoolRoot = await mkdtemp(join(tmpdir(), "exposure-ingest-spool-"));
    await mkdir(join(spoolRoot, "events"));
    return spoolRoot;
  };

  const cursorRow = async (sourceId: string) =>
    (
      await sql<{
        cursorOffset: string;
        parserState: { cliProjectionRevision?: number };
      }>`SELECT cursor_offset AS "cursorOffset",parser_state AS "parserState"
        FROM learning_exposure_projection_cursors WHERE source_id=${sourceId}::uuid`.execute(
        kysely,
      )
    ).rows[0];

  test("records the revision-2 rewind of a pre-revision JSONL cursor", async () => {
    // More lines than one projection window drains, so the rewound cursor lands
    // BELOW the legacy cursor and only a revision bump can persist it.
    const lines = Array.from(
      { length: 1500 },
      (_, index) =>
        `${JSON.stringify({ type: "event_msg", payload: { index } })}\n`,
    ).join("");
    const bytes = Buffer.from(lines, "utf8");
    const source = await registerSource("codex", "jsonl", bytes.length);
    await commitVersion(source, bytes);
    await sql`INSERT INTO learning_exposure_projection_cursors
      (source_id,generation,cursor_offset,source_order,parser_state)
      VALUES(${source.sourceId}::uuid,${source.generation},${bytes.length},1500,
        ${JSON.stringify({ sessionId: "legacy-session" })}::jsonb)`.execute(
      kysely,
    );
    const spoolRoot = await emptySpool();
    const ingest = new LearningExposureIngestService(
      kysely,
      archive,
      exposure,
      { enabled: true, spoolRoot },
    );
    try {
      await ingest.ingestSpool(true);
      const rewound = await cursorRow(source.sourceId);
      expect(rewound?.parserState.cliProjectionRevision).toBe(2);
      expect(Number(rewound?.cursorOffset)).toBeGreaterThan(0);
      expect(Number(rewound?.cursorOffset)).toBeLessThan(bytes.length);

      // The recorded revision persists, so the next sweep resumes instead of
      // rewinding to byte 0 again.
      await ingest.ingestSpool(true);
      const resumed = await cursorRow(source.sourceId);
      expect(resumed?.parserState.cliProjectionRevision).toBe(2);
      expect(Number(resumed?.cursorOffset)).toBeGreaterThan(
        Number(rewound?.cursorOffset),
      );
    } finally {
      await rm(spoolRoot, { recursive: true, force: true });
    }
  });

  test("refuses an oversized SQLite version once under the selector's import key", async () => {
    const oversize = 68 * 1024 * 1024;
    const source = await registerSource("antigravity", "sqlite", oversize);
    const { versionId } = await commitOversizeVersion(source, oversize);
    const spoolRoot = await emptySpool();
    const ingest = new LearningExposureIngestService(
      kysely,
      archive,
      exposure,
      { enabled: true, spoolRoot },
    );
    try {
      const first = await ingest.ingestSpool(true);
      expect(first.gaps).toBe(1);
      const receipts = await sql<{ key: string; gapCode: string }>`
        SELECT import_key AS key,gap_code AS "gapCode" FROM learning_exposure_imports
        WHERE raw_version_id=${versionId}::uuid`.execute(kysely);
      expect(receipts.rows).toEqual([
        {
          key: `cli-v2:${versionId}`,
          gapCode: "projection-version-over-64MiB-limit",
        },
      ]);

      // The refusal is terminal: the selector must not re-claim and re-gap it.
      const second = await ingest.ingestSpool(true);
      expect(second).toEqual({ processed: 0, pending: 0, gaps: 0 });
      await expect(ingest.parity()).resolves.toMatchObject({
        projectionEligibleVersions: 1,
        projectionPendingVersions: 0,
        projectionGapVersions: 1,
      });
    } finally {
      await rm(spoolRoot, { recursive: true, force: true });
    }
  });

  /** A WAL-mode SQLite file whose schema has not been checkpointed yet: a valid
   * header page and an empty sqlite_master, exactly what Antigravity leaves on
   * disk between creating a conversation database and its first checkpoint. */
  const sqliteSnapshot = async (
    build: (database: Database) => void,
  ): Promise<Buffer> => {
    const directory = await mkdtemp(join(tmpdir(), "exposure-ingest-sqlite-"));
    try {
      const database = new Database(join(directory, "snapshot.db"));
      try {
        database.exec("PRAGMA journal_mode=WAL");
        build(database);
        database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        database.close();
      }
      return Buffer.from(
        await Bun.file(join(directory, "snapshot.db")).arrayBuffer(),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  test("records a SQLite snapshot without a steps table as a gap instead of failing the drain", async () => {
    const unstarted = await sqliteSnapshot(() => {});
    expect(unstarted.length).toBe(4096);
    const started = await sqliteSnapshot((database) => {
      database.exec(
        "CREATE TABLE steps(idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, step_payload blob)",
      );
      database
        .query("INSERT INTO steps(idx, step_type, has_subtrajectory) VALUES (?, ?, 0)")
        .run(0, 132);
    });
    // The unstarted source has no projection cursor, so the selector orders it
    // FIRST; the healthy source behind it must still be projected in this pass.
    const unstartedSource = await registerSource("antigravity", "sqlite", unstarted.length);
    const unstartedVersion = await commitVersion(unstartedSource, unstarted);
    const startedSource = await registerSource("antigravity", "sqlite", started.length);
    const startedVersion = await commitVersion(startedSource, started);
    const spoolRoot = await emptySpool();
    const ingest = new LearningExposureIngestService(
      kysely,
      archive,
      exposure,
      { enabled: true, spoolRoot },
    );
    try {
      const first = await ingest.ingestSpool(true);
      // pending=1 means "a selection happened, drain again"; the second pass proves it empties.
      expect(first).toEqual({ processed: 1, pending: 1, gaps: 1 });
      const receipts = await sql<{ key: string; status: string; gapCode: string | null }>`
        SELECT import_key AS key,status,gap_code AS "gapCode" FROM learning_exposure_imports
        WHERE raw_version_id IN (${unstartedVersion}::uuid,${startedVersion}::uuid) ORDER BY import_key`.execute(kysely);
      expect(receipts.rows).toEqual(
        [
          { key: `cli-v2:${unstartedVersion}`, status: "gap", gapCode: "sqlite-snapshot-without-steps-table" },
          { key: `cli-v2:${startedVersion}`, status: "completed", gapCode: null },
        ].sort((a, b) => a.key.localeCompare(b.key)),
      );
      // Terminal for that version: the selector must not re-claim and re-gap it.
      const second = await ingest.ingestSpool(true);
      expect(second).toEqual({ processed: 0, pending: 0, gaps: 0 });
      await expect(ingest.parity()).resolves.toMatchObject({
        projectionEligibleVersions: 2,
        projectionPendingVersions: 0,
        projectionGapVersions: 1,
      });
    } finally {
      await rm(spoolRoot, { recursive: true, force: true });
    }
  });

  test("leases spool captures under one stable, attributable owner", async () => {
    const spoolRoot = await mkdtemp(join(tmpdir(), "exposure-ingest-spool-"));
    const eventsDirectory = join(spoolRoot, "events");
    await mkdir(eventsDirectory);
    for (const name of ["owned-a.json", "owned-b.json"]) {
      await writeFile(
        join(eventsDirectory, name),
        `${JSON.stringify({ notAnObservation: name })}\n`,
        { mode: 0o600 },
      );
    }
    const recording = new OwnerRecordingArchiveService(kysely);
    const ingest = new LearningExposureIngestService(
      kysely,
      recording,
      exposure,
      { enabled: true, spoolRoot },
    );
    try {
      await ingest.ingestSpool(false);
      expect(recording.leaseOwners).toHaveLength(2);
      expect(new Set(recording.leaseOwners).size).toBe(1);
      expect(recording.leaseOwners[0]).toBe(ingest.leaseOwnerId);
      expect(ingest.leaseOwnerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // A second instance in the same process owns its leases identically, so a
      // reclaimer can attribute and free every lease this process left behind.
      expect(
        new LearningExposureIngestService(kysely, archive, exposure, {
          enabled: true,
          spoolRoot,
        }).leaseOwnerId,
      ).toBe(ingest.leaseOwnerId);
    } finally {
      await rm(spoolRoot, { recursive: true, force: true });
    }
  });
});
