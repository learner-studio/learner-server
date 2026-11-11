-- Restart safety (docs/operations/restart-safety.md): who executes a reserved model attempt right now.
-- The reservation rows stay as they are (immutable or one-shot); the lease beside them is mutable.
-- attempt_key: 'assessment:<run_id>' | 'replicate:<run_id>:<n>' | 'drift:<user>:<item>:<week>'.
-- owner: one value per process, whose life is held by a session advisory lock on 'learner-llm-owner:'||owner;
-- a probe that can take that lock proves the owner dead. repeat_free: the backend may be called again when the
-- outcome is unknown (a local flat-rate CLI child), never for a metered remote one. takeovers: bounded (3).
CREATE TABLE public.learning_llm_attempt_leases (
  attempt_key text PRIMARY KEY,
  backend text NOT NULL,
  repeat_free boolean NOT NULL,
  owner text NOT NULL,
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  takeovers integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
-- Every automatic repair: an attempt taken over from a dead owner, a blocked concept released because the only
-- thing blocking it was a repairable restart casualty. The runbook and the alarm read it; nothing deletes it.
CREATE TABLE public.learning_llm_attempt_reclaims (
  id bigserial PRIMARY KEY,
  attempt_key text NOT NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learning_llm_attempt_reclaims_key ON public.learning_llm_attempt_reclaims(attempt_key, at);
