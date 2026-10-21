-- Lossless, opaque-byte archive for locally persisted CLI records.
-- Additive only: the existing Hindsight projection and text collector remain intact.

CREATE TABLE IF NOT EXISTS learning_archive_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_kind TEXT NOT NULL CHECK (run_kind IN ('scheduled', 'backfill', 'recovery', 'probe', 'e2e')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'partial', 'completed', 'failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  sources_discovered INTEGER NOT NULL DEFAULT 0 CHECK (sources_discovered >= 0),
  sources_captured INTEGER NOT NULL DEFAULT 0 CHECK (sources_captured >= 0),
  versions_sealed INTEGER NOT NULL DEFAULT 0 CHECK (versions_sealed >= 0),
  gaps_recorded INTEGER NOT NULL DEFAULT 0 CHECK (gaps_recorded >= 0),
  errors_recorded INTEGER NOT NULL DEFAULT 0 CHECK (errors_recorded >= 0),
  bytes_read BIGINT NOT NULL DEFAULT 0 CHECK (bytes_read >= 0),
  raw_bytes_stored BIGINT NOT NULL DEFAULT 0 CHECK (raw_bytes_stored >= 0),
  encoded_bytes_stored BIGINT NOT NULL DEFAULT 0 CHECK (encoded_bytes_stored >= 0),
  deduplicated_bytes BIGINT NOT NULL DEFAULT 0 CHECK (deduplicated_bytes >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'running' AND completed_at IS NULL)
      OR (status <> 'running' AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS learning_archive_sources (
  source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  host TEXT NOT NULL,
  provider TEXT NOT NULL,
  root_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  file_kind TEXT NOT NULL,
  device_id BIGINT,
  inode_id BIGINT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  generation_reason TEXT NOT NULL DEFAULT 'first-observation',
  discovery_state TEXT NOT NULL DEFAULT 'discovered'
    CHECK (discovery_state IN ('discovered', 'capturing', 'current', 'missing', 'unreadable', 'out_of_scope', 'error')),
  source_mtime_ns NUMERIC(30, 0),
  source_ctime_ns NUMERIC(30, 0),
  source_size BIGINT CHECK (source_size IS NULL OR source_size >= 0),
  first_observed_at TIMESTAMPTZ NOT NULL,
  last_observed_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  lease_owner UUID,
  lease_token UUID,
  lease_expires_at TIMESTAMPTZ,
  fencing_token BIGINT NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (host, provider, root_path, relative_path),
  CHECK (relative_path <> '' AND relative_path !~ '(^|/)\.\.(/|$)'),
  CHECK ((lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS learning_archive_sources_backlog_idx
  ON learning_archive_sources (discovery_state, last_success_at NULLS FIRST);
CREATE INDEX IF NOT EXISTS learning_archive_sources_lease_idx
  ON learning_archive_sources (lease_expires_at) WHERE lease_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS learning_archive_blobs (
  sha256 BYTEA PRIMARY KEY CHECK (octet_length(sha256) = 32),
  raw_byte_length INTEGER NOT NULL CHECK (raw_byte_length >= 0 AND raw_byte_length <= 4194304),
  codec TEXT NOT NULL CHECK (codec IN ('gzip')),
  codec_version TEXT NOT NULL,
  encoded_bytes BYTEA NOT NULL,
  encoded_byte_length INTEGER NOT NULL CHECK (encoded_byte_length >= 0),
  encoded_sha256 BYTEA NOT NULL CHECK (octet_length(encoded_sha256) = 32),
  verified_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (octet_length(encoded_bytes) = encoded_byte_length)
);

CREATE TABLE IF NOT EXISTS learning_archive_versions (
  version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  capture_key TEXT NOT NULL UNIQUE CHECK (capture_key ~ '^[0-9a-f]{64}$'),
  source_id UUID NOT NULL REFERENCES learning_archive_sources(source_id),
  run_id UUID REFERENCES learning_archive_runs(run_id),
  base_version_id UUID REFERENCES learning_archive_versions(version_id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  version_number BIGINT NOT NULL CHECK (version_number > 0),
  capture_kind TEXT NOT NULL
    CHECK (capture_kind IN ('append-prefix', 'complete-file', 'consistent-sqlite-snapshot')),
  consistency_status TEXT NOT NULL
    CHECK (consistency_status IN ('stable-prefix', 'stable-file', 'logical-sqlite-snapshot', 'ambiguous', 'failed')),
  coverage_status TEXT NOT NULL CHECK (coverage_status IN ('prefix', 'complete', 'gap')),
  byte_offset BIGINT NOT NULL CHECK (byte_offset >= 0),
  captured_byte_length BIGINT NOT NULL CHECK (captured_byte_length >= 0),
  aggregate_sha256 BYTEA NOT NULL CHECK (octet_length(aggregate_sha256) = 32),
  observed_device_id BIGINT,
  observed_inode_id BIGINT,
  observed_mode INTEGER,
  observed_size BIGINT CHECK (observed_size IS NULL OR observed_size >= 0),
  observed_mtime_ns NUMERIC(30, 0),
  observed_ctime_ns NUMERIC(30, 0),
  capture_started_at TIMESTAMPTZ NOT NULL,
  capture_ended_at TIMESTAMPTZ NOT NULL,
  limitations JSONB NOT NULL DEFAULT '[]'::jsonb,
  manifest_status TEXT NOT NULL DEFAULT 'writing' CHECK (manifest_status IN ('writing', 'sealed')),
  sealed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, generation, version_number),
  UNIQUE (version_id, source_id, generation),
  CHECK (capture_ended_at >= capture_started_at),
  CHECK ((manifest_status = 'writing' AND sealed_at IS NULL)
      OR (manifest_status = 'sealed' AND sealed_at IS NOT NULL)),
  CHECK (base_version_id IS NULL OR base_version_id <> version_id)
);

CREATE INDEX IF NOT EXISTS learning_archive_versions_source_idx
  ON learning_archive_versions (source_id, generation, version_number DESC);

CREATE TABLE IF NOT EXISTS learning_archive_version_chunks (
  version_id UUID NOT NULL REFERENCES learning_archive_versions(version_id),
  chunk_ordinal INTEGER NOT NULL CHECK (chunk_ordinal >= 0),
  byte_offset BIGINT NOT NULL CHECK (byte_offset >= 0),
  raw_byte_length INTEGER NOT NULL CHECK (raw_byte_length > 0 AND raw_byte_length <= 4194304),
  blob_sha256 BYTEA NOT NULL REFERENCES learning_archive_blobs(sha256),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (version_id, chunk_ordinal),
  UNIQUE (version_id, byte_offset)
);

CREATE TABLE IF NOT EXISTS learning_archive_checkpoints (
  source_id UUID NOT NULL REFERENCES learning_archive_sources(source_id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  cursor_offset BIGINT NOT NULL DEFAULT 0 CHECK (cursor_offset >= 0),
  last_version_number BIGINT NOT NULL DEFAULT 0 CHECK (last_version_number >= 0),
  last_verified_version_id UUID REFERENCES learning_archive_versions(version_id),
  recovery_state TEXT NOT NULL DEFAULT 'ready'
    CHECK (recovery_state IN ('ready', 'capturing', 'retryable_error', 'terminal_gap')),
  last_success_at TIMESTAMPTZ,
  last_error_at TIMESTAMPTZ,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (source_id, generation),
  FOREIGN KEY (last_verified_version_id, source_id, generation)
    REFERENCES learning_archive_versions(version_id, source_id, generation)
);

CREATE TABLE IF NOT EXISTS learning_archive_errors (
  error_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES learning_archive_runs(run_id),
  source_id UUID REFERENCES learning_archive_sources(source_id),
  generation INTEGER CHECK (generation IS NULL OR generation >= 0),
  version_id UUID REFERENCES learning_archive_versions(version_id),
  error_code TEXT NOT NULL,
  error_message TEXT NOT NULL,
  retryable BOOLEAN NOT NULL,
  is_gap BOOLEAN NOT NULL DEFAULT FALSE,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS learning_archive_errors_source_idx
  ON learning_archive_errors (source_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS learning_archive_errors_run_idx
  ON learning_archive_errors (run_id, observed_at DESC);

CREATE OR REPLACE FUNCTION learning_archive_reject_blob_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'learning archive blobs are immutable';
END;
$$;

DROP TRIGGER IF EXISTS learning_archive_blobs_immutable ON learning_archive_blobs;
CREATE TRIGGER learning_archive_blobs_immutable
  BEFORE UPDATE OR DELETE ON learning_archive_blobs
  FOR EACH ROW EXECUTE FUNCTION learning_archive_reject_blob_mutation();

CREATE OR REPLACE FUNCTION learning_archive_guard_version_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.manifest_status = 'sealed' THEN
    RAISE EXCEPTION 'sealed learning archive versions are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.manifest_status = 'sealed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'sealed learning archive versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS learning_archive_versions_immutable ON learning_archive_versions;
CREATE TRIGGER learning_archive_versions_immutable
  BEFORE UPDATE OR DELETE ON learning_archive_versions
  FOR EACH ROW EXECUTE FUNCTION learning_archive_guard_version_mutation();

CREATE OR REPLACE FUNCTION learning_archive_guard_chunk_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  current_status TEXT;
BEGIN
  SELECT manifest_status INTO current_status
    FROM learning_archive_versions
   WHERE version_id = COALESCE(NEW.version_id, OLD.version_id);
  IF current_status = 'sealed' THEN
    RAISE EXCEPTION 'chunks of a sealed learning archive version are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS learning_archive_version_chunks_immutable ON learning_archive_version_chunks;
CREATE TRIGGER learning_archive_version_chunks_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON learning_archive_version_chunks
  FOR EACH ROW EXECUTE FUNCTION learning_archive_guard_chunk_mutation();

CREATE OR REPLACE FUNCTION learning_archive_validate_version_seal()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  chunk_count BIGINT;
  ordinal_min INTEGER;
  ordinal_max INTEGER;
  length_sum BIGINT;
  first_offset BIGINT;
  final_offset BIGINT;
  discontinuities BIGINT;
BEGIN
  IF NEW.manifest_status <> 'sealed' OR OLD.manifest_status = 'sealed' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*), MIN(chunk_ordinal), MAX(chunk_ordinal), COALESCE(SUM(raw_byte_length), 0),
         MIN(byte_offset), MAX(byte_offset + raw_byte_length)
    INTO chunk_count, ordinal_min, ordinal_max, length_sum, first_offset, final_offset
    FROM learning_archive_version_chunks
   WHERE version_id = NEW.version_id;

  SELECT COUNT(*) INTO discontinuities
    FROM (
      SELECT byte_offset,
             LAG(byte_offset + raw_byte_length) OVER (ORDER BY chunk_ordinal) AS prior_end
        FROM learning_archive_version_chunks
       WHERE version_id = NEW.version_id
    ) ordered_chunks
   WHERE prior_end IS NOT NULL AND byte_offset <> prior_end;

  IF (NEW.captured_byte_length = 0 AND chunk_count <> 0)
     OR (NEW.captured_byte_length > 0 AND (
       chunk_count = 0 OR ordinal_min <> 0 OR ordinal_max <> chunk_count - 1
       OR length_sum <> NEW.captured_byte_length OR first_offset <> NEW.byte_offset
       OR final_offset <> NEW.byte_offset + NEW.captured_byte_length OR discontinuities <> 0
     )) THEN
    RAISE EXCEPTION 'cannot seal non-contiguous learning archive version %', NEW.version_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS learning_archive_versions_validate_seal ON learning_archive_versions;
CREATE TRIGGER learning_archive_versions_validate_seal
  BEFORE UPDATE OF manifest_status ON learning_archive_versions
  FOR EACH ROW EXECUTE FUNCTION learning_archive_validate_version_seal();
