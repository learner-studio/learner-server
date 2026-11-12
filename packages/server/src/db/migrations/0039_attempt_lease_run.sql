-- Tracing (pikku-trace-audit fix 3): which workflow run and step function hold or repaired an attempt, so a lease
-- or reclaim row joins to learner_workflow_runs/steps by id (step_name = learner_workflow_steps.rpc_name), not
-- through a step's JSON input. Written from the Pikku call scope (runtime-pikku/src/adapt.ts); NULL outside a
-- workflow step and on rows from before this migration. Additive: no existing column or row changes.
-- From this change learning_llm_attempt_reclaims also records action 'refused' (detail.reason): a claim the lease
-- would not grant (metered backend, takeover budget spent), which the caller answers 'uncertain' with no receipt.
ALTER TABLE public.learning_llm_attempt_leases ADD COLUMN workflow_run_id text, ADD COLUMN step_name text;
ALTER TABLE public.learning_llm_attempt_reclaims ADD COLUMN workflow_run_id text, ADD COLUMN step_name text;
