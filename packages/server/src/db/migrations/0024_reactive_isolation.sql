-- Reactive grading isolation (docs/operations/reactive-grading-runbook.md).
--
-- 2026-10-30..11-11: four indexed chunks with no vector stopped reactive routing
-- (one batch of 100 arrivals retried unchanged every minute) and every concept
-- assessment. One unverifiable item must never block the queue behind it.

-- An arrival routing cannot verify is HELD with its reason and retried on a
-- bounded schedule; everything behind it routes. next_attempt_at NULL means its
-- retries are exhausted: it stays countable here until an operator releases it
-- (releaseLearningReactiveHolds) or its vectors appear and a release routes it.
CREATE TABLE public.learning_reactive_route_holds (
  user_id text NOT NULL,
  event_id uuid NOT NULL REFERENCES public.learning_vector_arrivals(event_id),
  revision text NOT NULL,
  message_id text NOT NULL,
  reason text NOT NULL,
  missing_chunk_ids text[] NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  first_held_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz,
  PRIMARY KEY (user_id, event_id, revision)
);
CREATE INDEX learning_reactive_route_holds_due ON public.learning_reactive_route_holds (user_id, revision, next_attempt_at);

-- A concept pass that failed BEFORE any paid model call is retried with backoff
-- instead of being sent straight to the 3-attempt breaker (which stays for
-- passes that reserved a paid attempt). This stamps when it last failed.
ALTER TABLE public.learning_reactive_admission ADD COLUMN last_failed_at timestamptz;

-- learning_reactive_routes is read for "when did routing last make progress".
CREATE INDEX IF NOT EXISTS learning_reactive_routes_user_created ON public.learning_reactive_routes (user_id, routed_at DESC);
