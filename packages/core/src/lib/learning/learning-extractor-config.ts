import {
  assertSelectableCombination,
  type CliEffort,
  type LlmBackend,
} from '@learner/llm/lib/llm/model-catalog.js'
import { ExtractorBackend } from '@learner/contract/learning/learning-admin.js'
import { metaDbQuery } from '../db-metadata/_shared.js'

export type LearningExtractorConfig = {
  backend: (typeof ExtractorBackend.options)[number]
  model: string
  effort: CliEffort
  updatedAt: string | null
}

export const DEFAULT_LEARNING_EXTRACTOR_CONFIG: LearningExtractorConfig = {
  backend: 'codex',
  model: 'gpt-5.6-luna',
  effort: 'high',
  updatedAt: null,
}

type LearningExtractorConfigRow = {
  backend: string
  model: string
  effort: string
  updated_at: string | Date
}

/** The extractor runs only on an allowed CLI and a combination the catalogue can run; anything else,
 * stored or submitted, is an error rather than a silent substitution. */
function assertExtractorSelection(backend: string, model: string, effort: string) {
  const allowed = ExtractorBackend.safeParse(backend)
  if (!allowed.success) throw new Error(`The Learning extractor cannot run on ${backend}; allowed: ${ExtractorBackend.options.join(', ')}`)
  assertSelectableCombination(allowed.data as LlmBackend, model, effort as CliEffort)
  return allowed.data
}

const normalizeRow = (row: LearningExtractorConfigRow): LearningExtractorConfig => ({
  backend: assertExtractorSelection(row.backend, row.model, row.effort),
  model: row.model,
  effort: row.effort as CliEffort,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
})

export async function loadLearningExtractorConfig(): Promise<LearningExtractorConfig> {
  const result = await metaDbQuery<LearningExtractorConfigRow>(
    `SELECT backend, model, effort, updated_at
       FROM learning_extractor_config
      WHERE config_key = 'default'`,
  )
  const row = result.rows[0]
  if (!row) return DEFAULT_LEARNING_EXTRACTOR_CONFIG
  return normalizeRow(row)
}

export async function saveLearningExtractorConfig(
  selection: Pick<LearningExtractorConfig, 'backend' | 'model' | 'effort'>,
  updatedBy: string,
): Promise<LearningExtractorConfig> {
  assertExtractorSelection(selection.backend, selection.model, selection.effort)
  const result = await metaDbQuery<LearningExtractorConfigRow>(
    `INSERT INTO learning_extractor_config
       (config_key, backend, model, effort, updated_by, updated_at)
     VALUES ('default', $1, $2, $3, $4, NOW())
     ON CONFLICT (config_key) DO UPDATE SET
       backend = EXCLUDED.backend,
       model = EXCLUDED.model,
       effort = EXCLUDED.effort,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING backend, model, effort, updated_at`,
    [selection.backend, selection.model, selection.effort, updatedBy],
  )
  const row = result.rows[0]
  if (!row) throw new Error('Learning extractor configuration was not persisted')
  return normalizeRow(row)
}
