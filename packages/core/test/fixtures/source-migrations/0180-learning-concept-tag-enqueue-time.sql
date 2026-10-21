-- Separate actual enqueue time from manifest preparation (prepareOnly may wait).
ALTER TABLE learning_concept_tag_items ADD COLUMN enqueued_at timestamptz;
