-- The few small fields the live hook reads from an assessment run, kept beside it.
-- A run's snapshot averages ~240 kB of TOASTed JSON (it carries the full evidence),
-- so reading promptRevision, the frozen node and the evidence ids out of it on every
-- lookup decompressed ~100 MB per hook turn (~1.6 s). Runs are immutable (see
-- learning_assessment_run_immutable), so the digest is written once, at insert.
CREATE TABLE public.learning_concept_assessment_run_digests (
  run_id text PRIMARY KEY REFERENCES public.learning_concept_assessment_runs(run_id) ON DELETE CASCADE,
  prompt_revision text,
  node_title text,
  node_description text,
  node_objectives jsonb,
  evidence_ids text[] NOT NULL
);

CREATE FUNCTION public.learning_assessment_run_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.learning_concept_assessment_run_digests(run_id,prompt_revision,node_title,node_description,node_objectives,evidence_ids)
  VALUES (NEW.run_id, NEW.snapshot->>'promptRevision', NEW.snapshot#>>'{context,nodeStates,0,title}',
    NEW.snapshot#>>'{context,nodeStates,0,description}', NEW.snapshot#>'{context,nodeStates,0,objectives}',
    ARRAY(SELECT e->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.snapshot->'evidence')='array' THEN NEW.snapshot->'evidence' ELSE '[]'::jsonb END) e));
  RETURN NEW;
END $$;

CREATE TRIGGER learning_assessment_run_digest AFTER INSERT ON public.learning_concept_assessment_runs
  FOR EACH ROW EXECUTE FUNCTION public.learning_assessment_run_digest();

INSERT INTO public.learning_concept_assessment_run_digests(run_id,prompt_revision,node_title,node_description,node_objectives,evidence_ids)
SELECT run_id, s->>'promptRevision', s#>>'{context,nodeStates,0,title}', s#>>'{context,nodeStates,0,description}', s#>'{context,nodeStates,0,objectives}',
  ARRAY(SELECT e->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s->'evidence')='array' THEN s->'evidence' ELSE '[]'::jsonb END) e)
FROM (SELECT run_id, snapshot AS s FROM public.learning_concept_assessment_runs) runs;
