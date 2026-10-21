import { z } from 'zod'
import { metaDbQuery } from '../db-metadata/_shared.js'
import { LIVE_CATALOG,LiveFeedbackMatch,RecentLiveFeedback,type LiveFeedback } from './learning-live-feedback.js'

const ids=new Set(LIVE_CATALOG.map(item=>item.id))
/** Historical bytes are immutable. Unlike new submissions, history is a
 * best-effort current-catalog projection: never invent aliases or evidence. */
export function projectRecentLiveFeedback(turnId:string,feedback:unknown):LiveFeedback {
  const stored=z.object({matches:z.unknown(),taughtConceptIds:z.unknown()}).safeParse(feedback)
  const rawMatches=stored.success&&Array.isArray(stored.data.matches)?stored.data.matches:[]
  const rawTaught=stored.success&&Array.isArray(stored.data.taughtConceptIds)?stored.data.taughtConceptIds:[]
  const matches:LiveFeedback['matches']=[]
  const taughtConceptIds:string[]=[]
  for(const raw of rawMatches) {
    const match=LiveFeedbackMatch.safeParse(raw)
    if(match.success&&!matches.some(item=>item.conceptId===match.data.conceptId)) matches.push(match.data)
  }
  for(const raw of rawTaught) {
    if(typeof raw==='string'&&ids.has(raw)&&!taughtConceptIds.includes(raw)) taughtConceptIds.push(raw)
  }
  if(!stored.success||!Array.isArray(stored.data.matches)||!Array.isArray(stored.data.taughtConceptIds)||matches.length!==rawMatches.length||taughtConceptIds.length!==rawTaught.length)
    console.warn('[learning-feedback] Historical entries excluded from current-catalog projection',{turnId})
  return RecentLiveFeedback.parse({turnId,matches,taughtConceptIds})
}

export async function readRecentLiveFeedback(userId:string,sessionId:string):Promise<LiveFeedback[]> {
  const rows=await metaDbQuery<{turn_id:string;feedback:unknown}>(`SELECT turn_id,feedback FROM learning_live_feedback_turns WHERE user_id=$1 AND session_id=$2 AND feedback IS NOT NULL AND created_at>now()-interval '24 hours' ORDER BY created_at DESC LIMIT 12`,[userId,sessionId])
  return rows.rows.map(row=>projectRecentLiveFeedback(row.turn_id,row.feedback))
}
