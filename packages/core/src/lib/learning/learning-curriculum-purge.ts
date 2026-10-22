import { randomUUID } from 'node:crypto'
import { metaDbQuery as q, metaDbWithClient, type MetaPgClient } from '../db-metadata/_shared.js'

/**
 * Deleting a curriculum, comprehensively: its tree and concepts, every score
 * and every grading record made against those concepts, and the live grading
 * state that would otherwise try to grade a concept that no longer exists.
 *
 * The purge is split into idempotent steps over a frozen record, so a durable
 * workflow can resume it after a crash, and a caller that needs it done
 * synchronously (rejecting an outline) runs the same steps with
 * `purgeCurriculum`. Assessment history is immutable everywhere else; the
 * trigger lets a DELETE through only inside `inPurge` (migration 0007).
 */
export type CurriculumPurgeOptions = {
  /** The shipped library (`source_kind = 'seed'`) is refused unless this is set. */
  allowSeed?: boolean
  /** Keep the generation runs and their sources: a rejected outline is still a record of what was turned down. */
  keepGenerationRuns?: boolean
}
export type CurriculumPurge = {
  purgeId: string; curriculumId: string; title: string | null; status: 'frozen' | 'completed'
  conceptCount: number; counts: Record<string, number>; requestedBy: string; createdAt: string; completedAt: string | null
}

const runPrefix = (curriculumId: string) => /-([0-9a-f]{8})$/.exec(curriculumId)?.[1] ?? null

/**
 * Freeze a purge: the curriculum's concepts that no other curriculum uses. An
 * open purge of the same curriculum is reused, so a retried request resumes it.
 * A curriculum already partly removed is still purged by its id prefix.
 */
