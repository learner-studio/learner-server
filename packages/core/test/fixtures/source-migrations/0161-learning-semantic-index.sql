-- The semantic projection is disposable; canonical observations and their raw
-- archive versions remain authoritative and are never updated by this index.
CREATE TABLE IF NOT EXISTS learning_semantic_index_runs (
  run_id uuid PRIMARY KEY,
  frozen_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  watermark text NOT NULL,
  scope text NOT NULL DEFAULT 'all-queryable',
  canonical_messages integer NOT NULL DEFAULT 0,
  raw_observations integer NOT NULL DEFAULT 0,
  error text
);
CREATE TABLE IF NOT EXISTS learning_semantic_index_messages (
  message_id text PRIMARY KEY,
  observation_id uuid NOT NULL REFERENCES learning_exposure_observations(observation_id),
  logical_message_key text NOT NULL,
  raw_version_id uuid NOT NULL REFERENCES learning_archive_versions(version_id),
  conversation_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('user','assistant')),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  source_text text NOT NULL,
  source_sha256 text NOT NULL,
  parts jsonb NOT NULL,
  media_count integer NOT NULL DEFAULT 0,
  current_canonical boolean NOT NULL DEFAULT true,
  status text NOT NULL CHECK (status IN ('pending','chunked','indexed','empty','media_only','unsupported','error')),
  error text,
  indexed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS learning_semantic_index_conversation ON learning_semantic_index_messages(conversation_id,observed_at);
CREATE TABLE IF NOT EXISTS learning_semantic_index_members (
  run_id uuid NOT NULL REFERENCES learning_semantic_index_runs(run_id),
  message_id text NOT NULL REFERENCES learning_semantic_index_messages(message_id),
  PRIMARY KEY (run_id,message_id)
);
CREATE TABLE IF NOT EXISTS learning_semantic_index_chunks (
  chunk_id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES learning_semantic_index_messages(message_id),
  ordinal integer NOT NULL,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL CHECK(end_offset>start_offset),
  token_count integer NOT NULL CHECK(token_count<=480),
  tokenizer_sha256 text NOT NULL,
  content_sha256 text NOT NULL,
  operation_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','submitted','indexed','error')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  indexed_at timestamptz,
  UNIQUE(message_id,ordinal)
);
CREATE TABLE IF NOT EXISTS learning_semantic_index_operations (
  operation_id uuid PRIMARY KEY,
  chunk_ids jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
