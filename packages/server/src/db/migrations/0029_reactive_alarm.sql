-- Reactive grading alarm, round 2 (docs/operations/reactive-grading-runbook.md).

-- When a concept FIRST became waiting (requested > captured) since its last
-- settled pass. last_notified_at moves on every new arrival, so a concept the
-- learner keeps touching never looked old to the stall check (review S7).
ALTER TABLE public.learning_reactive_admission ADD COLUMN IF NOT EXISTS waiting_since timestamptz;
UPDATE public.learning_reactive_admission a SET waiting_since=COALESCE(
  (SELECT min(n.created_at) FROM public.learning_reactive_notifications n
    WHERE n.user_id=a.user_id AND n.session_id=a.session_id AND n.created_at>COALESCE(a.last_finished_at,'-infinity'::timestamptz)),
  a.last_notified_at)
WHERE a.requested_generation>a.captured_generation;

-- Failures before any paid model call cost nothing, so they retry on a capped
-- backoff forever instead of spending the 3-attempt breaker (review S4). This
-- counts them since the last settled pass, for the backoff and the alarm.
ALTER TABLE public.learning_reactive_admission ADD COLUMN IF NOT EXISTS unpaid_failures integer NOT NULL DEFAULT 0;

-- A live pass that graded without some indexed chunks the bank holds no vector
-- for records them in its snapshot (counts.unverifiedChunkIds). The snapshot is
-- large and TOASTed, so its count is mirrored here for the health check (review N2).
ALTER TABLE public.learning_vector_turn_experiments ADD COLUMN IF NOT EXISTS unverified_chunks integer NOT NULL DEFAULT 0;
