import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";

import {
  LearningLosslessArchiveService,
  verifyCapturedArchiveBytes,
  type CapturedArchiveBytes,
  type CapturedArchiveChunk,
} from "./learning-lossless-archive-service.js";
import type { DB } from "../types/db.types.js";

const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const chunk = (
  bytes: Uint8Array,
  ordinal: number,
  offset: number,
): CapturedArchiveChunk => {
  const encodedBytes = gzipSync(bytes);
  return {
    ordinal,
    offset,
    rawLength: bytes.byteLength,
    rawSha256: digest(bytes),
    codec: "gzip",
    codecVersion: "rfc1952",
    encodedLength: encodedBytes.byteLength,
    encodedSha256: digest(encodedBytes),
    encodedBytes,
  };
};

const capture = (parts: Uint8Array[]): CapturedArchiveBytes => {
  let offset = 0;
  const chunks = parts.map((bytes, ordinal) => {
    const value = chunk(bytes, ordinal, offset);
    offset += bytes.byteLength;
    return value;
  });
  const raw = Buffer.concat(parts);
  return {
    captureKind: "opaque-complete",
    consistency: "stable-file",
    coverage: "complete",
    source: {
      deviceId: "1",
      inodeId: "2",
      mode: 0o600,
      size: raw.byteLength,
      mtimeNs: "3",
      ctimeNs: "4",
    },
    captureStartedAt: "2026-09-05T00:00:00.000Z",
    captureEndedAt: "2026-09-05T00:00:01.000Z",
    offset: 0,
    rawLength: raw.byteLength,
    rawSha256: digest(raw),
    chunks,
    limitations: [],
  };
};

describe("lossless archive chunk verification", () => {
  test("reconstructs exact opaque JSONL and binary bytes across chunk boundaries", () => {
    const first = Buffer.concat([
      Buffer.from('  {"unknown":"💾","line":"CRLF"}\r\n{"tool":"'),
      Buffer.from([0xff, 0xfe, 0x00, 0x80]),
    ]);
    const second = Buffer.from(
      `${"result".repeat(10_000)}"}\npartial-final-record`,
    );
    const fixture = capture([first, second]);

    const verified = verifyCapturedArchiveBytes(fixture);
    const restored = Buffer.concat(verified.map(({ rawBytes }) => rawBytes));
    const expected = Buffer.concat([first, second]);

    expect(restored.equals(expected)).toBe(true);
    expect(digest(restored)).toBe(fixture.rawSha256);
    expect(restored.byteLength).toBe(fixture.rawLength);
  });

  test("refuses encoded corruption before any persistence boundary", () => {
    const fixture = capture([Buffer.from("immutable opaque bytes")]);
    fixture.chunks[0]!.encodedBytes = Uint8Array.from(
      fixture.chunks[0]!.encodedBytes,
    );
    fixture.chunks[0]!.encodedBytes[3] =
      (fixture.chunks[0]!.encodedBytes[3] ?? 0) ^ 0xff;

    expect(() => verifyCapturedArchiveBytes(fixture)).toThrow(
      "encoded digest mismatch",
    );
  });

  test("refuses a raw digest mismatch after successful decompression", () => {
    const fixture = capture([Buffer.from("digest-checked")]);
    fixture.chunks[0]!.rawSha256 = "0".repeat(64);

    expect(() => verifyCapturedArchiveBytes(fixture)).toThrow(
      "raw digest mismatch",
    );
  });

  test("refuses chunk gaps and aggregate truncation", () => {
    const fixture = capture([Buffer.from("first"), Buffer.from("second")]);
    fixture.chunks[1]!.offset += 1;
    expect(() => verifyCapturedArchiveBytes(fixture)).toThrow("offset gap");

    const truncated = capture([Buffer.from("first"), Buffer.from("second")]);
    truncated.rawLength -= 1;
    expect(() => verifyCapturedArchiveBytes(truncated)).toThrow(
      "raw length does not equal its chunks",
    );
  });

  test("enforces the four MiB raw chunk ceiling", () => {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
    expect(() => verifyCapturedArchiveBytes(capture([oversized]))).toThrow(
      "exceeds the 4194304-byte bound",
    );
  });
});

const integrationUrl = process.env.LOSSLESS_ARCHIVE_TEST_DATABASE_URL;
const describePostgres = integrationUrl ? describe : describe.skip;

