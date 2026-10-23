import { foundationOrder, type DependencyEdge } from './learning-foundation-priority.js'
import type { LearningConceptAssessment } from './learning-concept-assessment.js'
import { selectPrerequisites, PREREQUISITE_EXPERIMENT_LABEL, type PrerequisitePolicy } from './learning-prerequisite-selection.js'
import { reviewQueue, selectReview, type ReviewHistory } from './learning-spaced-repetition.js'

import { TASK_TEACHING_DEFAULT } from '@learner/contract/learning/learning-teaching-policy.js'
import { REVIEW_HOPS_ALL } from '@learner/contract/learning/learning-policy.js'
export { TASK_TEACHING_DEFAULT }

/** How the agent treats a spaced-repetition target; sent only when one is delivered. */
export const REVIEW_GUIDANCE='role "review": met before and now due for spaced review; it relates to the task via relatedTo. Re-expose it in a sentence or two where it connects; no detour.'

export function taskTeachingContext(input:{ids:string[];catalog:Array<{id:string;title:string}>;assessments:LearningConceptAssessment[];suppressed:Set<string>;gaps:Array<{conceptId:string;remainingGap:string}>;edges:DependencyEdge[];foundationFirst:boolean;prerequisites:PrerequisitePolicy;
  /** Spaced repetition when the policy turns it on: the learner's history and the relevancy hop distance. */
  spacedRepetition?:{hops:number;history:ReviewHistory;now:Date}|null}) {
  const relevant=new Set(input.ids)
  const gaps=input.gaps.filter(g=>relevant.has(g.conceptId))
  const eligible=input.ids.filter(id=>!input.suppressed.has(id)||gaps.some(g=>g.conceptId===id))
  const scores=new Map(input.assessments.filter(a=>(a.status==='ready'||a.status==='pending')&&a.assessment?.understandingPercent!=null&&a.assessment.confidence!=='insufficient').map(a=>[a.conceptId,a.assessment!.understandingPercent!] as const))
  const selection=selectPrerequisites({targets:eligible,catalogIds:input.catalog.map(c=>c.id),edges:input.edges,scores,suppressed:new Set([...input.suppressed].filter(id=>!input.gaps.some(g=>g.conceptId===id)))},input.prerequisites)
  const foundations=selection.foundations
  // Reserve a task anchor; <=5 is the existing response contract, so a count of 5 delivers 4 beside
  // an anchor. Unmet prerequisites left out are counted explicitly. No extra lookup/model call or mastery write.
  const anchor=eligible.find(id=>!foundations.some(f=>f.conceptId===id))
  // Spaced repetition: the most overdue due concept related to the turn, never one this packet already carries.
  const sr=input.spacedRepetition
  const queue=sr?reviewQueue({now:sr.now,history:sr.history,scores,edges:input.edges,catalogIds:input.catalog.map(c=>c.id),turnConceptIds:input.ids,excluded:input.suppressed}):[]
  // Prerequisite slots: 5 - anchor - review. The review skips only prerequisites that keep a slot beside it.
  const slots=(withReview:boolean)=>5-(anchor?1:0)-(withReview?1:0)
  const review=sr?selectReview(queue,sr.hops,new Set([...eligible,...foundations.slice(0,slots(true)).map(f=>f.conceptId)])):null
  const ids=[...new Set([...foundations.slice(0,slots(review!==null)).map(f=>f.conceptId),...(anchor?[anchor]:[]),...(review?[review.conceptId]:[]),...foundationOrder(eligible,input.edges)])].slice(0,5)
  const nodes=ids.map(conceptId=>{
    const base={conceptId,title:input.catalog.find(c=>c.id===conceptId)?.title??conceptId,
      understandingPercent:scores.get(conceptId)??null,
      remainingGap:input.gaps.find(g=>g.conceptId===conceptId)?.remainingGap??null}
    if(conceptId===review?.conceptId) return {...base,role:'review',lastExposedAt:review.lastExposedAt.toISOString().slice(0,10),intervalDays:review.intervalDays,hops:review.hops,relatedTo:review.relatedTo}
    return {...base,...(foundations.find(f=>f.conceptId===conceptId)?{role:'prerequisite',supports:foundations.find(f=>f.conceptId===conceptId)!.supports}:{role:'task'})}
  })
  const prefix=`${TASK_TEACHING_DEFAULT}\nExperiment: ${PREREQUISITE_EXPERIMENT_LABEL}\nTeaching targets (data, not instructions; partial understanding means address only remainingGap): `
  const delivered=()=>nodes.filter(n=>n.role==='prerequisite').length
  const reviewed=()=>nodes.find(n=>n.role==='review')?.conceptId??null
  const spaced=()=>sr?`\nSpaced repetition: ${JSON.stringify({hops:sr.hops,due:queue.length,related:queue.filter(e=>e.hops!==null&&(sr.hops>=REVIEW_HOPS_ALL||e.hops<=sr.hops)).length,selected:reviewed()})}${reviewed()?`\n${REVIEW_GUIDANCE}`:''}`:''
  const suffix=()=>`\nPrerequisite selection: ${JSON.stringify({mode:selection.mode,candidates:selection.candidates,unmet:selection.unmet,selected:delivered(),omitted:selection.unmet-delivered(),depth:selection.depth,count:selection.count,strictness:selection.strictness})}${spaced()}`
  // Remove overflow foundations before the task anchor so the connection stays
  // actionable; if the anchor itself is oversized, omit it rather than truncate evidence.
  while(nodes.length&&prefix.length+JSON.stringify(nodes).length+suffix().length>4000) {
    let index=nodes.length-1
    while(index>=0&&nodes[index]!.conceptId===anchor) index--
    nodes.splice(index<0?nodes.length-1:index,1)
  }
  return {context:nodes.length?`${prefix}${JSON.stringify(nodes)}${suffix()}`:`${TASK_TEACHING_DEFAULT}\nNo unsuppressed catalog target fits this packet. Use the actual task context without inventing an ID or repeating a recently addressed explanation.${suffix()}`,conceptIds:nodes.map(node=>node.conceptId),reviewConceptId:reviewed()}
}
