-- Pikku core 0.12.156 / @pikku/kysely 0.13.43 serialise every workflow run and step claim on a lease
-- (WorkflowServiceOptions.leaseService is required): a step row carries its claim's expiry, and the
-- leases themselves live in pikku_lease (@pikku/kysely lease.schema). The standalone engine ignores both.
-- Additive only: a run in flight under the previous version keeps its rows; a NULL expiry reads as unclaimed.
ALTER TABLE public.learner_workflow_steps ADD COLUMN IF NOT EXISTS lease_expires_at bigint;

CREATE TABLE IF NOT EXISTS public.pikku_lease (
  key text PRIMARY KEY,
  holder text NOT NULL,
  token integer NOT NULL,
  expires_at bigint NOT NULL
);
