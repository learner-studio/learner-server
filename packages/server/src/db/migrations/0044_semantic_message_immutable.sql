-- A live assessment run stores references, not text (0042): its prompt is rebuilt from these rows (every column
-- SOURCE_COLUMNS reads) and refused unless byte-identical. So a message_id names one message for ever: those columns
-- never change. Indexing only inserts (ON CONFLICT DO NOTHING) and updates status/current_canonical/error/indexed_at,
-- which stay free. The one deleter is the CLI e2e fixture cleanup, whose messages its run row lists and which are
-- never selected as evidence.
CREATE FUNCTION public.learning_semantic_message_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.message_id, NEW.conversation_id, NEW.role, NEW.source_text, NEW.observed_at, NEW.logical_message_key, NEW.payload, NEW.raw_version_id)
      IS NOT DISTINCT FROM (OLD.message_id, OLD.conversation_id, OLD.role, OLD.source_text, OLD.observed_at, OLD.logical_message_key, OLD.payload, OLD.raw_version_id) THEN
      RETURN NEW;
    END IF;
  ELSIF EXISTS (SELECT 1 FROM public.learning_cli_vector_e2e_runs f WHERE OLD.message_id = ANY (f.message_ids)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learning_semantic_index_messages % is immutable: assessment runs rebuild their prompts from it', OLD.message_id;
END $$;

CREATE TRIGGER learning_semantic_message_immutable BEFORE UPDATE OR DELETE ON public.learning_semantic_index_messages
  FOR EACH ROW EXECUTE FUNCTION public.learning_semantic_message_immutable();
