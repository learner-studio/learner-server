-- learning_blind_measurements, second version (review round 6, S-1). The holdout headline's
-- follow-up is the answer to a concept's FIRST delivered probe since the holdout start, the probe
-- analysis's k = 1 (learning-blind-probes.ts probeAnswerEvidenceSql with `firstSince`). 0032's
-- version only flagged "answers some probe", so GrowthBook's fact table took the first such reading
-- and fell through to probe 2, 3, … when the first probe produced none: the testing effect again.
--
-- Same contract as 0032 (ids, times and numbers only; runs as its owner; GrowthBook's read-only role
-- may execute it), plus the holdout start and a `first_probe` column. The body is the server's
-- countedMeasurements SQL as rendered from the TypeScript on 2026-11-11 with $1 = p_user,
-- $2 = p_probes_since; mastery-holdout-growthbook.integration.test.ts holds the two equal.
DROP FUNCTION IF EXISTS public.learning_blind_measurements(text);
CREATE OR REPLACE FUNCTION public.learning_blind_measurements(p_user text, p_probes_since timestamptz)
RETURNS TABLE (concept_id text, evidence_at timestamptz, blind_percent numeric, blind_gradings integer, blind_runs integer, gradings integer, probe boolean, first_probe boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
SELECT b.concept_id, b.evidence_at, b.blind_percent, b.blind_gradings, b.blind_runs, b.gradings, b.probe, b.first_probe FROM (
SELECT m.concept_id, m.evidence_at, m.blind_percent, m.blind_gradings, m.blind_runs, m.gradings,
       (COALESCE(m.learner_dated, false) AND EXISTS (SELECT 1 FROM learning_live_feedback_turns p
  CROSS JOIN LATERAL (SELECT a.created_at, a.feedback FROM learning_live_feedback_turns a WHERE a.user_id = p.user_id AND a.session_id = p.session_id AND (a.created_at, a.turn_id) > (p.created_at, p.turn_id) ORDER BY a.created_at, a.turn_id LIMIT 1) a
  WHERE p.user_id = p_user AND p.probe_outcome = 'delivered' AND p.probe_concept_id = m.concept_id
    AND a.feedback IS NOT NULL AND NOT COALESCE(jsonb_exists(CASE WHEN jsonb_typeof(a.feedback->'taughtConceptIds') = 'array' THEN a.feedback->'taughtConceptIds' ELSE '[]' END, p.probe_concept_id), false)
    AND m.evidence_at > p.created_at AND m.evidence_at <= a.created_at + interval '2 minutes')) AS probe,
       (COALESCE(m.learner_dated, false) AND EXISTS (SELECT 1 FROM learning_live_feedback_turns p
  CROSS JOIN LATERAL (SELECT a.created_at, a.feedback FROM learning_live_feedback_turns a WHERE a.user_id = p.user_id AND a.session_id = p.session_id AND (a.created_at, a.turn_id) > (p.created_at, p.turn_id) ORDER BY a.created_at, a.turn_id LIMIT 1) a
  WHERE p.user_id = p_user AND p.probe_outcome = 'delivered' AND p.probe_concept_id = m.concept_id
    AND a.feedback IS NOT NULL AND NOT COALESCE(jsonb_exists(CASE WHEN jsonb_typeof(a.feedback->'taughtConceptIds') = 'array' THEN a.feedback->'taughtConceptIds' ELSE '[]' END, p.probe_concept_id), false)
    AND m.evidence_at > p.created_at AND m.evidence_at <= a.created_at + interval '2 minutes'
    AND p.created_at >= p_probes_since AND NOT EXISTS (SELECT 1 FROM learning_live_feedback_turns q
      WHERE q.user_id = p.user_id AND q.probe_outcome = 'delivered' AND q.probe_concept_id = p.probe_concept_id
        AND q.created_at >= p_probes_since AND (q.created_at, q.turn_id) < (p.created_at, p.turn_id)))) AS first_probe
     FROM (
  SELECT r.concept_id, r.dated_at AS evidence_at,
    avg(r.understanding_percent) FILTER (WHERE (r.confidence IN ('medium','high') AND r.understanding_percent IS NOT NULL)) AS understanding_percent,
    count(*) FILTER (WHERE (r.confidence IN ('medium','high') AND r.understanding_percent IS NOT NULL))::int AS live_gradings,
    sum(r.blind_percent * r.blind_gradings) FILTER (WHERE (r.blind_gradings > 0 AND r.blind_percent IS NOT NULL AND r.blind_confidence IN ('medium','high'))) / NULLIF(sum(r.blind_gradings) FILTER (WHERE (r.blind_gradings > 0 AND r.blind_percent IS NOT NULL AND r.blind_confidence IN ('medium','high'))), 0) AS blind_percent,
    COALESCE(sum(r.blind_gradings) FILTER (WHERE (r.blind_gradings > 0 AND r.blind_percent IS NOT NULL AND r.blind_confidence IN ('medium','high'))), 0)::int AS blind_gradings,
    count(*) FILTER (WHERE (r.blind_gradings > 0 AND r.blind_percent IS NOT NULL AND r.blind_confidence IN ('medium','high')))::int AS blind_runs,
    CASE WHEN count(*) FILTER (WHERE (r.blind_gradings > 0 AND r.blind_percent IS NOT NULL AND r.blind_confidence IN ('medium','high'))) > 0 THEN 'medium' END AS blind_confidence,
    max(r.live_index)::int AS gradings,
    COALESCE(bool_and(r.confidence = 'high') FILTER (WHERE (r.confidence IN ('medium','high') AND r.understanding_percent IS NOT NULL)), false) AS clear,
    CASE WHEN bool_and(r.confidence = 'high') FILTER (WHERE (r.confidence IN ('medium','high') AND r.understanding_percent IS NOT NULL)) THEN 'high' ELSE 'medium' END AS confidence,
    bool_or(r.cited_learner_at IS NOT NULL) AS cited,
    bool_and(r.evidence_dated) AS evidence_dated,
    bool_or(date_trunc('milliseconds', r.cited_learner_at) = r.dated_at) AS learner_dated,
    min(r.completed_at) AS completed_at, min(r.created_at) AS created_at,
    (array_agg(r.run_id ORDER BY r.completed_at, r.created_at, r.run_id))[1] AS run_id
  FROM (SELECT x.*, count(*) OVER (PARTITION BY x.concept_id ORDER BY x.dated_at RANGE UNBOUNDED PRECEDING) AS live_index FROM (
  SELECT v.*, ev.cited_learner_at,
    CASE WHEN v.evidence_basis = 'evidence_set' THEN COALESCE(ev.learner_p75, v.evidence_at) ELSE v.evidence_at END AS dated_at
  FROM (
  WITH RECURSIVE mine AS (SELECT * FROM learning_mastery_readings WHERE user_id = p_user),
  chain AS (
    SELECT m.run_id, m.reused_run_id AS src, 0 AS depth, ARRAY[m.run_id, m.reused_run_id] AS path, m.reused_run_id = m.run_id AS cyc
    FROM mine m WHERE m.status = 'unchanged' AND m.reused_run_id IS NOT NULL
    UNION ALL
    SELECT c.run_id, t.receipt->>'reusedRunId', c.depth + 1, c.path || (t.receipt->>'reusedRunId'), (t.receipt->>'reusedRunId') = ANY(c.path)
    FROM chain c JOIN learning_concept_assessment_receipts t ON t.run_id = c.src
    WHERE NOT c.cyc AND t.receipt->>'status' = 'unchanged' AND t.receipt->>'reusedRunId' IS NOT NULL
  ), origin AS (
    SELECT DISTINCT ON (run_id) run_id,
      CASE WHEN cyc THEN (SELECT min(e) FROM unnest(path[array_position(path, src):cardinality(path) - 1]) e) ELSE src END AS src
    FROM chain ORDER BY run_id, depth DESC)
  SELECT DISTINCT ON (m.concept_id, COALESCE(o.src, m.run_id)) m.*
  FROM mine m LEFT JOIN origin o USING (run_id)
  ORDER BY m.concept_id, COALESCE(o.src, m.run_id), m.completed_at, m.created_at, m.run_id) v
  LEFT JOIN LATERAL (
    SELECT max(e.at) FILTER (WHERE e.role = 'user' AND e.id = ANY(cid.ids)) AS cited_learner_at,
      percentile_disc(0.75) WITHIN GROUP (ORDER BY e.at) FILTER (WHERE e.role = 'user') AS learner_p75
    FROM (SELECT ARRAY(SELECT c->>'sourceId' FROM learning_concept_assessment_receipts t,
            jsonb_array_elements(CASE WHEN jsonb_typeof(t.receipt #> '{assessment,demonstrated}') = 'array' THEN t.receipt #> '{assessment,demonstrated}' ELSE '[]'::jsonb END) c
            WHERE t.run_id = v.run_id AND v.confidence IN ('medium','high')) AS ids) cid,
      LATERAL (SELECT m->>'id' AS id, m->>'role' AS role, (m->>'occurredAt')::timestamptz AS at
        FROM learning_concept_assessment_runs u,
          jsonb_array_elements(CASE WHEN jsonb_typeof(u.snapshot->'evidence') = 'array' THEN u.snapshot->'evidence' ELSE '[]'::jsonb END) m
        WHERE u.run_id = v.run_id AND v.confidence IN ('medium','high') AND v.understanding_percent IS NOT NULL
          AND m->>'occurredAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}') e
    WHERE e.at >= '1971-01-01'::timestamptz
  ) ev ON true) x) r
  WHERE (r.confidence IN ('medium','high') AND r.understanding_percent IS NOT NULL) OR (r.blind_gradings > 0 AND r.blind_percent IS NOT NULL AND r.blind_confidence IN ('medium','high'))
  GROUP BY r.concept_id, r.dated_at) m
) b
WHERE b.blind_percent IS NOT NULL AND b.blind_gradings > 0
$fn$;

REVOKE ALL ON FUNCTION public.learning_blind_measurements(text, timestamptz) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'learner_growthbook') THEN
    GRANT EXECUTE ON FUNCTION public.learning_blind_measurements(text, timestamptz) TO learner_growthbook;
  END IF;
END $$;
