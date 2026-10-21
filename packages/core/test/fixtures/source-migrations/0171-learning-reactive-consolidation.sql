-- No replay of the historical corpus: record transitions after installation.
CREATE TABLE learning_vector_arrivals (
  message_id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION learning_record_vector_arrival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_canonical AND NEW.status='indexed' THEN
    INSERT INTO learning_vector_arrivals(message_id) VALUES(NEW.message_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER learning_vector_arrival AFTER INSERT OR UPDATE OF status,current_canonical
  ON learning_semantic_index_messages FOR EACH ROW EXECUTE FUNCTION learning_record_vector_arrival();

CREATE TABLE learning_reactive_settings (
  user_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  activated_at timestamptz NOT NULL DEFAULT now(),
  config jsonb NOT NULL,
  revision text NOT NULL,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE learning_reactive_targets (
  user_id text NOT NULL,
  session_id uuid NOT NULL,
  concept_id text NOT NULL,
  PRIMARY KEY(user_id,session_id),
  UNIQUE(user_id,concept_id)
);
CREATE TABLE learning_reactive_routes (
  user_id text NOT NULL,
  message_id text NOT NULL REFERENCES learning_vector_arrivals(message_id),
  revision text NOT NULL,
  matches jsonb NOT NULL,
  routed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,message_id,revision)
);
CREATE TABLE learning_reactive_embeddings (
  revision text PRIMARY KEY,
  concepts jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE learning_reactive_admission (LIKE learning_active_archive_sessions INCLUDING DEFAULTS INCLUDING CONSTRAINTS);
ALTER TABLE learning_reactive_admission ADD PRIMARY KEY(user_id,session_id);
ALTER TABLE learning_reactive_admission ADD UNIQUE(active_slot);
CREATE TABLE learning_reactive_notifications (LIKE learning_active_archive_notifications INCLUDING ALL);
CREATE UNIQUE INDEX learning_reactive_dispatch_identity ON learner_workflow_runs ((input::jsonb->>'dispatchId'))
  WHERE workflow='learningReactiveConceptWorkflow';
