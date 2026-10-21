import type {AssessmentSource} from './learning-concept-assessment.js'

export const EVIDENCE_TRIM_RULE='newest-first-whole-items-v1'

/** Conservative serialized-size estimate; callers record provider-reported tokens beside it. */
export const estimateEvidenceTokens=(evidence:AssessmentSource[],charsPerToken:number)=>Math.ceil(JSON.stringify(evidence).length/charsPerToken)

/**
 * Fit evidence to a token budget by dropping the OLDEST whole messages first.
 * Messages are never split: citations must stay byte-exact. The walk stops at the
 * first message that does not fit, so the result is always a contiguous most-recent
 * window, never older fragments slotted into leftover space. Survivors keep their
 * original order. Undated messages count as oldest; ties break on id.
 */
export function trimEvidenceNewestFirst(evidence:AssessmentSource[],budget:{maxTokens:number;charsPerToken:number}) {
  if(!(budget.maxTokens>0)||!(budget.charsPerToken>0))throw new Error('Evidence budget requires positive maxTokens and charsPerToken')
  const time=(item:AssessmentSource)=>item.occurredAt?Date.parse(item.occurredAt):Number.NEGATIVE_INFINITY
  const newestFirst=[...evidence].sort((a,b)=>time(b)-time(a)||a.id.localeCompare(b.id))
  const keep=new Set<AssessmentSource>()
  for(const item of newestFirst){
    if(estimateEvidenceTokens([...keep,item],budget.charsPerToken)>budget.maxTokens)break
    keep.add(item)
  }
  const kept=evidence.filter(item=>keep.has(item))
  return {kept,droppedIds:evidence.filter(item=>!keep.has(item)).map(item=>item.id),estimatedTokens:estimateEvidenceTokens(kept,budget.charsPerToken),rule:EVIDENCE_TRIM_RULE}
}
