-- learner-desktop (the macOS app) reports in over HTTPS RPC (docs/learner-desktop-api.md).
-- One row per device: the latest heartbeat. Its habit/call rows live in the
-- `habits` database GrowthBook reads; this table answers "is the device alive,
-- and is it exporting?" so silence is visible on the server.
CREATE TABLE public.learner_desktop_devices (
    client_id text PRIMARY KEY,
    user_id text NOT NULL,
    app_version text NOT NULL,
    screenpipe_version text,
    capture_state text NOT NULL,
    outbox_depth integer NOT NULL,
    last_sent_at timestamptz,
    last_vault_export_at timestamptz,
    detail jsonb NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at timestamptz NOT NULL DEFAULT now(),
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    habit_events_received integer NOT NULL DEFAULT 0,
    calls_received integer NOT NULL DEFAULT 0,
    documents_received integer NOT NULL DEFAULT 0,
    last_upload_at timestamptz
);
