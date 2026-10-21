-- An arrival is a transition, not a timestamp cursor or a permanent message flag.
-- Re-canonicalizing/re-indexing a source can require a fresh routing decision.
ALTER TABLE learning_vector_arrivals ADD COLUMN event_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE learning_reactive_routes DROP CONSTRAINT learning_reactive_routes_message_id_fkey;
ALTER TABLE learning_reactive_routes ADD COLUMN event_id uuid;
UPDATE learning_reactive_routes r SET event_id=a.event_id FROM learning_vector_arrivals a WHERE a.message_id=r.message_id;
ALTER TABLE learning_reactive_routes ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE learning_reactive_routes DROP CONSTRAINT learning_reactive_routes_pkey;
ALTER TABLE learning_vector_arrivals DROP CONSTRAINT learning_vector_arrivals_pkey;
ALTER TABLE learning_vector_arrivals ADD PRIMARY KEY(event_id);
ALTER TABLE learning_reactive_routes ADD PRIMARY KEY(user_id,event_id,revision);
ALTER TABLE learning_reactive_routes ADD FOREIGN KEY(event_id) REFERENCES learning_vector_arrivals(event_id);
CREATE INDEX learning_vector_arrivals_pending ON learning_vector_arrivals(created_at,event_id);
CREATE OR REPLACE FUNCTION learning_record_vector_arrival() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_canonical AND NEW.status='indexed' THEN
      INSERT INTO learning_vector_arrivals(message_id) VALUES(NEW.message_id);
    END IF;
  ELSIF NEW.current_canonical AND NEW.status='indexed'
    AND (NOT OLD.current_canonical OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO learning_vector_arrivals(message_id) VALUES(NEW.message_id);
  END IF;
  RETURN NEW;
END $$;