export async function freezeCurriculumPurge(curriculumId: string, requestedBy: string, options: CurriculumPurgeOptions = {}): Promise<string> {
  const open = (await q<{ purge_id: string }>("SELECT purge_id FROM learning_curriculum_purges WHERE curriculum_id=$1 AND status='frozen'", [curriculumId])).rows[0]
  if (open) return open.purge_id
  const curriculum = (await q<{ title: string; source_kind: string }>('SELECT title,source_kind FROM learning_curricula WHERE id=$1', [curriculumId])).rows[0]
  if (curriculum?.source_kind === 'seed' && !options.allowSeed) throw new Error(`Curriculum ${curriculumId} is part of the shipped library; pass allowSeed to delete it`)
  const purgeId = randomUUID()
  return metaDbWithClient(async (client) => {
    await client.query('BEGIN')
    try {
      await client.query('INSERT INTO learning_curriculum_purges(purge_id,curriculum_id,title,source_kind,requested_by,options) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [purgeId, curriculumId, curriculum?.title ?? null, curriculum?.source_kind ?? null, requestedBy, JSON.stringify(options)])
      // Members of the tree, plus anything still carrying the generated id
      // prefix (a curriculum removed by an older path left those behind).
      await client.query(`INSERT INTO learning_curriculum_purge_concepts(purge_id,concept_id)
        SELECT $1::uuid,id FROM (
          SELECT concept_id AS id FROM learning_curriculum_module_concepts WHERE curriculum_id=$2
          UNION SELECT id FROM learning_concepts WHERE id LIKE $3
          UNION SELECT concept_id FROM learning_concept_assessment_runs WHERE concept_id LIKE $3
          UNION SELECT concept_id FROM learning_concept_assessment_cache WHERE concept_id LIKE $3
          UNION SELECT concept_id FROM learning_reactive_targets WHERE concept_id LIKE $3
        ) member
        WHERE NOT EXISTS(SELECT 1 FROM learning_curriculum_module_concepts other WHERE other.concept_id=member.id AND other.curriculum_id<>$2)`,
        [purgeId, curriculumId, `${curriculumId}.%`])
      await client.query('COMMIT')
      return purgeId
    } catch (error) { await client.query('ROLLBACK'); throw error }
  })
}

async function frozen(purgeId: string) {
  const row = (await q<{ curriculum_id: string; options: CurriculumPurgeOptions; status: string }>('SELECT curriculum_id,options,status FROM learning_curriculum_purges WHERE purge_id=$1', [purgeId])).rows[0]
  if (!row) throw new Error(`No such curriculum purge: ${purgeId}`)
  return row
}

/** One transaction in which the purge's concepts may be deleted from immutable history. */
async function inPurge(purgeId: string, fn: (client: MetaPgClient, concepts: string) => Promise<Record<string, number>>) {
  return metaDbWithClient(async (client) => {
    await client.query('BEGIN')
    try {
      await client.query("SELECT set_config('learner.curriculum_purge',$1,true)", [purgeId])
      const counts = await fn(client, `(SELECT concept_id FROM learning_curriculum_purge_concepts WHERE purge_id='${purgeId}'::uuid)`)
      await client.query("UPDATE learning_curriculum_purges SET counts=counts||$2::jsonb WHERE purge_id=$1", [purgeId, JSON.stringify(counts)])
      await client.query('COMMIT')
      return counts
    } catch (error) { await client.query('ROLLBACK'); throw error }
  })
}

const del = async (client: MetaPgClient, sql: string, params: unknown[] = []) => (await client.query(sql, params)).rowCount

/** Stop live grading from touching the concepts. Call under the reactive routing and admission locks. */
export async function stopCurriculumGrading(purgeId: string) {
  await frozen(purgeId)
  return inPurge(purgeId, async (client, set) => {
    const targets = `SELECT user_id,session_id FROM learning_reactive_targets WHERE concept_id IN ${set}`
    const counts = {
      reactiveNotifications: await del(client, `DELETE FROM learning_reactive_notifications WHERE (user_id,session_id) IN (${targets})`),
      reactiveAdmissions: await del(client, `DELETE FROM learning_reactive_admission WHERE (user_id,session_id) IN (${targets})`),
      reactiveTargets: await del(client, `DELETE FROM learning_reactive_targets WHERE concept_id IN ${set}`),
      activeSelections: await del(client, `DELETE FROM learning_concept_assessment_active WHERE concept_id IN ${set}`),
      scores: await del(client, `DELETE FROM learning_concept_assessment_cache WHERE concept_id IN ${set}`),
      // Cached catalog embeddings are keyed by catalog revision; one naming a purged concept is stale.
      conceptEmbeddingCaches: await del(client, `DELETE FROM learning_reactive_embeddings e WHERE EXISTS(
        SELECT 1 FROM jsonb_array_elements(e.concepts) c WHERE c->>'id' IN ${set})`),
    }
    // An explicit concept filter naming a purged concept would stop routing for everyone.
    await client.query(`UPDATE learning_reactive_settings SET config=jsonb_set(config,'{conceptIds}',
        COALESCE((SELECT jsonb_agg(id) FROM jsonb_array_elements_text(config->'conceptIds') id WHERE id NOT IN ${set}),'[]'::jsonb))
      WHERE jsonb_typeof(config->'conceptIds')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(config->'conceptIds') id WHERE id IN ${set})`)
    return counts
  })
}

/** Delete every grading record made against the concepts. */
export async function purgeCurriculumHistory(purgeId: string) {
  await frozen(purgeId)
  return inPurge(purgeId, async (client, set) => {
    const runs = `SELECT run_id FROM learning_concept_assessment_runs WHERE concept_id IN ${set}`
    const turnAssessments = await del(client, `DELETE FROM learning_vector_turn_assessments WHERE concept_id IN ${set} OR run_id IN (${runs})`)
    const counts = {
      turnAssessments,
      // Live and experiment passes scoped to purged concepts only, left with no assessments.
      vectorPasses: await del(client, `DELETE FROM learning_vector_turn_experiments x WHERE jsonb_typeof(x.config->'conceptIds')='array'
        AND jsonb_array_length(x.config->'conceptIds')>0
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(x.config->'conceptIds') id WHERE id NOT IN ${set})
        AND NOT EXISTS(SELECT 1 FROM learning_vector_turn_assessments a WHERE a.experiment_id=x.run_id)`),
      promptExports: await del(client, `DELETE FROM learning_consolidator_prompt_exports WHERE assessment_run_id IN (${runs})`),
      receipts: await del(client, `DELETE FROM learning_concept_assessment_receipts WHERE run_id IN (${runs})`),
      attempts: await del(client, `DELETE FROM learning_concept_assessment_attempts WHERE run_id IN (${runs})`),
      runs: await del(client, `DELETE FROM learning_concept_assessment_runs WHERE concept_id IN ${set}`),
      settledAdmissionArchive: await del(client, `DELETE FROM learning_reactive_admission_settled_20261021 WHERE concept_id IN ${set}`),
      routeMatches: await del(client, `UPDATE learning_reactive_routes SET matches=jsonb_set(matches,'{conceptIds}',
          COALESCE((SELECT jsonb_agg(id) FROM jsonb_array_elements_text(matches->'conceptIds') id WHERE id NOT IN ${set}),'[]'::jsonb))
        WHERE EXISTS(SELECT 1 FROM jsonb_array_elements_text(matches->'conceptIds') id WHERE id IN ${set})`),
    }
    return counts
  })
}

/** Delete the tree, the concepts and (unless kept) the generation runs and their sources. */
export async function removePurgedCurriculum(purgeId: string) {
  const { curriculum_id: curriculumId, options } = await frozen(purgeId)
  return inPurge(purgeId, async (client, set) => {
    const prefix = runPrefix(curriculumId)
    const counts = {
      conceptEdges: await del(client, `DELETE FROM learning_concept_edges WHERE curriculum_id=$1 OR from_concept_id IN ${set} OR to_concept_id IN ${set}`, [curriculumId]),
      moduleConcepts: await del(client, `DELETE FROM learning_curriculum_module_concepts WHERE curriculum_id=$1 OR concept_id IN ${set}`, [curriculumId]),
      moduleDependencies: await del(client, 'DELETE FROM learning_curriculum_module_dependencies WHERE curriculum_id=$1', [curriculumId]),
      modules: await del(client, 'DELETE FROM learning_curriculum_modules WHERE curriculum_id=$1', [curriculumId]),
      lanes: await del(client, 'DELETE FROM learning_curriculum_lanes WHERE curriculum_id=$1', [curriculumId]),
      concepts: await del(client, `DELETE FROM learning_concepts WHERE id IN ${set}`),
      curricula: await del(client, 'DELETE FROM learning_curricula WHERE id=$1', [curriculumId]),
      // Sources cascade with their run. A run whose curriculum link was nulled is found by the id suffix it gave the curriculum.
      generationRuns: options.keepGenerationRuns ? 0 : await del(client, `DELETE FROM learning_curriculum_generation_runs
        WHERE curriculum_id=$1 OR ($2::text IS NOT NULL AND curriculum_id IS NULL AND left(id,8)=$2)`, [curriculumId, prefix]),
    }
    return counts
  })
}

export async function finishCurriculumPurge(purgeId: string): Promise<CurriculumPurge> {
  await q("UPDATE learning_curriculum_purges SET status='completed',completed_at=COALESCE(completed_at,now()) WHERE purge_id=$1", [purgeId])
  return getCurriculumPurge(purgeId)
}

export async function getCurriculumPurge(purgeId: string): Promise<CurriculumPurge> {
  const row = (await q<{ purge_id: string; curriculum_id: string; title: string | null; status: CurriculumPurge['status']; counts: Record<string, number>; requested_by: string; created_at: Date; completed_at: Date | null; concepts: string }>(
    `SELECT p.*,(SELECT count(*) FROM learning_curriculum_purge_concepts c WHERE c.purge_id=p.purge_id) AS concepts FROM learning_curriculum_purges p WHERE p.purge_id=$1`, [purgeId])).rows[0]
  if (!row) throw new Error(`No such curriculum purge: ${purgeId}`)
  return { purgeId: row.purge_id, curriculumId: row.curriculum_id, title: row.title, status: row.status, conceptCount: Number(row.concepts), counts: row.counts,
    requestedBy: row.requested_by, createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null }
}

/** The whole purge, synchronously. The workflow runs the same steps durably. */
export async function purgeCurriculum(curriculumId: string, requestedBy: string, options: CurriculumPurgeOptions = {}, lock: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()): Promise<CurriculumPurge> {
  const purgeId = await freezeCurriculumPurge(curriculumId, requestedBy, options)
  await lock(() => stopCurriculumGrading(purgeId))
  await purgeCurriculumHistory(purgeId)
  await removePurgedCurriculum(purgeId)
  return finishCurriculumPurge(purgeId)
}
