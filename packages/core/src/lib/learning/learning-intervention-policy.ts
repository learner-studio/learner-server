import { INJECTION_WINDOW_TURNS } from '@learner/contract/learning/learning-policy.js'
import type { MetaPgQueryFn } from '../db-metadata/_shared.js'

/** Whether this turn may carry a teaching intervention. `recent` is the session's previous turns,
 * newest first, each true when that turn was injected. The rate is a ceiling, not a dice roll: at
 * most rate/20 injections in any 5 consecutive turns, so the realised rate matches the slider. */
export function injectionAllowed(recent:readonly boolean[],rate:number) {
  const quota=Math.round(rate*INJECTION_WINDOW_TURNS/100)
  return recent.slice(0,INJECTION_WINDOW_TURNS-1).filter(Boolean).length<quota
}

/** Decide, once, whether this live turn carries its teaching guidance. The decision is stored on the
 * turn, so a replayed submission returns it unchanged and later turns count what was delivered.
 * Earlier turns of the session that never submitted feedback count as not injected. */
export async function decideTurnInjection(query:MetaPgQueryFn,turn:{userId:string;sessionId:string;turnId:string},valuable:boolean,rate:number) {
  const recent=(await query<{injected:boolean}>(`SELECT COALESCE(p.injected,false) AS injected FROM learning_live_feedback_turns p, learning_live_feedback_turns t
    WHERE t.user_id=$1 AND t.session_id=$2 AND t.turn_id=$3 AND p.user_id=t.user_id AND p.session_id=t.session_id AND p.created_at<t.created_at
    ORDER BY p.created_at DESC LIMIT $4`,[turn.userId,turn.sessionId,turn.turnId,INJECTION_WINDOW_TURNS-1])).rows.map(row=>row.injected)
  const injected=valuable&&injectionAllowed(recent,rate)
  const stored=await query<{injected:boolean}>(`UPDATE learning_live_feedback_turns SET injected=$4 WHERE user_id=$1 AND session_id=$2 AND turn_id=$3 AND injected IS NULL RETURNING injected`,[turn.userId,turn.sessionId,turn.turnId,injected])
  if(stored.rowCount) return injected
  return (await query<{injected:boolean}>(`SELECT injected FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND turn_id=$3`,[turn.userId,turn.sessionId,turn.turnId])).rows[0]!.injected
}

/** Guidance for a turn the policy leaves alone: no targets, so nothing for the agent to teach. */
export const NO_INTERVENTION_CONTEXT='Learning policy: no teaching intervention this turn. Answer the task as asked; do not add a lesson, a prerequisite explanation or an understanding check.'
