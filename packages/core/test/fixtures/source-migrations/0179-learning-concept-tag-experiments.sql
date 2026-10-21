CREATE TABLE learning_concept_tag_experiments (
 run_id uuid PRIMARY KEY, user_id text NOT NULL, manifest jsonb NOT NULL,
 status text NOT NULL DEFAULT 'prepared', dataset_id text, score_configs jsonb,
 summary jsonb, created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE TABLE learning_concept_tag_items (
 run_id uuid NOT NULL REFERENCES learning_concept_tag_experiments(run_id) ON DELETE CASCADE,
 case_id text NOT NULL, arm text NOT NULL, reserved_at timestamptz, receipt jsonb,
 export_state text NOT NULL DEFAULT 'pending', workflow_run_id uuid,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,case_id,arm)
);
