-- Additive coordination and progress receipts for independently draining workers.
CREATE TABLE IF NOT EXISTS learning_exposure_work (
  work_key TEXT PRIMARY KEY,
  token UUID,
  lease_until TIMESTAMPTZ,
  cursor JSONB NOT NULL DEFAULT '{}'::jsonb,
  counters JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((token IS NULL) = (lease_until IS NULL))
);
CREATE INDEX IF NOT EXISTS learning_exposure_work_lease_idx
  ON learning_exposure_work(lease_until) WHERE token IS NOT NULL;
