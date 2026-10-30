-- Mastery notifications: completed_at at MILLISECOND precision. Clients receive it through
-- JSON (toISOString keeps milliseconds) and send it back as the exclusive `since` cursor; at
-- microsecond precision a reading at ...05.123456 is after a cursor of ...05.123, so a page ending
-- on a group that shares one completedAt was returned again forever once the group filled a page.
-- Readings within one millisecond now tie, and a page never splits a tie. (Found by learner-desktop.)
CREATE OR REPLACE VIEW public.learning_mastery_readings AS
WITH live AS (
  SELECT r.run_id, r.user_id, r.concept_id, r.created_at,
    CASE WHEN d.experiment_id IS NULL THEN 'manual' ELSE 'reactive' END AS origin,
    COALESCE(d.experiment_id, r.run_id) AS pass_id,
    COALESCE(a.part, 0) AS part,
    t.receipt->'assessment' AS assessment,
    t.receipt->>'status' AS status,
    t.receipt->>'reusedRunId' AS reused_run_id,
    date_trunc('milliseconds', GREATEST((t.receipt->>'completedAt')::timestamptz, t.completed_at, e.finished_at)) AS completed_at
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
  completed_at, created_at, reused_run_id
FROM live
ORDER BY pass_id, concept_id, part DESC, created_at DESC;