describePostgres("LearningLosslessArchiveService PostgreSQL contract", () => {
  let kysely: Kysely<DB>;
  let service: LearningLosslessArchiveService;

  beforeAll(() => {
    kysely = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new Pool({ connectionString: integrationUrl!, max: 3 }),
      }),
      plugins: [new CamelCasePlugin()],
    });
    service = new LearningLosslessArchiveService(kysely);
  });

  afterAll(async () => {
    await kysely?.destroy();
  });

  const register = async (relativePath: string) =>
    service.registerSource({
      host: "lossless-storage-integration",
      provider: "codex",
      rootPath: "/tmp/lossless-storage-integration",
      relativePath,
      fileKind: "jsonl",
      deviceId: "1",
      inodeId: "2",
      sourceSize: 0,
      sourceMtimeNs: "1",
      sourceCtimeNs: "1",
      observedAt: "2026-09-05T00:00:00.000Z",
    });

  const claim = async (sourceId: string, generation: number) => {
    const value = await service.claimSource({
      sourceId,
      generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (!value) throw new Error("integration fixture claim failed");
    return value;
  };

  test("atomically seals, restores, appends with blob reuse and keeps occurrences distinct", async () => {
    const runId = randomUUID();
    expect(await service.createRun({ runId, runKind: "probe" })).toBe(runId);
    expect(await service.createRun({ runId, runKind: "probe" })).toBe(runId);
    const firstSource = await register("first.jsonl");
    const firstBytes = Buffer.from('  {"unknown":"雪"}\r\npartial');
    const firstCapture = capture([firstBytes]);
    const first = await service.commitCapture({
      claim: await claim(firstSource.sourceId, firstSource.generation),
      runId,
      expectedCursor: 0,
      checkpointCursorAfter: firstBytes.length,
      capture: firstCapture,
    });
    expect(
      (await service.restoreVersion(first.versionId)).equals(firstBytes),
    ).toBe(true);

    const duplicateSource = await register("duplicate.jsonl");
    const differentlyEncoded = capture([firstBytes]);
    const alternateGzip = gzipSync(firstBytes, { level: 1 });
    differentlyEncoded.chunks[0]!.encodedBytes = alternateGzip;
    differentlyEncoded.chunks[0]!.encodedLength = alternateGzip.byteLength;
    differentlyEncoded.chunks[0]!.encodedSha256 = digest(alternateGzip);
    const duplicate = await service.commitCapture({
      claim: await claim(duplicateSource.sourceId, duplicateSource.generation),
      runId,
      expectedCursor: 0,
      checkpointCursorAfter: firstBytes.length,
      capture: differentlyEncoded,
    });
    expect(duplicate.versionId).not.toBe(first.versionId);
    expect(duplicate.deduplicatedBytes).toBe(firstBytes.length);

    const suffix = Buffer.from('\n{"appended":true}\n');
    const suffixCapture = capture([suffix]);
    suffixCapture.captureKind = "opaque-range";
    suffixCapture.consistency = "stable-prefix";
    suffixCapture.coverage = "prefix";
    suffixCapture.offset = firstBytes.length;
    suffixCapture.chunks[0]!.offset = firstBytes.length;
    const appended = await service.commitCapture({
      claim: await claim(firstSource.sourceId, firstSource.generation),
      runId,
      expectedCursor: firstBytes.length,
      checkpointCursorAfter: firstBytes.length + suffix.length,
      baseVersionId: first.versionId,
      capture: suffixCapture,
    });
    expect(
      (await service.restoreVersion(appended.versionId)).equals(
        Buffer.concat([firstBytes, suffix]),
      ),
    ).toBe(true);
    const linked = await sql<{
      count: string;
    }>`SELECT count(*) AS count FROM learning_archive_version_chunks WHERE version_id = ${appended.versionId}::uuid`.execute(
      kysely,
    );
    expect(Number(linked.rows[0]?.count)).toBe(2);
  });

  test("restores an exact bounded window across stored chunk boundaries", async () => {
    const source = await register("windowed.jsonl");
    const pieces = [
      Buffer.from("first-chunk:"),
      Buffer.from("second-chunk:"),
      Buffer.from("third"),
    ];
    const all = Buffer.concat(pieces);
    const sealed = await service.commitCapture({
      claim: await claim(source.sourceId, source.generation),
      expectedCursor: 0,
      checkpointCursorAfter: all.length,
      capture: capture(pieces),
    });
    const offset = pieces[0]!.length - 2;
    const length = pieces[1]!.length + 4;
    expect(
      (
        await service.restoreVersionWindow(sealed.versionId, offset, length)
      ).equals(all.subarray(offset, offset + length)),
    ).toBe(true);
    expect(
      await service.restoreVersionWindow(sealed.versionId, all.length, 8),
    ).toEqual(Buffer.alloc(0));
    await expect(
      service.restoreVersionWindow(sealed.versionId, 0, 16 * 1024 * 1024 + 1),
    ).rejects.toThrow("Archive restore window must be between");
    await expect(
      service.restoreVersionWindow(sealed.versionId, all.length + 1, 8),
    ).rejects.toThrow("offset exceeds version length");
  });

  test("rejects stale fencing and rolls an interrupted blob transaction back without a cursor gap", async () => {
    const runId = await service.createRun({ runKind: "probe" });
    const staleSource = await register("stale.jsonl");
    const stale = await claim(staleSource.sourceId, staleSource.generation);
    expect(await service.releaseClaim(stale)).toBe(true);
    const current = await claim(staleSource.sourceId, staleSource.generation);
    const bytes = Buffer.from("fenced");
    await expect(
      service.commitCapture({
        claim: stale,
        runId,
        expectedCursor: 0,
        checkpointCursorAfter: bytes.length,
        capture: capture([bytes]),
      }),
    ).rejects.toThrow("lost its claim lease");
    expect(await service.releaseClaim(current)).toBe(true);

    const interruptedSource = await register("interrupted.jsonl");
    const interruptedClaim = await claim(
      interruptedSource.sourceId,
      interruptedSource.generation,
    );
    const interrupted = new LearningLosslessArchiveService(kysely, {
      afterBlobWrite: () => {
        throw new Error("synthetic interruption");
      },
    });
    await expect(
      interrupted.commitCapture({
        claim: interruptedClaim,
        runId,
        expectedCursor: 0,
        checkpointCursorAfter: bytes.length,
        capture: capture([bytes]),
      }),
    ).rejects.toThrow("synthetic interruption");
    expect(
      (await service.getCheckpoint(interruptedSource.sourceId))?.cursorOffset,
    ).toBe(0);
    const blobCount = await sql<{
      count: string;
    }>`SELECT count(*) AS count FROM learning_archive_blobs WHERE sha256 = decode(${digest(bytes)}, 'hex')`.execute(
      kysely,
    );
    expect(Number(blobCount.rows[0]?.count)).toBe(0);
    const recovered = await service.commitCapture({
      claim: interruptedClaim,
      runId,
      expectedCursor: 0,
      checkpointCursorAfter: bytes.length,
      capture: capture([bytes]),
    });
    expect(
      (await service.restoreVersion(recovered.versionId)).equals(bytes),
    ).toBe(true);
  });

  test("rolls back an in-flight commit when its isolated PostgreSQL backend is terminated", async () => {
    const faultPool = new Pool({ connectionString: integrationUrl!, max: 1 });
    // pg emits the expected server-side termination on the pool as well as
    // rejecting the in-flight query. Consume only this isolated test pool's
    // error so Bun does not treat the deliberate disconnect as uncaught.
    faultPool.on("error", () => {});
    faultPool.on("connect", (client) => client.on("error", () => {}));
    const controlPool = new Pool({ connectionString: integrationUrl!, max: 1 });
    const faultKysely = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: faultPool }),
      plugins: [new CamelCasePlugin()],
    });
    const controlKysely = new Kysely<DB>({
      dialect: new PostgresDialect({ pool: controlPool }),
      plugins: [new CamelCasePlugin()],
    });
    try {
      const backend = await sql<{ pid: number; databaseName: string }>`
        SELECT pg_backend_pid() AS pid, current_database() AS "databaseName"`.execute(
        faultKysely,
      );
      const expectedDatabase = decodeURIComponent(
        new URL(integrationUrl!).pathname.slice(1),
      );
      expect(backend.rows[0]?.databaseName).toBe(expectedDatabase);
      const source = await register("database-disconnect.jsonl");
      const sourceClaim = await claim(source.sourceId, source.generation);
      const runId = await service.createRun({ runKind: "probe" });
      const bytes = Buffer.from(`database-loss-${randomUUID()}`);
      const disconnecting = new LearningLosslessArchiveService(faultKysely, {
        afterBlobWrite: async () => {
          const terminated = await sql<{ terminated: boolean }>`
            SELECT pg_terminate_backend(${backend.rows[0]!.pid}) AS terminated
              FROM pg_stat_activity
             WHERE pid=${backend.rows[0]!.pid} AND datname=current_database()
               AND pid <> pg_backend_pid()`.execute(controlKysely);
          if (terminated.rows[0]?.terminated !== true)
            throw new Error("isolated backend termination was not confirmed");
        },
      });
      await expect(
        disconnecting.commitCapture({
          claim: sourceClaim,
          runId,
          expectedCursor: 0,
          checkpointCursorAfter: bytes.length,
          capture: capture([bytes]),
        }),
      ).rejects.toThrow();
      expect((await service.getCheckpoint(source.sourceId))?.cursorOffset).toBe(
        0,
      );
      const persisted = await sql<{ blobs: string; versions: string }>`
        SELECT (SELECT count(*) FROM learning_archive_blobs WHERE sha256=decode(${digest(bytes)},'hex')) AS blobs,
               (SELECT count(*) FROM learning_archive_versions WHERE source_id=${source.sourceId}::uuid) AS versions`.execute(
        kysely,
      );
      expect(persisted.rows[0]).toEqual({ blobs: "0", versions: "0" });
      const replayed = await service.commitCapture({
        claim: sourceClaim,
        runId,
        expectedCursor: 0,
        checkpointCursorAfter: bytes.length,
        capture: capture([bytes]),
      });
      expect(
        (await service.restoreVersion(replayed.versionId)).equals(bytes),
      ).toBe(true);
    } finally {
      await Promise.allSettled([
        faultKysely.destroy(),
        controlKysely.destroy(),
      ]);
    }
  });

  test("database triggers refuse mutation of sealed evidence", async () => {
    const source = await register("immutable.jsonl");
    const bytes = Buffer.from("do not mutate");
    const committed = await service.commitCapture({
      claim: await claim(source.sourceId, source.generation),
      expectedCursor: 0,
      checkpointCursorAfter: bytes.length,
      capture: capture([bytes]),
    });
    await expect(
      sql`UPDATE learning_archive_versions SET coverage_status = 'gap' WHERE version_id = ${committed.versionId}::uuid`.execute(
        kysely,
      ),
    ).rejects.toThrow("sealed learning archive versions are immutable");
    await expect(
      sql`UPDATE learning_archive_blobs SET verified_at = NOW() WHERE sha256 = decode(${digest(bytes)}, 'hex')`.execute(
        kysely,
      ),
    ).rejects.toThrow("learning archive blobs are immutable");
  });

  test("a staged capture whose bytes were lost before sealing does not wedge later captures of the source", async () => {
    // 2026-09-21: two SQLite sources sat at `capture-failed` on every pass after
    // their staged copies vanished — the orphaned `writing` row held
    // checkpoint+1, so every new INSERT collided on (source, generation,
    // version_number). The archive must step over the orphan.
    const source = await register("orphaned.sqlite");
    const sourceClaim = await claim(source.sourceId, source.generation);
    const sourceIdentity = { deviceId: "1", inodeId: "2", mode: 0o600, mtimeNs: "3", ctimeNs: "4" };
    const begin = (bytes: Buffer, withClaim = sourceClaim, expectedCursor = 0) =>
      service.beginStagedCapture({
        claim: withClaim,
        expectedCursor,
        captureKind: "consistent-sqlite-snapshot",
        consistencyStatus: "logical-sqlite-snapshot",
        coverageStatus: "complete",
        source: { ...sourceIdentity, size: bytes.length },
        captureStartedAt: "2026-09-05T00:00:00.000Z",
        limitations: ["logical snapshot"],
        stagingKey: `${randomUUID()}:${digest(bytes)}`,
        expectedRawLength: bytes.length,
        expectedAggregateSha256: digest(bytes),
      });
    const lost = Buffer.from("snapshot-whose-staged-copy-was-lost");
    const orphan = await begin(lost);
    await service.appendStagedChunk({
      claim: sourceClaim,
      versionId: orphan.versionId,
      expectedOffset: 0,
      chunk: chunk(lost.subarray(0, 8), 0, 0),
    });
    // The staged file is gone; the source moved on. Nothing seals `orphan`.
    const current = Buffer.from("snapshot-taken-after-the-source-grew");
    const next = await begin(current);
    expect(next.versionId).not.toBe(orphan.versionId);
    expect(next.idempotent).toBe(false);
    await service.appendStagedChunk({
      claim: sourceClaim,
      versionId: next.versionId,
      expectedOffset: 0,
      chunk: chunk(current, 0, 0),
    });
    const sealed = await service.sealStagedCapture({
      claim: sourceClaim,
      versionId: next.versionId,
      checkpointCursorAfter: current.length,
      captureEndedAt: "2026-09-05T00:00:01.000Z",
    });
    expect((await service.restoreVersion(sealed.versionId)).equals(current)).toBe(true);
    const numbers = await sql<{ versionNumber: number; manifestStatus: string }>`
      SELECT version_number AS "versionNumber", manifest_status AS "manifestStatus"
        FROM learning_archive_versions WHERE source_id = ${source.sourceId}::uuid ORDER BY version_number
    `.execute(kysely);
    expect(numbers.rows.map((row) => [Number(row.versionNumber), row.manifestStatus])).toEqual([[1, "writing"], [2, "sealed"]]);
    // A third capture after the seal (a new pass: fresh claim, advanced cursor) numbers past both.
    const later = Buffer.from("snapshot-taken-later-still");
    const third = await begin(later, await claim(source.sourceId, source.generation), current.length);
    expect(third.versionId).not.toBe(next.versionId);
    const thirdRow = await sql<{ versionNumber: number }>`
      SELECT version_number AS "versionNumber" FROM learning_archive_versions WHERE version_id = ${third.versionId}::uuid
    `.execute(kysely);
    expect(Number(thirdRow.rows[0]?.versionNumber)).toBe(3);
  });

  test("stages a multi-transaction SQLite snapshot and seals only after aggregate verification", async () => {
    const source = await register("large.sqlite");
    const sourceClaim = await claim(source.sourceId, source.generation);
    const first = Buffer.from("sqlite-snapshot-page-one");
    const second = Buffer.from("sqlite-snapshot-page-two");
    const all = Buffer.concat([first, second]);
    const staged = await service.beginStagedCapture({
      claim: sourceClaim,
      expectedCursor: 0,
      captureKind: "consistent-sqlite-snapshot",
      consistencyStatus: "logical-sqlite-snapshot",
      coverageStatus: "complete",
      source: {
        deviceId: "1",
        inodeId: "2",
        mode: 0o600,
        size: all.length,
        mtimeNs: "3",
        ctimeNs: "4",
      },
      captureStartedAt: "2026-09-05T00:00:00.000Z",
      limitations: ["logical snapshot"],
      stagingKey: randomUUID(),
      expectedRawLength: all.length,
      expectedAggregateSha256: digest(all),
    });
    const firstChunk = chunk(first, 0, 0);
    const firstStored = await service.appendStagedChunk({
      claim: sourceClaim,
      versionId: staged.versionId,
      expectedOffset: 0,
      chunk: firstChunk,
    });
    expect(firstStored.nextOffset).toBe(first.length);
    expect(
      (
        await service.appendStagedChunk({
          claim: sourceClaim,
          versionId: staged.versionId,
          expectedOffset: 0,
          chunk: firstChunk,
        })
      ).idempotent,
    ).toBe(true);
    await expect(
      service.sealStagedCapture({
        claim: sourceClaim,
        versionId: staged.versionId,
        checkpointCursorAfter: all.length,
        captureEndedAt: "2026-09-05T00:00:01.000Z",
      }),
    ).rejects.toThrow("aggregate verification failed");
    await service.appendStagedChunk({
      claim: sourceClaim,
      versionId: staged.versionId,
      expectedOffset: first.length,
      chunk: chunk(second, 1, first.length),
    });
    const sealed = await service.sealStagedCapture({
      claim: sourceClaim,
      versionId: staged.versionId,
      checkpointCursorAfter: all.length,
      captureEndedAt: "2026-09-05T00:00:01.000Z",
    });
    expect((await service.restoreVersion(sealed.versionId)).equals(all)).toBe(
      true,
    );
    expect(
      (
        await service.sealStagedCapture({
          claim: sourceClaim,
          versionId: staged.versionId,
          checkpointCursorAfter: all.length,
          captureEndedAt: "2026-09-05T00:00:01.000Z",
        })
      ).versionId,
    ).toBe(sealed.versionId);
  });
});
