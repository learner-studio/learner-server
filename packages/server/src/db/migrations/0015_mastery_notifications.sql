-- Mastery notifications (docs/specs/mastery-notifications.md, S1).
--
-- learning_mastery_readings: the history of LIVE mastery readings, one row per
-- published pass and concept. History already exists in the immutable run +
-- receipt rows, so this is a view, not a table. A reading is live when:
--   * manual: the run has no snapshot experimentId (startLearningConceptAssessment);
--   * reactive: its experimentId names a vector-turn pass with config purpose
--     'live' that finished (status 'completed'). An unfinished or abandoned pass
--     never published, so its parts are not readings (replay: 11 of 1,101 cache
--     rows disagreed until that condition was added, 0 after).
-- Comparison and grading experiments (other purposes, or an experimentId with no
-- vector-turn pass) are excluded. A multi-part pass publishes its LAST part that
-- carries an assessment (a failed final part leaves the earlier one), so that is
-- the row kept. Note: learning_reactive_admission.dispatch_id is cleared once a
-- pass settles, so it cannot identify reactive runs after the fact.
-- The run's experimentId, beside the other digested fields (0010): reading it from the
-- ~240 kB snapshot of every run made the first version of this view take 26 s.
ALTER TABLE public.learning_concept_assessment_run_digests ADD COLUMN experiment_id text;
UPDATE public.learning_concept_assessment_run_digests d SET experiment_id = r.snapshot->>'experimentId'
  FROM public.learning_concept_assessment_runs r WHERE r.run_id = d.run_id AND r.snapshot ? 'experimentId';
CREATE OR REPLACE FUNCTION public.learning_assessment_run_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.learning_concept_assessment_run_digests(run_id,prompt_revision,node_title,node_description,node_objectives,evidence_ids,experiment_id)
  VALUES (NEW.run_id, NEW.snapshot->>'promptRevision', NEW.snapshot#>>'{context,nodeStates,0,title}',
    NEW.snapshot#>>'{context,nodeStates,0,description}', NEW.snapshot#>'{context,nodeStates,0,objectives}',
    ARRAY(SELECT e->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.snapshot->'evidence')='array' THEN NEW.snapshot->'evidence' ELSE '[]'::jsonb END) e),
    NEW.snapshot->>'experimentId');
  RETURN NEW;
END $$;
CREATE INDEX learning_concept_assessment_runs_user_concept ON public.learning_concept_assessment_runs (user_id, concept_id);

CREATE OR REPLACE VIEW public.learning_mastery_readings AS
WITH live AS (
  SELECT r.run_id, r.user_id, r.concept_id, r.created_at,
    CASE WHEN d.experiment_id IS NULL THEN 'manual' ELSE 'reactive' END AS origin,
    COALESCE(d.experiment_id, r.run_id) AS pass_id,
    COALESCE(a.part, 0) AS part,
    t.receipt->'assessment' AS assessment,
    t.receipt->>'status' AS status,
    COALESCE((t.receipt->>'completedAt')::timestamptz, t.completed_at) AS completed_at
  FROM public.learning_concept_assessment_runs r
  JOIN public.learning_concept_assessment_run_digests d USING (run_id)
  JOIN public.learning_concept_assessment_receipts t USING (run_id)
  LEFT JOIN public.learning_vector_turn_experiments e ON e.run_id::text = d.experiment_id
  LEFT JOIN public.learning_vector_turn_assessments a ON a.run_id = r.run_id
  WHERE jsonb_typeof(t.receipt->'assessment') = 'object'
    AND (d.experiment_id IS NULL OR (e.config->>'purpose' = 'live' AND e.status = 'completed'))
)
SELECT DISTINCT ON (pass_id, concept_id)
  run_id, user_id, concept_id, origin, pass_id, status,
  (assessment->>'understandingPercent')::numeric AS understanding_percent,
  assessment->>'confidence' AS confidence,
  completed_at, created_at
FROM live
ORDER BY pass_id, concept_id, part DESC, created_at DESC;

-- What the person did with a notification. One row per (run, action): a
-- replayed submit is a no-op. 'ignored' is recorded by the desktop after 8 s.
CREATE TABLE public.learning_notification_feedback (
  run_id text NOT NULL REFERENCES public.learning_concept_assessment_receipts(run_id),
  action text NOT NULL CHECK (action IN ('opened','nice','not_right','ignored')),
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, action)
);
