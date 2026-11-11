-- 0031 dropped and recreated learning_mastery_readings, and a dropped view takes its grants with it:
-- GrowthBook's read-only role (docs/specs/mastery-notifications-status.md S7) lost SELECT on the view
-- its live-reading fact table ftb_bkhj8zimvvaekoc reads. Restore it where the role exists.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'learner_growthbook') THEN
    GRANT SELECT ON public.learning_mastery_readings TO learner_growthbook;
  END IF;
END $$;
