-- Blind probes (docs/specs/blind-probes.md), review rounds 3 and 4: two stored-shape rules that
-- were only true by convention.
--   probe_concept_hops is the delivered concept's distance, so it exists only on a delivered probe.
--   fail_open means nothing was drawn, so it carries no arm, no candidate counts and no concept.
-- One direction only for the first rule (a delivered probe may lack its hops): rows and test
-- fixtures from before 0026 store delivered probes without them.
-- Idempotent (drop-then-add): applied by hand on dev and learner_test after this file was pushed.
ALTER TABLE public.learning_live_feedback_turns DROP CONSTRAINT IF EXISTS learning_live_feedback_turns_probe_concept_hops_check;
ALTER TABLE public.learning_live_feedback_turns ADD CONSTRAINT learning_live_feedback_turns_probe_concept_hops_check
  CHECK (probe_concept_hops IS NULL OR probe_outcome IS NOT DISTINCT FROM 'delivered');

ALTER TABLE public.learning_live_feedback_turns DROP CONSTRAINT IF EXISTS learning_live_feedback_turns_probe_fail_open_check;
ALTER TABLE public.learning_live_feedback_turns ADD CONSTRAINT learning_live_feedback_turns_probe_fail_open_check
  CHECK (probe_outcome IS DISTINCT FROM 'fail_open'
    OR (probe_arm IS NULL AND probe_held_out_candidates IS NULL AND probe_taught_candidates IS NULL AND probe_concept_id IS NULL));
