-- A live assessment run stores its evidence as references and no prompt (2026-11-13): ~235 kB of copied message text
-- per run grew this table ~6 GB/day. The prompt is rebuilt from the run's pass when needed (frozenRun). A live run's
-- prompt is a v6 incremental one, which always carries the estimate section, so its revision stands in for the text.
CREATE OR REPLACE FUNCTION public.learning_assessment_run_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.learning_concept_assessment_run_digests(run_id,prompt_revision,node_title,node_description,node_objectives,evidence_ids,experiment_id,model,prior_percent)
  VALUES (NEW.run_id, NEW.snapshot->>'promptRevision', NEW.snapshot#>>'{context,nodeStates,0,title}',
    NEW.snapshot#>>'{context,nodeStates,0,description}', NEW.snapshot#>'{context,nodeStates,0,objectives}',
    ARRAY(SELECT e->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.snapshot->'evidence')='array' THEN NEW.snapshot->'evidence' ELSE '[]'::jsonb END) e),
    NEW.snapshot->>'experimentId',
    (NEW.snapshot#>>'{model,backend}') || '/' || (NEW.snapshot#>>'{model,model}') || '/' || (NEW.snapshot#>>'{model,effort}'),
    CASE WHEN COALESCE(position('### CURRENT PUBLISHED ESTIMATE' in NEW.snapshot->>'prompt') > 0, NEW.snapshot->>'promptRevision' LIKE 'gradual-understanding-v6-prior-aware-incremental%')
      AND jsonb_typeof(NEW.snapshot #> '{prior,understandingPercent}') = 'number'
      THEN (NEW.snapshot #>> '{prior,understandingPercent}')::numeric END);
  RETURN NEW;
END $$;
