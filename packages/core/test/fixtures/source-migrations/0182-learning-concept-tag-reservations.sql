-- Additive only: legacy manifests and JSON receipts are never rewritten.
CREATE TABLE learning_concept_tag_budgets (
 run_id uuid PRIMARY KEY REFERENCES learning_concept_tag_experiments(run_id) ON DELETE CASCADE,
 reserved_count integer NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
 failed_count integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0)
);
CREATE TABLE learning_concept_tag_reservations (
 run_id uuid NOT NULL REFERENCES learning_concept_tag_experiments(run_id) ON DELETE CASCADE,
 case_id text NOT NULL, chunk_index integer NOT NULL,
 request_hash text, owner_token uuid, reserved_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, state text NOT NULL CHECK (state IN ('active','uncertain','succeeded','failed')),
 receipt jsonb, PRIMARY KEY (run_id,case_id,chunk_index)
);
-- Active lease expiry fences NEW work; it never authorizes a replacement call.
CREATE INDEX learning_concept_tag_reservations_pending
 ON learning_concept_tag_reservations(run_id,state,lease_until)
 WHERE state IN ('active','uncertain');
