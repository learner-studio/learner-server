-- Shared coalescer, separate global single-slot lane for local embedding.
CREATE TABLE learning_index_admission (LIKE learning_active_archive_sessions INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE learning_index_admission ADD PRIMARY KEY(user_id,session_id);
ALTER TABLE learning_index_admission ADD UNIQUE(active_slot);
ALTER TABLE learning_index_admission ADD CHECK(active_slot=1);
CREATE TABLE learning_index_notifications (LIKE learning_active_archive_notifications INCLUDING ALL);
CREATE UNIQUE INDEX learning_index_dispatch_identity ON learner_workflow_runs ((input::jsonb->>'dispatchId'))
  WHERE workflow='learningSemanticIndexWorkflow' AND input::jsonb->>'dispatchId' IS NOT NULL;
