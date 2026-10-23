import type { Kysely } from 'kysely'
import { z } from 'zod'

import type { DB } from '../types/db.types.js'
import {
  LearningGraphSchema,
  LearningProvenanceSchema,
  type LearningGraph,
} from '../functions/learning/learning-seed.js'

const StringArraySchema = z.array(z.string())

/**
 * Durable boundary for curriculum content.
 *
 * Source seeds remain readable review artifacts, while this store makes the
 * runtime database canonical. Sync replaces only rows explicitly owned by the
 * seed. A later imported or user-authored curriculum with the same stable ID
 * is refused rather than silently overwritten.
 */
export class LearningCurriculumStore {
  constructor(private readonly kysely: Kysely<DB>) {}

  async syncSeeds(graphs: readonly LearningGraph[]): Promise<void> {
    for (const graph of graphs) await this.syncSeed(graph)
    const activeSeedIds = graphs.map((graph) => graph.curriculum.id)
    await this.kysely.transaction().execute(async (trx) => {
      let retiredSeeds = trx.deleteFrom('learningCurricula').where('sourceKind', '=', 'seed')
      if (activeSeedIds.length > 0) retiredSeeds = retiredSeeds.where('id', 'not in', activeSeedIds)
      await retiredSeeds.execute()
      await trx
        .deleteFrom('learningConcepts')
        .where('sourceKind', '=', 'seed')
        .where(({ not, exists, selectFrom }) => not(exists(
          selectFrom('learningCurriculumModuleConcepts')
            .select('conceptId')
            .whereRef('learningCurriculumModuleConcepts.conceptId', '=', 'learningConcepts.id'),
        )))
        .execute()
    })
  }

