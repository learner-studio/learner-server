-- Admission state only. Original transcript bytes remain in the lossless archive.
CREATE TABLE learning_active_archive_sessions (
  user_id text NOT NULL,
  session_id uuid NOT NULL,
  requested_generation bigint NOT NULL DEFAULT 0,
  captured_generation bigint NOT NULL DEFAULT 0,
  dispatch_id uuid,
  run_id uuid,
  active_slot integer UNIQUE CHECK (active_slot BETWEEN 1 AND 3),
  attempts integer NOT NULL DEFAULT 0,
  last_notified_at timestamptz NOT NULL DEFAULT now(),
  last_finished_at timestamptz,
  last_run_id uuid,
  last_failure text,
  PRIMARY KEY(user_id,session_id),
  CHECK (captured_generation <= requested_generation),
  CHECK (attempts BETWEEN 0 AND 3)
);
CREATE TABLE learning_active_archive_notifications (
  invocation_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learning_active_archive_dirty ON learning_active_archive_sessions(last_notified_at)
  WHERE requested_generation > captured_generation;
-- A lost start acknowledgement must not create a second resumable workflow.
CREATE UNIQUE INDEX learning_archive_dispatch_identity ON learner_workflow_runs ((input::jsonb->>'dispatchId'))
  WHERE workflow='learningCoalescedArchiveWorkflow';
