import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { Database } from "bun:sqlite";
import { defineSessionlessFunction } from "../../../runtime/define.js";
import { z } from "zod";

import {
  captureOpaqueFile,
  captureOpaqueRange,
  captureSqliteLogicalSnapshot,
  verifyOpaquePrefix,
  type CapturedArchiveBytes,
} from "@learner/core/lib/learning/lossless-archive-files.js";
import {
  LearningLosslessArchiveService,
  type ArchiveClaim,
  type ArchiveFileKind,
  type ArchiveProvider,
} from "@learner/core/services/learning-lossless-archive-service.js";

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
const now = (): string => new Date().toISOString();

export const SetupLearningLosslessArchiveProofStepInput = z.object({
  runId: z.string().uuid(),
});
export const SetupLearningLosslessArchiveProofStepOutput = z.object({
  runId: z.string().uuid(),
  fixtureId: z.string().uuid(),
  root: z.string(),
  jsonlPath: z.string(),
  binaryPath: z.string(),
  duplicatePath: z.string(),
  sqlitePath: z.string(),
  jsonlSha256: z.string(),
  jsonlLength: z.number(),
  binarySha256: z.string(),
  binaryLength: z.number(),
});

export const CaptureLearningLosslessArchiveProofStepInput =
  SetupLearningLosslessArchiveProofStepOutput;
export const CaptureLearningLosslessArchiveProofStepOutput =
  SetupLearningLosslessArchiveProofStepOutput.extend({
    jsonlSourceId: z.string().uuid(),
    binarySourceId: z.string().uuid(),
    duplicateSourceId: z.string().uuid(),
    sqliteSourceId: z.string().uuid(),
    jsonlVersionId: z.string().uuid(),
    binaryVersionId: z.string().uuid(),
    duplicateVersionId: z.string().uuid(),
    sqliteVersionId: z.string().uuid(),
    sqliteIntegrity: z.literal(true),
    exactByteMatches: z.number(),
    deduplicatedBytes: z.number(),
    versionsSealed: z.number(),
  });

export const RecoverLearningLosslessArchiveProofStepInput =
  CaptureLearningLosslessArchiveProofStepOutput;
export const RecoverLearningLosslessArchiveProofStepOutput =
  CaptureLearningLosslessArchiveProofStepOutput.extend({
    appendedVersionId: z.string().uuid(),
    replacementVersionId: z.string().uuid(),
    recoveryVersionId: z.string().uuid(),
    recoverySourceId: z.string().uuid(),
    missingSourceId: z.string().uuid(),
    vanishingSourceId: z.string().uuid(),
    sameSizeRewriteDetected: z.literal(true),
    truncationDetected: z.literal(true),
    oldVersionsPreserved: z.literal(true),
    sourceDeletedAfterCapture: z.literal(true),
    staleWorkerCommits: z.literal(0),
    cursorGaps: z.literal(0),
    duplicateLogicalVersions: z.literal(0),
    explicitGaps: z.number(),
    deletionBeforeCaptureGap: z.literal(true),
    compressionFailuresDetected: z.number(),
    interruptedCommitsRecovered: z.number(),
  });

export const LosslessArchiveProofOutput = z.object({
  runId: z.string().uuid(),
  fixtureId: z.string().uuid(),
  status: z.literal("completed"),
  completedAt: z.string(),
  cases: z
    .array(
      z.enum([
        "jsonl-byte-fidelity",
        "chunk-spanning-binary",
        "sqlite-wal-logical-snapshot",
        "deduplicated-occurrences",
        "mutation-version-preservation",
        "concurrent-fencing",
        "interrupted-commit-recovery",
        "compression-corruption-refusal",
        "missing-and-deleted-source",
        "truncation-detection",
        "deletion-before-capture-gap",
      ]),
    )
    .length(11),
  casesPassed: z.number().int().min(11),
  exactByteMatches: z.number().int().min(4),
  versionsSealed: z.number().int().min(7),
  oldVersionsPreserved: z.literal(true),
  sourceDeletedAfterCapture: z.literal(true),
  sqliteIntegrity: z.literal(true),
  sameSizeRewriteDetected: z.literal(true),
  truncationDetected: z.literal(true),
  staleWorkerCommits: z.literal(0),
  cursorGaps: z.literal(0),
  duplicateLogicalVersions: z.literal(0),
  explicitGaps: z.number().int().min(1),
  deletionBeforeCaptureGap: z.literal(true),
  deduplicatedBytes: z.number().int().positive(),
  compressionFailuresDetected: z.number().int().min(1),
  interruptedCommitsRecovered: z.number().int().min(1),
  limitations: z.array(z.string()),
});
export const FinishLearningLosslessArchiveProofStepInput =
  RecoverLearningLosslessArchiveProofStepOutput;
