-- Blind probes (docs/specs/blind-probes.md), review round 2.
--   probe_concept_hops   the delivered concept's own distance from the turn's concepts (probe_hops is
--                        the setting). The graph is not versioned, so the distance is stored.
--   probe_outcome        gains 'fail_open': the guidance lookup failed while probes were on, so nothing
--                        was drawn. Without it such a turn looks like one decided with probes off.
-- Idempotent (IF NOT EXISTS, drop-then-add): applied by hand on dev and learner_test after this file
-- was pushed, because 0021 (another lane) is not on main and the ledger cannot run past it yet.
ALTER TABLE public.learning_live_feedback_turns ADD COLUMN IF NOT EXISTS probe_concept_hops smallint;

ALTER TABLE public.learning_live_feedback_turns DROP CONSTRAINT IF EXISTS learning_live_feedback_turns_probe_outcome_check;
ALTER TABLE public.learning_live_feedback_turns ADD CONSTRAINT learning_live_feedback_turns_probe_outcome_check
  CHECK (probe_outcome IN ('not_drawn', 'no_target', 'packet_full', 'arm_empty', 'size', 'not_injected', 'delivered', 'fail_open'));