  /** Update this seed only; unlike syncSeeds, never retire other curricula or orphan concepts. */
  async syncSeed(graph: LearningGraph): Promise<void> {
    const parsed = LearningGraphSchema.parse(graph)
    await this.kysely.transaction().execute(async (trx) => {
      const existingCurriculum = await trx
        .selectFrom('learningCurricula')
        .select('sourceKind')
        .where('id', '=', parsed.curriculum.id)
        .executeTakeFirst()
      if (existingCurriculum && existingCurriculum.sourceKind !== 'seed') {
        throw new Error(`Refusing to overwrite non-seed curriculum ${parsed.curriculum.id}`)
      }

      const conceptIds = parsed.concepts.map((concept) => concept.id)
      const protectedConcept = conceptIds.length === 0
        ? undefined
        : await trx
            .selectFrom('learningConcepts')
            .select(['id', 'sourceKind'])
            .where('id', 'in', conceptIds)
            .where('sourceKind', '!=', 'seed')
            .executeTakeFirst()
      if (protectedConcept) {
        throw new Error(`Refusing to overwrite non-seed concept ${protectedConcept.id}`)
      }

      const updatedAt = new Date()
      await trx
        .insertInto('learningCurricula')
        .values({
          id: parsed.curriculum.id,
          title: parsed.curriculum.title,
          description: parsed.curriculum.description,
          domain: parsed.curriculum.domain,
          status: parsed.curriculum.status,
          sourceKind: 'seed',
          provenance: parsed.curriculum.provenance,
          updatedAt,
        })
        .onConflict((conflict) => conflict.column('id').doUpdateSet({
          title: parsed.curriculum.title,
          description: parsed.curriculum.description,
          domain: parsed.curriculum.domain,
          status: parsed.curriculum.status,
          sourceKind: 'seed',
          provenance: parsed.curriculum.provenance,
          updatedAt,
        }))
        .execute()

      // Lanes own the curriculum-local tree by cascade. Edges hang directly
      // from the curriculum, so clear them first and rebuild one deterministic
      // snapshot inside the same transaction.
      await trx.deleteFrom('learningConceptEdges').where('curriculumId', '=', parsed.curriculum.id).execute()
      await trx.deleteFrom('learningCurriculumLanes').where('curriculumId', '=', parsed.curriculum.id).execute()

      await trx.insertInto('learningCurriculumLanes').values(parsed.curriculum.lanes.map((lane) => ({
        curriculumId: parsed.curriculum.id,
        id: lane.id,
        title: lane.title,
        summary: lane.summary,
        laneOrder: lane.order,
        color: lane.color,
        provenance: lane.provenance,
      }))).execute()

      await trx.insertInto('learningCurriculumModules').values(parsed.curriculum.modules.map((item) => ({
        curriculumId: parsed.curriculum.id,
        id: item.id,
        laneId: item.laneId,
        step: item.step,
        title: item.title,
        summary: item.summary,
        parentId: item.parentId,
        // The generated type is `unknown` without a DB annotation, so node-pg
        // would otherwise serialize a JS array as a Postgres array literal.
        masteryGoals: JSON.stringify(item.masteryGoals),
        provenance: item.provenance,
      }))).execute()

      if (parsed.concepts.length > 0) {
        await trx.insertInto('learningConcepts').values(parsed.concepts.map((concept) => ({
          id: concept.id,
          title: concept.title,
          summary: concept.summary,
          explanation: concept.explanation,
          example: concept.example,
          domain: concept.domain,
          capability: concept.capability,
          x: concept.x,
          y: concept.y,
          sourceKind: 'seed',
          provenance: concept.provenance,
          updatedAt,
        }))).onConflict((conflict) => conflict.column('id').doUpdateSet((excluded) => ({
          title: excluded.ref('excluded.title'),
          summary: excluded.ref('excluded.summary'),
          explanation: excluded.ref('excluded.explanation'),
          example: excluded.ref('excluded.example'),
          domain: excluded.ref('excluded.domain'),
          capability: excluded.ref('excluded.capability'),
          x: excluded.ref('excluded.x'),
          y: excluded.ref('excluded.y'),
          sourceKind: 'seed',
          provenance: excluded.ref('excluded.provenance'),
          updatedAt,
        }))).execute()
      }

      const memberships = parsed.curriculum.modules.flatMap((item) => item.conceptIds.map((conceptId, position) => ({
        curriculumId: parsed.curriculum.id,
        moduleId: item.id,
        conceptId,
        position,
      })))
      if (memberships.length > 0) {
        await trx.insertInto('learningCurriculumModuleConcepts').values(memberships).execute()
      }

      const dependencies = parsed.curriculum.modules.flatMap((item) => item.dependsOnModuleIds.map((dependencyId) => ({
        curriculumId: parsed.curriculum.id,
        moduleId: item.id,
        dependsOnModuleId: dependencyId,
      })))
      if (dependencies.length > 0) {
        await trx.insertInto('learningCurriculumModuleDependencies').values(dependencies).execute()
      }

      if (parsed.edges.length > 0) {
        await trx.insertInto('learningConceptEdges').values(parsed.edges.map((edge) => ({
          curriculumId: parsed.curriculum.id,
          fromConceptId: edge.from,
          toConceptId: edge.to,
          kind: edge.kind,
          confidence: edge.confidence,
          provenance: edge.provenance,
        }))).execute()
      }
    })
  }

  async listGraphs(): Promise<LearningGraph[]> {
    const rows = await this.kysely.selectFrom('learningCurricula').select('id').orderBy('id', 'asc').execute()
    const graphs = await Promise.all(rows.map((row) => this.getGraph(row.id)))
    return graphs.filter((graph): graph is LearningGraph => graph !== undefined)
  }

  /**
   * The curricula one learner may see: the shipped library, which has no
   * owner, plus their own generated ones.
   *
   * This exists as a separate method rather than a parameter on `listGraphs`
   * because the two have genuinely different jobs. `listGraphs` builds the
   * concept catalogues that hooks, the semantic index and the consolidator
   * read, and several of those callers have no session at all. This one backs
   * an authenticated RPC, where showing a learner someone else's private
   * curriculum is a leak rather than a superset.
   *
   * A NULL owner means "shipped", not "unknown owner" — the database refuses
   * any other reading, since `learning_curricula_owner_check` ties the null to
   * `source_kind = 'seed'` exactly.
   */
  async listGraphsVisibleTo(ownerUserId: string): Promise<LearningGraph[]> {
    const rows = await this.kysely
      .selectFrom('learningCurricula')
      .select('id')
      .where((eb) => eb.or([eb('ownerUserId', 'is', null), eb('ownerUserId', '=', ownerUserId)]))
      .orderBy('id', 'asc')
      .execute()
    const graphs = await Promise.all(rows.map((row) => this.getGraph(row.id)))
    return graphs.filter((graph): graph is LearningGraph => graph !== undefined)
  }

