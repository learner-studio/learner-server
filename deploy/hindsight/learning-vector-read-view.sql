-- Learner-owned read-only integration view; no upstream Hindsight code changes.
-- Run against the dedicated hindsight database on the existing PostgreSQL server.
-- The learner role cannot read other banks or original Hindsight tables through this grant.
CREATE OR REPLACE VIEW public.learner_learning_vectors AS
SELECT document_id, embedding
FROM public.memory_units
WHERE bank_id='learning-live-archive-v1' AND fact_type='world' AND embedding IS NOT NULL;
GRANT SELECT ON public.learner_learning_vectors TO learner;
