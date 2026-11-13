-- The simulated-learner experiment's efficacy looks (docs/specs/simulated-learner-experiment.md, revision 8.5): one
-- row per (run, look), written once when the look is taken and never revised. They lived in look-<k>.json files
-- under the runner's --out, which a caller picks; the database is the record.
CREATE TABLE IF NOT EXISTS public.learning_sim_looks (
  run_id text NOT NULL,
  look integer NOT NULL CHECK (look >= 1),
  entry jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, look)
);
