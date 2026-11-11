import { defineFunction } from '../../runtime/define.js'
import { metaDbQuery } from '@learner/core/lib/db-metadata/_shared.js'
import { holdoutReport, masteryChanges } from '@learner/core/lib/learning/mastery-change.js'
import { GetMasteryChangesInput, HoldoutEffect, MasteryChanges } from '@learner/contract'
import { z } from 'zod'
import { masteryLearnerFor } from './mastery-notifications.function.js'
import { holdoutEffectOutput, masteryChangesOutput } from './mastery-statistics-output.js'

/** docs/specs/mastery-change-statistics.md. Computed on read; admin session or device key, as the other mastery RPCs. */

export const getMasteryChanges = defineFunction({
  title: 'Signed mastery change with a 95 % interval, per concept and overall',
  description: 'Declines included. Verdicts rest on prior-blind measurements (by evidence time): per-concept from/to/delta/slope with a Benjamini–Hochberg beyond-noise flag, each measurement\'s variance σ_e² + σ_g²/k (its own evidence error, measured from readings close in time, plus the grader\'s; replicates earn no precision until σ_e is measured); the random-effects mean change and slope per week with t-widened bootstrap intervals over concepts (none below the minimum), and whether the change interval excludes zero. The live, anchored scores are reported beside them with the grader\'s own drift.',
  expose: true, readonly: true,
  input: GetMasteryChangesInput, output: MasteryChanges,
  func: async (services, { sinceDays }, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    const out = await masteryChanges(metaDbQuery, userId, { sinceDays: sinceDays ?? null })
    const names = new Map((await metaDbQuery<{ id: string; title: string }>('SELECT id, title FROM learning_concepts WHERE id = ANY($1::text[])', [out.concepts.map((c) => c.conceptId)])).rows.map((r) => [r.id, r.title]))
    return masteryChangesOutput(out, names)
  },
})

export const getHoldoutEffect = defineFunction({
  title: 'osmosis-concept-holdout: taught minus held-out mastery, adjusted for baseline',
  description: 'Concepts with a baseline measured before the phase start. The headline (`probe`) is each probed concept\'s prior-blind answer to its FIRST delivered probe after the start (the probe analysis\'s k = 1: an equal opportunity in both arms, no earlier probe behind it); a first probe that produced no prior-blind reading is attrition in its arm (`baselineOnly`), never replaced by a later probe\'s answer. Both arms\' concepts are probed at the same rate, but for one learner the realized timing still differs by chance: the headline also adjusts for weeks from baseline to the answer, and `probed` gives each arm\'s probed share. For one learner this is a descriptive signal, not a test: about one probe in five is a held-out one and few held-out concepts have a baseline, so a verdict on teaching belongs to the pooled analysis. Beside it, with follow-up = the latest measurement after the start: every prior-blind measurement (opportunistic) and the live scores adjusted for gradings between. ANCOVA with a t-widened stratified bootstrap interval once enough concepts per arm are measured twice; per-arm gradings, attrition and a power line with the pace.',
  expose: true, readonly: true,
  input: z.object({}), output: HoldoutEffect,
  func: async (services, _data, { session }) => {
    const userId = await masteryLearnerFor(services, session)
    return holdoutEffectOutput(await holdoutReport(metaDbQuery, userId))
  },
})
