-- Honest mastery statistics (docs/specs/mastery-change-statistics.md): one migration for parts A-C,
-- so the three parallel lanes' migration numbers cannot collide.
--
-- A. The grader's model on the run digest, so the grader-noise estimate (identical evidence
-- graded more than once by the live model) never reads the ~240 kB snapshot (2 s → 0.2 s).
ALTER TABLE public.learning_concept_assessment_run_digests ADD COLUMN model text;
UPDATE public.learning_concept_assessment_run_digests d SET model = (r.snapshot#>>'{model,backend}') || '/' || (r.snapshot#>>'{model,model}') || '/' || (r.snapshot#>>'{model,effort}')
  FROM public.learning_concept_assessment_runs r WHERE r.run_id = d.run_id;
CREATE OR REPLACE FUNCTION public.learning_assessment_run_digest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.learning_concept_assessment_run_digests(run_id,prompt_revision,node_title,node_description,node_objectives,evidence_ids,experiment_id,model)
  VALUES (NEW.run_id, NEW.snapshot->>'promptRevision', NEW.snapshot#>>'{context,nodeStates,0,title}',
    NEW.snapshot#>>'{context,nodeStates,0,description}', NEW.snapshot#>'{context,nodeStates,0,objectives}',
    ARRAY(SELECT e->>'id' FROM jsonb_array_elements(CASE WHEN jsonb_typeof(NEW.snapshot->'evidence')='array' THEN NEW.snapshot->'evidence' ELSE '[]'::jsonb END) e),
    NEW.snapshot->>'experimentId',
    (NEW.snapshot#>>'{model,backend}') || '/' || (NEW.snapshot#>>'{model,model}') || '/' || (NEW.snapshot#>>'{model,effort}'));
  RETURN NEW;
END $$;


-- B. Replicate grading, policy `gradingReplicates`: at the default 1 none of these rows exist and
-- every reading is exactly what it was.
-- A plan row says a reading will be the mean of `replicates` independent gradings; the reading
-- stays out of learning_mastery_readings until its summary exists, so it is published once,
-- already averaged (never the first grading, then the mean).
CREATE TABLE public.learning_concept_assessment_replicate_plans (
  run_id text PRIMARY KEY REFERENCES public.learning_concept_assessment_runs(run_id) ON DELETE CASCADE,
  replicates smallint NOT NULL CHECK (replicates BETWEEN 2 AND 5),
  planned_at timestamptz NOT NULL DEFAULT now()
);
-- One row per extra grading (2..k; grading 1 is the run's own receipt). Reserved before the
-- model call: a reservation with no receipt is an attempt of unknown outcome and is never paid twice.
CREATE TABLE public.learning_concept_assessment_replicates (
  run_id text NOT NULL REFERENCES public.learning_concept_assessment_runs(run_id) ON DELETE CASCADE,
  replicate smallint NOT NULL CHECK (replicate BETWEEN 2 AND 5),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  receipt jsonb,
  PRIMARY KEY (run_id, replicate)
);
-- The published combination: raw mean (display_percent is the 5-point grid value the cache shows),
-- spread, the weakest confidence, and what all gradings of the reading cost.
CREATE TABLE public.learning_concept_assessment_replicate_summaries (
  run_id text PRIMARY KEY REFERENCES public.learning_concept_assessment_runs(run_id) ON DELETE CASCADE,
  replicates smallint NOT NULL,
  mean_percent numeric,
  display_percent smallint,
  sd numeric,
  min_percent numeric,
  max_percent numeric,
  confidence text,
  input_tokens bigint,
  output_tokens bigint,
  duration_ms bigint,
  combined_at timestamptz NOT NULL DEFAULT now()
);


-- C. osmosis-concept-holdout phases: the share (1 in `buckets`) and when it took effect. Changing
-- the share starts a new phase; the analysis reads the current phase's start and share, so history
-- is never silently reassigned. Phase 1 is the experiment as it started (S6, 2026-10-30).
CREATE TABLE public.learning_holdout_phases (
  experiment_key text NOT NULL,
  phase integer NOT NULL CHECK (phase >= 1),
  buckets smallint NOT NULL CHECK (buckets BETWEEN 2 AND 20),
  started_at timestamptz NOT NULL,
  PRIMARY KEY (experiment_key, phase)
);
INSERT INTO public.learning_holdout_phases VALUES ('osmosis-concept-holdout', 1, 5, '2026-10-30T18:05:00Z');


-- The readings view: 0018's columns and order, a replicate-averaged reading where one exists,
-- and two appended columns. A planned reading without its summary is not published yet.
CREATE OR REPLACE VIEW public.learning_mastery_readings AS
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
    s.mean_percent, s.confidence AS combined_confidence, s.replicates, s.sd AS replicate_sd
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
)
SELECT DISTINCT ON (pass_id, concept_id)
  run_id, user_id, concept_id, origin, pass_id, status,
  COALESCE(mean_percent, (assessment->>'understandingPercent')::numeric) AS understanding_percent,
  COALESCE(combined_confidence, assessment->>'confidence') AS confidence,
  completed_at, created_at, reused_run_id,
  COALESCE(evidence_at, completed_at) AS evidence_at,
  evidence_at IS NOT NULL AS evidence_dated,
  CASE WHEN evidence_at IS NULL THEN 'graded' ELSE evidence_basis END AS evidence_basis,
  COALESCE(replicates, 1)::integer AS replicates,
  replicate_sd
FROM live
ORDER BY pass_id, concept_id, part DESC, created_at DESC;
