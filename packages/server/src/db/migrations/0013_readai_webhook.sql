-- The Read AI webhook: one row, like learning_call_identity. The URL token is
-- the delivery's only credential (Read.ai signs nothing), so only its sha256
-- is kept, plus its last four characters to tell tokens apart in the UI.
CREATE TABLE public.learning_readai_webhook (
  config_key text PRIMARY KEY CHECK (config_key = 'default'),
  token_sha256 text NOT NULL CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  token_hint text NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The last delivery that presented the token: a Read.ai call or a test.
  last_delivery_at timestamptz,
  last_delivery jsonb
);