export const FinishLearningLosslessArchiveProofStepOutput =
  LosslessArchiveProofOutput;

const fixtureJsonl = (): Buffer =>
  Buffer.concat([
    Buffer.from(
      '  \r\n{"type":"unknown-event","value":"雪 🚀"}\n{"tool":{"input":{"opaque":true},"result":"',
    ),
    Buffer.from("x".repeat(1_050_000)),
    Buffer.from('"}}\n{malformed json}\r\n'),
    Buffer.from([0xff, 0xfe, 0x00, 0x80]),
    Buffer.from('\n{"partial":"terminal"'),
  ]);

const fixtureBinary = (fixtureId: string): Buffer => {
  const seed = createHash("sha256").update(fixtureId).digest();
  const out = Buffer.alloc(1_048_777);
  for (let i = 0; i < out.length; i += 1) out[i] = seed[i % seed.length]!;
  out[0] = 0;
  out[out.length - 1] = 0;
  return out;
};

async function registerAndClaim(
  service: LearningLosslessArchiveService,
  input: {
    fixtureId: string;
    root: string;
    path: string;
    relativePath: string;
    provider: ArchiveProvider;
    fileKind: ArchiveFileKind;
  },
) {
  const details = await stat(input.path, { bigint: true });
  const source = await service.registerSource({
    host: `lossless-proof-${input.fixtureId}`,
    provider: input.provider,
    rootPath: input.root,
    relativePath: input.relativePath,
    fileKind: input.fileKind,
    deviceId: String(details.dev),
    inodeId: String(details.ino),
    sourceSize: Number(details.size),
    sourceMtimeNs: String(details.mtimeNs),
    sourceCtimeNs: String(details.ctimeNs),
    observedAt: now(),
    metadata: { syntheticProof: true, fixtureId: input.fixtureId },
  });
  const claim = await service.claimSource({
    sourceId: source.sourceId,
    generation: source.generation,
    ownerId: randomUUID(),
    leaseMs: 60_000,
  });
  if (!claim)
    throw new Error(
      `Synthetic archive proof could not claim ${input.relativePath}`,
    );
  return { source, claim };
}

async function commitComplete(
  service: LearningLosslessArchiveService,
  runId: string,
  root: string,
  path: string,
  registration: Awaited<ReturnType<typeof registerAndClaim>>,
) {
  const capture = await captureOpaqueFile(path, { approvedRoot: root });
  const committed = await service.commitCapture({
    claim: registration.claim,
    runId,
    expectedCursor: 0,
    checkpointCursorAfter: capture.rawLength,
    capture,
  });
  return { capture, committed };
}

