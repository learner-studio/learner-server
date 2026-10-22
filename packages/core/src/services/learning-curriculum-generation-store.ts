import type { Kysely } from 'kysely'
import type { DB, Json } from '../types/db.types.js'
import type { CurriculumRows } from '../lib/learning/curriculum-writer.js'
// CurriculumOutline is imported as a VALUE, not a type: the read path parses
// stored jsonb through the schema rather than casting to it. See readOutline.
import { CurriculumOutline } from '../lib/learning/curriculum-generation-types.js'
import type {
  CurriculumGraphProposal,
  CurriculumRunStatus,
  CurriculumSourceRef,
} from '../lib/learning/curriculum-generation-types.js'

/**
 * The durable record of a curriculum generation run, and the writer that turns
 * an approved proposal into rows a learner can open.
 *
 * Two properties are worth stating because the rest of the design follows from
 * them. Every read is scoped to an owner: a generated curriculum is private to
 * the person who asked for it, so a run id alone must never be enough to read
 * one. And the curriculum write is a single transaction: a half-written tree
 * would render as a broken page rather than as an error, and the learner would
 * have no way to tell the difference from a bad curriculum.
 */

export type GenerationRun = {
  readonly id: string
  readonly curriculumId: string | null
  readonly ownerUserId: string
  readonly objective: string
  readonly domain: string | null
  readonly scale: string | null
  readonly status: CurriculumRunStatus
  readonly outline: CurriculumOutline | null
  readonly graphProposal: CurriculumGraphProposal | null
  readonly shape: unknown
  readonly error: string | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** A JSON-safe copy of a computed value, typed as the column's Json. */
const toJson = (value: unknown): Json => JSON.parse(JSON.stringify(value))

type RunPatch = {
  status?: CurriculumRunStatus
  curriculumId?: string | null
  domain?: string | null
  scale?: string | null
  outline?: CurriculumOutline | null
  graphProposal?: CurriculumGraphProposal | null
  shape?: unknown
  error?: string | null
}

/**
 * Read a stored outline back through its own schema instead of casting to it.
 *
 * The column is jsonb and the rows outlive the type. `as CurriculumOutline` is
 * a promise to the compiler, not a check: when `moduleDependencies` was added
 * to the outline on 2026-09-11, every row written before that date came back
 * with the field ABSENT while the type said it was present, so the first
 * `outline.moduleDependencies.length` threw — in the approval panel, for the
 * one curriculum that was live. A Zod default only applies where `parse` runs,
 * and the read path was the one place it did not.
 *
 * The fallback is deliberate and narrow. A row that fails to parse for some
 * other reason is a data problem, but throwing here takes the whole builder
 * page down for every run the learner has; filling in what the current schema
 * would have defaulted keeps the page renderable and is strictly better than
 * the cast it replaces, which handed the caller a lie either way.
 */
const readOutline = (value: unknown): CurriculumOutline | null => {
  if (value === null || value === undefined) return null
  const parsed = CurriculumOutline.safeParse(value)
  if (parsed.success) return parsed.data
  const raw = value as CurriculumOutline
  return { ...raw, moduleDependencies: raw.moduleDependencies ?? [] }
}

export class LearningCurriculumGenerationStore {
  constructor(private readonly kysely: Kysely<DB>) {}

  async createRun(run: { id: string; ownerUserId: string; objective: string }): Promise<void> {
    await this.kysely
      .insertInto('learningCurriculumGenerationRuns')
      .values({ id: run.id, ownerUserId: run.ownerUserId, objective: run.objective, status: 'interpreting' })
      // A workflow step may replay, and replaying the first step must not
      // reset a run that has since progressed.
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute()
  }

  async updateRun(runId: string, patch: RunPatch): Promise<void> {
    const { shape, ...rest } = patch
    await this.kysely
      .updateTable('learningCurriculumGenerationRuns')
      .set({
        ...rest,
        ...(shape !== undefined ? { shape: shape === null ? null : toJson(shape) } : {}),
        // jsonb columns take an object directly, but node-postgres serializes a
        // JS array as a Postgres array literal, which jsonb rejects. These
        // three are objects or null, never arrays, so they pass as they are.
        updatedAt: new Date(),
      })
      .where('id', '=', runId)
      .execute()
  }

  /** A run, only for the person who started it. */
  async getRun(runId: string, ownerUserId: string): Promise<GenerationRun | null> {
    const row = await this.kysely
      .selectFrom('learningCurriculumGenerationRuns')
      .selectAll()
      .where('id', '=', runId)
      .where('ownerUserId', '=', ownerUserId)
      .executeTakeFirst()
    if (!row) return null
    return {
      ...row,
      status: row.status as CurriculumRunStatus,
      outline: readOutline(row.outline),
      graphProposal: (row.graphProposal ?? null) as CurriculumGraphProposal | null,
    }
  }

  /**
   * A run WITHOUT the owner check, for workflow steps.
   *
   * Steps run with no session, so they cannot supply an owner. This is safe
   * because nothing external reaches it: the id comes from the workflow's own
   * input, which the owner-scoped start RPC created. Every surface a person
   * can call goes through `getRun` instead.
   */
  async getRunById(runId: string): Promise<GenerationRun | null> {
    const row = await this.kysely
      .selectFrom('learningCurriculumGenerationRuns')
      .selectAll()
      .where('id', '=', runId)
      .executeTakeFirst()
    if (!row) return null
    return {
      ...row,
      status: row.status as CurriculumRunStatus,
      outline: readOutline(row.outline),
      graphProposal: (row.graphProposal ?? null) as CurriculumGraphProposal | null,
    }
  }

  async listRuns(ownerUserId: string, limit = 20): Promise<GenerationRun[]> {
    const rows = await this.kysely
      .selectFrom('learningCurriculumGenerationRuns')
      .selectAll()
      .where('ownerUserId', '=', ownerUserId)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .execute()
    return rows.map((row) => ({
      ...row,
      status: row.status as CurriculumRunStatus,
      outline: readOutline(row.outline),
      graphProposal: (row.graphProposal ?? null) as CurriculumGraphProposal | null,
    }))
  }

  /** The published material the run actually read, kept as citations. */
  async recordSources(runId: string, sources: readonly CurriculumSourceRef[]): Promise<void> {
    if (sources.length === 0) return
    await this.kysely
      .insertInto('learningCurriculumSources')
      .values(sources.map((source) => ({
        runId,
        sourceId: source.sourceId,
        provider: source.provider,
        title: source.title,
        url: source.url,
        licence: source.licence,
        attribution: source.attribution,
        retrievedAt: source.retrievedAt,
        contentChars: source.contentChars,
      })))
      .onConflict((conflict) => conflict.columns(['runId', 'sourceId']).doNothing())
      .execute()
  }

  async listSources(runId: string): Promise<CurriculumSourceRef[]> {
    const rows = await this.kysely
      .selectFrom('learningCurriculumSources')
      .selectAll()
      .where('runId', '=', runId)
      .orderBy('sourceId')
      .execute()
    return rows.map((row) => ({
      sourceId: row.sourceId,
      provider: row.provider as CurriculumSourceRef['provider'],
      title: row.title,
      url: row.url,
      licence: row.licence,
      attribution: row.attribution,
      retrievedAt: row.retrievedAt.toISOString(),
      contentChars: row.contentChars,
    }))
  }

  /**
   * Write a generated curriculum. One transaction, and idempotent: the write
   * step of a durable workflow may replay, so it deletes the curriculum's own
   * rows first rather than conflicting with a previous attempt.
   *
   * Concepts are the exception to the delete: they are namespaced by curriculum
   * id, so they cannot collide with another curriculum's, and an upsert keeps a
   * re-run cheap.
   */
  async writeCurriculum(rows: CurriculumRows): Promise<void> {
    const { curriculum } = rows
    const now = new Date()
    await this.kysely.transaction().execute(async (trx) => {
      await trx.insertInto('learningCurricula').values({
        id: curriculum.id,
        title: curriculum.title,
        description: curriculum.description,
        domain: curriculum.domain,
        status: curriculum.status,
        sourceKind: curriculum.sourceKind,
        ownerUserId: curriculum.ownerUserId,
        provenance: curriculum.provenance,
        updatedAt: now,
      }).onConflict((conflict) => conflict.column('id').doUpdateSet({
        title: curriculum.title,
        description: curriculum.description,
        domain: curriculum.domain,
        status: curriculum.status,
        sourceKind: curriculum.sourceKind,
        ownerUserId: curriculum.ownerUserId,
        provenance: curriculum.provenance,
        updatedAt: now,
      })).execute()

      // Order matters: memberships and dependencies reference modules, and
      // edges reference concepts, so the children go before the parents.
      await trx.deleteFrom('learningConceptEdges').where('curriculumId', '=', curriculum.id).execute()
      await trx.deleteFrom('learningCurriculumModuleConcepts').where('curriculumId', '=', curriculum.id).execute()
      await trx.deleteFrom('learningCurriculumModuleDependencies').where('curriculumId', '=', curriculum.id).execute()
      await trx.deleteFrom('learningCurriculumModules').where('curriculumId', '=', curriculum.id).execute()
      await trx.deleteFrom('learningCurriculumLanes').where('curriculumId', '=', curriculum.id).execute()

      // And the curriculum's own CONCEPTS, which the upsert below cannot reach.
      //
      // `learning_concepts` has no curriculum column — a concept is owned by
      // the namespace in its id (`<curriculumId>.<moduleId>--<slug>`, minted by
      // curriculumConceptId), which is exactly what makes this delete safe: no
      // other curriculum can produce a row under this prefix, and the seed's
      // ids carry no prefix at all. Without it, a rebuild that renames or drops
      // a concept leaves the old row behind with its memberships and edges
      // deleted — a node in the table belonging to no lesson, i.e. a graph that
      // grows on every regeneration instead of being replaced. Any row still
      // referenced from outside this curriculum raises a foreign-key error and
      // rolls the whole write back, which is the loud answer we want.
      await trx.deleteFrom('learningConcepts')
        .where('id', 'like', `${curriculum.id.replace(/[\\%_]/g, (character) => `\\${character}`)}.%`)
        .execute()

      await trx.insertInto('learningCurriculumLanes').values(rows.lanes.map((lane) => ({ ...lane }))).execute()

      await trx.insertInto('learningCurriculumModules').values(rows.modules.map((module) => ({
        ...module,
        // The generated column type is `unknown`, so node-postgres would
        // otherwise send this array as a Postgres array literal and jsonb
        // would reject it (SQLSTATE 22P02).
        masteryGoals: JSON.stringify(module.masteryGoals),
      }))).execute()

      if (rows.concepts.length > 0) {
        await trx.insertInto('learningConcepts').values(rows.concepts.map((concept) => ({
          ...concept,
          updatedAt: now,
        }))).onConflict((conflict) => conflict.column('id').doUpdateSet((excluded) => ({
          title: excluded.ref('excluded.title'),
          summary: excluded.ref('excluded.summary'),
          explanation: excluded.ref('excluded.explanation'),
          example: excluded.ref('excluded.example'),
          domain: excluded.ref('excluded.domain'),
          capability: excluded.ref('excluded.capability'),
          x: excluded.ref('excluded.x'),
          y: excluded.ref('excluded.y'),
          sourceKind: excluded.ref('excluded.sourceKind'),
          provenance: excluded.ref('excluded.provenance'),
          updatedAt: now,
        }))).execute()
      }

      if (rows.memberships.length > 0) {
        await trx.insertInto('learningCurriculumModuleConcepts').values(rows.memberships.map((row) => ({ ...row }))).execute()
      }
      if (rows.moduleDependencies.length > 0) {
        await trx.insertInto('learningCurriculumModuleDependencies').values(rows.moduleDependencies.map((row) => ({ ...row }))).execute()
      }
      if (rows.conceptEdges.length > 0) {
        await trx.insertInto('learningConceptEdges').values(rows.conceptEdges.map((row) => ({ ...row }))).execute()
      }
    })
  }

  /**
   * Whether the curriculum is this owner's generated one. Deleting goes through
   * the curriculum purge; this guard is what keeps a learner's rejection from
   * ever reaching the shipped library or someone else's curriculum.
   */
  async ownsGeneratedCurriculum(curriculumId: string, ownerUserId: string): Promise<boolean> {
    const owned = await this.kysely
      .selectFrom('learningCurricula')
      .select('id')
      .where('id', '=', curriculumId)
      .where('ownerUserId', '=', ownerUserId)
      .where('sourceKind', '=', 'generated')
      .executeTakeFirst()
    return owned !== undefined
  }
}
