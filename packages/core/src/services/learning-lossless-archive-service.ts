import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { gunzipSync } from "node:zlib";

import { sql, type Kysely, type Transaction } from "kysely";

import type { DB } from "../types/db.types.js";

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_RESTORE_LIMIT = 64 * 1024 * 1024;
const RESTORE_PAGE_SIZE = 32;

export type ArchiveProvider =
  | "codex"
  | "claude"
  | "agy"
  | "antigravity"
  | "openai"
  | "anthropic"
  | "google"
  | "openclaw";
export type ArchiveFileKind =
  | "jsonl"
  | "sqlite"
  | "sqlite-wal"
  | "sqlite-journal"
  | "attachment"
  | "sidecar"
  | "other";

export type CapturedArchiveChunk = {
  ordinal: number;
  offset: number;
  rawLength: number;
  rawSha256: string;
  codec: "gzip";
  codecVersion: "rfc1952";
  encodedLength: number;
  encodedSha256: string;
  encodedBytes: Uint8Array;
};

export type CapturedArchiveBytes = {
  captureKind: "opaque-complete" | "opaque-range" | "sqlite-logical-snapshot";
  consistency: "stable-file" | "stable-prefix" | "logical-sqlite-snapshot";
  coverage: "complete" | "prefix";
  source: {
    deviceId: string;
    inodeId: string;
    mode: number;
    size: number;
    mtimeNs: string;
    ctimeNs: string;
  };
  captureStartedAt: string;
  captureEndedAt: string;
  offset: number;
  rawLength: number;
  rawSha256: string;
  chunks: CapturedArchiveChunk[];
  limitations: string[];
};

export type RegisterSourceInput = {
  host: string;
  provider: ArchiveProvider;
  rootPath: string;
  relativePath: string;
  fileKind: ArchiveFileKind;
  deviceId?: string | null;
  inodeId?: string | null;
  sourceSize?: number | null;
  sourceMtimeNs?: string | null;
  sourceCtimeNs?: string | null;
  observedAt: string;
  metadata?: Record<string, unknown>;
};

export type ArchiveSourceRecord = {
  sourceId: string;
  host: string;
  provider: string;
  rootPath: string;
  relativePath: string;
  fileKind: string;
  deviceId: string | null;
  inodeId: string | null;
  generation: number;
  discoveryState: string;
  sourceSize: number | null;
  fencingToken: number;
  leaseExpiresAt: string | null;
};

export type ArchiveCheckpoint = {
  sourceId: string;
  generation: number;
  cursorOffset: number;
  lastVersionNumber: number;
  lastVerifiedVersionId: string | null;
  recoveryState: string;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
};

export type ArchiveClaim = {
  sourceId: string;
  generation: number;
  ownerId: string;
  claimToken: string;
  fencingToken: number;
  leaseExpiresAt: string;
};

export type ArchiveRunMetrics = {
  sourcesDiscovered?: number;
  sourcesCaptured?: number;
  versionsSealed?: number;
  gapsRecorded?: number;
  errorsRecorded?: number;
  bytesRead?: number;
  rawBytesStored?: number;
  encodedBytesStored?: number;
  deduplicatedBytes?: number;
};

export type ArchiveStorageTestHooks = {
  /** Synthetic probe hook. Production service construction must omit this. */
  afterBlobWrite?: () => void | Promise<void>;
};

export type ArchiveRunRecord = ArchiveRunMetrics & {
  runId: string;
  runKind: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  summary: string | null;
  result: unknown;
};

export type ArchiveVersionRecord = {
  versionId: string;
  sourceId: string;
  generation: number;
  versionNumber: number;
  baseVersionId: string | null;
  captureKind: string;
  consistencyStatus: string;
  coverageStatus: string;
  byteOffset: number;
  capturedByteLength: number;
  aggregateSha256: string;
  captureStartedAt: string;
  captureEndedAt: string;
  manifestStatus: string;
};

type VerifiedChunk = CapturedArchiveChunk & { rawBytes: Buffer };
type DbExecutor = Kysely<DB> | Transaction<DB>;

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const normalizeHexDigest = (digest: string, label: string): string => {
  const normalized = digest.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized))
    throw new Error(`${label} must be a 64-character SHA-256 hex digest`);
  return normalized;
};

const asSafeNumber = (
  value: string | number | bigint | null,
  label: string,
): number => {
  if (value === null) throw new Error(`${label} is absent`);
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`${label} is outside JavaScript's safe integer range`);
  return number;
};

const iso = (value: Date | string | null): string | null =>
  value === null
    ? null
    : value instanceof Date
      ? value.toISOString()
      : new Date(value).toISOString();

const validatePathIdentity = ({
  host,
  rootPath,
  relativePath,
}: RegisterSourceInput): void => {
  if (!host.trim()) throw new Error("Archive source host must not be empty");
  if (!isAbsolute(rootPath))
    throw new Error("Archive source rootPath must be absolute");
  if (
    !relativePath ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..") ||
    relativePath.includes("\0")
  ) {
    throw new Error(
      "Archive source relativePath must stay beneath its approved root",
    );
  }
};

