import { randomUUID } from 'node:crypto'
import type { QueryFn } from '../../db/handle.js'
import { LIVE_GRADER_MODEL } from './grader-noise.js'
import { isHeldOut } from './learning-concept-holdout.js'
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
 *   Uncounted readings are graded 'low', their blind summary too. An anchored grading's prompt carries its prior.
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
  for (const r of s.readings) {
    const conceptId = concepts.get(r.conceptId)!
    const said = origin + r.at, graded = said + 3_600_000
    end = Math.max(end, graded)
    const runId = randomUUID(), messageId = `m-${runId}`
    const anchored = r.prior !== null
    const snapshot = {
      prompt: anchored ? `p\n### CURRENT PUBLISHED ESTIMATE\n${r.prior}% (medium)\n` : 'p',
      ...(anchored ? { prior: { understandingPercent: r.prior, confidence: 'medium' } } : {}),
      promptRevision: 'known-truth', model: { backend, model, effort },
      evidence: [{ id: messageId, role: 'user', occurredAt: new Date(said).toISOString(), text: 't' }],
    }
    await query(`INSERT INTO learning_concept_assessment_runs(run_id,user_id,request_id,concept_id,node_version,input_hash,snapshot,created_at)
      VALUES($1,$2,$1,$3,'v',$1,$4::jsonb,$5)`, [runId, userId, conceptId, JSON.stringify(snapshot), new Date(graded).toISOString()])
    const replicated = s.k > 1
    if (replicated) await query('INSERT INTO learning_concept_assessment_replicate_plans(run_id,replicates) VALUES($1,$2)', [runId, s.k])
    const receipt = { status: 'completed', completedAt: new Date(graded).toISOString(), assessment: {
      conceptId, understandingPercent: r.anchored, confidence: r.counted ? 'medium' : 'low',
      demonstrated: [{ quote: 'q', sourceId: messageId, description: 'd' }], gaps: [], nextCheck: 'n', needsReview: true } }
    await query('INSERT INTO learning_concept_assessment_receipts(run_id,receipt,completed_at) VALUES($1,$2::jsonb,$3)', [runId, JSON.stringify(receipt), new Date(graded).toISOString()])
    if (replicated) {
      const b = r.blind, mean = b.length ? b.reduce((x, y) => x + y, 0) / b.length : null
      const sd = b.length > 1 ? Math.sqrt(b.reduce((x, y) => x + (y - mean!) ** 2, 0) / (b.length - 1)) : null
      await query(`INSERT INTO learning_concept_assessment_replicate_summaries(run_id,replicates,mean_percent,display_percent,sd,confidence) VALUES($1,$2,$3,$4,$5,$6)`,
        // An uncounted reading's blind gradings are uncounted too (the simulator draws one confidence per reading).
        [runId, b.length, mean, mean === null ? null : Math.round(mean / 5) * 5, sd, b.length ? (r.counted ? 'medium' : 'low') : null])
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
