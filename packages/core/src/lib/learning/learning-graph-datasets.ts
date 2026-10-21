import { metaDbQuery } from '../db-metadata/_shared.js'

export type LearningGraphDataset = {
  tag: string
  label: string
  runId: string
  experimentLabel: string
  pairCount: number
  matchCount: number
  conceptIds: string[]
  completedAt: string
}

/**
 * Return the newest completed run for each immutable experimental dataset.
 * Only concept IDs and aggregate metadata cross into the graph response; the
 * private benchmark snapshots remain on the benchmark surface.
 */
export async function readLearningGraphDatasets(ontologyId: string): Promise<LearningGraphDataset[]> {
  const result = await metaDbQuery<{
    tag: string
    label: string
    run_id: string
    experiment_label: string
    pair_count: number
    match_count: number
    concept_ids: string[]
    completed_at: string
  }>(
    `WITH newest_dataset_runs AS (
       SELECT DISTINCT ON (COALESCE(config->'dataset'->'tags'->>0,config->'tags'->>0))
         COALESCE(config->'dataset'->'tags'->>0,config->'tags'->>0) AS tag,
         COALESCE(config->'dataset'->>'label', config->>'datasetLabel') AS label,
         run_id,
         COALESCE(config->>'experimentLabel', config->'dataset'->>'label', config->>'datasetLabel') AS experiment_label,
         sample_size AS pair_count,
         completed_at
       FROM learning_extraction_benchmark_runs
       WHERE status='completed'
         AND COALESCE(config->>'validity','valid')='valid'
         AND config->>'ontologyId'=$1
         AND config->'dataset'->>'immutable'='true'
         AND COALESCE(jsonb_typeof(config->'dataset'->'tags'),jsonb_typeof(config->'tags'))='array'
         AND COALESCE(jsonb_array_length(config->'dataset'->'tags'),jsonb_array_length(config->'tags')) > 0
       ORDER BY COALESCE(config->'dataset'->'tags'->>0,config->'tags'->>0), started_at DESC
     )
     SELECT dataset.tag,dataset.label,dataset.run_id,dataset.experiment_label,dataset.pair_count,
       count(match.value)::int AS match_count,
       COALESCE(array_agg(DISTINCT match.value->>'conceptId')
         FILTER (WHERE match.value->>'conceptId' IS NOT NULL), ARRAY[]::text[]) AS concept_ids,
       dataset.completed_at::text
     FROM newest_dataset_runs dataset
     LEFT JOIN learning_extraction_benchmark_results result
       ON result.run_id=dataset.run_id AND result.status='completed'
     LEFT JOIN LATERAL jsonb_array_elements(COALESCE(result.extraction->'matches','[]'::jsonb)) match(value) ON true
     GROUP BY dataset.tag,dataset.label,dataset.run_id,dataset.experiment_label,dataset.pair_count,dataset.completed_at
     ORDER BY dataset.completed_at DESC`,
    [ontologyId],
  )
  return result.rows.map((row) => ({
    tag: row.tag,
    label: row.label,
    runId: row.run_id,
    experimentLabel: row.experiment_label,
    pairCount: row.pair_count,
    matchCount: row.match_count,
    conceptIds: row.concept_ids,
    completedAt: row.completed_at,
  }))
}
