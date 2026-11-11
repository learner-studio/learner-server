-- Randomized injection (docs/specs/randomized-injection.md). `injected` alone cannot say why a
-- turn was left alone: false means both "nothing worth teaching" and "worth teaching, not
-- chosen". These are stored once, with the decision, in both assignment modes, so analysis can
-- compare eligible-injected with eligible-not-injected turns. Null on turns decided before this.
ALTER TABLE public.learning_live_feedback_turns
  ADD COLUMN injection_eligible boolean,
  ADD COLUMN injection_mode text CHECK (injection_mode IN ('quota', 'randomized')),
  ADD COLUMN injection_rate smallint CHECK (injection_rate BETWEEN 0 AND 100);