export const setupLearningLosslessArchiveProofStep = defineSessionlessFunction({
  title: "Create an isolated lossless archive proof fixture",
  input: SetupLearningLosslessArchiveProofStepInput,
  output: SetupLearningLosslessArchiveProofStepOutput,
  func: async ({ learningLosslessArchiveService }, { runId }) => {
    const fixtureId = randomUUID();
    const root = join(tmpdir(), `lossless-archive-proof-${fixtureId}`);
    await mkdir(root, { recursive: false, mode: 0o700 });
    const jsonlPath = join(root, "events.jsonl");
    const binaryPath = join(root, "attachment.bin");
    const duplicatePath = join(root, "attachment-copy.bin");
    const sqlitePath = join(root, "conversation.sqlite");
    const jsonl = fixtureJsonl();
    const binary = fixtureBinary(fixtureId);
    await Promise.all([
      writeFile(jsonlPath, jsonl, { flag: "wx", mode: 0o600 }),
      writeFile(binaryPath, binary, { flag: "wx", mode: 0o600 }),
      writeFile(duplicatePath, binary, { flag: "wx", mode: 0o600 }),
    ]);
    const sqlite = new Database(sqlitePath, { create: true, strict: true });
    try {
      sqlite.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE unknown_records(id INTEGER PRIMARY KEY, label TEXT, payload BLOB);",
      );
      sqlite
        .query("INSERT INTO unknown_records(label,payload) VALUES (?,?)")
        .run("wal-committed", binary.subarray(0, 4097));
    } finally {
      sqlite.close();
    }
    await learningLosslessArchiveService.createRun({
      runId,
      runKind: "e2e",
      metadata: { fixtureId, syntheticProof: true },
    });
    return {
      runId,
      fixtureId,
      root,
      jsonlPath,
      binaryPath,
      duplicatePath,
      sqlitePath,
      jsonlSha256: sha256(jsonl),
      jsonlLength: jsonl.length,
      binarySha256: sha256(binary),
      binaryLength: binary.length,
    };
  },
});

