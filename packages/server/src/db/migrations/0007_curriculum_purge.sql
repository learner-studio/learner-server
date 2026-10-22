-- Deleting a curriculum is a purge: its tree, its concepts, every score and
-- every grading record made against them. One row per purge is the audit
-- record (who, when, what was removed); its frozen concept set is what a
-- resumed purge works from after the curriculum row itself is gone.
CREATE TABLE public.learning_curriculum_purges (
  purge_id uuid PRIMARY KEY,
  curriculum_id text NOT NULL,
  title text,
  source_kind text,
  requested_by text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen','completed')),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX learning_curriculum_purges_curriculum_idx ON public.learning_curriculum_purges (curriculum_id);

CREATE TABLE public.learning_curriculum_purge_concepts (
  purge_id uuid NOT NULL REFERENCES public.learning_curriculum_purges(purge_id) ON DELETE CASCADE,
  concept_id text NOT NULL,
  PRIMARY KEY (purge_id, concept_id)
);

-- Assessment runs, receipts and attempts stay immutable: UPDATE is always
-- refused. A DELETE passes only inside a transaction that names a purge
-- (SET LOCAL learner.curriculum_purge) and only for a row whose concept is in
-- that purge's frozen set. Nothing else can delete grading history.
CREATE OR REPLACE FUNCTION public.learning_assessment_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  purge text := current_setting('learner.curriculum_purge', true);
  concept text;
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
  RAISE EXCEPTION 'Learning assessment evidence and receipts are immutable';
END $$;
