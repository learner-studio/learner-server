import { DEFAULT_LEARNING_POLICY, LearningPolicySettings, type LearningPolicyConfig } from '@learner/contract/learning/learning-policy.js'
import { metaDbQuery } from '../db-metadata/_shared.js'
import { HOLDOUT_EXPERIMENT_KEY } from './learning-concept-holdout.js'

type Row = { settings: unknown; updated_at: Date }

/** The stored policy, completed with defaults for any setting added since it was saved. */
export async function loadLearningPolicy(query = metaDbQuery): Promise<LearningPolicyConfig> {
  const row = (await query<Row>(`SELECT settings, updated_at FROM learning_policy_settings WHERE config_key = 'default'`)).rows[0]
  if (!row) return { ...DEFAULT_LEARNING_POLICY, updatedAt: null }
  return { ...LearningPolicySettings.parse(row.settings), updatedAt: row.updated_at.toISOString() }
}

export async function saveLearningPolicy(settings: LearningPolicySettings, updatedBy: string, query = metaDbQuery): Promise<LearningPolicyConfig> {
  const parsed = LearningPolicySettings.parse(settings)
  // A changed holdout share starts a new phase in the same statement, so the share the live turn
  // filters by and the phase the analysis reads never disagree (docs/specs/mastery-change-statistics.md).
  const row = (await query<Row>(`WITH saved AS (
      INSERT INTO learning_policy_settings (config_key, settings, updated_by, updated_at) VALUES ('default', $1::jsonb, $2, now())
      ON CONFLICT (config_key) DO UPDATE SET settings = EXCLUDED.settings, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
      RETURNING settings, updated_at
    ), current AS (SELECT phase, buckets FROM learning_holdout_phases WHERE experiment_key = $3 ORDER BY phase DESC LIMIT 1),
    phase AS (
      INSERT INTO learning_holdout_phases (experiment_key, phase, buckets, started_at)
      SELECT $3, COALESCE((SELECT phase FROM current), 0) + 1, $4, now()
      WHERE (SELECT buckets FROM current) IS DISTINCT FROM $4::smallint
      RETURNING phase
    )
    SELECT settings, updated_at FROM saved`, [JSON.stringify(parsed), updatedBy, HOLDOUT_EXPERIMENT_KEY, parsed.holdoutBuckets])).rows[0]!
  return { ...LearningPolicySettings.parse(row.settings), updatedAt: row.updated_at.toISOString() }
}
