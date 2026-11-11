-- The guidance text a turn's decision delivered, stored in the statement that claims the decision, so a
-- retried submission after a restart answers exactly what was decided (and recorded as a blind probe)
-- without recomputing it from state that may have moved. Null on a not-injected turn and on turns decided
-- before this column existed.
ALTER TABLE public.learning_live_feedback_turns ADD COLUMN guidance_context text;