export const captureLearningLosslessArchiveProofStep = defineSessionlessFunction({
  title: "Capture byte-exact JSONL, binary and SQLite proof versions",
  input: CaptureLearningLosslessArchiveProofStepInput,
  output: CaptureLearningLosslessArchiveProofStepOutput,
  func: async ({ learningLosslessArchiveService }, fixture) => {
    const jsonlRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: fixture.jsonlPath,
        relativePath: "events.jsonl",
        provider: "codex",
        fileKind: "jsonl",
      },
    );
    const jsonl = await commitComplete(
      learningLosslessArchiveService,
      fixture.runId,
      fixture.root,
      fixture.jsonlPath,
      jsonlRegistration,
    );
    const binaryRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: fixture.binaryPath,
        relativePath: "attachment.bin",
        provider: "claude",
        fileKind: "attachment",
      },
    );
    const binary = await commitComplete(
      learningLosslessArchiveService,
      fixture.runId,
      fixture.root,
      fixture.binaryPath,
      binaryRegistration,
    );
    const duplicateRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: fixture.duplicatePath,
        relativePath: "attachment-copy.bin",
        provider: "agy",
        fileKind: "attachment",
      },
    );
    const duplicate = await commitComplete(
      learningLosslessArchiveService,
      fixture.runId,
      fixture.root,
      fixture.duplicatePath,
      duplicateRegistration,
    );

    const sqliteRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: fixture.sqlitePath,
        relativePath: "conversation.sqlite",
        provider: "agy",
        fileKind: "sqlite",
      },
    );
    // Keep a writer open with autocheckpoint disabled so the second committed
    // row exists in WAL while the read-only snapshot is taken. This catches the
    // main-database-only copy bug without checkpointing the provider source.
    const sqliteWriter = new Database(fixture.sqlitePath, { strict: true });
    sqliteWriter.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    sqliteWriter
      .query("INSERT INTO unknown_records(label,payload) VALUES (?,?)")
      .run("wal-live", fixtureBinary(fixture.fixtureId).subarray(4097, 8194));
    const walDetails = await stat(`${fixture.sqlitePath}-wal`);
    if (walDetails.size <= 0)
      throw new Error("SQLite proof did not create WAL-only committed state");
    sqliteWriter.exec("BEGIN");
    sqliteWriter
      .query("INSERT INTO unknown_records(label,payload) VALUES (?,?)")
      .run("after-boundary", Buffer.from("must-not-enter-snapshot"));
    let sqliteCapture: CapturedArchiveBytes;
    try {
      sqliteCapture = await captureSqliteLogicalSnapshot(fixture.sqlitePath, {
        approvedRoot: fixture.root,
      });
      sqliteWriter.exec("COMMIT");
    } finally {
      if (sqliteWriter.inTransaction) sqliteWriter.exec("ROLLBACK");
      sqliteWriter.close();
    }
    const sqliteCommitted = await learningLosslessArchiveService.commitCapture({
      claim: sqliteRegistration.claim,
      runId: fixture.runId,
      expectedCursor: 0,
      checkpointCursorAfter: sqliteCapture.rawLength,
      capture: sqliteCapture,
    });

    const [jsonlRestored, binaryRestored, duplicateRestored, sqliteRestored] =
      await Promise.all([
        learningLosslessArchiveService.restoreVersion(
          jsonl.committed.versionId,
        ),
        learningLosslessArchiveService.restoreVersion(
          binary.committed.versionId,
        ),
        learningLosslessArchiveService.restoreVersion(
          duplicate.committed.versionId,
        ),
        learningLosslessArchiveService.restoreVersion(
          sqliteCommitted.versionId,
        ),
      ]);
    if (
      sha256(jsonlRestored) !== fixture.jsonlSha256 ||
      jsonlRestored.length !== fixture.jsonlLength
    )
      throw new Error("JSONL proof restore mismatch");
    if (
      sha256(binaryRestored) !== fixture.binarySha256 ||
      binaryRestored.length !== fixture.binaryLength
    )
      throw new Error("Binary proof restore mismatch");
    if (
      sha256(duplicateRestored) !== fixture.binarySha256 ||
      duplicateRestored.length !== fixture.binaryLength
    )
      throw new Error("Deduplicated occurrence restore mismatch");
    const sqliteVerifyPath = join(fixture.root, "restored.sqlite");
    await writeFile(sqliteVerifyPath, sqliteRestored, {
      flag: "wx",
      mode: 0o600,
    });
    const sqlite = new Database(sqliteVerifyPath, {
      readonly: true,
      strict: true,
    });
    try {
      if (
        sqlite
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get()?.integrity_check !== "ok"
      )
        throw new Error("SQLite proof integrity failed");
      const rows = sqlite
        .query<{ label: string; payload: Uint8Array }, []>(
          "SELECT label,payload FROM unknown_records ORDER BY id",
        )
        .all();
      if (
        rows.length !== 2 ||
        rows[0]?.label !== "wal-committed" ||
        rows[1]?.label !== "wal-live" ||
        sha256(rows[0].payload) !==
          sha256(fixtureBinary(fixture.fixtureId).subarray(0, 4097)) ||
        sha256(rows[1].payload) !==
          sha256(fixtureBinary(fixture.fixtureId).subarray(4097, 8194))
      ) {
        throw new Error("SQLite unknown-schema/BLOB proof mismatch");
      }
    } finally {
      sqlite.close();
    }
    const liveSqlite = new Database(fixture.sqlitePath, {
      readonly: true,
      strict: true,
    });
    try {
      const liveCount = liveSqlite
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM unknown_records",
        )
        .get()?.count;
      if (liveCount !== 3)
        throw new Error(
          "SQLite concurrent transaction boundary was not exercised",
        );
    } finally {
      liveSqlite.close();
    }
    return {
      ...fixture,
      jsonlSourceId: jsonlRegistration.source.sourceId,
      binarySourceId: binaryRegistration.source.sourceId,
      duplicateSourceId: duplicateRegistration.source.sourceId,
      sqliteSourceId: sqliteRegistration.source.sourceId,
      jsonlVersionId: jsonl.committed.versionId,
      binaryVersionId: binary.committed.versionId,
      duplicateVersionId: duplicate.committed.versionId,
      sqliteVersionId: sqliteCommitted.versionId,
      sqliteIntegrity: true as const,
      exactByteMatches: 4,
      deduplicatedBytes: duplicate.committed.deduplicatedBytes,
      versionsSealed: 4,
    };
  },
});

