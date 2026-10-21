import { randomUUID } from 'node:crypto'
import { sql, type Kysely } from 'kysely'

import type { DB } from '../types/db.types.js'
import {
  CanonicalEpisodeArtifactSchema,
  OutcomeSteeringJudgmentSchema,
  type CanonicalEpisodeArtifact,
  type OutcomeEvaluatorConfig,
  type OutcomeSteeringJudgment,
  sha256,
} from '../lib/learning/outcome-steering.js'

type EvaluationStatus = 'running' | 'completed' | 'abstained' | 'failed'

export type OutcomeEvaluationRecord = {
  evaluationId: string
  artifactId: string
  evaluatorVersion: string
  backend: string
  model: string
  effort: string
  status: EvaluationStatus
  judgment: OutcomeSteeringJudgment | null
  error: string | null
  startedAt: string
  completedAt: string | null
}

const evaluationIdFor = (artifactId: string, evaluatorVersion: string, configHash: string): string => {
  const hash = sha256({ artifactId, evaluatorVersion, configHash })
  const chars = hash.slice(0, 32).split('')
  chars[12] = '5'
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16)
  const compact = chars.join('')
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`
}

/** Durable, idempotent persistence boundary for the shared episode artifact. */
export class LearningEpisodeStore {
  constructor(private readonly kysely: Kysely<DB>) {}

  async upsertCanonicalArtifact(artifact: CanonicalEpisodeArtifact): Promise<CanonicalEpisodeArtifact> {
    const parsed = CanonicalEpisodeArtifactSchema.parse(artifact)
    const providerThreadIds = [...new Set(parsed.turns.map((turn) => `${turn.provider}:${turn.threadId}`))]
    const harnessTaskIds = [...new Set(parsed.tasks.map((task) => task.taskId))]
    // Raw SQL is temporary only because this forward migration is newer than
    // the checked-in generated DB schema. DB codegen makes these tables
    // available to the typed builder after the migration is applied.
    const result = await sql<{ artifact: unknown }>`
      INSERT INTO learning_episode_artifacts (
        artifact_id, source_episode_key, source_fingerprint, grouping_version,
        status, provider_thread_ids, harness_task_ids, domain_metadata,
        input_snapshot, artifact, started_at, ended_at
      ) VALUES (
        ${parsed.artifactId}::uuid, ${parsed.sourceEpisodeKey}, ${parsed.sourceFingerprint},
        ${parsed.groupingVersion}, 'canonical', ${providerThreadIds}::text[],
        ${harnessTaskIds}::text[], ${JSON.stringify(parsed.domains)}::jsonb,
        ${JSON.stringify(parsed)}::jsonb, ${JSON.stringify(parsed)}::jsonb,
        ${parsed.startedAt}::timestamptz, ${parsed.endedAt}::timestamptz
      )
      ON CONFLICT (source_fingerprint) DO UPDATE SET
        updated_at = NOW()
      RETURNING artifact
    `.execute(this.kysely)
    return CanonicalEpisodeArtifactSchema.parse(result.rows[0]?.artifact)
  }

  async getArtifact(artifactId: string): Promise<CanonicalEpisodeArtifact | undefined> {
    const result = await sql<{ artifact: unknown }>`
      SELECT artifact FROM learning_episode_artifacts WHERE artifact_id = ${artifactId}::uuid
    `.execute(this.kysely)
    const row = result.rows[0]
    return row ? CanonicalEpisodeArtifactSchema.parse(row.artifact) : undefined
  }

  async markArtifact(artifactId: string, status: 'analyzing' | 'completed' | 'partial' | 'failed', error: string | null = null): Promise<void> {
    await sql`
      UPDATE learning_episode_artifacts
         SET status = ${status}, error = ${error}, updated_at = NOW()
       WHERE artifact_id = ${artifactId}::uuid
    `.execute(this.kysely)
  }

  async claimEvaluation(artifact: CanonicalEpisodeArtifact, config: OutcomeEvaluatorConfig): Promise<{
    evaluationId: string
    claimToken: string | null
    shouldEvaluate: boolean
    existing: OutcomeEvaluationRecord | null
  }> {
    const evaluatorVersion = 'outcome-steering-v1'
    const configHash = sha256(config)
    const evaluationId = evaluationIdFor(artifact.artifactId, evaluatorVersion, configHash)
    const claimToken = randomUUID()
    const result = await sql<{
      evaluation_id: string
      artifact_id: string
      evaluator_version: string
      backend: string
      model: string
      effort: string
      status: EvaluationStatus
      claim_token: string | null
      raw_judgment: unknown
      error: string | null
      started_at: string | Date
      completed_at: string | Date | null
    }>`
      INSERT INTO learning_outcome_steering_evaluations (
        evaluation_id, artifact_id, evaluator_version, config_hash,
        backend, model, effort, status, claim_token, lease_expires_at
      ) VALUES (
        ${evaluationId}::uuid, ${artifact.artifactId}::uuid, ${evaluatorVersion}, ${configHash},
        ${config.backend}, ${config.model}, ${config.effort}, 'running', ${claimToken}::uuid,
        NOW() + INTERVAL '10 minutes'
      )
      ON CONFLICT (artifact_id, evaluator_version, config_hash) DO UPDATE SET
        status = 'running', claim_token = ${claimToken}::uuid,
        lease_expires_at = NOW() + INTERVAL '10 minutes', error = NULL, updated_at = NOW()
      WHERE learning_outcome_steering_evaluations.status = 'failed'
         OR (learning_outcome_steering_evaluations.status = 'running'
             AND learning_outcome_steering_evaluations.lease_expires_at < NOW())
      RETURNING evaluation_id, artifact_id, evaluator_version, backend, model,
                effort, status, claim_token, raw_judgment, error,
                started_at, completed_at
    `.execute(this.kysely)
    const claimed = result.rows[0]
    if (claimed?.claim_token === claimToken) {
      return { evaluationId, claimToken, shouldEvaluate: true, existing: null }
    }
    return {
      evaluationId,
      claimToken: null,
      shouldEvaluate: false,
      existing: await this.getEvaluation(evaluationId) ?? null,
    }
  }

  async completeEvaluation(evaluationId: string, claimToken: string, judgment: OutcomeSteeringJudgment): Promise<OutcomeEvaluationRecord> {
    const parsed = OutcomeSteeringJudgmentSchema.parse(judgment)
    await this.kysely.transaction().execute(async (trx) => {
      const updated = await sql<{ evaluation_id: string }>`
        UPDATE learning_outcome_steering_evaluations
           SET status = ${parsed.overallStatus === 'abstained' ? 'abstained' : 'completed'},
               raw_judgment = ${JSON.stringify(parsed)}::jsonb,
               summary = ${parsed.summary}, limitations = ${JSON.stringify(parsed.limitations)}::jsonb,
               claim_token = NULL, lease_expires_at = NULL,
               completed_at = NOW(), updated_at = NOW()
         WHERE evaluation_id = ${evaluationId}::uuid AND claim_token = ${claimToken}::uuid
         RETURNING evaluation_id
      `.execute(trx)
      if (!updated.rows[0]) throw new Error(`Outcome evaluation ${evaluationId} lost its claim lease`)
      await sql`DELETE FROM learning_outcome_steering_dimensions WHERE evaluation_id = ${evaluationId}::uuid`.execute(trx)
      for (const dimension of parsed.dimensions) {
        await sql`
          INSERT INTO learning_outcome_steering_dimensions (
            evaluation_id, dimension, status, estimate, confidence, rationale, observed_domains
          ) VALUES (
            ${evaluationId}::uuid, ${dimension.dimension}, ${dimension.status}, ${dimension.estimate},
            ${dimension.confidence}, ${dimension.rationale}, ${JSON.stringify(dimension.observedDomains)}::jsonb
          )
        `.execute(trx)
        for (const refId of dimension.evidenceRefs) {
          await sql`
            INSERT INTO learning_outcome_steering_evidence (evaluation_id, dimension, ref_id)
            VALUES (${evaluationId}::uuid, ${dimension.dimension}, ${refId})
          `.execute(trx)
        }
      }
    })
    const stored = await this.getEvaluation(evaluationId)
    if (!stored) throw new Error(`Outcome evaluation ${evaluationId} was not persisted`)
    return stored
  }

  async failEvaluation(evaluationId: string, claimToken: string, error: string): Promise<void> {
    await sql`
      UPDATE learning_outcome_steering_evaluations
         SET status = 'failed', error = ${error}, claim_token = NULL,
             lease_expires_at = NULL, completed_at = NOW(), updated_at = NOW()
       WHERE evaluation_id = ${evaluationId}::uuid AND claim_token = ${claimToken}::uuid
    `.execute(this.kysely)
  }

  async getEvaluation(evaluationId: string): Promise<OutcomeEvaluationRecord | undefined> {
    const result = await sql<{
      evaluation_id: string
      artifact_id: string
      evaluator_version: string
      backend: string
      model: string
      effort: string
      status: EvaluationStatus
      raw_judgment: unknown
      error: string | null
      started_at: string | Date
      completed_at: string | Date | null
    }>`
      SELECT evaluation_id, artifact_id, evaluator_version, backend, model, effort,
             status, raw_judgment, error, started_at, completed_at
        FROM learning_outcome_steering_evaluations
       WHERE evaluation_id = ${evaluationId}::uuid
    `.execute(this.kysely)
    const row = result.rows[0]
    if (!row) return undefined
    return {
      evaluationId: String(row.evaluation_id), artifactId: String(row.artifact_id),
      evaluatorVersion: row.evaluator_version, backend: row.backend, model: row.model,
      effort: row.effort, status: row.status,
      judgment: row.raw_judgment ? OutcomeSteeringJudgmentSchema.parse(row.raw_judgment) : null,
      error: row.error,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
      completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ? String(row.completed_at) : null,
    }
  }

  async listEvaluations(limit = 50): Promise<Array<OutcomeEvaluationRecord & { artifact: CanonicalEpisodeArtifact }>> {
    const result = await sql<{
      evaluation_id: string
      artifact_id: string
      evaluator_version: string
      backend: string
      model: string
      effort: string
      status: EvaluationStatus
      raw_judgment: unknown
      error: string | null
      started_at: string | Date
      completed_at: string | Date | null
      artifact: unknown
    }>`
      SELECT e.evaluation_id, e.artifact_id, e.evaluator_version, e.backend, e.model,
             e.effort, e.status, e.raw_judgment, e.error, e.started_at,
             e.completed_at, a.artifact
        FROM learning_outcome_steering_evaluations e
        JOIN learning_episode_artifacts a ON a.artifact_id = e.artifact_id
       ORDER BY e.started_at DESC
       LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}
    `.execute(this.kysely)
    return result.rows.map((row) => ({
      evaluationId: String(row.evaluation_id), artifactId: String(row.artifact_id),
      evaluatorVersion: row.evaluator_version, backend: row.backend, model: row.model,
      effort: row.effort, status: row.status,
      judgment: row.raw_judgment ? OutcomeSteeringJudgmentSchema.parse(row.raw_judgment) : null,
      error: row.error,
      startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at),
      completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at ? String(row.completed_at) : null,
      artifact: CanonicalEpisodeArtifactSchema.parse(row.artifact),
    }))
  }
}
