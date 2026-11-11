-- The teaching targets a turn's guidance delivered (docs/specs/blind-probes.md, "Limits"): '{}' on a
-- decided turn that carried none, null on turns decided before this migration. Only the review and the
-- agent's own taughtConceptIds were stored, so "was this concept a target earlier in the session"
-- could not be answered from the table.
-- 0027 is left to another lane. IF NOT EXISTS: applied by hand on dev and learner_test after this
-- file was pushed, because 0021 is not on main and the ledger cannot run past it yet.
ALTER TABLE public.learning_live_feedback_turns ADD COLUMN IF NOT EXISTS guidance_concept_ids text[];
