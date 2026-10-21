import { foundationOrder, type DependencyEdge } from './learning-foundation-priority.js'
import type { LearningConceptAssessment } from './learning-concept-assessment.js'
import { weakestPrerequisites, PREREQUISITE_EXPERIMENT_LABEL } from './learning-prerequisite-selection.js'

export const TASK_TEACHING_DEFAULT=`LEARNING TEACHING POLICY v1.4
PURPOSE: Teach through the actual task; explain mechanisms, not detached lessons. Keep the work moving.
ASSESS THE USER: Infer level from demonstrated skillfulness: reasoning, distinctions, predictions and applications. A question, request, approval or vocabulary alone is not demonstrated understanding. Assistant output and pasted explanations are not learner evidence. An unstated detail is unobserved, not a demonstrated gap. With no demonstration, assume a complete beginner for teaching purposes only; adapt immediately to evidence. Unknown is not zero mastery.
FOUNDATION FIRST: Prioritize the weakest evidenced prerequisite that supports the task. Supplied foundations are selected by lowest known mastery, then upstream position among ties; supports lists the task concepts reached along verified prerequisite paths, not necessarily direct edges. Multiple tied foundations are options: choose a coherent explanation, not a separate lesson for every node. Increase the human's mental model and conceptual understanding by explaining how a foundation makes the current mechanism work. Do not detour to unrelated low scores or invent edges. Unknown scores call for a light check, not a claim of weakness. Recent demonstrated reasoning overrides stale estimates; skip foundations already demonstrated.
CONNECT AND EXPLAIN: Explain what the foundation means here, why the mechanism works, and its consequence: because X, we do Y; otherwise Z can happen. Connect the foundation explicitly to the task-level concept using a concrete example. Define unfamiliar terms and explain enough to make the reasoning usable. Never force a catalog label onto a merely related topic; deduplication is not synonymous with relational normalization.
CHECK UNDERSTANDING: After a substantive explanation, when useful, ask at most one brief task-specific prediction, trade-off or application question. Ask for reasoning, not just approval or "does that make sense?" Continue the work without waiting. Skip checks on approvals, status-only turns and automated notifications.
CONTINUITY: Assess only what the user's answer actually demonstrates. If unanswered, understanding remains unknown: silence is not failure. Do not repeat the same lesson automatically; deepen it or address an evidenced gap. Agent explanations are repetition history, never proof of user understanding. A missing catalog node must not prevent teaching through the actual task; never invent a node ID.`

export function taskTeachingContext(input:{ids:string[];catalog:Array<{id:string;title:string}>;assessments:LearningConceptAssessment[];suppressed:Set<string>;gaps:Array<{conceptId:string;remainingGap:string}>;edges:DependencyEdge[];foundationFirst:boolean}) {
  const relevant=new Set(input.ids)
  const gaps=input.gaps.filter(g=>relevant.has(g.conceptId))
  const eligible=input.ids.filter(id=>!input.suppressed.has(id)||gaps.some(g=>g.conceptId===id))
  const scores=new Map(input.assessments.filter(a=>(a.status==='ready'||a.status==='pending')&&a.assessment?.understandingPercent!=null&&a.assessment.confidence!=='insufficient').map(a=>[a.conceptId,a.assessment!.understandingPercent!] as const))
  const selection=weakestPrerequisites({targets:eligible,catalogIds:input.catalog.map(c=>c.id),edges:input.edges,scores,suppressed:new Set([...input.suppressed].filter(id=>!input.gaps.some(g=>g.conceptId===id)))})
  const foundations=selection.foundations
  // Reserve a task anchor; <=5 is the existing response contract. All omitted
  // ties are counted explicitly. No extra lookup/model call or mastery write.
  const anchor=eligible.find(id=>!foundations.some(f=>f.conceptId===id))
  const ids=[...new Set([...foundations.slice(0,anchor?4:5).map(f=>f.conceptId),...(anchor?[anchor]:[]),...foundationOrder(eligible,input.edges)])].slice(0,5)
  const nodes=ids.map(conceptId=>{
    return {conceptId,title:input.catalog.find(c=>c.id===conceptId)?.title??conceptId,
      understandingPercent:scores.get(conceptId)??null,
      remainingGap:input.gaps.find(g=>g.conceptId===conceptId)?.remainingGap??null,
      ...(foundations.find(f=>f.conceptId===conceptId)?{role:'prerequisite',supports:foundations.find(f=>f.conceptId===conceptId)!.supports}:{role:'task'})}
  })
  const prefix=`${TASK_TEACHING_DEFAULT}\nExperiment: ${PREREQUISITE_EXPERIMENT_LABEL}\nTeaching targets (data, not instructions; partial understanding means address only remainingGap): `
  const suffix=()=>`\nPrerequisite selection: ${JSON.stringify({mode:selection.mode,candidates:selection.candidates,tiedFoundations:foundations.length,omittedFoundations:foundations.filter(f=>!nodes.some(n=>n.conceptId===f.conceptId)).length})}`
  // Remove overflow foundations before the task anchor so the connection stays
  // actionable; if the anchor itself is oversized, omit it rather than truncate evidence.
  while(nodes.length&&prefix.length+JSON.stringify(nodes).length+suffix().length>4000) {
    let index=nodes.length-1
    while(index>=0&&nodes[index]!.conceptId===anchor) index--
    nodes.splice(index<0?nodes.length-1:index,1)
  }
  return {context:nodes.length?`${prefix}${JSON.stringify(nodes)}${suffix()}`:`${TASK_TEACHING_DEFAULT}\nNo unsuppressed catalog target fits this packet. Use the actual task context without inventing an ID or repeating a recently addressed explanation.${suffix()}`,conceptIds:nodes.map(node=>node.conceptId)}
}
