import { z } from 'zod'

import type { CurriculumCandidate, CurriculumObjectivePlan } from './curriculum-generation-types.js'

/**
 * The gate between "we found published material" and "we transcribed it".
 *
 * The first live run made the case for this on its own. Search returned three
 * unrelated MIT courses, and the outline step wrote a description reading "The
 * supplied published material does not teach computer algorithms or data
 * structures. The closest technical source is a seven-unit graduate Dynamics
 * course" — and then produced a Dynamics curriculum anyway. A learner who asked
 * about algorithms would have been handed a skill tree about rigid bodies.
 *
 * The model can clearly TELL. It just had no way to say no: `CurriculumOutline`
 * requires at least one module, so "none of this is usable" is not expressible
 * in the shape the outline step must return. This gate is that shape — one
 * verdict per candidate, before the material is even fetched, from titles and
 * summaries alone. It costs one cheap call and saves up to three browser
 * renders on material nobody should read.
 */

export const CurriculumRelevanceVerdict = z.object({
  sourceId: z.string().min(1),
  /** True only when this course TEACHES the objective's subject. A course that
   * merely applies it, or shares vocabulary with it, is false. */
  teachesObjective: z.boolean(),
  /** The model's own words. Shown to the learner when a run is refused, so a
   * bad search is legible as a bad search. */
  reason: z.string().min(1),
})
export type CurriculumRelevanceVerdict = z.infer<typeof CurriculumRelevanceVerdict>

export const CurriculumRelevanceVerdicts = z.object({
  verdicts: z.array(CurriculumRelevanceVerdict),
})
export type CurriculumRelevanceVerdicts = z.infer<typeof CurriculumRelevanceVerdicts>

export const RELEVANCE_SCHEMA = z.toJSONSchema(CurriculumRelevanceVerdicts)

export function buildRelevancePrompt(
  objective: string,
  plan: CurriculumObjectivePlan,
  candidates: readonly CurriculumCandidate[],
): string {
  const listed = candidates
    .map((candidate, index) =>
      [
        `${index + 1}. sourceId: ${candidate.sourceId}`,
        `   title: ${candidate.title}`,
        `   provider: ${candidate.provider}`,
        candidate.summary ? `   description: ${candidate.summary}` : '   description: (none published)',
      ].join('\n'),
    )
    .join('\n\n')

  return `A learner asked to understand: "${objective}"

Restated: ${plan.restated}
Subject area: ${plan.domain}

A search returned these published courses. Judge each one ONLY on whether it
TEACHES that subject to a learner who does not know it yet.

${listed}

Rules:
1. A course that APPLIES the subject to another field does not teach it. A
   course on chemical process control uses differential equations; it does not
   teach differential equations.
2. Shared vocabulary is not a subject match. "Algorithms for Inference" is a
   graduate course in probabilistic inference, not an introduction to
   algorithms; "Marine Power and Propulsion" is not about power systems.
3. A course at the wrong LEVEL still teaches the subject. Judge the subject,
   not the difficulty — the outline step handles depth.
4. Answer for EVERY sourceId listed, using the sourceId exactly as given.
5. The reason is one sentence a learner would understand, naming what the
   course is actually about.

Return {"verdicts": [{"sourceId", "teachesObjective", "reason"}]}.`
}

export type RelevanceSplit = {
  readonly kept: CurriculumCandidate[]
  /** Each rejected candidate with the reason it was rejected, in the order the
   * search ranked them. Recorded on the run so a refusal can be read. */
  readonly dropped: ReadonlyArray<{ candidate: CurriculumCandidate; reason: string }>
}

/**
 * Apply the verdicts to the candidate list.
 *
 * A candidate the model did not answer for is DROPPED, not kept. The whole
 * point of the gate is that unrelated material must not reach the outline, and
 * a silently-omitted verdict is an unasked question rather than a cleared one.
 * Since a run with nothing kept throws, the failure mode of a model that
 * answers nothing is a loud refusal, never a quiet Dynamics curriculum.
 */
export function applyRelevanceVerdicts(
  candidates: readonly CurriculumCandidate[],
  verdicts: readonly CurriculumRelevanceVerdict[],
): RelevanceSplit {
  const byId = new Map(verdicts.map((verdict) => [verdict.sourceId, verdict]))
  const kept: CurriculumCandidate[] = []
  const dropped: Array<{ candidate: CurriculumCandidate; reason: string }> = []
  for (const candidate of candidates) {
    const verdict = byId.get(candidate.sourceId)
    if (verdict?.teachesObjective) kept.push(candidate)
    else dropped.push({ candidate, reason: verdict?.reason ?? 'the relevance check returned no verdict for this source' })
  }
  return { kept, dropped }
}

/** The message a learner sees when every candidate was refused. It names the
 * courses and the reasons, because "no material found" for a search that
 * plainly returned results is the least useful thing we could say. */
export function describeRelevanceRefusal(objective: string, dropped: RelevanceSplit['dropped']): string {
  const lines = dropped.map(({ candidate, reason }) => `  - ${candidate.title}: ${reason}`)
  return `None of the ${dropped.length} published course(s) found teach "${objective}":\n${lines.join('\n')}`
}
