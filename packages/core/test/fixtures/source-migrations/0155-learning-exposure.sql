-- Derived, replayable Learning projection. Raw archive tables remain canonical.
-- A message key is an explicit provider identity, never a text similarity key.
CREATE TABLE learning_exposure_observations (
  observation_id UUID PRIMARY KEY,
  dedupe_key TEXT,
  logical_message_key TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('user_to_model','model_to_user','internal','unknown')),
  visible BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  raw_version_id UUID NOT NULL REFERENCES learning_archive_versions(version_id),
  payload JSONB NOT NULL,
  payload_sha256 TEXT NOT NULL CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX learning_exposure_dedupe_idx ON learning_exposure_observations(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX learning_exposure_message_idx ON learning_exposure_observations(logical_message_key,direction);
CREATE INDEX learning_exposure_visible_idx ON learning_exposure_observations(observation_id) WHERE visible;
CREATE TABLE learning_exposure_imports (
  import_key TEXT PRIMARY KEY,
  raw_version_id UUID REFERENCES learning_archive_versions(version_id),
  status TEXT NOT NULL CHECK(status IN ('completed','gap')),
  gap_code TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE learning_exposure_projection_cursors (
  source_id UUID NOT NULL REFERENCES learning_archive_sources(source_id),
  generation INTEGER NOT NULL,
  cursor_offset BIGINT NOT NULL DEFAULT 0 CHECK(cursor_offset>=0),
  source_order BIGINT NOT NULL DEFAULT 0 CHECK(source_order>=0),
  parser_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(source_id,generation)
);
