import { randomUUID } from 'node:crypto'
import type { QueryFn } from '../../db/handle.js'
import { LIVE_GRADER_MODEL } from './grader-noise.js'
import { isHeldOut } from './learning-concept-holdout.js'
import { combineReplicates } from './mastery-change-statistics.js'
import type { SimLearner } from './mastery-known-truth.js'

/**
 * A simulated learner (mastery-known-truth.ts) written as the rows a real one leaves: one manual
 * assessment run and receipt per reading, its digest by the 0031 trigger, a prior-blind replicate
 * summary at k ≥ 2, and the live turns that make a probe answer one. The known-truth study then runs
 * through the SAME SQL the server reads (MEASUREMENTS, the view, probeAnswerEvidenceSql) instead of
 * the simulator's own bookkeeping. Callers write inside a transaction they roll back.
 *
 * - Times: simulated time 0 is placed so the simulated holdout start lands on `phaseStartedAt` (the
 *   recorded phase), so the server's own phase arithmetic applies.
 * - Concepts: each simulated concept gets a real id whose `isHeldOut` matches its simulated arm.
 * - A reading rests on one learner message, said at its time and cited, graded an hour later.
 *   Every fourth counted reading that answers no probe is UNCITED instead (review round 2, S-a): four
 *   learner messages, three hours, two hours and zero before its time and half an hour after, none
 *   cited, so the server dates it by the 75th percentile of its learner messages (READINGS), which is
 *   its simulated time.
 *   Uncounted readings are graded 'low', their blind summary too. An anchored grading's prompt carries its prior.
 * - The replicate summary is what `combineReplicates` makes of the reading's blind gradings (each at
 *   the reading's confidence), not a mean computed here.
 * - A probe answer: a probe of the concept delivered a minute before, in a session of its own whose
 *   next turn begins thirty seconds after and teaches nothing.
 */
export interface SeededLearner {
  userId: string
  /** Simulated concept id -> seeded concept id. */
  concepts: Map<string, string>
  /** Simulated time 0, in ms since the epoch. */
  origin: number
  /** The end of the simulated window: read the statistics "as of" this time. */
  end: number
}

export async function seedSimLearner(query: QueryFn, s: SimLearner, opts: { phaseStartedAt: number; tag: string; userId?: string }): Promise<SeededLearner> {
  const userId = opts.userId ?? `kt-${opts.tag}-${s.lane}-k${s.k}`
  const origin = opts.phaseStartedAt - s.phaseStart
  const concepts = new Map<string, string>()
  for (const simId of new Set(s.readings.map((r) => r.conceptId))) {
    const held = s.heldOut.has(simId)
    let id = ''
    for (let n = 0; ; n++) { id = `kt-${opts.tag}-${s.lane}-k${s.k}-${simId}-${n}`; if (isHeldOut(id) === held) break }
    concepts.set(simId, id)
    await query(`INSERT INTO learning_concepts(id,title,summary,explanation,example,domain,capability,x,y,source_kind)
      VALUES($1,$2,'s','e','x','d','c',0,0,'user')`, [id, `Known-truth ${s.lane} ${simId.split('-c')[1]}`])
  }
  const [backend, model, effort] = LIVE_GRADER_MODEL.split('/')
  let end = origin
  for (const [index, r] of s.readings.entries()) {
    const conceptId = concepts.get(r.conceptId)!
    const said = origin + r.at, graded = said + 3_600_000
    end = Math.max(end, graded)
    const runId = randomUUID(), messageId = `m-${runId}`
    const anchored = r.prior !== null
    const uncited = r.counted && !r.probe && index % 4 === 1
    const hour = 3_600_000
    const evidence = uncited
      ? [-3 * hour, -2 * hour, 0, hour / 2].map((dt, i) => ({ id: `${messageId}-${i}`, role: 'user', occurredAt: new Date(said + dt).toISOString(), text: 't' }))
      : [{ id: messageId, role: 'user', occurredAt: new Date(said).toISOString(), text: 't' }]
    const snapshot = {
      prompt: anchored ? `p\n### CURRENT PUBLISHED ESTIMATE\n${r.prior}% (medium)\n` : 'p',
      ...(anchored ? { prior: { understandingPercent: r.prior, confidence: 'medium' } } : {}),
      promptRevision: 'known-truth', model: { backend, model, effort },
      evidence,
    }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at)
      VALUES($1,$2,$1,$3,'v',$1,$4::jsonb,$5)`, [runId, userId, conceptId, JSON.stringify(snapshot), new Date(graded).toISOString()])
    const replicated = s.k > 1
    if (replicated) await query('INSERT INTO learning_concept_assessment_replicate_plans(run_id,replicates) VALUES($1,$2)', [runId, s.k])
    const receipt = { status: 'completed', completedAt: new Date(graded).toISOString(), assessment: {
      conceptId, understandingPercent: r.anchored, confidence: r.counted ? 'medium' : 'low',
      demonstrated: uncited ? [] : [{ quote: 'q', sourceId: messageId, description: 'd' }], gaps: [], nextCheck: 'n', needsReview: true } }
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)', [runId, JSON.stringify(receipt), new Date(graded).toISOString()])
    if (replicated) {
      // An uncounted reading's blind gradings are uncounted too (the simulator draws one confidence per reading).
      const c = combineReplicates(r.blind.map((percent) => ({ percent, confidence: r.counted ? 'medium' : 'low' })))
      await query(`INSERT INTO learning_concept_assessment_replicate_summaries(run_id,replicates,mean_percent,display_percent,sd,confidence) VALUES($1,$2,$3,$4,$5,$6)`,
        [runId, c?.replicates ?? 0, c?.meanPercent ?? null, c?.displayPercent ?? null, c?.sd ?? null, c?.confidence ?? null])
    }
    if (r.probe) {
      const session = `kt-${opts.tag}-${runId}`
      await query(`INSERT INTO learning_live_feedback_turns(user_id,session_id,turn_id,message,foundation_first,catalog_version,feedback,created_at,probe_concept_id,probe_outcome)
        VALUES($1,$2,$3,'m',false,'v',$4::jsonb,$5,$6,'delivered'), ($1,$2,$7,'m',false,'v',$4::jsonb,$8,NULL,NULL)`,
        [userId, session, randomUUID(), JSON.stringify({ matches: [], taughtConceptIds: [] }), new Date(said - 60_000).toISOString(), conceptId, randomUUID(), new Date(said + 30_000).toISOString()])
    }
  }
  return { userId, concepts, origin, end }
}
