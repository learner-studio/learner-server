-- Blind probes (docs/specs/blind-probes.md): the probe concept a turn's guidance delivered,
-- stored with the injection decision like review_concept_id (null when none was delivered).
-- Its arm is a function of the concept id (the holdout bucket), so it is not stored.
-- IF NOT EXISTS: first shipped as 0021 and applied by hand on dev and learner_test; renumbered
-- because other lanes hold 0021 and 0022, so the ledger reaches this file after the column exists.
ALTER TABLE public.learning_live_feedback_turns ADD COLUMN IF NOT EXISTS probe_concept_id text;
