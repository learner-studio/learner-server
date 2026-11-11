-- Drift panel items name their source grading by the runs table's own key type (review round 1, N4):
-- learning_concept_assessment_runs.run_id is text, so the join needs no cast and the reference is enforced.
ALTER TABLE public.learning_drift_panel_items ALTER COLUMN source_run_id TYPE text USING source_run_id::text;
ALTER TABLE public.learning_drift_panel_items
  ADD CONSTRAINT learning_drift_panel_items_source_run_fk FOREIGN KEY (source_run_id) REFERENCES public.learning_concept_assessment_runs(run_id);