export const recoverLearningLosslessArchiveProofStep = defineSessionlessFunction({
  title: "Prove mutation detection, fencing, rollback and recovery",
  input: RecoverLearningLosslessArchiveProofStepInput,
  output: RecoverLearningLosslessArchiveProofStepOutput,
  func: async ({ learningLosslessArchiveService, kysely }, fixture) => {
    const original = await readFile(fixture.jsonlPath);
    const append = Buffer.from('\r\n{"after":"append"}\n');
    await writeFile(fixture.jsonlPath, append, { flag: "a" });
    const appendRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: fixture.jsonlPath,
        relativePath: "events.jsonl",
        provider: "codex",
        fileKind: "jsonl",
      },
    );
    const appendedCapture = await captureOpaqueRange(fixture.jsonlPath, {
      approvedRoot: fixture.root,
      offset: original.length,
      length: append.length,
    });
    const appended = await learningLosslessArchiveService.commitCapture({
      claim: appendRegistration.claim,
      runId: fixture.runId,
      expectedCursor: original.length,
      checkpointCursorAfter: original.length + append.length,
      baseVersionId: fixture.jsonlVersionId,
      capture: appendedCapture,
    });
    const expectedAppended = Buffer.concat([original, append]);
    const restoredAppended =
      await learningLosslessArchiveService.restoreVersion(appended.versionId);
    if (
      sha256(restoredAppended) !== sha256(expectedAppended) ||
      restoredAppended.length !== expectedAppended.length
    )
      throw new Error("Appended archive proof mismatch");
    const appendedCheckpoint =
      await learningLosslessArchiveService.getCheckpoint(fixture.jsonlSourceId);
    const appendedVersions = await learningLosslessArchiveService.listVersions(
      fixture.jsonlSourceId,
    );
    if (
      appendedCheckpoint?.cursorOffset !== expectedAppended.length ||
      new Set(appendedVersions.map(({ versionId }) => versionId)).size !==
        appendedVersions.length ||
      !appendedVersions.some(
        ({ versionId }) => versionId === fixture.jsonlVersionId,
      ) ||
      !appendedVersions.some(
        ({ versionId }) => versionId === appended.versionId,
      )
    ) {
      throw new Error(
        "Append replay produced a cursor gap or duplicate logical version",
      );
    }

    const rewritten = Buffer.from(expectedAppended);
    rewritten[0] = rewritten[0] === 0x20 ? 0x21 : 0x20;
    await writeFile(fixture.jsonlPath, rewritten);
    let sameSizeRewriteDetected = false;
    try {
      await verifyOpaquePrefix(fixture.jsonlPath, {
        approvedRoot: fixture.root,
        length: expectedAppended.length,
        sha256: sha256(expectedAppended),
      });
    } catch {
      sameSizeRewriteDetected = true;
    }
    if (!sameSizeRewriteDetected)
      throw new Error("Same-size prefix rewrite was not detected");

    await writeFile(fixture.jsonlPath, rewritten.subarray(0, 17));
    let truncationDetected = false;
    try {
      await verifyOpaquePrefix(fixture.jsonlPath, {
        approvedRoot: fixture.root,
        length: expectedAppended.length,
        sha256: sha256(expectedAppended),
      });
    } catch {
      truncationDetected = true;
    }
    if (!truncationDetected)
      throw new Error("Source truncation was not detected");
    await writeFile(fixture.jsonlPath, rewritten);

    const rotatedPath = join(fixture.root, "events.rotated.jsonl");
    await rename(fixture.jsonlPath, rotatedPath);
    await writeFile(fixture.jsonlPath, rewritten, { flag: "wx", mode: 0o600 });
    const replacementRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: fixture.jsonlPath,
        relativePath: "events.jsonl",
        provider: "codex",
        fileKind: "jsonl",
      },
    );
    if (
      replacementRegistration.source.generation <=
      appendRegistration.source.generation
    )
      throw new Error("Path replacement did not open a new source generation");
    const replacement = await commitComplete(
      learningLosslessArchiveService,
      fixture.runId,
      fixture.root,
      fixture.jsonlPath,
      replacementRegistration,
    );

    const raceRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: fixture.binaryPath,
        relativePath: "attachment.bin",
        provider: "claude",
        fileKind: "attachment",
      },
    );
    const concurrent = await learningLosslessArchiveService.claimSource({
      sourceId: raceRegistration.source.sourceId,
      generation: raceRegistration.source.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (concurrent !== null)
      throw new Error("Concurrent worker acquired an already-held source");
    await learningLosslessArchiveService.releaseClaim(raceRegistration.claim);
    const newClaim = await learningLosslessArchiveService.claimSource({
      sourceId: raceRegistration.source.sourceId,
      generation: raceRegistration.source.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (!newClaim)
      throw new Error("Replacement worker could not acquire released source");
    await writeFile(fixture.binaryPath, Buffer.from([0x7f]), { flag: "a" });
    const staleCapture = await captureOpaqueRange(fixture.binaryPath, {
      approvedRoot: fixture.root,
      offset: fixture.binaryLength,
      length: 1,
    });
    let staleRejected = false;
    try {
      await learningLosslessArchiveService.commitCapture({
        claim: raceRegistration.claim,
        runId: fixture.runId,
        expectedCursor: fixture.binaryLength,
        checkpointCursorAfter: fixture.binaryLength + 1,
        baseVersionId: fixture.binaryVersionId,
        capture: staleCapture,
      });
    } catch {
      staleRejected = true;
    }
    if (!staleRejected) throw new Error("Stale worker commit was accepted");
    await learningLosslessArchiveService.releaseClaim(newClaim);

    const recoveryPath = join(fixture.root, "recovery.bin");
    await writeFile(
      recoveryPath,
      fixtureBinary(`${fixture.fixtureId}-recovery`),
      { flag: "wx", mode: 0o600 },
    );
    const recoveryRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: recoveryPath,
        relativePath: "recovery.bin",
        provider: "codex",
        fileKind: "other",
      },
    );
    const recoveryCapture = await captureOpaqueFile(recoveryPath, {
      approvedRoot: fixture.root,
    });
    const interrupted = new LearningLosslessArchiveService(kysely, {
      afterBlobWrite: () => {
        throw new Error("synthetic crash after blob write");
      },
    });
    let interruptedRejected = false;
    try {
      await interrupted.commitCapture({
        claim: recoveryRegistration.claim,
        runId: fixture.runId,
        expectedCursor: 0,
        checkpointCursorAfter: recoveryCapture.rawLength,
        capture: recoveryCapture,
      });
    } catch {
      interruptedRejected = true;
    }
    if (
      !interruptedRejected ||
      (
        await learningLosslessArchiveService.getCheckpoint(
          recoveryRegistration.source.sourceId,
        )
      )?.cursorOffset !== 0
    ) {
      throw new Error("Interrupted commit advanced its checkpoint");
    }
    const recovered = await learningLosslessArchiveService.commitCapture({
      claim: recoveryRegistration.claim,
      runId: fixture.runId,
      expectedCursor: 0,
      checkpointCursorAfter: recoveryCapture.rawLength,
      capture: recoveryCapture,
    });
    const recoveredBytes = await learningLosslessArchiveService.restoreVersion(
      recovered.versionId,
    );
    if (sha256(recoveredBytes) !== recoveryCapture.rawSha256)
      throw new Error("Interrupted capture did not recover exactly");
    const recoveredCheckpoint =
      await learningLosslessArchiveService.getCheckpoint(
        recoveryRegistration.source.sourceId,
      );
    const recoveredVersions = await learningLosslessArchiveService.listVersions(
      recoveryRegistration.source.sourceId,
    );
    if (
      recoveredCheckpoint?.cursorOffset !== recoveryCapture.rawLength ||
      recoveredVersions.length !== 1 ||
      recoveredVersions[0]?.versionId !== recovered.versionId
    ) {
      throw new Error(
        "Interrupted recovery left a cursor gap or duplicate logical version",
      );
    }

    const corruptedCapture: CapturedArchiveBytes = {
      ...recoveryCapture,
      chunks: recoveryCapture.chunks.map((chunk, index) =>
        index
          ? chunk
          : {
              ...chunk,
              encodedBytes: new Uint8Array(gzipSync(Buffer.from("corrupt"))),
            },
      ),
    };
    let compressionRejected = false;
    const corruptionRegistration = await registerAndClaim(
      learningLosslessArchiveService,
      {
        ...fixture,
        path: recoveryPath,
        relativePath: "recovery.bin",
        provider: "codex",
        fileKind: "other",
      },
    );
    try {
      await learningLosslessArchiveService.commitCapture({
        claim: corruptionRegistration.claim,
        runId: fixture.runId,
        expectedCursor: recoveryCapture.rawLength,
        checkpointCursorAfter: recoveryCapture.rawLength,
        capture: corruptedCapture,
      });
    } catch {
      compressionRejected = true;
    }
    if (!compressionRejected)
      throw new Error("Corrupted compressed bytes were accepted");
    await learningLosslessArchiveService.releaseClaim(
      corruptionRegistration.claim,
    );

    const missing = await learningLosslessArchiveService.registerSource({
      host: `lossless-proof-${fixture.fixtureId}`,
      provider: "claude",
      rootPath: fixture.root,
      relativePath: "missing-attachment.bin",
      fileKind: "attachment",
      observedAt: now(),
      metadata: { syntheticProof: true, fixtureId: fixture.fixtureId },
    });
    const missingClaim = await learningLosslessArchiveService.claimSource({
      sourceId: missing.sourceId,
      generation: missing.generation,
      ownerId: randomUUID(),
      leaseMs: 60_000,
    });
    if (
      !missingClaim ||
      !(await learningLosslessArchiveService.failCapture({
        claim: missingClaim,
        runId: fixture.runId,
        errorCode: "missing-attachment",
        errorMessage: "Synthetic referenced attachment was unavailable",
        retryable: false,
        isGap: true,
      }))
    ) {
      throw new Error("Missing attachment did not persist an explicit gap");
    }

    const vanishingPath = join(fixture.root, "vanishing.bin");
    await writeFile(vanishingPath, Buffer.from("delete-before-capture"), {
      flag: "wx",
      mode: 0o600,
    });
    const vanishing = await registerAndClaim(learningLosslessArchiveService, {
      ...fixture,
      path: vanishingPath,
      relativePath: "vanishing.bin",
      provider: "claude",
      fileKind: "attachment",
    });
    await rm(vanishingPath);
    let deletionBeforeCaptureGap = false;
    try {
      await captureOpaqueFile(vanishingPath, { approvedRoot: fixture.root });
    } catch {
      deletionBeforeCaptureGap =
        await learningLosslessArchiveService.failCapture({
          claim: vanishing.claim,
          runId: fixture.runId,
          errorCode: "deleted-before-capture",
          errorMessage:
            "Synthetic source disappeared after discovery and before capture",
          retryable: false,
          isGap: true,
        });
    }
    if (!deletionBeforeCaptureGap)
      throw new Error(
        "Deletion before capture did not persist an explicit gap",
      );

    await rm(fixture.binaryPath);
    const afterDeletion = await learningLosslessArchiveService.restoreVersion(
      fixture.binaryVersionId,
    );
    if (sha256(afterDeletion) !== fixture.binarySha256)
      throw new Error("Source deletion invalidated an archived version");
    const oldJsonl = await learningLosslessArchiveService.restoreVersion(
      fixture.jsonlVersionId,
    );
    if (sha256(oldJsonl) !== fixture.jsonlSha256)
      throw new Error("Mutation invalidated the old JSONL version");

    return {
      ...fixture,
      appendedVersionId: appended.versionId,
      replacementVersionId: replacement.committed.versionId,
      recoveryVersionId: recovered.versionId,
      recoverySourceId: recoveryRegistration.source.sourceId,
      missingSourceId: missing.sourceId,
      vanishingSourceId: vanishing.source.sourceId,
      sameSizeRewriteDetected: true as const,
      truncationDetected: true as const,
      oldVersionsPreserved: true as const,
      sourceDeletedAfterCapture: true as const,
      staleWorkerCommits: 0 as const,
      cursorGaps: 0 as const,
      duplicateLogicalVersions: 0 as const,
      explicitGaps: 2,
      deletionBeforeCaptureGap: true as const,
      compressionFailuresDetected: 1,
      interruptedCommitsRecovered: 1,
      versionsSealed: fixture.versionsSealed + 3,
      exactByteMatches: fixture.exactByteMatches + 3,
    };
  },
});

