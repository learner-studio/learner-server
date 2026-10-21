-- Durable workflow state (apps/server/src/workflow/durable.ts).
--
-- Column names and types deliberately mirror the former framework's
-- workflow_runs / workflow_step tables: ported Learning code reads these rows
-- directly (idempotency checks on `input::jsonb->>'runId'`, coordinator
-- staleness via max(step.updated_at)), and historical Learning runs are copied
-- in so those checks keep their answers.
CREATE TABLE public.learner_workflow_runs (
    workflow_run_id text DEFAULT gen_random_uuid()::text NOT NULL PRIMARY KEY,
    workflow text NOT NULL,
    status text NOT NULL,
    input text NOT NULL,
    output text,
    error text,
    state text DEFAULT '{}'::text,
    wire text,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    -- Lease: the worker that is executing this run, and until when. A run whose
    -- lease lapsed is resumable by any worker.
    lease_owner text,
    lease_until timestamp with time zone
);
CREATE INDEX learner_workflow_runs_workflow_status ON public.learner_workflow_runs (workflow, status);
CREATE INDEX learner_workflow_runs_input_run_id ON public.learner_workflow_runs (workflow, ((input::jsonb ->> 'runId')));

CREATE TABLE public.learner_workflow_steps (
    workflow_step_id text DEFAULT gen_random_uuid()::text NOT NULL PRIMARY KEY,
    workflow_run_id text NOT NULL REFERENCES public.learner_workflow_runs(workflow_run_id) ON DELETE CASCADE,
    step_name text NOT NULL,
    rpc_name text,
    data text,
    status text DEFAULT 'pending'::text NOT NULL,
    result text,
    error text,
    retries integer,
    retry_delay text,
    current_attempt integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    UNIQUE (workflow_run_id, step_name)
);
