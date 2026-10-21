import type { Kysely } from 'kysely'

import type { DB } from '../../types/db.types.js'
import {
  compareCurriculumShapes,
  measureCurriculumShape,
  type CurriculumShape,
  type ShapeComparisonRow,
  type ShapeModule,
} from './curriculum-shape.js'

/**
 * Read a stored curriculum's structure and measure its shape.
 *
 * This is deliberately NOT built on `LearningCurriculumStore.getGraph`. That
 * method parses every row through `LearningGraphSchema`, which is the app's
 * view of a curriculum a learner can study — and a curriculum awaiting
 * approval is exactly the case where the shape matters most and the graph
 * schema is least willing to describe it. Reading the tables directly means
 * the measurement works on a draft the moment its rows land, which is what
 * the approval screen needs.
 *
 * Two joins deserve their reasons stated, because both encode a judgement:
 *
 * `sourceCount` is derived from each module's provenance kind rather than
 * counted from a sources table. A module whose provenance says
 * `external-material` was transcribed from published course material; one
 * saying `model-generated` or `model-seed` was not. That is the distinction
 * `groundedShare` exists to report, and provenance is where the writer
 * already records it per node.
 *
 * `distinctConceptCount` is queried separately rather than summed from the
 * per-module counts, because a concept may belong to more than one module.
 * The Computer Science seed has 664 distinct concepts across 674 memberships,
 * so summing would report ten concepts that do not exist.
 */
export async function measureStoredCurriculumShape(
  kysely: Kysely<DB>,
  curriculumId: string,
): Promise<CurriculumShape | null> {
  const curriculum = await kysely
    .selectFrom('learningCurricula')
    .select('id')
    .where('id', '=', curriculumId)
    .executeTakeFirst()
  if (!curriculum) return null

  const [laneRows, moduleRows, dependencyRows, membershipRows, edgeRows] = await Promise.all([
    kysely.selectFrom('learningCurriculumLanes').select('id')
      .where('curriculumId', '=', curriculumId).execute(),
    kysely.selectFrom('learningCurriculumModules').select(['id', 'laneId', 'provenance'])
      .where('curriculumId', '=', curriculumId).execute(),
    kysely.selectFrom('learningCurriculumModuleDependencies')
      .select(['moduleId', 'dependsOnModuleId', 'confidence'])
      .where('curriculumId', '=', curriculumId).execute(),
    kysely.selectFrom('learningCurriculumModuleConcepts').select(['moduleId', 'conceptId'])
      .where('curriculumId', '=', curriculumId).execute(),
    kysely.selectFrom('learningConceptEdges').select('fromConceptId')
      .where('curriculumId', '=', curriculumId).execute(),
  ])

  const dependenciesByModule = new Map<string, string[]>()
  for (const row of dependencyRows) {
    const existing = dependenciesByModule.get(row.moduleId) ?? []
    existing.push(row.dependsOnModuleId)
    dependenciesByModule.set(row.moduleId, existing)
  }

  const conceptsByModule = new Map<string, number>()
  for (const row of membershipRows) {
    conceptsByModule.set(row.moduleId, (conceptsByModule.get(row.moduleId) ?? 0) + 1)
  }

  const modules: ShapeModule[] = moduleRows.map((row) => ({
    id: row.id,
    laneId: row.laneId,
    dependsOnModuleIds: dependenciesByModule.get(row.id) ?? [],
    conceptCount: conceptsByModule.get(row.id) ?? 0,
    sourceCount: provenanceKind(row.provenance) === 'external-material' ? 1 : 0,
  }))

  // A null confidence means "hand-authored, nothing to score". Keeping only the
  // non-null values would silently score a partly-annotated curriculum against
  // a smaller denominator, so the set counts only when EVERY dependency
  // carries one; otherwise the field is omitted and reported as not
  // applicable. It is omitted rather than passed as undefined because
  // `exactOptionalPropertyTypes` distinguishes the two.
  const confidences = dependencyRows
    .map((row) => row.confidence)
    .filter((value): value is number => typeof value === 'number')
  const scorable = dependencyRows.length > 0 && confidences.length === dependencyRows.length

  return measureCurriculumShape({
    laneCount: laneRows.length,
    modules,
    conceptEdgeCount: edgeRows.length,
    distinctConceptCount: new Set(membershipRows.map((row) => row.conceptId)).size,
    ...(scorable ? { dependencyConfidences: confidences } : {}),
  })
}

/** The `kind` inside a provenance JSON column, or '' when it is absent or
 * malformed. Provenance is `jsonb`, so it arrives as an already-parsed value
 * of unknown shape rather than a string to parse. */
const provenanceKind = (provenance: unknown): string =>
  provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance)
    ? String((provenance as Record<string, unknown>).kind ?? '')
    : ''

export type CurriculumShapeReading = {
  readonly curriculumId: string
  readonly shape: CurriculumShape
  readonly baselineCurriculumId: string | null
  readonly comparison: readonly ShapeComparisonRow[]
}

/**
 * Measure one curriculum, optionally read against a baseline. The baseline is
 * a curriculum id rather than a stored snapshot so the comparison is always
 * against the seed as it stands today, not against a number written down once
 * and left to rot.
 */
export async function readCurriculumShape(
  kysely: Kysely<DB>,
  curriculumId: string,
  baselineCurriculumId?: string,
): Promise<CurriculumShapeReading | null> {
  const shape = await measureStoredCurriculumShape(kysely, curriculumId)
  if (!shape) return null
  if (!baselineCurriculumId || baselineCurriculumId === curriculumId) {
    return { curriculumId, shape, baselineCurriculumId: null, comparison: [] }
  }
  const baseline = await measureStoredCurriculumShape(kysely, baselineCurriculumId)
  if (!baseline) return { curriculumId, shape, baselineCurriculumId: null, comparison: [] }
  return {
    curriculumId,
    shape,
    baselineCurriculumId,
    comparison: compareCurriculumShapes(baseline, shape),
  }
}
