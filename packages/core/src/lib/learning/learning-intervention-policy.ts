import { createHash } from 'node:crypto'
import { INJECTION_WINDOW_TURNS } from '@learner/contract/learning/learning-policy.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'
import type { ProbeDraw } from './learning-blind-probes.js'

/** Whether this turn may carry a teaching intervention. `recent` is the session's previous turns,
 * newest first, each true when that turn was injected. The rate is a ceiling, not a dice roll: at
 * most rate/20 injections in any 5 consecutive turns, so the realised rate matches the slider. */
export function injectionAllowed(recent:readonly boolean[],rate:number) {
  const quota=Math.round(rate*INJECTION_WINDOW_TURNS/100)
  return recent.slice(0,INJECTION_WINDOW_TURNS-1).filter(Boolean).length<quota
}

export const INJECTION_MODES=['quota','randomized'] as const
export type InjectionMode=(typeof INJECTION_MODES)[number]

/** A turn's draw for one purpose (`salt`): an integer 0-99 that is a pure function of the turn id,
 * so a replay draws the same number and anyone can recompute it. The first 7 hex digits (28 bits,
 * always a non-negative int in SQL) of md5("<salt>:<turnId>"), like the concept holdout. The id is
 * lowercased first: Postgres writes a uuid in lowercase, so the SQL twin hashes that form. */
export function turnDraw(salt:string,turnId:string):number {
  return parseInt(createHash('md5').update(`${salt}:${turnId.toLowerCase()}`).digest('hex').slice(0,7),16)%100
}
/** The same draw in SQL, for a column holding the turn id. */
export const turnDrawSql=(salt:string,column:string)=>`(('x' || substr(md5('${salt}:' || lower(${column}::text)), 1, 7))::bit(28)::int % 100)`

export const INJECTION_DRAW_SALT='learning-injection'
/** Randomized injection (docs/specs/randomized-injection.md): the coin for a turn worth teaching.
 * Heads with probability rate/100, independent of the session's earlier turns. */
export const injectionCoin=(turnId:string,rate:number):boolean=>turnDraw(INJECTION_DRAW_SALT,turnId)<rate

/** Decide, once, whether this live turn carries its teaching guidance. The decision is stored on the
 * turn, so a replayed submission returns it unchanged and later turns count what was delivered.
 * Earlier turns of the session that never submitted feedback count as not injected. A delivered
 * spaced-repetition review is stored with the decision (none when the turn is not injected), so the
 * policy does not offer it again for 24 hours. The turn's blind-probe decision (`probe`, null when
 * probes are off) is stored whatever its outcome: the draw, the arm, both arms' candidate counts and
 * why nothing was delivered.
 *
 * `valuable` (there is something worth teaching) is the turn's ELIGIBILITY. Among eligible turns the
 * default mode is the quota above; with `randomized` it is the turn's coin, so injected and
 * not-injected eligible turns differ only by chance. Eligibility, the mode and the rate are stored
 * with the decision in both modes. */
export async function decideTurnInjection(query:MetaPgQueryFn,turn:{userId:string;sessionId:string;turnId:string},valuable:boolean,rate:number,reviewConceptId:string|null=null,randomized=false,probe:ProbeDraw|null=null) {
  const mode:InjectionMode=randomized?'randomized':'quota'
  let injected=false
  if(valuable&&randomized) injected=injectionCoin(turn.turnId,rate)
  else if(valuable) {
    const recent=(await query<{injected:boolean}>(`SELECT COALESCE(p.injected,false) AS injected FROM learning_live_feedback_turns p, learning_live_feedback_turns t
      WHERE t.user_id=$1 AND t.session_id=$2 AND t.turn_id=$3 AND p.user_id=t.user_id AND p.session_id=t.session_id AND p.created_at<t.created_at
      ORDER BY p.created_at DESC LIMIT $4`,[turn.userId,turn.sessionId,turn.turnId,INJECTION_WINDOW_TURNS-1])).rows.map(row=>row.injected)
    injected=injectionAllowed(recent,rate)
  }
  // A probe is delivered only with the guidance; a not-injected turn keeps its draw, arm and counts.
  const decided=probe&&probe.outcome==='delivered'&&!injected?{...probe,outcome:'not_injected' as const,conceptId:null}:probe
  const stored=await query<{injected:boolean}>(`UPDATE learning_live_feedback_turns SET injected=$4,review_concept_id=CASE WHEN $4 THEN $5::text END,
    injection_eligible=$6,injection_mode=$7,injection_rate=$8,probe_concept_id=$9,
    probe_outcome=$10,probe_arm=$11,probe_held_out_candidates=$12,probe_taught_candidates=$13,probe_rate=$14,probe_hops=$15
    WHERE user_id=$1 AND session_id=$2 AND turn_id=$3 AND injected IS NULL RETURNING injected`,[turn.userId,turn.sessionId,turn.turnId,injected,reviewConceptId,valuable,mode,rate,
    decided?.conceptId??null,decided?.outcome??null,decided?.arm??null,decided?.heldOutCandidates??null,decided?.taughtCandidates??null,decided?.rate??null,decided?.hops??null])
  if(stored.rowCount) return injected
  return (await query<{injected:boolean}>(`SELECT injected FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`,[turn.userId,turn.sessionId,turn.turnId])).rows[0]!.injected
}

/** Guidance for a turn the policy leaves alone: no targets, so nothing for the agent to teach. */
export const NO_INTERVENTION_CONTEXT='Learning policy: no teaching intervention this turn. Answer the task as asked; do not add a lesson, a prerequisite explanation or an understanding check.'