export const finishLearningLosslessArchiveProofStep = defineSessionlessFunction({
  title: "Publish bounded lossless archive proof evidence",
  input: FinishLearningLosslessArchiveProofStepInput,
  output: FinishLearningLosslessArchiveProofStepOutput,
  func: async ({ learningLosslessArchiveService }, proof) => {
    const cases = [
      "jsonl-byte-fidelity",
      "chunk-spanning-binary",
      "sqlite-wal-logical-snapshot",
      "deduplicated-occurrences",
      "mutation-version-preservation",
      "concurrent-fencing",
      "interrupted-commit-recovery",
      "compression-corruption-refusal",
      "missing-and-deleted-source",
      "truncation-detection",
      "deletion-before-capture-gap",
    ] as const;
    const fixtureSourceIds = new Set([
      proof.jsonlSourceId,
      proof.binarySourceId,
      proof.duplicateSourceId,
      proof.sqliteSourceId,
      proof.recoverySourceId,
      proof.missingSourceId,
      proof.vanishingSourceId,
    ]);
    const fixtureVersions = (
      await Promise.all(
        [...fixtureSourceIds].map((sourceId) =>
          learningLosslessArchiveService.listVersions(sourceId, 500),
        ),
      )
    ).flat();
    const capturedSourceCount = new Set(
      fixtureVersions.map((version) => version.sourceId),
    ).size;
    const measuredRawBytes = fixtureVersions.reduce(
      (sum, version) => sum + version.capturedByteLength,
      0,
    );
    if (fixtureVersions.length !== proof.versionsSealed)
      throw new Error(
        `Persisted proof version count ${fixtureVersions.length} did not match ${proof.versionsSealed}`,
      );
    const output = {
      runId: proof.runId,
      fixtureId: proof.fixtureId,
      status: "completed" as const,
      completedAt: new Date().toISOString(),
      cases: [...cases],
      casesPassed: cases.length,
      exactByteMatches: proof.exactByteMatches,
      versionsSealed: proof.versionsSealed,
      oldVersionsPreserved: proof.oldVersionsPreserved,
      sourceDeletedAfterCapture: proof.sourceDeletedAfterCapture,
      sqliteIntegrity: proof.sqliteIntegrity,
      sameSizeRewriteDetected: proof.sameSizeRewriteDetected,
      truncationDetected: proof.truncationDetected,
      staleWorkerCommits: proof.staleWorkerCommits,
      cursorGaps: proof.cursorGaps,
      duplicateLogicalVersions: proof.duplicateLogicalVersions,
      explicitGaps: proof.explicitGaps,
      deletionBeforeCaptureGap: proof.deletionBeforeCaptureGap,
      deduplicatedBytes: proof.deduplicatedBytes,
      compressionFailuresDetected: proof.compressionFailuresDetected,
      interruptedCommitsRecovered: proof.interruptedCommitsRecovered,
      limitations: [
        "Polling cannot prove capture of transient versions between observations",
        "SQLite proof is a transactionally consistent logical snapshot; physical DB/WAL identity is not claimed",
        "Database outage and PostgreSQL backup restore require separate isolated integration rehearsals",
        "The synthetic workflow has no provider or LLM dependency, but runtime call-count instrumentation is not installed, so zero external calls are not claimed",
        "Unreadable-file behavior requires an isolated non-root process because the development API runs as root",
        "Seed V1 preservation needs a frozen-table hash captured before and after an isolated rehearsal",
      ],
    };
    await learningLosslessArchiveService.finishRun(proof.runId, {
      status: "completed",
      summary: "Synthetic lossless archive proof passed",
      result: output,
      sourcesDiscovered: fixtureSourceIds.size,
      sourcesCaptured: capturedSourceCount,
      versionsSealed: fixtureVersions.length,
      gapsRecorded: output.explicitGaps,
      bytesRead: measuredRawBytes,
      rawBytesStored: measuredRawBytes,
      deduplicatedBytes: proof.deduplicatedBytes,
    });
    await rm(proof.root, { recursive: true, force: true });
    return output;
  },
});
