import { z } from 'zod'
import { metaDbQuery } from '../db-metadata/_shared.js'
import { schemasFor,type LiveFeedback } from './learning-live-feedback.js'
import { LIVE,type LiveCatalog } from './learning-live-catalog.js'

/** Historical bytes are immutable. Unlike new submissions, history is a
 * best-effort current-catalog projection: never invent aliases or evidence. */
export function projectRecentLiveFeedback(turnId:string,feedback:unknown,catalog:LiveCatalog=LIVE):LiveFeedback {
  const {ids,LiveFeedbackMatch,RecentLiveFeedback}=schemasFor(catalog)
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

/** The session's recent feedback (the 24 hours before `now`), newest first, WITHOUT a blind probe's answer: the matches for the
 * probed concept on the turn right after the probe (the same rule as readReviewHistory). Both readers
 * get this view: the live policy, so an answered probe never suppresses teaching or opens a gap, and
 * the begin packet, so the agent is not told about the answer either. The same rule for both arms. */
export async function readRecentLiveFeedback(userId:string,sessionId:string,catalog:LiveCatalog=LIVE,now:Date=new Date()):Promise<LiveFeedback[]> {
  const rows=await metaDbQuery<{turn_id:string;feedback:unknown;probed:string|null}>(`SELECT t.turn_id,t.feedback,
    (SELECT p.probe_concept_id FROM learning_live_feedback_turns p WHERE p.user_id=t.user_id AND p.session_id=t.session_id AND p.created_at<t.created_at ORDER BY p.created_at DESC LIMIT 1) AS probed
    FROM learning_live_feedback_turns t WHERE t.user_id=$1 AND t.session_id=$2 AND t.feedback IS NOT NULL AND t.created_at>$3::timestamptz-interval '24 hours' ORDER BY t.created_at DESC LIMIT 12`,[userId,sessionId,now.toISOString()])
  return rows.rows.map(row=>{
    const feedback=projectRecentLiveFeedback(row.turn_id,row.feedback,catalog)
    return row.probed?{...feedback,matches:feedback.matches.filter(match=>match.conceptId!==row.probed)}:feedback
  })
}
