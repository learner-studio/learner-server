-- CI test devices (docs/specs/server-desktop-pairing.md, "One-paste pairing and CI test devices").
-- A row here IS the test flag: the device user it names reads only its own mastery, is confined
-- to a handful of RPCs, and is deleted with every row it wrote. A revoked row stays a day as a
-- tombstone, so the creation rate limit counts it and the sweep can purge a late write.
CREATE TABLE public.learner_test_devices (
  client_id text PRIMARY KEY CHECK (client_id ~ '^ci-[a-z0-9-]+-[0-9a-f]{8}$'),
  user_id text NOT NULL UNIQUE,
  run_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX learner_test_devices_created_at_idx ON public.learner_test_devices (created_at);

-- The one predicate a cross-user read uses to leave test devices out.
CREATE FUNCTION public.learner_test_user(p_user text) RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.learner_test_devices WHERE user_id = p_user) $$;

-- Assessment runs and receipts stay immutable (0007), with one more scoped exception: under
-- SET LOCAL learner.test_device_purge = 'on', a DELETE of a run or receipt whose run belongs to a
-- REVOKED test device's own user (its email is <client_id>@devices.learner.invalid). The database
-- itself refuses any other row, whatever the caller asks.
CREATE OR REPLACE FUNCTION public.learning_assessment_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purge text := current_setting('learner.curriculum_purge', true);
  concept text;
  run_user text;
BEGIN
  IF TG_OP = 'DELETE' AND purge IS NOT NULL AND purge <> '' THEN
    IF TG_TABLE_NAME = 'learning_concept_assessment_runs' THEN
      concept := OLD.concept_id;
    ELSE
      SELECT r.concept_id INTO concept FROM public.learning_concept_assessment_runs r WHERE r.run_id = OLD.run_id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.learning_curriculum_purge_concepts c
               WHERE c.purge_id = purge::uuid AND c.concept_id = concept) THEN
      RETURN OLD;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('learner.test_device_purge', true) = 'on'
     AND TG_TABLE_NAME IN ('learning_concept_assessment_runs', 'learning_concept_assessment_receipts') THEN
    IF TG_TABLE_NAME = 'learning_concept_assessment_runs' THEN
      run_user := OLD.user_id;
    ELSE
      SELECT r.user_id INTO run_user FROM public.learning_concept_assessment_runs r WHERE r.run_id = OLD.run_id;
    END IF;
    IF EXISTS (SELECT 1 FROM public.learner_test_devices t JOIN public."user" u ON u.id = t.user_id
               WHERE t.user_id = run_user AND t.revoked_at IS NOT NULL AND u.email = t.client_id || '@devices.learner.invalid') THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'Learning assessment evidence and receipts are immutable';
END $$;
