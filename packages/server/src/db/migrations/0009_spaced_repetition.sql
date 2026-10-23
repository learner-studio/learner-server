-- Spaced repetition: the review concept a turn's guidance delivered, stored with the
-- injection decision. The policy does not re-offer a review delivered in the last 24 hours
-- (an offered review is not an exposure: only a turn that taught it counts as one).
ALTER TABLE public.learning_live_feedback_turns ADD COLUMN review_concept_id text;

CREATE INDEX learning_live_feedback_reviews ON public.learning_live_feedback_turns (user_id, created_at DESC)
  WHERE review_concept_id IS NOT NULL;
