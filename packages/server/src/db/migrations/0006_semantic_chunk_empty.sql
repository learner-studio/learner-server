-- A chunk Hindsight retained but found nothing to embed in (a `.”` or `{}`
-- tail of a split message) is terminal, not missing: `empty`. Every coverage
-- guard reads status='indexed', so an empty chunk no longer blocks routing
-- and assessment forever.
ALTER TABLE learning_semantic_index_chunks DROP CONSTRAINT learning_semantic_index_chunks_status_check;
ALTER TABLE learning_semantic_index_chunks ADD CONSTRAINT learning_semantic_index_chunks_status_check
  CHECK (status = ANY (ARRAY['pending','submitted','indexed','empty','error']));
