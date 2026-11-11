-- Blind probes (docs/specs/blind-probes.md): every turn decided with probes on stores its probe
-- decision, not only a delivered probe. A turn is probed only when BOTH arms have a candidate, so
-- the analysis needs the draws that delivered nothing and why. Null on turns decided with probes off.
--   probe_outcome               why a probe was or was not delivered
--   probe_arm                   the turn's coin (set on every drawn turn, delivered or not)
--   probe_*_candidates          related concepts in each arm (set on every drawn turn)
--   probe_rate, probe_hops      the settings the decision was made under
-- IF NOT EXISTS / guarded constraints: applied by hand on dev and learner_test while 0021 and 0024
-- (other lanes) were not on main yet, so the ledger reaches this file after the columns exist.
ALTER TABLE public.learning_live_feedback_turns
  ADD COLUMN IF NOT EXISTS probe_outcome text,
  ADD COLUMN IF NOT EXISTS probe_arm text,
  ADD COLUMN IF NOT EXISTS probe_held_out_candidates integer,
  ADD COLUMN IF NOT EXISTS probe_taught_candidates integer,
  ADD COLUMN IF NOT EXISTS probe_rate smallint,
  ADD COLUMN IF NOT EXISTS probe_hops smallint;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learning_live_feedback_turns_probe_outcome_check') THEN
    ALTER TABLE public.learning_live_feedback_turns ADD CONSTRAINT learning_live_feedback_turns_probe_outcome_check
      CHECK (probe_outcome IN ('not_drawn', 'no_target', 'packet_full', 'arm_empty', 'size', 'not_injected', 'delivered'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learning_live_feedback_turns_probe_arm_check') THEN
    ALTER TABLE public.learning_live_feedback_turns ADD CONSTRAINT learning_live_feedback_turns_probe_arm_check
      CHECK (probe_arm IN ('held_out', 'taught'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'learning_live_feedback_turns_probe_delivered_check') THEN
    ALTER TABLE public.learning_live_feedback_turns ADD CONSTRAINT learning_live_feedback_turns_probe_delivered_check
      CHECK ((probe_concept_id IS NOT NULL) = (probe_outcome IS NOT DISTINCT FROM 'delivered') OR probe_outcome IS NULL);
  END IF;
END $$;
