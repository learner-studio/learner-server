-- A live assessment run stores references, not text (0042): its prompt is rebuilt from these rows and refused unless
-- byte-identical. A message_id therefore names one text and one version for ever. Indexing only inserts (ON CONFLICT
-- DO NOTHING) and updates status/current_canonical/error; this makes the rest a rule, not a habit. The one deleter is
-- the CLI e2e fixture cleanup, whose messages its run row lists and which are never selected as evidence.
CREATE FUNCTION public.learning_semantic_message_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND EXISTS (SELECT 1 FROM public.learning_cli_vector_e2e_runs f WHERE OLD.message_id = ANY (f.message_ids)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learning_semantic_index_messages % is immutable: assessment runs rebuild their prompts from it', OLD.message_id;
END $$;

CREATE TRIGGER learning_semantic_message_immutable BEFORE DELETE OR UPDATE OF source_text, raw_version_id ON public.learning_semantic_index_messages
  FOR EACH ROW EXECUTE FUNCTION public.learning_semantic_message_immutable();
