-- The Learning intervention policy the web app edits and the live hook path enforces.
-- One row, like learning_extractor_config: the hook authenticates as the agent key's
-- user, not the web session's, so a per-user row would never reach it.
CREATE TABLE public.learning_policy_settings (
  config_key text PRIMARY KEY CHECK (config_key = 'default'),
  settings jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Whether a turn's guidance carried a teaching intervention. Set once, when the
-- guidance is first computed, so the injection ceiling counts what was delivered
-- and a replayed submission returns the same decision.
ALTER TABLE public.learning_live_feedback_turns ADD COLUMN injected boolean;
