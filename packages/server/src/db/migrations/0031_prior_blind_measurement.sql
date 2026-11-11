-- Prior-blind measurement (docs/specs/mastery-change-statistics.md, review B1/B2).
--
-- The live v6 grader revises its own published estimate: its prompt carries a
-- "### CURRENT PUBLISHED ESTIMATE" section, the grade follows that prior with slope 0.94 and almost
-- never goes below it (dev 2026-11-11: 72 % equal, 27 % up, 0.3 % down). A chain of such readings
-- rises with the number of gradings whether or not anything was learned, so no verdict can rest on
-- it. A PRIOR-BLIND grading (no numeric prior in the prompt) is truth plus independent noise.
--
-- 1. The digest records the numeric prior a run's prompt carries (`prior_percent`, null = the prompt
--    is prior-blind), so the noise components and the view never read the ~240 kB snapshot.
ALTER TABLE public.learning_concept_assessment_run_digests ADD COLUMN prior_percent numeric;
UPDATE public.learning_concept_assessment_run_digests d
  SET prior_percent = (r.snapshot #>> '{prior,understandingPercent}')::numeric
  FROM public.learning_concept_assessment_runs r
  WHERE r.run_id = d.run_id AND position('### CURRENT PUBLISHED ESTIMATE' in r.snapshot->>'prompt') > 0
    AND jsonb_typeof(r.snapshot #> '{prior,understandingPercent}') = 'number';
CREATE OR REPLACE FUNCTION public.learning_assessment_run_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.learning_concept_assessment_run_digests(run_id,prompt_revision,node_title,node_description,node_objectives,evidence_ids,experiment_id,model,prior_percent)
  VALUES (NEW.run_id, NEW.snapshot->>'promptRevision', NEW.snapshot#>>'{context,nodeStates,0,title}',
    NEW.snapshot#>>'{context,nodeStates,0,description}', NEW.snapshot#>'{context,nodeStates,0,objectives}',
    ARRAY(SELECT e->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.snapshot->'evidence')='array' THEN NEW.snapshot->'evidence' ELSE '[]'::jsonb END) e),
    NEW.snapshot->>'experimentId',
    (NEW.snapshot#>>'{model,backend}') || '/' || (NEW.snapshot#>>'{model,model}') || '/' || (NEW.snapshot#>>'{model,effort}'),
    CASE WHEN position('### CURRENT PUBLISHED ESTIMATE' in NEW.snapshot->>'prompt') > 0 AND jsonb_typeof(NEW.snapshot #> '{prior,understandingPercent}') = 'number'
      THEN (NEW.snapshot #>> '{prior,understandingPercent}')::numeric END);
  RETURN NEW;
END $$;

-- 2. Replicates are now PRIOR-BLIND gradings of the run's evidence (the service rewrites the prompt's
--    estimate section to 'none'), and a summary is the combination of the run's blind gradings: its
--    replicates when it has them, plus the run's own grading when that was prior-blind. `replicates`
--    may be 0 (no blind grading produced a number).
COMMENT ON TABLE public.learning_concept_assessment_replicate_summaries IS
  'Since 0031: the combination of a reading''s PRIOR-BLIND gradings (mean, sd, median confidence). The reading itself stays the live grading.';

-- 3. The readings view: a reading is the live grading again (never averaged with anything), and four
--    columns describe its prior-blind measurement. A planned reading still waits for its summary.
--    `replicates` and `replicate_sd` are dropped: nothing is averaged into understanding_percent.
DROP VIEW public.learning_mastery_readings;
CREATE VIEW public.learning_mastery_readings AS
WITH live AS (
  SELECT r.run_id, r.user_id, r.concept_id, r.created_at,
    CASE WHEN d.experiment_id IS NULL THEN 'manual' ELSE 'reactive' END AS origin,
    COALESCE(d.experiment_id, r.run_id) AS pass_id,
    COALESCE(a.part, 0) AS part,
    t.receipt->'assessment' AS assessment,
    t.receipt->>'status' AS status,
    t.receipt->>'reusedRunId' AS reused_run_id,
    date_trunc('milliseconds', GREATEST((t.receipt->>'completedAt')::timestamptz, t.completed_at, e.finished_at)) AS completed_at,
    date_trunc('milliseconds', x.evidence_at) AS evidence_at,
    x.basis AS evidence_basis,
    d.prior_percent,
    s.run_id IS NOT NULL AS has_summary, s.mean_percent, s.confidence AS summary_confidence, s.replicates AS summary_gradings, s.sd AS summary_sd
  FROM public.learning_concept_assessment_runs r
  JOIN public.learning_concept_assessment_run_digests d USING (run_id)
  JOIN public.learning_concept_assessment_receipts t USING (run_id)
  LEFT JOIN public.learning_concept_assessment_evidence_times x USING (run_id)
  LEFT JOIN public.learning_vector_turn_experiments e ON e.run_id::text = d.experiment_id
  LEFT JOIN public.learning_vector_turn_assessments a ON a.run_id = r.run_id
  LEFT JOIN public.learning_concept_assessment_replicate_plans p ON p.run_id = r.run_id
  LEFT JOIN public.learning_concept_assessment_replicate_summaries s ON s.run_id = r.run_id
  WHERE jsonb_typeof(t.receipt->'assessment') = 'object'
    AND (d.experiment_id IS NULL OR (e.config->>'purpose' = 'live' AND e.status = 'completed'))
    AND (p.run_id IS NULL OR s.run_id IS NOT NULL)
), shaped AS (
  SELECT *, (assessment->>'understandingPercent')::numeric AS own_percent,
    -- The run's own grading is prior-blind when its prompt carried no numeric prior and it graded
    -- afresh: an 'unchanged' copy re-publishes an earlier grade and is no new measurement.
    (prior_percent IS NULL AND status = 'completed') AS own_blind
  FROM live
)
SELECT DISTINCT ON (pass_id, concept_id)
  run_id, user_id, concept_id, origin, pass_id, status,
  own_percent AS understanding_percent,
  assessment->>'confidence' AS confidence,
  completed_at, created_at, reused_run_id,
  COALESCE(evidence_at, completed_at) AS evidence_at,
  evidence_at IS NOT NULL AS evidence_dated,
  CASE WHEN evidence_at IS NULL THEN 'graded' ELSE evidence_basis END AS evidence_basis,
  prior_percent,
  CASE WHEN has_summary THEN mean_percent WHEN own_blind THEN own_percent END AS blind_percent,
  CASE WHEN has_summary THEN summary_gradings WHEN own_blind AND own_percent IS NOT NULL THEN 1 ELSE 0 END::integer AS blind_gradings,
  CASE WHEN has_summary THEN summary_confidence WHEN own_blind THEN assessment->>'confidence' END AS blind_confidence,
  summary_sd AS blind_sd
FROM shaped
ORDER BY pass_id, concept_id, part DESC, created_at DESC;
