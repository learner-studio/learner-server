-- Mastery readings dated by EVIDENCE time (docs/specs/mastery-notifications.md, "Evidence time").
--
-- completed_at is when the GRADER ran, not when the learner said the thing: on dev the
-- median lag between the newest cited message and the grading is 45 days, so anything
-- windowed by completed_at plots the grading backlog, not learning. evidence_at is the
-- time of the newest evidence a reading rests on:
--   'cited'        the newest message the assessment cites under `demonstrated`
--                  (sourceId = the id of an item in the run's own evidence snapshot);
--   'evidence_set' no citation (dev: 417 of 1,046 medium/high readings cite nothing):
--                  the newest learner-authored message in the run's evidence set, else
--                  the newest message of any role;
--   'graded'       no usable evidence time: evidence_at falls back to completed_at and
--                  evidence_dated is false.
-- An epoch-zero time (1,694 index messages carry 1970-01-01) is missing, not a date.
-- An 'unchanged' receipt takes the evidence time of the run it copied.
--
-- The times come from the run snapshot (~240 kB a run), which the view must never read
-- (0015: 26 s → 0.26 s), so they are computed once, when the receipt is written, into a
-- side table. Receipts are immutable, so a row never goes stale.
CREATE TABLE public.learning_concept_assessment_evidence_times (
  run_id text PRIMARY KEY REFERENCES public.learning_concept_assessment_receipts(run_id) ON DELETE CASCADE,
  evidence_at timestamptz,
  basis text NOT NULL CHECK (basis IN ('cited', 'evidence_set', 'none'))
);

-- Never raises: a malformed snapshot yields (NULL, 'none'), it must not fail a grading.
CREATE FUNCTION public.learning_assessment_evidence_time(p_run_id text, p_receipt jsonb, OUT evidence_at timestamptz, OUT basis text)
LANGUAGE plpgsql STABLE AS $$
BEGIN
  WITH ev AS (
    SELECT e->>'id' AS id, e->>'role' AS role, (e->>'occurredAt')::timestamptz AS at
    FROM public.learning_concept_assessment_runs r,
      jsonb_array_elements(CASE WHEN jsonb_typeof(r.snapshot->'evidence') = 'array' THEN r.snapshot->'evidence' ELSE '[]'::jsonb END) e
    WHERE r.run_id = p_run_id
  ), dated AS (SELECT * FROM ev WHERE at >= '1971-01-01'::timestamptz),
  cited AS (
    SELECT max(d.at) AS at FROM dated d
    WHERE d.id IN (SELECT c->>'sourceId' FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_receipt #> '{assessment,demonstrated}') = 'array' THEN p_receipt #> '{assessment,demonstrated}' ELSE '[]'::jsonb END) c)
  ), whole AS (SELECT max(at) FILTER (WHERE role = 'user') AS learner_at, max(at) AS any_at FROM dated)
  SELECT COALESCE(cited.at, whole.learner_at, whole.any_at),
    CASE WHEN cited.at IS NOT NULL THEN 'cited' WHEN whole.any_at IS NOT NULL THEN 'evidence_set' ELSE 'none' END
  INTO evidence_at, basis FROM cited, whole;
EXCEPTION WHEN OTHERS THEN
  evidence_at := NULL; basis := 'none';
END $$;

CREATE FUNCTION public.learning_assessment_receipt_evidence_time() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE found_at timestamptz; found_basis text;
BEGIN
  IF jsonb_typeof(NEW.receipt->'assessment') IS DISTINCT FROM 'object' THEN RETURN NEW; END IF;
  -- A copy takes its origin's time: the copied row already holds ITS origin's, so one hop is the chain.
  IF NEW.receipt->>'status' = 'unchanged' AND NEW.receipt->>'reusedRunId' IS NOT NULL THEN
    SELECT x.evidence_at, x.basis INTO found_at, found_basis
    FROM public.learning_concept_assessment_evidence_times x WHERE x.run_id = NEW.receipt->>'reusedRunId' AND x.evidence_at IS NOT NULL;
  END IF;
  IF found_at IS NULL THEN
    SELECT f.evidence_at, f.basis INTO found_at, found_basis FROM public.learning_assessment_evidence_time(NEW.run_id, NEW.receipt) f;
  END IF;
  INSERT INTO public.learning_concept_assessment_evidence_times(run_id, evidence_at, basis)
  VALUES (NEW.run_id, found_at, COALESCE(found_basis, 'none')) ON CONFLICT (run_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_assessment_receipt_evidence_time AFTER INSERT ON public.learning_concept_assessment_receipts
  FOR EACH ROW EXECUTE FUNCTION public.learning_assessment_receipt_evidence_time();

-- Backfill: every receipt's own evidence first, then each copy takes the origin at the end of its chain.
INSERT INTO public.learning_concept_assessment_evidence_times(run_id, evidence_at, basis)
SELECT t.run_id, f.evidence_at, f.basis
FROM public.learning_concept_assessment_receipts t, LATERAL public.learning_assessment_evidence_time(t.run_id, t.receipt) f
WHERE jsonb_typeof(t.receipt->'assessment') = 'object';
WITH RECURSIVE chain AS (
  SELECT t.run_id, t.receipt->>'reusedRunId' AS src, 0 AS depth FROM public.learning_concept_assessment_receipts t
  WHERE t.receipt->>'status' = 'unchanged' AND t.receipt->>'reusedRunId' IS NOT NULL
  UNION ALL
  SELECT c.run_id, t.receipt->>'reusedRunId', c.depth + 1
  FROM chain c JOIN public.learning_concept_assessment_receipts t ON t.run_id = c.src
  WHERE t.receipt->>'status' = 'unchanged' AND t.receipt->>'reusedRunId' IS NOT NULL AND c.depth < 100
), origin AS (SELECT DISTINCT ON (run_id) run_id, src FROM chain ORDER BY run_id, depth DESC)
UPDATE public.learning_concept_assessment_evidence_times x SET evidence_at = s.evidence_at, basis = s.basis
FROM origin o JOIN public.learning_concept_assessment_evidence_times s ON s.run_id = o.src
WHERE x.run_id = o.run_id AND s.evidence_at IS NOT NULL AND (x.evidence_at, x.basis) IS DISTINCT FROM (s.evidence_at, s.basis);

-- completed_at is unchanged: the notification feed's cursor pages by it. The new columns are
-- appended (a replaced view keeps its columns in order). Milliseconds, like completed_at.
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
    x.basis AS evidence_basis
  FROM public.learning_concept_assessment_runs r
  JOIN public.learning_concept_assessment_run_digests d USING (run_id)
  JOIN public.learning_concept_assessment_receipts t USING (run_id)
  LEFT JOIN public.learning_concept_assessment_evidence_times x USING (run_id)
  LEFT JOIN public.learning_vector_turn_experiments e ON e.run_id::text = d.experiment_id
  LEFT JOIN public.learning_vector_turn_assessments a ON a.run_id = r.run_id
  WHERE jsonb_typeof(t.receipt->'assessment') = 'object'
    AND (d.experiment_id IS NULL OR (e.config->>'purpose' = 'live' AND e.status = 'completed'))
)
SELECT DISTINCT ON (pass_id, concept_id)
  run_id, user_id, concept_id, origin, pass_id, status,
  (assessment->>'understandingPercent')::numeric AS understanding_percent,
  assessment->>'confidence' AS confidence,
  completed_at, created_at, reused_run_id,
  COALESCE(evidence_at, completed_at) AS evidence_at,
  evidence_at IS NOT NULL AS evidence_dated,
  CASE WHEN evidence_at IS NULL THEN 'graded' ELSE evidence_basis END AS evidence_basis
FROM live
ORDER BY pass_id, concept_id, part DESC, created_at DESC;
