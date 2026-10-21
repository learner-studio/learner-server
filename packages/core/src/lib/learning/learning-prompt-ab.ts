import {createHash} from 'node:crypto'

export const PROMPT_AB_REVISION='curriculum-grounded-v1'
export const promptAbHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const promptAbId=(...parts:string[])=>{
  const h=promptAbHash(parts)
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}
export const seededConceptSample=(ids:string[],seed:string,count=50)=>[...new Set(ids)]
  .sort((a,b)=>promptAbHash([seed,a]).localeCompare(promptAbHash([seed,b]))).slice(0,count)

export const CURRICULUM_GROUNDING_INSTRUCTIONS=[
  'OVERALL OBJECTIVE: Help a human learn to understand, direct and evaluate LLM-assisted work. Maintain a provisional evidence-backed estimate for ONE concept so future assistance can build on demonstrated skills and address meaningful gaps.',
  'CURRICULUM CONTEXT: Each supplied breadcrumb is an actual curriculum/course/lesson path to the leaf concept. Use its educational context, concept description and learning objectives to interpret the intended meaning. Assess ONLY the supplied leaf concept, never its lesson, curriculum, prerequisites or neighbors. The application calculates parent rollups deterministically.',
  'RELEVANCE: Retrieval intentionally favors broad coverage. Retrieved conversations are candidates, not proof of relevance. Shared terminology is insufficient. Disregard material about a different meaning of the concept. Unrelated material must neither increase nor decrease a still-supported prior estimate; missing evidence means untested, not inability.',
  'CITATION GROUNDING: Every claimed demonstration and observed difficulty must cite an original HUMAN sourceId and an exact contiguous quote. Verify surrounding context: a human envelope can contain pasted assistant explanations or external sources. The quote must support the specific claim, not merely mention the concept. Base every non-null percentage on these cited human demonstrations, including still-supported citations retained from the prior assessment. If none exist, use null, confidence insufficient, and demonstrated []. Never invent citations; untested gaps remain explicitly uncited.',
  'STRUCTURED RESPONSE: Return ONLY JSON matching the supplied schema, exactly one proposal per concept/nodeVersion. Copy IDs exactly. understandingPercent is a five-point-increment provisional estimate or null, not a probability; confidence separately reflects evidence quality. Each demonstrated item has description/sourceId/quote. Each gap has description/kind/sourceId/quote; untested requires null citations, observed_difficulty requires a human citation. Keep at most five demonstrated items and five gaps. nextCheck is one concise task-relevant question or activity that advances the lesson objective by clarifying this concept. needsReview must be true. Do not add breadcrumbs, parent scores, commentary or extra properties to the response.',
].join('\n\n')

export function breadcrumbPrompt(oldPrompt:string,breadcrumbs:string[][]) {
  const marker='\n\nINPUT:\n'
  const at=oldPrompt.indexOf(marker)
  if(at<0||!breadcrumbs.length) throw new Error('Expected structured assessment input and real curriculum breadcrumb')
  const input=JSON.parse(oldPrompt.slice(at+marker.length))
  input.nodeStates=input.nodeStates.map((node:Record<string,unknown>)=>({...node,breadcrumbs}))
  return `${oldPrompt.slice(0,at)}\n\nEXPERIMENT PROMPT REVISION: ${PROMPT_AB_REVISION}\n\n${CURRICULUM_GROUNDING_INSTRUCTIONS}${marker}${JSON.stringify(input)}`
}

/** Blind derived assessment state, not raw conversation evidence. Both arms use
 * this exact transform before the treatment adds curriculum context. */
export function blindAssessmentPrompt(prompt:string) {
  const marker='\n\nINPUT:\n'
  const at=prompt.indexOf(marker)
  if(at<0)throw new Error('Missing structured assessment input')
  const input=JSON.parse(prompt.slice(at+marker.length))
  input.nodeStates=blindAssessmentNodes(input.nodeStates)
  return `${prompt.slice(0,at)}${marker}${JSON.stringify(input)}`
}
export function blindAssessmentNodes(nodes:Record<string,unknown>[]) {
  return nodes.map(({assessment:_,understandingPercent:__,...node})=>node)
}