export const verifyCapturedArchiveBytes = (
  capture: CapturedArchiveBytes,
): VerifiedChunk[] => {
  const aggregate = createHash("sha256");
  let expectedOffset = capture.offset;
  let total = 0;
  const verified = capture.chunks.map((chunk, index) => {
    if (chunk.codec !== "gzip" || chunk.codecVersion !== "rfc1952")
      throw new Error(`Archive chunk ${index} uses an unsupported codec`);
    if (chunk.ordinal !== index)
      throw new Error(`Archive chunk ordinal gap at ${index}`);
    if (chunk.offset !== expectedOffset)
      throw new Error(`Archive chunk offset gap at ordinal ${index}`);
    if (
      !Number.isSafeInteger(chunk.rawLength) ||
      chunk.rawLength <= 0 ||
      chunk.rawLength > MAX_CHUNK_BYTES
    ) {
      throw new Error(
        `Archive chunk ${index} exceeds the ${MAX_CHUNK_BYTES}-byte bound`,
      );
    }
    if (chunk.encodedLength !== chunk.encodedBytes.byteLength)
      throw new Error(`Archive chunk ${index} encoded length mismatch`);
    if (
      sha256(chunk.encodedBytes) !==
      normalizeHexDigest(
        chunk.encodedSha256,
        `Archive chunk ${index} encoded digest`,
      )
    ) {
      throw new Error(`Archive chunk ${index} encoded digest mismatch`);
    }
    let rawBytes: Buffer;
    try {
      rawBytes = gunzipSync(chunk.encodedBytes);
    } catch (error) {
      throw new Error(
        `Archive chunk ${index} gzip verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (rawBytes.byteLength !== chunk.rawLength)
      throw new Error(`Archive chunk ${index} raw length mismatch`);
    if (
      sha256(rawBytes) !==
      normalizeHexDigest(chunk.rawSha256, `Archive chunk ${index} raw digest`)
    ) {
      throw new Error(`Archive chunk ${index} raw digest mismatch`);
    }
    aggregate.update(rawBytes);
    expectedOffset += rawBytes.byteLength;
    total += rawBytes.byteLength;
    return {
      ...chunk,
      rawSha256: chunk.rawSha256.toLowerCase(),
      encodedSha256: chunk.encodedSha256.toLowerCase(),
      rawBytes,
    };
  });
  if (total !== capture.rawLength)
    throw new Error("Archive capture raw length does not equal its chunks");
  if (
    aggregate.digest("hex") !==
    normalizeHexDigest(capture.rawSha256, "Archive capture aggregate digest")
  ) {
    throw new Error("Archive capture aggregate digest mismatch");
  }
  return verified;
};

const sourceRow = (row: {
  sourceId: string;
  host: string;
  provider: string;
  rootPath: string;
  relativePath: string;
  fileKind: string;
  deviceId: string | number | bigint | null;
  inodeId: string | number | bigint | null;
  generation: number;
  discoveryState: string;
  sourceSize: string | number | bigint | null;
  fencingToken: string | number | bigint;
  leaseExpiresAt: Date | string | null;
}): ArchiveSourceRecord => ({
  ...row,
  deviceId: row.deviceId === null ? null : String(row.deviceId),
  inodeId: row.inodeId === null ? null : String(row.inodeId),
  sourceSize:
    row.sourceSize === null
      ? null
      : asSafeNumber(row.sourceSize, "source size"),
  fencingToken: asSafeNumber(row.fencingToken, "fencing token"),
  leaseExpiresAt: iso(row.leaseExpiresAt),
});

const checkpointRow = (row: {
  sourceId: string;
  generation: number;
  cursorOffset: string | number | bigint;
  lastVersionNumber: string | number | bigint;
  lastVerifiedVersionId: string | null;
  recoveryState: string;
  lastSuccessAt: Date | string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
}): ArchiveCheckpoint => ({
  ...row,
  cursorOffset: asSafeNumber(row.cursorOffset, "checkpoint cursor"),
  lastVersionNumber: asSafeNumber(
    row.lastVersionNumber,
    "checkpoint version number",
  ),
  lastSuccessAt: iso(row.lastSuccessAt),
});

const mapVersion = (row: {
  versionId: string;
  sourceId: string;
  generation: number;
  versionNumber: string | number | bigint;
  baseVersionId: string | null;
  captureKind: string;
  consistencyStatus: string;
  coverageStatus: string;
  byteOffset: string | number | bigint;
  capturedByteLength: string | number | bigint;
  aggregateSha256: string;
  captureStartedAt: Date | string;
  captureEndedAt: Date | string;
  manifestStatus: string;
}): ArchiveVersionRecord => ({
  ...row,
  versionNumber: asSafeNumber(row.versionNumber, "version number"),
  byteOffset: asSafeNumber(row.byteOffset, "version byte offset"),
  capturedByteLength: asSafeNumber(
    row.capturedByteLength,
    "captured byte length",
  ),
  captureStartedAt: iso(row.captureStartedAt)!,
  captureEndedAt: iso(row.captureEndedAt)!,
});

export class LearningLosslessArchiveService {
  constructor(
    private readonly kysely: Kysely<DB>,
    private readonly testHooks: ArchiveStorageTestHooks = {},
  ) {}

  async registerSource(
    input: RegisterSourceInput,
  ): Promise<ArchiveSourceRecord> {
    validatePathIdentity(input);
    const observedAt = new Date(input.observedAt);
    if (Number.isNaN(observedAt.valueOf()))
      throw new Error("Archive source observedAt must be an ISO timestamp");
    return this.kysely.transaction().execute(async (trx) => {
      const proposedSourceId = randomUUID();
      await sql`
        INSERT INTO learning_archive_sources (
          source_id, host, provider, root_path, relative_path, file_kind,
          device_id, inode_id, generation, generation_reason, discovery_state, source_size,
          source_mtime_ns, source_ctime_ns, first_observed_at, last_observed_at, metadata
        ) VALUES (
          ${proposedSourceId}::uuid, ${input.host}, ${input.provider}, ${input.rootPath}, ${input.relativePath}, ${input.fileKind},
          ${input.deviceId ?? null}, ${input.inodeId ?? null}, 0, 'first-observation', 'discovered', ${input.sourceSize ?? null},
          ${input.sourceMtimeNs ?? null}, ${input.sourceCtimeNs ?? null}, ${input.observedAt}::timestamptz,
          ${input.observedAt}::timestamptz, ${JSON.stringify(input.metadata ?? {})}::jsonb
        ) ON CONFLICT (host, provider, root_path, relative_path) DO NOTHING
      `.execute(trx);
      const locked = await sql<{
        sourceId: string;
        deviceId: string | null;
        inodeId: string | null;
        generation: number;
      }>`
        SELECT source_id AS "sourceId", device_id AS "deviceId", inode_id AS "inodeId", generation
          FROM learning_archive_sources
         WHERE host = ${input.host} AND provider = ${input.provider}
           AND root_path = ${input.rootPath} AND relative_path = ${input.relativePath}
         FOR UPDATE
      `.execute(trx);
      const prior = locked.rows[0];
      const identityChanged =
        Boolean(prior) &&
        prior!.deviceId !== null &&
        prior!.inodeId !== null &&
        input.deviceId != null &&
        input.inodeId != null &&
        (String(prior!.deviceId) !== input.deviceId ||
          String(prior!.inodeId) !== input.inodeId);
      if (!prior)
        throw new Error("Archive source registration lost its identity row");
      const generation = prior.generation + (identityChanged ? 1 : 0);
      const sourceId = prior.sourceId;
      await sql`
        UPDATE learning_archive_sources SET
          file_kind = ${input.fileKind}, device_id = ${input.deviceId ?? null}, inode_id = ${input.inodeId ?? null},
          generation = ${generation},
          generation_reason = CASE WHEN generation <> ${generation} THEN 'identity-change' ELSE generation_reason END,
          discovery_state = CASE
            WHEN generation = ${generation} AND lease_token IS NOT NULL AND lease_expires_at > NOW()
              THEN discovery_state
            ELSE 'discovered'
          END,
          source_size = ${input.sourceSize ?? null},
          source_mtime_ns = ${input.sourceMtimeNs ?? null}, source_ctime_ns = ${input.sourceCtimeNs ?? null},
          last_observed_at = ${input.observedAt}::timestamptz, metadata = metadata || ${JSON.stringify(input.metadata ?? {})}::jsonb,
          lease_owner = CASE WHEN generation <> ${generation} THEN NULL ELSE lease_owner END,
          lease_token = CASE WHEN generation <> ${generation} THEN NULL ELSE lease_token END,
          lease_expires_at = CASE WHEN generation <> ${generation} THEN NULL ELSE lease_expires_at END,
          updated_at = NOW()
        WHERE source_id = ${sourceId}::uuid
      `.execute(trx);
      await sql`
        INSERT INTO learning_archive_checkpoints (source_id, generation)
        VALUES (${sourceId}::uuid, ${generation}) ON CONFLICT DO NOTHING
      `.execute(trx);
      const stored = await this.getSourceFrom(trx, sourceId);
      if (!stored)
        throw new Error(`Archive source ${sourceId} was not persisted`);
      return stored;
    });
  }

  private async getSourceFrom(
    db: DbExecutor,
    sourceId: string,
  ): Promise<ArchiveSourceRecord | undefined> {
    const result = await sql<any>`
      SELECT source_id AS "sourceId", host, provider, root_path AS "rootPath", relative_path AS "relativePath",
             file_kind AS "fileKind", device_id AS "deviceId", inode_id AS "inodeId", generation,
             discovery_state AS "discoveryState", source_size AS "sourceSize", fencing_token AS "fencingToken",
             lease_expires_at AS "leaseExpiresAt"
        FROM learning_archive_sources WHERE source_id = ${sourceId}::uuid
    `.execute(db);
    return result.rows[0] ? sourceRow(result.rows[0]) : undefined;
  }

  async getSource(sourceId: string): Promise<ArchiveSourceRecord | undefined> {
    return this.getSourceFrom(this.kysely, sourceId);
  }

  async getCheckpoint(
    sourceId: string,
    generation?: number,
  ): Promise<ArchiveCheckpoint | undefined> {
    const generationClause =
      generation === undefined
        ? sql`c.generation = s.generation`
        : sql`c.generation = ${generation}`;
    const result = await sql<any>`
      SELECT c.source_id AS "sourceId", c.generation, c.cursor_offset AS "cursorOffset",
             c.last_version_number AS "lastVersionNumber", c.last_verified_version_id AS "lastVerifiedVersionId",
             c.recovery_state AS "recoveryState", c.last_success_at AS "lastSuccessAt",
             c.last_error_code AS "lastErrorCode", c.last_error_message AS "lastErrorMessage"
        FROM learning_archive_checkpoints c
        JOIN learning_archive_sources s ON s.source_id = c.source_id
       WHERE c.source_id = ${sourceId}::uuid AND ${generationClause}
    `.execute(this.kysely);
    return result.rows[0] ? checkpointRow(result.rows[0]) : undefined;
  }

  async openGeneration({
    sourceId,
    expectedGeneration,
    reason,
    source,
  }: {
    sourceId: string;
    expectedGeneration: number;
    reason:
      | "replacement"
      | "truncation"
      | "prefix-rewrite"
      | "same-size-rewrite"
      | "manual-recovery";
    source: CapturedArchiveBytes["source"];
  }): Promise<ArchiveSourceRecord> {
    return this.kysely.transaction().execute(async (trx) => {
      const next = await sql<{ generation: number }>`
        UPDATE learning_archive_sources
           SET generation = generation + 1, device_id = ${source.deviceId}, inode_id = ${source.inodeId},
               source_size = ${source.size}, source_mtime_ns = ${source.mtimeNs}, source_ctime_ns = ${source.ctimeNs},
               generation_reason = ${reason}, discovery_state = 'discovered',
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE source_id = ${sourceId}::uuid AND generation = ${expectedGeneration}
         RETURNING generation
      `.execute(trx);
      const generation = next.rows[0]?.generation;
      if (generation === undefined)
        throw new Error(
          `Archive source ${sourceId} generation changed concurrently`,
        );
      await sql`
        INSERT INTO learning_archive_checkpoints (source_id, generation)
        VALUES (${sourceId}::uuid, ${generation})
      `.execute(trx);
      const stored = await this.getSourceFrom(trx, sourceId);
      if (!stored)
        throw new Error(
          `Archive source ${sourceId} disappeared while opening a generation`,
        );
      return stored;
    });
  }

  async listSources({
    state,
    limit = 100,
  }: { state?: string; limit?: number } = {}): Promise<ArchiveSourceRecord[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const stateClause = state ? sql`AND discovery_state = ${state}` : sql``;
    const result = await sql<any>`
      SELECT source_id AS "sourceId", host, provider, root_path AS "rootPath", relative_path AS "relativePath",
             file_kind AS "fileKind", device_id AS "deviceId", inode_id AS "inodeId", generation,
             discovery_state AS "discoveryState", source_size AS "sourceSize", fencing_token AS "fencingToken",
             lease_expires_at AS "leaseExpiresAt"
        FROM learning_archive_sources
       WHERE 1 = 1 ${stateClause}
       ORDER BY last_success_at NULLS FIRST, last_observed_at, source_id
       LIMIT ${boundedLimit}
    `.execute(this.kysely);
    return result.rows.map(sourceRow);
  }

  async claimSource({
    sourceId,
    generation,
    ownerId,
    leaseMs,
  }: {
    sourceId: string;
    generation: number;
    ownerId: string;
    leaseMs: number;
  }): Promise<ArchiveClaim | null> {
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1_000 ||
      leaseMs > 3_600_000
    )
      throw new Error("Archive lease must be 1 second to 1 hour");
    const claimToken = randomUUID();
    const result = await sql<any>`
      UPDATE learning_archive_sources
         SET lease_owner = ${ownerId}::uuid, lease_token = ${claimToken}::uuid,
             lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'),
             fencing_token = fencing_token + 1, discovery_state = 'capturing', updated_at = NOW()
       WHERE source_id = ${sourceId}::uuid AND generation = ${generation}
         AND (lease_token IS NULL OR lease_expires_at <= NOW())
       RETURNING fencing_token AS "fencingToken", lease_expires_at AS "leaseExpiresAt"
    `.execute(this.kysely);
    const row = result.rows[0];
    return row
      ? {
          sourceId,
          generation,
          ownerId,
          claimToken,
          fencingToken: asSafeNumber(row.fencingToken, "fencing token"),
          leaseExpiresAt: iso(row.leaseExpiresAt)!,
        }
      : null;
  }

  async renewClaim(
    claim: ArchiveClaim,
    leaseMs: number,
  ): Promise<ArchiveClaim> {
    if (
      !Number.isSafeInteger(leaseMs) ||
      leaseMs < 1_000 ||
      leaseMs > 3_600_000
    )
      throw new Error("Archive lease must be 1 second to 1 hour");
    const result = await sql<any>`
      UPDATE learning_archive_sources
         SET lease_expires_at = NOW() + (${leaseMs} * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
         AND lease_owner = ${claim.ownerId}::uuid AND lease_token = ${claim.claimToken}::uuid
         AND fencing_token = ${claim.fencingToken} AND lease_expires_at > NOW()
       RETURNING lease_expires_at AS "leaseExpiresAt"
    `.execute(this.kysely);
    if (!result.rows[0])
      throw new Error(`Archive source ${claim.sourceId} lost its claim lease`);
    return { ...claim, leaseExpiresAt: iso(result.rows[0].leaseExpiresAt)! };
  }

  async releaseClaim(claim: ArchiveClaim): Promise<boolean> {
    const result = await sql`
      UPDATE learning_archive_sources
         SET lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
             discovery_state = CASE WHEN discovery_state = 'capturing' THEN 'discovered' ELSE discovery_state END,
             updated_at = NOW()
       WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
         AND lease_token = ${claim.claimToken}::uuid AND fencing_token = ${claim.fencingToken}
    `.execute(this.kysely);
    return Number(result.numAffectedRows ?? 0) === 1;
  }

  async createRun({
    runId = randomUUID(),
    runKind,
    metadata = {},
  }: {
    runId?: string;
    runKind: "scheduled" | "backfill" | "recovery" | "probe" | "e2e";
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const result = await sql<{ runId: string }>`
      INSERT INTO learning_archive_runs (run_id, run_kind, metadata)
      VALUES (${runId}::uuid, ${runKind}, ${JSON.stringify(metadata)}::jsonb)
      ON CONFLICT (run_id) DO UPDATE SET run_id = EXCLUDED.run_id
      RETURNING run_id AS "runId"
    `.execute(this.kysely);
    return result.rows[0]!.runId;
  }

  async updateRunMetadata(
    runId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const result = await sql`
      UPDATE learning_archive_runs SET metadata = metadata || ${JSON.stringify(metadata)}::jsonb, updated_at = NOW()
      WHERE run_id = ${runId}::uuid AND status = 'running'
    `.execute(this.kysely);
    if (Number(result.numAffectedRows ?? 0) !== 1)
      throw new Error(`Archive run ${runId} is absent or no longer running`);
  }

  async getRun(runId: string): Promise<ArchiveRunRecord | undefined> {
    const result = await sql<any>`
      SELECT run_id AS "runId", run_kind AS "runKind", status, started_at AS "startedAt",
             completed_at AS "completedAt", sources_discovered AS "sourcesDiscovered",
             sources_captured AS "sourcesCaptured", versions_sealed AS "versionsSealed",
             gaps_recorded AS "gapsRecorded", errors_recorded AS "errorsRecorded", bytes_read AS "bytesRead",
             raw_bytes_stored AS "rawBytesStored", encoded_bytes_stored AS "encodedBytesStored",
             deduplicated_bytes AS "deduplicatedBytes", metadata, summary, result
        FROM learning_archive_runs WHERE run_id = ${runId}::uuid
    `.execute(this.kysely);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      ...row,
      startedAt: iso(row.startedAt)!,
      completedAt: iso(row.completedAt),
      sourcesDiscovered: asSafeNumber(
        row.sourcesDiscovered,
        "sources discovered",
      ),
      sourcesCaptured: asSafeNumber(row.sourcesCaptured, "sources captured"),
      versionsSealed: asSafeNumber(row.versionsSealed, "versions sealed"),
      gapsRecorded: asSafeNumber(row.gapsRecorded, "gaps recorded"),
      errorsRecorded: asSafeNumber(row.errorsRecorded, "errors recorded"),
      bytesRead: asSafeNumber(row.bytesRead, "bytes read"),
      rawBytesStored: asSafeNumber(row.rawBytesStored, "raw bytes stored"),
      encodedBytesStored: asSafeNumber(
        row.encodedBytesStored,
        "encoded bytes stored",
      ),
      deduplicatedBytes: asSafeNumber(
        row.deduplicatedBytes,
        "deduplicated bytes",
      ),
    };
  }

  async finishRun(
    runId: string,
    {
      status,
      summary = null,
      result = null,
      ...metrics
    }: ArchiveRunMetrics & {
      status: "partial" | "completed" | "failed";
      summary?: string | null;
      result?: unknown;
    },
  ): Promise<void> {
    const updated = await sql`
      UPDATE learning_archive_runs SET status = ${status}, summary = ${summary}, result = ${JSON.stringify(result)}::jsonb, completed_at = NOW(),
        sources_discovered = ${metrics.sourcesDiscovered ?? 0}, sources_captured = ${metrics.sourcesCaptured ?? 0},
        versions_sealed = ${metrics.versionsSealed ?? 0}, gaps_recorded = ${metrics.gapsRecorded ?? 0},
        errors_recorded = ${metrics.errorsRecorded ?? 0}, bytes_read = ${metrics.bytesRead ?? 0},
        raw_bytes_stored = ${metrics.rawBytesStored ?? 0}, encoded_bytes_stored = ${metrics.encodedBytesStored ?? 0},
        deduplicated_bytes = ${metrics.deduplicatedBytes ?? 0}, updated_at = NOW()
      WHERE run_id = ${runId}::uuid AND status = 'running'
    `.execute(this.kysely);
    if (Number(updated.numAffectedRows ?? 0) === 1) return;
    const existing = await this.getRun(runId);
    if (!existing || existing.status !== status)
      throw new Error(
        `Archive run ${runId} is absent or has a conflicting terminal status`,
      );
  }

  private async versionMetadata(
    versionId: string,
    db: DbExecutor = this.kysely,
  ): Promise<ArchiveVersionRecord | undefined> {
    const result = await sql<any>`
      SELECT version_id AS "versionId", source_id AS "sourceId", generation, version_number AS "versionNumber",
             base_version_id AS "baseVersionId", capture_kind AS "captureKind", consistency_status AS "consistencyStatus",
             coverage_status AS "coverageStatus", byte_offset AS "byteOffset", captured_byte_length AS "capturedByteLength",
             encode(aggregate_sha256, 'hex') AS "aggregateSha256", capture_started_at AS "captureStartedAt",
             capture_ended_at AS "captureEndedAt", manifest_status AS "manifestStatus"
        FROM learning_archive_versions WHERE version_id = ${versionId}::uuid
    `.execute(db);
    return result.rows[0] ? mapVersion(result.rows[0]) : undefined;
  }

  async listVersions(
    sourceId: string,
    limit = 100,
  ): Promise<ArchiveVersionRecord[]> {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const result = await sql<any>`
      SELECT version_id AS "versionId", source_id AS "sourceId", generation, version_number AS "versionNumber",
             base_version_id AS "baseVersionId", capture_kind AS "captureKind", consistency_status AS "consistencyStatus",
             coverage_status AS "coverageStatus", byte_offset AS "byteOffset", captured_byte_length AS "capturedByteLength",
             encode(aggregate_sha256, 'hex') AS "aggregateSha256", capture_started_at AS "captureStartedAt",
             capture_ended_at AS "captureEndedAt", manifest_status AS "manifestStatus"
        FROM learning_archive_versions WHERE source_id = ${sourceId}::uuid
       ORDER BY generation DESC, version_number DESC LIMIT ${boundedLimit}
    `.execute(this.kysely);
    return result.rows.map(mapVersion);
  }

  private async readChunkPage(
    versionId: string,
    afterOrdinal: number,
  ): Promise<
    Array<{
      ordinal: number;
      offset: number;
      rawLength: number;
      rawSha256: string;
      encodedLength: number;
      encodedSha256: string;
      codec: string;
      codecVersion: string;
      encodedBytes: Uint8Array;
    }>
  > {
    const result = await sql<any>`
      SELECT c.chunk_ordinal AS ordinal, c.byte_offset AS offset, c.raw_byte_length AS "rawLength",
             encode(c.blob_sha256, 'hex') AS "rawSha256", b.encoded_byte_length AS "encodedLength",
             encode(b.encoded_sha256, 'hex') AS "encodedSha256", b.codec, b.codec_version AS "codecVersion",
             b.encoded_bytes AS "encodedBytes"
        FROM learning_archive_version_chunks c
        JOIN learning_archive_blobs b ON b.sha256 = c.blob_sha256
       WHERE c.version_id = ${versionId}::uuid AND c.chunk_ordinal > ${afterOrdinal}
       ORDER BY c.chunk_ordinal LIMIT ${RESTORE_PAGE_SIZE}
    `.execute(this.kysely);
    return result.rows.map((row: any) => ({
      ...row,
      ordinal: asSafeNumber(row.ordinal, "chunk ordinal"),
      offset: asSafeNumber(row.offset, "chunk offset"),
      rawLength: asSafeNumber(row.rawLength, "chunk raw length"),
      encodedLength: asSafeNumber(row.encodedLength, "chunk encoded length"),
    }));
  }

  private async *verifiedVersionChunks(
    version: ArchiveVersionRecord,
    allowWriting = false,
  ): AsyncGenerator<Uint8Array> {
    if (
      version.manifestStatus !== "sealed" &&
      !(allowWriting && version.manifestStatus === "writing")
    ) {
      throw new Error(
        `Archive version ${version.versionId} is absent or unsealed`,
      );
    }
    const aggregate = createHash("sha256");
    let ordinal = 0;
    let offset = version.byteOffset;
    let total = 0;
    while (true) {
      const page = await this.readChunkPage(version.versionId, ordinal - 1);
      if (page.length === 0) break;
      for (const chunk of page) {
        const verified = verifyCapturedArchiveBytes({
          captureKind: "opaque-range",
          consistency: "stable-prefix",
          coverage: "prefix",
          source: {
            deviceId: "0",
            inodeId: "0",
            mode: 0,
            size: chunk.rawLength,
            mtimeNs: "0",
            ctimeNs: "0",
          },
          captureStartedAt: version.captureStartedAt,
          captureEndedAt: version.captureEndedAt,
          offset: chunk.offset,
          rawLength: chunk.rawLength,
          rawSha256: chunk.rawSha256,
          chunks: [
            { ...chunk, ordinal: 0, codec: "gzip", codecVersion: "rfc1952" },
          ],
          limitations: [],
        })[0]!;
        if (chunk.ordinal !== ordinal || chunk.offset !== offset)
          throw new Error(
            `Archive version ${version.versionId} has a chunk gap`,
          );
        aggregate.update(verified.rawBytes);
        total += verified.rawBytes.byteLength;
        offset += verified.rawBytes.byteLength;
        ordinal += 1;
        yield verified.rawBytes;
      }
      if (page.length < RESTORE_PAGE_SIZE) break;
    }
    if (
      total !== version.capturedByteLength ||
      aggregate.digest("hex") !== version.aggregateSha256
    ) {
      throw new Error(
        `Archive version ${version.versionId} aggregate verification failed`,
      );
    }
  }

  async *restoreVersionChunks(versionId: string): AsyncGenerator<Uint8Array> {
    const version = await this.versionMetadata(versionId);
    if (!version)
      throw new Error(`Archive version ${versionId} does not exist`);
    yield* this.verifiedVersionChunks(version);
  }

  async verifyVersion(
    versionId: string,
  ): Promise<{
    versionId: string;
    sha256: string;
    rawLength: number;
    chunkCount: number;
  }> {
    const version = await this.versionMetadata(versionId);
    if (!version)
      throw new Error(`Archive version ${versionId} does not exist`);
    let rawLength = 0;
    let chunkCount = 0;
    for await (const bytes of this.restoreVersionChunks(versionId)) {
      rawLength += bytes.byteLength;
      chunkCount += 1;
    }
    return {
      versionId,
      sha256: version.aggregateSha256,
      rawLength,
      chunkCount,
    };
  }

  async restoreVersion(
    versionId: string,
    maxBytes = DEFAULT_RESTORE_LIMIT,
  ): Promise<Buffer> {
    const version = await this.versionMetadata(versionId);
    if (!version)
      throw new Error(`Archive version ${versionId} does not exist`);
    if (version.capturedByteLength > maxBytes)
      throw new Error(
        `Archive version ${versionId} exceeds bounded restore limit ${maxBytes}`,
      );
    const chunks: Uint8Array[] = [];
    for await (const bytes of this.restoreVersionChunks(versionId))
      chunks.push(bytes);
    return Buffer.concat(chunks);
  }

  /** Restore one bounded byte range without materializing the whole version.
   * Callers proving whole-version parity should verifyVersion once before
   * consuming successive windows. Every selected blob is still independently
   * authenticated and decompressed here. */
  async restoreVersionWindow(
    versionId: string,
    offset: number,
    maxBytes: number,
  ): Promise<Buffer> {
    const maxWindowBytes = 16 * 1024 * 1024;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error(
        "Archive restore window offset must be a non-negative integer",
      );
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > maxWindowBytes
    ) {
      throw new Error(
        `Archive restore window must be between 1 and ${maxWindowBytes} bytes`,
      );
    }
    const version = await this.versionMetadata(versionId);
    if (!version)
      throw new Error(`Archive version ${versionId} does not exist`);
    if (version.manifestStatus !== "sealed")
      throw new Error(
        `Archive version ${version.versionId} is absent or unsealed`,
      );
    if (offset > version.capturedByteLength)
      throw new Error("Archive restore window offset exceeds version length");
    if (offset === version.capturedByteLength) return Buffer.alloc(0);
    const start = version.byteOffset + offset;
    const end = Math.min(
      version.byteOffset + version.capturedByteLength,
      start + maxBytes,
    );
    const result = await sql<any>`
      SELECT c.chunk_ordinal AS ordinal,c.byte_offset AS offset,c.raw_byte_length AS "rawLength",
             encode(c.blob_sha256,'hex') AS "rawSha256",b.encoded_byte_length AS "encodedLength",
             encode(b.encoded_sha256,'hex') AS "encodedSha256",b.codec,b.codec_version AS "codecVersion",
             b.encoded_bytes AS "encodedBytes"
        FROM learning_archive_version_chunks c JOIN learning_archive_blobs b ON b.sha256=c.blob_sha256
       WHERE c.version_id=${versionId}::uuid AND c.byte_offset < ${end}
         AND c.byte_offset + c.raw_byte_length > ${start}
       ORDER BY c.chunk_ordinal`.execute(this.kysely);
    if (result.rows.length === 0)
      throw new Error(`Archive version ${versionId} has a chunk gap`);
    const output: Buffer[] = [];
    let expectedOrdinal: number | null = null;
    let expectedOffset: number | null = null;
    let coveredUntil = start;
    for (const raw of result.rows) {
      const chunk = {
        ...raw,
        ordinal: asSafeNumber(raw.ordinal, "chunk ordinal"),
        offset: asSafeNumber(raw.offset, "chunk offset"),
        rawLength: asSafeNumber(raw.rawLength, "chunk raw length"),
        encodedLength: asSafeNumber(raw.encodedLength, "chunk encoded length"),
      };
      if (chunk.codec !== "gzip" || chunk.codecVersion !== "rfc1952") {
        throw new Error(
          `Archive version ${versionId} has an unsupported chunk codec`,
        );
      }
      if (
        expectedOrdinal !== null &&
        (chunk.ordinal !== expectedOrdinal || chunk.offset !== expectedOffset)
      ) {
        throw new Error(`Archive version ${versionId} has a chunk gap`);
      }
      if (
        expectedOrdinal === null &&
        (chunk.offset > start || chunk.offset + chunk.rawLength <= start)
      ) {
        throw new Error(`Archive version ${versionId} has a chunk gap`);
      }
      const verified = verifyCapturedArchiveBytes({
        captureKind: "opaque-range",
        consistency: "stable-prefix",
        coverage: "prefix",
        source: {
          deviceId: "0",
          inodeId: "0",
          mode: 0,
          size: chunk.rawLength,
          mtimeNs: "0",
          ctimeNs: "0",
        },
        captureStartedAt: version.captureStartedAt,
        captureEndedAt: version.captureEndedAt,
        offset: chunk.offset,
        rawLength: chunk.rawLength,
        rawSha256: chunk.rawSha256,
        chunks: [{ ...chunk, ordinal: 0 }],
        limitations: [],
      })[0]!;
      const sliceStart = Math.max(start, chunk.offset) - chunk.offset;
      const sliceEnd =
        Math.min(end, chunk.offset + chunk.rawLength) - chunk.offset;
      output.push(
        Buffer.from(verified.rawBytes).subarray(sliceStart, sliceEnd),
      );
      coveredUntil = Math.max(coveredUntil, chunk.offset + sliceEnd);
      expectedOrdinal = chunk.ordinal + 1;
      expectedOffset = chunk.offset + chunk.rawLength;
    }
    const restored = Buffer.concat(output);
    if (coveredUntil < end || restored.byteLength !== end - start) {
      throw new Error(`Archive version ${versionId} has a chunk gap`);
    }
    return restored;
  }

  private async existingChunkRefs(
    versionId: string,
  ): Promise<
    Array<{
      ordinal: number;
      offset: number;
      rawLength: number;
      rawSha256: string;
    }>
  > {
    const result = await sql<any>`
      SELECT chunk_ordinal AS ordinal, byte_offset AS offset, raw_byte_length AS "rawLength",
             encode(blob_sha256, 'hex') AS "rawSha256"
        FROM learning_archive_version_chunks WHERE version_id = ${versionId}::uuid ORDER BY chunk_ordinal
    `.execute(this.kysely);
    return result.rows.map((row: any) => ({
      ordinal: asSafeNumber(row.ordinal, "chunk ordinal"),
      offset: asSafeNumber(row.offset, "chunk offset"),
      rawLength: asSafeNumber(row.rawLength, "chunk raw length"),
      rawSha256: row.rawSha256,
    }));
  }

  private async verifyExistingBlob(
    chunk: CapturedArchiveChunk,
  ): Promise<boolean> {
    const result = await sql<any>`
      SELECT raw_byte_length AS "rawLength", codec, codec_version AS "codecVersion",
             encoded_byte_length AS "encodedLength", encode(encoded_sha256, 'hex') AS "encodedSha256",
             encoded_bytes AS "encodedBytes"
        FROM learning_archive_blobs WHERE sha256 = decode(${chunk.rawSha256}, 'hex')
    `.execute(this.kysely);
    const row = result.rows[0];
    if (!row) return false;
    const encoded = Buffer.from(row.encodedBytes);
    if (
      asSafeNumber(row.rawLength, "stored blob raw length") !==
        chunk.rawLength ||
      row.codec !== "gzip" ||
      row.codecVersion !== "rfc1952" ||
      asSafeNumber(row.encodedLength, "stored blob encoded length") !==
        encoded.byteLength ||
      row.encodedSha256 !== sha256(encoded)
    ) {
      throw new Error(
        `Stored archive blob metadata verification failed for ${chunk.rawSha256}`,
      );
    }
    const raw = gunzipSync(encoded);
    if (raw.byteLength !== chunk.rawLength || sha256(raw) !== chunk.rawSha256) {
      throw new Error(
        `Stored archive blob content verification failed for ${chunk.rawSha256}`,
      );
    }
    return true;
  }

  async beginStagedCapture({
    claim,
    runId = null,
    expectedCursor,
    captureKind,
    consistencyStatus,
    coverageStatus,
    source,
    captureStartedAt,
    limitations,
    stagingKey,
    expectedRawLength,
    expectedAggregateSha256,
  }: {
    claim: ArchiveClaim;
    runId?: string | null | undefined;
    expectedCursor: number;
    captureKind: "consistent-sqlite-snapshot";
    consistencyStatus: "logical-sqlite-snapshot";
    coverageStatus: "complete";
    source: CapturedArchiveBytes["source"];
    captureStartedAt: string;
    limitations: string[];
    stagingKey: string;
    expectedRawLength: number;
    expectedAggregateSha256: string;
  }): Promise<{
    versionId: string;
    nextOffset: number;
    nextOrdinal: number;
    idempotent: boolean;
    sealed: boolean;
  }> {
    if (!stagingKey.trim())
      throw new Error("Staged archive capture requires a stable staging key");
    if (!Number.isSafeInteger(expectedRawLength) || expectedRawLength < 0)
      throw new Error("Invalid staged archive byte length");
    const aggregateSha256 = normalizeHexDigest(
      expectedAggregateSha256,
      "Staged archive aggregate digest",
    );
    const captureKey = createHash("sha256")
      .update(
        JSON.stringify({
          sourceId: claim.sourceId,
          generation: claim.generation,
          stagingKey,
        }),
      )
      .digest("hex");
    return this.kysely.transaction().execute(async (trx) => {
      const locked = await sql<any>`
        SELECT s.generation, s.lease_owner AS "leaseOwner", s.lease_token AS "leaseToken",
               s.lease_expires_at AS "leaseExpiresAt", s.fencing_token AS "fencingToken",
               s.device_id AS "deviceId", s.inode_id AS "inodeId",
               c.cursor_offset AS "cursorOffset", c.last_version_number AS "lastVersionNumber"
          FROM learning_archive_sources s
          JOIN learning_archive_checkpoints c ON c.source_id = s.source_id AND c.generation = s.generation
         WHERE s.source_id = ${claim.sourceId}::uuid FOR UPDATE
      `.execute(trx);
      const state = locked.rows[0];
      if (
        !state ||
        state.generation !== claim.generation ||
        state.leaseOwner !== claim.ownerId ||
        state.leaseToken !== claim.claimToken ||
        asSafeNumber(state.fencingToken, "fencing token") !==
          claim.fencingToken ||
        new Date(state.leaseExpiresAt).valueOf() <= Date.now()
      )
        throw new Error(
          `Archive source ${claim.sourceId} lost its claim lease`,
        );
      if (
        (state.deviceId !== null &&
          String(state.deviceId) !== source.deviceId) ||
        (state.inodeId !== null && String(state.inodeId) !== source.inodeId)
      ) {
        throw new Error(
          "Staged archive source identity differs from its registered generation",
        );
      }
      if (
        asSafeNumber(state.cursorOffset, "checkpoint cursor") !== expectedCursor
      )
        throw new Error("Archive checkpoint changed before staged capture");

      const existing = await sql<any>`
        SELECT v.version_id AS "versionId", v.captured_byte_length AS "rawLength",
               encode(v.aggregate_sha256, 'hex') AS digest, v.manifest_status AS status,
               COALESCE(max(c.chunk_ordinal), -1) AS "lastOrdinal",
               COALESCE(max(c.byte_offset + c.raw_byte_length), v.byte_offset) AS "nextOffset"
          FROM learning_archive_versions v
          LEFT JOIN learning_archive_version_chunks c ON c.version_id = v.version_id
         WHERE v.capture_key = ${captureKey}
         GROUP BY v.version_id
      `.execute(trx);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (
          asSafeNumber(row.rawLength, "staged raw length") !==
            expectedRawLength ||
          row.digest !== aggregateSha256
        ) {
          throw new Error("Staged archive key was reused for different bytes");
        }
        return {
          versionId: row.versionId,
          nextOffset: asSafeNumber(row.nextOffset, "staged next offset"),
          nextOrdinal: asSafeNumber(row.lastOrdinal, "staged last ordinal") + 1,
          idempotent: true,
          sealed: row.status === "sealed",
        };
      }
      const versionId = randomUUID();
      // The checkpoint's last_version_number advances only when a version SEALS,
      // but a staged version is inserted as `writing` long before that. When
      // the staged bytes are lost before sealing (a reboot wipes tmpfs; the
      // staging root moved on 2026-09-21), the orphaned `writing` row keeps its
      // number, and `checkpoint + 1` would collide with it on every later
      // capture of the source — the unique violation surfaced as a permanent
      // `capture-failed`. Number from the versions table, which is the row
      // being inserted into, so an orphan is stepped over rather than hit.
      const numbered = await sql<{ maxVersionNumber: string | number | bigint }>`
        SELECT COALESCE(MAX(version_number), 0) AS "maxVersionNumber"
          FROM learning_archive_versions
         WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
      `.execute(trx);
      const versionNumber =
        Math.max(
          asSafeNumber(state.lastVersionNumber, "last version number"),
          asSafeNumber(numbered.rows[0]?.maxVersionNumber ?? 0, "max version number"),
        ) + 1;
      await sql`
        INSERT INTO learning_archive_versions (
          version_id, capture_key, source_id, run_id, generation, version_number, capture_kind,
          consistency_status, coverage_status, byte_offset, captured_byte_length, aggregate_sha256,
          observed_device_id, observed_inode_id, observed_mode, observed_size, observed_mtime_ns,
          observed_ctime_ns, capture_started_at, capture_ended_at, limitations
        ) VALUES (
          ${versionId}::uuid, ${captureKey}, ${claim.sourceId}::uuid, ${runId}::uuid, ${claim.generation},
          ${versionNumber}, ${captureKind}, ${consistencyStatus}, ${coverageStatus}, 0, ${expectedRawLength},
          decode(${aggregateSha256}, 'hex'), ${source.deviceId}, ${source.inodeId}, ${source.mode}, ${source.size},
          ${source.mtimeNs}, ${source.ctimeNs}, ${captureStartedAt}::timestamptz, ${captureStartedAt}::timestamptz,
          ${JSON.stringify(limitations)}::jsonb
        )
      `.execute(trx);
      return {
        versionId,
        nextOffset: 0,
        nextOrdinal: 0,
        idempotent: false,
        sealed: false,
      };
    });
  }

  async appendStagedChunk({
    claim,
    versionId,
    expectedOffset,
    chunk,
  }: {
    claim: ArchiveClaim;
    versionId: string;
    expectedOffset: number;
    chunk: CapturedArchiveChunk;
  }): Promise<{
    nextOffset: number;
    nextOrdinal: number;
    idempotent: boolean;
  }> {
    const verified = verifyCapturedArchiveBytes({
      captureKind: "opaque-range",
      consistency: "stable-prefix",
      coverage: "prefix",
      source: {
        deviceId: "0",
        inodeId: "0",
        mode: 0,
        size: chunk.rawLength,
        mtimeNs: "0",
        ctimeNs: "0",
      },
      captureStartedAt: new Date(0).toISOString(),
      captureEndedAt: new Date(0).toISOString(),
      offset: chunk.offset,
      rawLength: chunk.rawLength,
      rawSha256: chunk.rawSha256,
      chunks: [{ ...chunk, ordinal: 0 }],
      limitations: [],
    })[0]!;
    if (chunk.offset !== expectedOffset)
      throw new Error(
        "Staged archive chunk offset differs from its expected offset",
      );
    const blobAlreadyVerified = await this.verifyExistingBlob(chunk);
    return this.kysely.transaction().execute(async (trx) => {
      const locked = await sql<any>`
        SELECT s.generation, s.lease_owner AS "leaseOwner", s.lease_token AS "leaseToken",
               s.lease_expires_at AS "leaseExpiresAt", s.fencing_token AS "fencingToken"
          FROM learning_archive_sources s WHERE s.source_id = ${claim.sourceId}::uuid FOR UPDATE
      `.execute(trx);
      const state = locked.rows[0];
      if (
        !state ||
        state.generation !== claim.generation ||
        state.leaseOwner !== claim.ownerId ||
        state.leaseToken !== claim.claimToken ||
        asSafeNumber(state.fencingToken, "fencing token") !==
          claim.fencingToken ||
        new Date(state.leaseExpiresAt).valueOf() <= Date.now()
      )
        throw new Error(
          `Archive source ${claim.sourceId} lost its claim lease`,
        );
      const version = await sql<any>`
        SELECT source_id AS "sourceId", generation, manifest_status AS status, captured_byte_length AS "rawLength",
               COALESCE((SELECT max(chunk_ordinal) + 1 FROM learning_archive_version_chunks WHERE version_id = v.version_id), 0) AS "nextOrdinal",
               COALESCE((SELECT max(byte_offset + raw_byte_length) FROM learning_archive_version_chunks WHERE version_id = v.version_id), v.byte_offset) AS "nextOffset"
          FROM learning_archive_versions v WHERE version_id = ${versionId}::uuid
      `.execute(trx);
      const target = version.rows[0];
      if (
        !target ||
        target.sourceId !== claim.sourceId ||
        target.generation !== claim.generation ||
        target.status !== "writing"
      ) {
        throw new Error(
          "Staged archive version is absent, sealed, or belongs to another generation",
        );
      }
      const prior = await sql<any>`
        SELECT c.byte_offset AS offset, c.raw_byte_length AS "rawLength", encode(c.blob_sha256, 'hex') AS "rawSha256",
               b.codec, b.codec_version AS "codecVersion", b.encoded_byte_length AS "encodedLength",
               encode(b.encoded_sha256, 'hex') AS "encodedSha256", b.encoded_bytes AS "encodedBytes"
          FROM learning_archive_version_chunks c JOIN learning_archive_blobs b ON b.sha256 = c.blob_sha256
         WHERE c.version_id = ${versionId}::uuid AND c.chunk_ordinal = ${chunk.ordinal}
      `.execute(trx);
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (
          asSafeNumber(row.offset, "stored chunk offset") !== chunk.offset ||
          asSafeNumber(row.rawLength, "stored chunk length") !==
            chunk.rawLength ||
          row.rawSha256 !== chunk.rawSha256 ||
          row.codec !== "gzip" ||
          row.codecVersion !== "rfc1952"
        ) {
          throw new Error(
            "Staged archive retry conflicts with the stored chunk",
          );
        }
        return {
          nextOffset: chunk.offset + chunk.rawLength,
          nextOrdinal: chunk.ordinal + 1,
          idempotent: true,
        };
      }
      const nextOrdinal = asSafeNumber(
        target.nextOrdinal,
        "staged next ordinal",
      );
      const nextOffset = asSafeNumber(target.nextOffset, "staged next offset");
      if (
        chunk.ordinal !== nextOrdinal ||
        chunk.offset !== nextOffset ||
        chunk.offset + chunk.rawLength >
          asSafeNumber(target.rawLength, "staged raw length")
      ) {
        throw new Error(
          "Staged archive chunk is out of order or beyond the expected snapshot",
        );
      }
      const encoded = Buffer.from(chunk.encodedBytes);
      const inserted = blobAlreadyVerified
        ? null
        : await sql`
        INSERT INTO learning_archive_blobs (
          sha256, raw_byte_length, codec, codec_version, encoded_bytes, encoded_byte_length, encoded_sha256, verified_at
        ) VALUES (
          decode(${chunk.rawSha256}, 'hex'), ${chunk.rawLength}, ${chunk.codec}, ${chunk.codecVersion}, ${encoded},
          ${chunk.encodedLength}, decode(${chunk.encodedSha256}, 'hex'), NOW()
        ) ON CONFLICT DO NOTHING RETURNING sha256
      `.execute(trx);
      if (inserted && !inserted.rows[0])
        throw new Error(
          `Archive blob ${chunk.rawSha256} appeared concurrently; retry capture`,
        );
      await sql`
        INSERT INTO learning_archive_version_chunks (version_id, chunk_ordinal, byte_offset, raw_byte_length, blob_sha256)
        VALUES (${versionId}::uuid, ${chunk.ordinal}, ${chunk.offset}, ${chunk.rawLength}, decode(${chunk.rawSha256}, 'hex'))
      `.execute(trx);
      return {
        nextOffset: chunk.offset + verified.rawBytes.byteLength,
        nextOrdinal: chunk.ordinal + 1,
        idempotent: false,
      };
    });
  }

  async sealStagedCapture({
    claim,
    versionId,
    checkpointCursorAfter,
    captureEndedAt,
  }: {
    claim: ArchiveClaim;
    versionId: string;
    checkpointCursorAfter: number;
    captureEndedAt: string;
  }): Promise<{ versionId: string; versionNumber: number; rawBytes: number }> {
    const prepared = await this.versionMetadata(versionId);
    if (!prepared)
      throw new Error(`Staged archive version ${versionId} does not exist`);
    for await (const _bytes of this.verifiedVersionChunks(prepared, true)) {
      /* bounded verification */
    }
    if (prepared.manifestStatus === "sealed") {
      return {
        versionId,
        versionNumber: prepared.versionNumber,
        rawBytes: prepared.capturedByteLength,
      };
    }
    return this.kysely.transaction().execute(async (trx) => {
      const locked = await sql<any>`
        SELECT s.generation, s.lease_owner AS "leaseOwner", s.lease_token AS "leaseToken",
               s.lease_expires_at AS "leaseExpiresAt", s.fencing_token AS "fencingToken",
               s.device_id AS "deviceId", s.inode_id AS "inodeId",
               c.cursor_offset AS "cursorOffset", c.last_version_number AS "lastVersionNumber"
          FROM learning_archive_sources s
          JOIN learning_archive_checkpoints c ON c.source_id = s.source_id AND c.generation = s.generation
         WHERE s.source_id = ${claim.sourceId}::uuid FOR UPDATE
      `.execute(trx);
      const state = locked.rows[0];
      if (
        !state ||
        state.generation !== claim.generation ||
        state.leaseOwner !== claim.ownerId ||
        state.leaseToken !== claim.claimToken ||
        asSafeNumber(state.fencingToken, "fencing token") !==
          claim.fencingToken ||
        new Date(state.leaseExpiresAt).valueOf() <= Date.now()
      )
        throw new Error(
          `Archive source ${claim.sourceId} lost its claim lease`,
        );
      const current = await this.versionMetadata(versionId, trx);
      if (
        !current ||
        current.sourceId !== claim.sourceId ||
        current.generation !== claim.generation
      )
        throw new Error("Staged archive version changed before seal");
      if (current.manifestStatus === "sealed")
        return {
          versionId,
          versionNumber: current.versionNumber,
          rawBytes: current.capturedByteLength,
        };
      if (
        checkpointCursorAfter <
        asSafeNumber(state.cursorOffset, "checkpoint cursor")
      )
        throw new Error("Archive checkpoint cannot move backwards");
      await sql`
        UPDATE learning_archive_versions SET manifest_status = 'sealed', sealed_at = NOW(), capture_ended_at = ${captureEndedAt}::timestamptz
        WHERE version_id = ${versionId}::uuid
      `.execute(trx);
      await sql`
        UPDATE learning_archive_checkpoints SET cursor_offset = ${checkpointCursorAfter},
          last_version_number = ${current.versionNumber}, last_verified_version_id = ${versionId}::uuid,
          recovery_state = 'ready', last_success_at = NOW(), last_error_at = NULL, last_error_code = NULL,
          last_error_message = NULL, updated_at = NOW()
        WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
      `.execute(trx);
      await sql`
        UPDATE learning_archive_sources SET discovery_state = 'current', last_success_at = NOW(),
          lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
        WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
          AND lease_token = ${claim.claimToken}::uuid AND fencing_token = ${claim.fencingToken}
      `.execute(trx);
      return {
        versionId,
        versionNumber: current.versionNumber,
        rawBytes: current.capturedByteLength,
      };
    });
  }

  async commitCapture({
    claim,
    runId = null,
    expectedCursor,
    checkpointCursorAfter,
    baseVersionId = null,
    capture,
  }: {
    claim: ArchiveClaim;
    runId?: string | null;
    expectedCursor: number;
    checkpointCursorAfter: number;
    baseVersionId?: string | null | undefined;
    capture: CapturedArchiveBytes;
  }): Promise<{
    versionId: string;
    versionNumber: number;
    rawBytes: number;
    encodedBytes: number;
    deduplicatedBytes: number;
    idempotent: boolean;
  }> {
    const verifiedNewChunks = verifyCapturedArchiveBytes(capture);
    if (
      checkpointCursorAfter < expectedCursor ||
      !Number.isSafeInteger(checkpointCursorAfter)
    )
      throw new Error("Archive checkpoint cannot move backwards");
    const base = baseVersionId
      ? await this.versionMetadata(baseVersionId)
      : undefined;
    if (
      baseVersionId &&
      (!base ||
        base.manifestStatus !== "sealed" ||
        base.sourceId !== claim.sourceId ||
        base.generation !== claim.generation)
    ) {
      throw new Error(
        "Archive base version is absent, unsealed, or belongs to another source generation",
      );
    }
    if (base && capture.offset !== base.byteOffset + base.capturedByteLength)
      throw new Error(
        "Appended archive range does not follow its base version",
      );
    if (!base && capture.offset !== 0)
      throw new Error(
        "An archive version without a base must begin at byte zero",
      );
    if (base && capture.captureKind !== "opaque-range")
      throw new Error("Only an opaque append range may reuse a base version");
    if (
      capture.captureKind === "opaque-range" &&
      (capture.offset !== expectedCursor ||
        checkpointCursorAfter !== capture.offset + capture.rawLength)
    ) {
      throw new Error(
        "Opaque archive range must advance exactly from the expected checkpoint",
      );
    }
    if (
      capture.captureKind === "opaque-complete" &&
      (expectedCursor !== 0 || checkpointCursorAfter !== capture.rawLength)
    ) {
      throw new Error(
        "Complete archive capture must advance a fresh generation to its exact length",
      );
    }

    const aggregate = createHash("sha256");
    if (base)
      for await (const bytes of this.restoreVersionChunks(base.versionId))
        aggregate.update(bytes);
    for (const chunk of verifiedNewChunks) aggregate.update(chunk.rawBytes);
    const aggregateSha256 = aggregate.digest("hex");
    const capturedByteLength =
      (base?.capturedByteLength ?? 0) + capture.rawLength;
    const byteOffset = base?.byteOffset ?? capture.offset;
    const captureKey = createHash("sha256")
      .update(
        JSON.stringify({
          sourceId: claim.sourceId,
          generation: claim.generation,
          byteOffset,
          capturedByteLength,
          aggregateSha256,
          captureKind: capture.captureKind,
          consistency: capture.consistency,
          coverage: capture.coverage,
        }),
      )
      .digest("hex");
    const baseRefs = base ? await this.existingChunkRefs(base.versionId) : [];
    const verifiedExistingBlobs = new Set<string>();
    for (const chunk of verifiedNewChunks) {
      if (await this.verifyExistingBlob(chunk))
        verifiedExistingBlobs.add(chunk.rawSha256);
    }

    return this.kysely.transaction().execute(async (trx) => {
      const existing = await sql<any>`
        SELECT version_id AS "versionId", version_number AS "versionNumber"
          FROM learning_archive_versions WHERE capture_key = ${captureKey} AND manifest_status = 'sealed'
      `.execute(trx);
      if (existing.rows[0])
        return {
          versionId: existing.rows[0].versionId,
          versionNumber: asSafeNumber(
            existing.rows[0].versionNumber,
            "version number",
          ),
          rawBytes: capturedByteLength,
          encodedBytes: 0,
          deduplicatedBytes: capture.rawLength,
          idempotent: true,
        };
      const locked = await sql<any>`
        SELECT s.generation, s.lease_owner AS "leaseOwner", s.lease_token AS "leaseToken",
               s.lease_expires_at AS "leaseExpiresAt", s.fencing_token AS "fencingToken",
               s.device_id AS "deviceId", s.inode_id AS "inodeId",
               c.cursor_offset AS "cursorOffset", c.last_version_number AS "lastVersionNumber"
          FROM learning_archive_sources s
          JOIN learning_archive_checkpoints c ON c.source_id = s.source_id AND c.generation = s.generation
         WHERE s.source_id = ${claim.sourceId}::uuid FOR UPDATE
      `.execute(trx);
      const state = locked.rows[0];
      if (
        !state ||
        state.generation !== claim.generation ||
        state.leaseOwner !== claim.ownerId ||
        state.leaseToken !== claim.claimToken ||
        asSafeNumber(state.fencingToken, "fencing token") !==
          claim.fencingToken ||
        new Date(state.leaseExpiresAt).valueOf() <= Date.now()
      ) {
        throw new Error(
          `Archive source ${claim.sourceId} lost its claim lease`,
        );
      }
      if (
        (state.deviceId !== null &&
          String(state.deviceId) !== capture.source.deviceId) ||
        (state.inodeId !== null &&
          String(state.inodeId) !== capture.source.inodeId)
      ) {
        throw new Error(
          "Archive capture source identity differs from its registered generation",
        );
      }
      if (
        asSafeNumber(state.cursorOffset, "checkpoint cursor") !== expectedCursor
      )
        throw new Error("Archive checkpoint changed before commit");

      let encodedBytes = 0;
      let deduplicatedBytes = base?.capturedByteLength ?? 0;
      for (const chunk of verifiedNewChunks) {
        if (verifiedExistingBlobs.has(chunk.rawSha256)) {
          deduplicatedBytes += chunk.rawLength;
          continue;
        }
        const encoded = Buffer.from(chunk.encodedBytes);
        const inserted = await sql`
          INSERT INTO learning_archive_blobs (
            sha256, raw_byte_length, codec, codec_version, encoded_bytes,
            encoded_byte_length, encoded_sha256, verified_at
          ) VALUES (
            decode(${chunk.rawSha256}, 'hex'), ${chunk.rawLength}, ${chunk.codec}, ${chunk.codecVersion}, ${encoded},
            ${chunk.encodedLength}, decode(${chunk.encodedSha256}, 'hex'), NOW()
          ) ON CONFLICT DO NOTHING RETURNING sha256
        `.execute(trx);
        if (inserted.rows.length) encodedBytes += chunk.encodedLength;
        else
          throw new Error(
            `Archive blob ${chunk.rawSha256} appeared concurrently; retry capture`,
          );
      }
      await this.testHooks.afterBlobWrite?.();

      const versionId = randomUUID();
      const versionNumber =
        asSafeNumber(state.lastVersionNumber, "last version number") + 1;
      const captureKind =
        capture.captureKind === "opaque-range"
          ? "append-prefix"
          : capture.captureKind === "opaque-complete"
            ? "complete-file"
            : "consistent-sqlite-snapshot";
      await sql`
        INSERT INTO learning_archive_versions (
          version_id, capture_key, source_id, run_id, base_version_id, generation, version_number,
          capture_kind, consistency_status, coverage_status, byte_offset, captured_byte_length,
          aggregate_sha256, observed_device_id, observed_inode_id, observed_mode, observed_size,
          observed_mtime_ns, observed_ctime_ns, capture_started_at, capture_ended_at, limitations
        ) VALUES (
          ${versionId}::uuid, ${captureKey}, ${claim.sourceId}::uuid, ${runId}::uuid, ${baseVersionId}::uuid,
          ${claim.generation}, ${versionNumber}, ${captureKind}, ${capture.consistency}, ${capture.coverage},
          ${byteOffset}, ${capturedByteLength}, decode(${aggregateSha256}, 'hex'), ${capture.source.deviceId},
          ${capture.source.inodeId}, ${capture.source.mode}, ${capture.source.size}, ${capture.source.mtimeNs},
          ${capture.source.ctimeNs}, ${capture.captureStartedAt}::timestamptz, ${capture.captureEndedAt}::timestamptz,
          ${JSON.stringify(capture.limitations)}::jsonb
        )
      `.execute(trx);
      for (const ref of baseRefs) {
        await sql`
          INSERT INTO learning_archive_version_chunks (version_id, chunk_ordinal, byte_offset, raw_byte_length, blob_sha256)
          VALUES (${versionId}::uuid, ${ref.ordinal}, ${ref.offset}, ${ref.rawLength}, decode(${ref.rawSha256}, 'hex'))
        `.execute(trx);
      }
      for (const chunk of verifiedNewChunks) {
        await sql`
          INSERT INTO learning_archive_version_chunks (version_id, chunk_ordinal, byte_offset, raw_byte_length, blob_sha256)
          VALUES (${versionId}::uuid, ${baseRefs.length + chunk.ordinal}, ${chunk.offset}, ${chunk.rawLength}, decode(${chunk.rawSha256}, 'hex'))
        `.execute(trx);
      }
      await sql`
        UPDATE learning_archive_versions SET manifest_status = 'sealed', sealed_at = NOW() WHERE version_id = ${versionId}::uuid
      `.execute(trx);
      await sql`
        UPDATE learning_archive_checkpoints
           SET cursor_offset = ${checkpointCursorAfter}, last_version_number = ${versionNumber},
               last_verified_version_id = ${versionId}::uuid, recovery_state = 'ready', last_success_at = NOW(),
               last_error_at = NULL, last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
         WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
      `.execute(trx);
      await sql`
        UPDATE learning_archive_sources
           SET discovery_state = 'current', last_success_at = NOW(), source_size = ${capture.source.size},
               source_mtime_ns = ${capture.source.mtimeNs}, source_ctime_ns = ${capture.source.ctimeNs},
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
           AND lease_token = ${claim.claimToken}::uuid AND fencing_token = ${claim.fencingToken}
      `.execute(trx);
      return {
        versionId,
        versionNumber,
        rawBytes: capturedByteLength,
        encodedBytes,
        deduplicatedBytes,
        idempotent: false,
      };
    });
  }

  async failCapture({
    claim,
    runId = null,
    errorCode,
    errorMessage,
    retryable,
    isGap = false,
    details = {},
  }: {
    claim: ArchiveClaim;
    runId?: string | null;
    errorCode: string;
    errorMessage: string;
    retryable: boolean;
    isGap?: boolean;
    details?: Record<string, unknown>;
  }): Promise<boolean> {
    const boundedMessage = errorMessage.slice(0, 4_000);
    return this.kysely.transaction().execute(async (trx) => {
      const released = await sql`
        UPDATE learning_archive_sources
           SET discovery_state = ${isGap ? "error" : "discovered"}, last_error_at = NOW(),
               last_error_code = ${errorCode}, last_error_message = ${boundedMessage},
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
           AND lease_token = ${claim.claimToken}::uuid AND fencing_token = ${claim.fencingToken}
      `.execute(trx);
      if (Number(released.numAffectedRows ?? 0) !== 1) return false;
      await sql`
        UPDATE learning_archive_checkpoints
           SET recovery_state = ${isGap || !retryable ? "terminal_gap" : "retryable_error"},
               last_error_at = NOW(), last_error_code = ${errorCode}, last_error_message = ${boundedMessage}, updated_at = NOW()
         WHERE source_id = ${claim.sourceId}::uuid AND generation = ${claim.generation}
      `.execute(trx);
      await sql`
        INSERT INTO learning_archive_errors (
          run_id, source_id, generation, error_code, error_message, retryable, is_gap, details
        ) VALUES (
          ${runId}::uuid, ${claim.sourceId}::uuid, ${claim.generation}, ${errorCode}, ${boundedMessage},
          ${retryable}, ${isGap}, ${JSON.stringify(details)}::jsonb
        )
      `.execute(trx);
      return true;
    });
  }
}
