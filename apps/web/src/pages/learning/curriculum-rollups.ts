/** Completion as the API computes it (`getLearningGraph` → `rollups`); the browser only formats it. */
export type CurriculumRollup = { estimate: number | null; known: number; unknown: number; required: number; coverage: number; complete: boolean }
export type CurriculumRollups = { curriculum: CurriculumRollup; lanes: Record<string, CurriculumRollup>; modules: Record<string, CurriculumRollup> }
export const NO_ROLLUP: CurriculumRollup = { estimate: null, known: 0, unknown: 0, required: 0, coverage: 0, complete: false }
export const rollupLabel = (rollup: CurriculumRollup): string => `${rollup.estimate === null ? 'No concepts' : `${rollup.estimate}% complete`} · ${rollup.known}/${rollup.required} assessed · ${rollup.unknown} unknown`
