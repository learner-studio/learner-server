-- Thin, application-owned checkpoint for native Hindsight consolidation.
-- It records no fact text. A row is scoped to one bank plus one native tag scope.
CREATE TABLE IF NOT EXISTS learning_hindsight_consolidation_triggers (
  bank_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  available_sequence BIGINT NOT NULL DEFAULT 0 CHECK (available_sequence >= 0),
  available_watermark TEXT,
  available_pending_facts INTEGER NOT NULL DEFAULT 0 CHECK (available_pending_facts >= 0),
  available_oldest_at TIMESTAMPTZ,
  reserved_watermark TEXT,
  reserved_sequence BIGINT,
  completed_watermark TEXT,
  reservation_token UUID,
  reservation_until TIMESTAMPTZ,
  native_operation_id UUID,
  native_submitted_at TIMESTAMPTZ,
  native_deadline_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','reserved','polling','completed','failed','uncertain')),
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  next_poll_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bank_id, scope_key),
  CHECK ((reservation_token IS NULL AND reservation_until IS NULL)
      OR (reservation_token IS NOT NULL AND reservation_until IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS learning_hindsight_consolidation_trigger_ready_idx
  ON learning_hindsight_consolidation_triggers (status, next_poll_at);

COMMENT ON TABLE learning_hindsight_consolidation_triggers IS
  'No-text durable watermark/reservation checkpoint for the disabled-by-default native Hindsight consolidation trigger.';
