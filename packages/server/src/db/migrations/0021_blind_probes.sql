-- Blind probes (docs/specs/blind-probes.md): the probe concept a turn's guidance delivered,
-- stored with the injection decision like review_concept_id (null when none was delivered).
-- Its arm is a function of the concept id (the holdout bucket), so it is not stored.
-- IF NOT EXISTS: 0020 belongs to another lane, so on a database where that lane's migration was
-- already applied this column was added by hand before the ledger could reach this file.
ALTER TABLE public.learning_live_feedback_turns ADD COLUMN IF NOT EXISTS probe_concept_id text;
