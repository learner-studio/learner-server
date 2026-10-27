-- Index the referencing side of every foreign key into the lossless archive.
-- Postgres indexes only the referenced primary key, so deleting a version or a
-- blob checked each of these columns with a full scan per deleted row: the
-- 2026-10-27 purge of 20,190 codex logs_2 versions was on course for ~20 TB of
-- reads and finished in 75 s with these built as temporary indexes. Measured
-- cost: ~10% more insert work per row (~0.5 us) and ~13 bytes of index per row.
-- Plain CREATE INDEX: migrations run in one transaction, which CONCURRENTLY
-- cannot. Each SHARE lock is held until COMMIT, so every table below is
-- write-blocked for the whole migration (tens of seconds at this size). The
-- lock timeout makes it fail fast rather than queue writers behind a long
-- transaction (the semantic index rewrites current_canonical in one).
SET LOCAL lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS learning_exposure_observations_raw_version_id_idx ON public.learning_exposure_observations (raw_version_id);
CREATE INDEX IF NOT EXISTS learning_exposure_imports_raw_version_id_idx ON public.learning_exposure_imports (raw_version_id);
CREATE INDEX IF NOT EXISTS learning_semantic_index_messages_raw_version_id_idx ON public.learning_semantic_index_messages (raw_version_id);
CREATE INDEX IF NOT EXISTS learning_archive_errors_version_id_idx ON public.learning_archive_errors (version_id);
CREATE INDEX IF NOT EXISTS learning_archive_versions_base_version_id_idx ON public.learning_archive_versions (base_version_id);
CREATE INDEX IF NOT EXISTS learning_archive_versions_run_id_idx ON public.learning_archive_versions (run_id);
CREATE INDEX IF NOT EXISTS learning_archive_checkpoints_last_verified_version_id_idx ON public.learning_archive_checkpoints (last_verified_version_id);
CREATE INDEX IF NOT EXISTS learning_archive_version_chunks_blob_sha256_idx ON public.learning_archive_version_chunks (blob_sha256);
