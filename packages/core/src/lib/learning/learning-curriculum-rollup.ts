import { z } from 'zod'

export const CurriculumRollupSchema = z.object({
  estimate: z.number().int().min(0).max(100).nullable(),
  known: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  required: z.number().int().nonnegative(),
  coverage: z.number().min(0).max(100),
  complete: z.boolean(),
})
export type CurriculumRollup = z.infer<typeof CurriculumRollupSchema>

/** Completion per curriculum module (its own and every descendant's concepts), per lane, and for the whole curriculum. */
export const CurriculumRollupsSchema = z.object({
  curriculum: CurriculumRollupSchema,
  lanes: z.record(z.string(), CurriculumRollupSchema),
  modules: z.record(z.string(), CurriculumRollupSchema),
})
export type CurriculumRollups = z.infer<typeof CurriculumRollupsSchema>

type RollupModule = { id: string; parentId: string | null; laneId: string; conceptIds: readonly string[] }
type RollupConcept = { id: string; assessment?: { assessment: { understandingPercent: number | null } | null } | null | undefined }

export function requiredConceptIds(moduleId: string, modules: readonly Omit<RollupModule, 'laneId'>[]): string[] {
  const visited = new Set<string>(), concepts = new Set<string>()
  const visit = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    for (const concept of modules.find((module) => module.id === id)?.conceptIds ?? []) concepts.add(concept)
    for (const child of modules.filter((module) => module.parentId === id)) visit(child.id)
  }
  visit(moduleId)
  return [...concepts]
}

/** Completion: every required atomic concept has equal weight, regardless of nesting or duplicates,
 * and an unassessed concept contributes nothing, so 3 of 10 concepts at 70% is 21% complete. */
export function curriculumRollup(ids: readonly string[], estimates: ReadonlyMap<string, number | null | undefined>): CurriculumRollup {
  const required = [...new Set(ids)]
  const values = required.map((id) => estimates.get(id)).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100)
  const complete = required.length > 0 && values.length === required.length && values.every((value) => value === 100)
  const rounded = required.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / required.length) : null
  return { estimate: rounded === 100 && !complete ? 99 : rounded, known: values.length, unknown: required.length - values.length,
    required: required.length, coverage: required.length ? values.length / required.length * 100 : 0, complete }
}

export function curriculumRollups(
  curriculum: { lanes: readonly { id: string }[]; modules: readonly RollupModule[] },
  concepts: readonly RollupConcept[],
): CurriculumRollups {
  const estimates = new Map(concepts.map((concept) => [concept.id, concept.assessment?.assessment?.understandingPercent]))
  const { lanes, modules } = curriculum
  return {
    curriculum: curriculumRollup(modules.flatMap((module) => module.conceptIds), estimates),
    lanes: Object.fromEntries(lanes.map((lane) => [lane.id, curriculumRollup(modules.filter((module) => module.laneId === lane.id).flatMap((module) => module.conceptIds), estimates)])),
    modules: Object.fromEntries(modules.map((module) => [module.id, curriculumRollup(requiredConceptIds(module.id, modules), estimates)])),
  }
}