  async getGraph(curriculumId: string): Promise<LearningGraph | undefined> {
    const curriculum = await this.kysely
      .selectFrom('learningCurricula')
      .selectAll()
      .where('id', '=', curriculumId)
      .executeTakeFirst()
    if (!curriculum) return undefined

    const [laneRows, moduleRows, membershipRows, dependencyRows, edgeRows] = await Promise.all([
      this.kysely.selectFrom('learningCurriculumLanes').selectAll()
        .where('curriculumId', '=', curriculumId).orderBy('laneOrder', 'asc').execute(),
      this.kysely.selectFrom('learningCurriculumModules').selectAll()
        .where('curriculumId', '=', curriculumId).orderBy('step', 'asc').execute(),
      this.kysely.selectFrom('learningCurriculumModuleConcepts').selectAll()
        .where('curriculumId', '=', curriculumId).orderBy('moduleId', 'asc').orderBy('position', 'asc').execute(),
      this.kysely.selectFrom('learningCurriculumModuleDependencies').selectAll()
        .where('curriculumId', '=', curriculumId).orderBy('moduleId', 'asc').orderBy('dependsOnModuleId', 'asc').execute(),
      this.kysely.selectFrom('learningConceptEdges').selectAll()
        .where('curriculumId', '=', curriculumId).orderBy('fromConceptId', 'asc').orderBy('toConceptId', 'asc').execute(),
    ])
    // The reads above are separate statements: a curriculum deleted after its row was read
    // cascades its lanes away and would parse as an invalid graph. It is gone, so say so.
    if (laneRows.length === 0) {
      const still = await this.kysely.selectFrom('learningCurricula').select('id').where('id', '=', curriculumId).executeTakeFirst()
      if (!still) return undefined
    }

    const conceptIds = [...new Set(membershipRows.map((row) => row.conceptId))]
    const conceptRows = conceptIds.length === 0
      ? []
      : await this.kysely.selectFrom('learningConcepts').selectAll().where('id', 'in', conceptIds).execute()
    const conceptById = new Map(conceptRows.map((row) => [row.id, row]))
    const conceptIdsByModule = new Map<string, string[]>()
    for (const row of membershipRows) {
      const ids = conceptIdsByModule.get(row.moduleId) ?? []
      ids.push(row.conceptId)
      conceptIdsByModule.set(row.moduleId, ids)
    }
    const dependenciesByModule = new Map<string, string[]>()
    for (const row of dependencyRows) {
      const ids = dependenciesByModule.get(row.moduleId) ?? []
      ids.push(row.dependsOnModuleId)
      dependenciesByModule.set(row.moduleId, ids)
    }

    return LearningGraphSchema.parse({
      curriculum: {
        id: curriculum.id,
        title: curriculum.title,
        description: curriculum.description,
        domain: curriculum.domain,
        status: curriculum.status,
        provenance: LearningProvenanceSchema.parse(curriculum.provenance),
        lanes: laneRows.map((lane) => ({
          id: lane.id,
          title: lane.title,
          summary: lane.summary,
          order: lane.laneOrder,
          color: lane.color,
          provenance: LearningProvenanceSchema.parse(lane.provenance),
        })),
        modules: moduleRows.map((item) => ({
          id: item.id,
          step: item.step,
          title: item.title,
          summary: item.summary,
          laneId: item.laneId,
          conceptIds: conceptIdsByModule.get(item.id) ?? [],
          parentId: item.parentId,
          dependsOnModuleIds: dependenciesByModule.get(item.id) ?? [],
          masteryGoals: StringArraySchema.parse(item.masteryGoals),
          provenance: LearningProvenanceSchema.parse(item.provenance),
        })),
      },
      concepts: conceptIds.flatMap((id) => {
        const concept = conceptById.get(id)
        return concept ? [{
          id: concept.id,
          title: concept.title,
          summary: concept.summary,
          explanation: concept.explanation,
          example: concept.example,
          domain: concept.domain,
          capability: concept.capability,
          provenance: LearningProvenanceSchema.parse(concept.provenance),
          x: concept.x,
          y: concept.y,
        }] : []
      }),
      edges: edgeRows.map((edge) => ({
        from: edge.fromConceptId,
        to: edge.toConceptId,
        kind: edge.kind,
        confidence: edge.confidence,
        provenance: LearningProvenanceSchema.parse(edge.provenance),
      })),
    })
  }
}
