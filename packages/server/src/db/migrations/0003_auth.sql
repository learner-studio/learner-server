-- Better Auth core tables plus the API-key plugin table. Column names follow
-- Better Auth's defaults in snake_case (the kysely handle camelCases them).
CREATE TABLE "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE session (
  id text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  ip_address text,
  user_agent text,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX session_user_id_idx ON session(user_id);
CREATE TABLE account (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_user_id_idx ON account(user_id);
CREATE TABLE verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE apikey (
  id text PRIMARY KEY,
  config_id text NOT NULL DEFAULT 'default',
  name text,
  start text,
  reference_id text NOT NULL,
  prefix text,
  key text NOT NULL,
  refill_interval integer,
  refill_amount integer,
  last_refill_at timestamptz,
  enabled boolean DEFAULT true,
  rate_limit_enabled boolean DEFAULT false,
  rate_limit_time_window integer,
  rate_limit_max integer,
  request_count integer DEFAULT 0,
  remaining integer,
  last_request timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  permissions text,
  metadata text
);
CREATE INDEX apikey_key_idx ON apikey(key);
CREATE INDEX apikey_reference_id_idx ON apikey(reference_id);
