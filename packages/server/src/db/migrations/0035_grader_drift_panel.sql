-- Weekly grader-drift regrade panel (docs/specs/mastery-change-statistics.md, "Drift panel"; review
-- round 2 S-b, round 3 S5).
--
-- The aggregate "rose"/"fell" must clear the prior-blind grader's own drift over calendar time. A
-- fixed panel of past evidence is regraded prior-blind every week with the shipped grader; the
-- within-item slope of those regrades on time is the drift.
--
-- These tables are deliberately OUTSIDE learning_concept_assessment_*: every reading, notification,
-- holdout, GrowthBook fact and stall measurement reads those tables (or views over them), so a
-- regrade can never become a reading. GrowthBook's read-only role gets no grant here. Evidence text
-- lives only in `ingredients` and in the model's `receipt.raw`; nothing else copies it.

-- One frozen panel per learner, chosen once, deterministically (grader-drift-panel.ts selectPanel).
CREATE TABLE public.learning_drift_panels (
  user_id text PRIMARY KEY,
  selection_revision text NOT NULL,
  -- Items chosen and eligible candidates at selection time: a panel smaller than its target says so.
  size integer NOT NULL,
  candidates integer NOT NULL,
  selected_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.learning_drift_panel_items (
  user_id text NOT NULL REFERENCES public.learning_drift_panels(user_id),
  item integer NOT NULL,
  -- The past prior-blind reading whose evidence this item regrades, and what it measured then.
  source_run_id uuid NOT NULL,
  concept_id text NOT NULL,
  level integer NOT NULL,
  source_percent numeric NOT NULL,
  -- The concept, read-only context turns and new evidence exactly as that grading's prompt held them.
  ingredients jsonb NOT NULL,
  PRIMARY KEY (user_id, item),
  UNIQUE (user_id, source_run_id)
);

-- A window is one grader: prompt revision plus model. A new one starts whenever either changes, and
-- drift is measured within the current window only (a revision change is a break, not drift).
CREATE TABLE public.learning_drift_panel_windows (
  window_id bigserial PRIMARY KEY,
  grader_key text NOT NULL,
  prompt_revision text NOT NULL,
  model text NOT NULL,
  started_week date NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One regrade per (panel item, week): reserved before the paid call, so a replay never pays twice.
CREATE TABLE public.learning_drift_panel_regrades (
  user_id text NOT NULL,
  item integer NOT NULL,
  week date NOT NULL,
  window_id bigint NOT NULL REFERENCES public.learning_drift_panel_windows(window_id),
  prompt_revision text NOT NULL,
  model text NOT NULL,
  status text,
  percent numeric,
  calls integer,
  receipt jsonb,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (user_id, item, week),
  FOREIGN KEY (user_id, item) REFERENCES public.learning_drift_panel_items(user_id, item)
);
CREATE INDEX learning_drift_panel_regrades_window ON public.learning_drift_panel_regrades(window_id, week);
