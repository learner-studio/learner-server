import { DEFAULT_LEARNING_POLICY, LearningPolicySettings, LearningPolicyUpdate, type LearningPolicyConfig } from '@learner/contract/learning/learning-policy.js'
import { metaDbQuery } from '../db-metadata/_shared.js'

type Row = { settings: unknown; updated_at: Date }

/** The stored policy, completed with defaults for any setting added since it was saved. */
export async function loadLearningPolicy(query = metaDbQuery): Promise<LearningPolicyConfig> {
  const row = (await query<Row>(`SELECT settings, updated_at FROM learning_policy_settings WHERE config_key = 'default'`)).rows[0]
  if (!row) return { ...DEFAULT_LEARNING_POLICY, updatedAt: null }
  return { ...LearningPolicySettings.parse(row.settings), updatedAt: row.updated_at.toISOString() }
}

/**
 * Merge a save over the stored policy in one statement (review N5): a setting the request does not
 * name keeps its stored value, never its default. With no stored row the defaults fill the rest.
 */
export async function saveLearningPolicy(update: LearningPolicyUpdate, updatedBy: string, query = metaDbQuery): Promise<LearningPolicyConfig> {
  const parsed = LearningPolicyUpdate.parse(update)
  const row = (await query<Row>(`INSERT INTO learning_policy_settings (config_key, settings, updated_by, updated_at) VALUES ('default', $1::jsonb || $2::jsonb, $3, now())
    ON CONFLICT (config_key) DO UPDATE SET settings = learning_policy_settings.settings || $2::jsonb, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
    RETURNING settings, updated_at`, [JSON.stringify(DEFAULT_LEARNING_POLICY), JSON.stringify(parsed), updatedBy])).rows[0]!
  return { ...LearningPolicySettings.parse(row.settings), updatedAt: row.updated_at.toISOString() }
}
