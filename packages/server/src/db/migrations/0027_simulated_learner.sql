-- Simulated-learner experiment (docs/specs/simulated-learner-experiment.md). Its rows live only on the
-- database the experiment runs on (learner_sim, or learner_test for the suite); the tables exist everywhere
-- so every database has one schema. Nothing in the product reads them.
-- IF NOT EXISTS: applied by hand to the shared learner_test, whose ledger holds other lanes' unshipped migrations.

-- One row per simulated learner of a run: its arm (on | off | control | randomized), lane and Learner user id.
CREATE TABLE IF NOT EXISTS public.learning_sim_learners (
  run_id text NOT NULL,
  learner_id text NOT NULL,
  user_id text NOT NULL,
  arm text NOT NULL,
  lane text NOT NULL,
  config jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, learner_id)
);

-- The conversation and the learner's notebooks: written once per (session, seq), so a replayed step
-- reads the same text back instead of appending a second copy.
CREATE TABLE IF NOT EXISTS public.learning_sim_messages (
  run_id text NOT NULL,
  learner_id text NOT NULL,
  session integer NOT NULL,
  seq integer NOT NULL,
  role text NOT NULL CHECK (role IN ('learner', 'agent', 'notebook')),
  text text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, learner_id, session, seq, role)
);

-- Model-call receipts: one per call key. A step that runs again finds its receipt and never pays twice;
-- the accounting (model, tokens, duration, attempts) is read from here.
CREATE TABLE IF NOT EXISTS public.learning_sim_calls (
  run_id text NOT NULL,
  learner_id text NOT NULL,
  call_key text NOT NULL,
  role text NOT NULL,
  model text NOT NULL,
  effort text NOT NULL,
  input_tokens integer,
  output_tokens integer,
  duration_ms integer NOT NULL,
  attempts integer NOT NULL,
  output jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, learner_id, call_key)
);
