-- The framework runtime adapter (packages/runtime-<framework>) keeps its durable
-- workflow state in the SAME two tables as the standalone engine, so the
-- ported Learning code that reads runs directly (`input::jsonb->>'runId'`
-- idempotency checks, coordinator staleness) gives one answer under either
-- runtime. Its run service maps its table names onto these; what it needs on
-- top is the columns and the two tables below. The standalone engine ignores
-- them.
ALTER TABLE public.learner_workflow_runs
    ADD COLUMN inline boolean DEFAULT false,
    ADD COLUMN graph_hash text,
    ADD COLUMN deterministic boolean DEFAULT false,
    ADD COLUMN planned_steps text;
CREATE INDEX learner_workflow_runs_status_created ON public.learner_workflow_runs (status, created_at);
CREATE INDEX learner_workflow_runs_workflow_created ON public.learner_workflow_runs (workflow, created_at);

ALTER TABLE public.learner_workflow_steps
    ADD COLUMN child_run_id text,
    ADD COLUMN branch_taken text,
    ADD COLUMN from_step_name text;
CREATE INDEX learner_workflow_steps_run_status ON public.learner_workflow_steps (workflow_run_id, status);

CREATE TABLE public.learner_workflow_step_history (
    history_id text NOT NULL PRIMARY KEY,
    workflow_step_id text NOT NULL REFERENCES public.learner_workflow_steps(workflow_step_id) ON DELETE CASCADE,
    status text NOT NULL,
    result text,
    error text,
    attempt integer,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    running_at timestamp without time zone,
    scheduled_at timestamp without time zone,
    succeeded_at timestamp without time zone,
    failed_at timestamp without time zone
);
CREATE INDEX learner_workflow_step_history_step ON public.learner_workflow_step_history (workflow_step_id, created_at);

CREATE TABLE public.learner_workflow_versions (
    workflow_name text NOT NULL,
    graph_hash text NOT NULL,
    graph text NOT NULL,
    source text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    PRIMARY KEY (workflow_name, graph_hash)
);
CREATE INDEX learner_workflow_versions_source_status ON public.learner_workflow_versions (source, status);
