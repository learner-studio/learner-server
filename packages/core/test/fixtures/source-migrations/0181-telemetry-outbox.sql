-- Provider-neutral durable telemetry. No credentials or transport URLs belong here.
CREATE TABLE IF NOT EXISTS telemetry_outbox (
  id uuid PRIMARY KEY,
  destination text NOT NULL CHECK (length(destination) BETWEEN 1 AND 80),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 512),
  payload jsonb,
  payload_fingerprint text NOT NULL CHECK (payload_fingerprint ~ '^[a-f0-9]{64}$'),
  compacted_at timestamptz,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivering','delivered','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE(destination, dedupe_key),
  CHECK ((state = 'delivering') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((payload IS NOT NULL AND compacted_at IS NULL) OR
    (payload IS NULL AND compacted_at IS NOT NULL AND state IN ('delivered','dead')))
);
CREATE INDEX IF NOT EXISTS telemetry_outbox_ready ON telemetry_outbox(available_at, created_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS telemetry_outbox_expired ON telemetry_outbox(lease_until) WHERE state = 'delivering';
CREATE INDEX IF NOT EXISTS telemetry_outbox_retention ON telemetry_outbox(updated_at, id)
  WHERE compacted_at IS NULL AND state IN ('delivered','dead');
