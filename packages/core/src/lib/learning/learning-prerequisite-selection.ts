import type { DependencyEdge } from './learning-foundation-priority.js'
import type { LearningPolicySettings, PrerequisiteDepth } from '@learner/contract/learning/learning-policy.js'

export const PREREQUISITE_EXPERIMENT_LABEL='weakest lesson prerequisite in prompt'

/** The three settings that decide prerequisite fallback. */
export type PrerequisitePolicy={strictness:number;count:number;depth:PrerequisiteDepth}
export const prerequisitePolicy=(settings:LearningPolicySettings):PrerequisitePolicy=>
  ({strictness:settings.progressionLinearity,count:settings.prerequisiteCount,depth:settings.prerequisiteDepth})

/** Unmet prerequisites of the task concepts, at most `count`, from at most `depth` hops up the
 * hard-prerequisite hierarchy (direct prerequisites are 1 hop). A scored prerequisite is unmet below
 * `strictness`; strictness 0 turns fallback off. Lowest score first; within a score, foundations
 * before their dependents, then by ID. Only verified prerequisite paths count: lesson co-membership
 * is not dependency, cycles are peers, and unknown is never zero mastery, so unscored prerequisites
 * are offered only when nothing scored is unmet.
 */
export function selectPrerequisites(input:{targets:string[];catalogIds:string[];edges:DependencyEdge[];scores:Map<string,number>;suppressed:Set<string>},policy:PrerequisitePolicy) {
  const valid=new Set(input.catalogIds)
  const parents=new Map<string,Set<string>>()
  for(const edge of input.edges) if(edge.kind==='hard-prerequisite'&&edge.from!==edge.to&&valid.has(edge.from)&&valid.has(edge.to)) {
    if(!parents.has(edge.to)) parents.set(edge.to,new Set())
    parents.get(edge.to)!.add(edge.from)
  }
  const maxHops=policy.depth==='all'?Infinity:policy.depth
  /** Ancestors with their nearest hop count, breadth first so each concept keeps its shortest path. */
  const ancestors=(id:string,limit=Infinity)=>{
    const hops=new Map<string,number>()
    let frontier=[id],hop=0
    while(frontier.length&&hop<limit) {
      hop++
      frontier=[...new Set(frontier.flatMap(next=>[...(parents.get(next)??[])]))].filter(p=>p!==id&&!hops.has(p))
      for(const p of frontier) hops.set(p,hop)
    }
    return hops
  }
  const supports=new Map<string,string[]>()
  for(const target of [...new Set(input.targets)].filter(id=>valid.has(id))) for(const id of ancestors(target,maxHops).keys()) {
    if(input.suppressed.has(id)) continue
    supports.set(id,[...(supports.get(id)??[]),target])
  }
  const candidates=[...supports.keys()].sort()
  const settings={depth:policy.depth,count:policy.count,strictness:policy.strictness}
  if(policy.strictness<=0) return {candidates:candidates.length,mode:'off' as const,unmet:0,minimum:null,...settings,foundations:[]}
  const unmetScored=candidates.filter(id=>input.scores.has(id)&&input.scores.get(id)!<policy.strictness)
  const pool=unmetScored.length?unmetScored:candidates.filter(id=>!input.scores.has(id))
  const lineage=new Map(pool.map(id=>[id,ancestors(id)]))
  // Peel foundations layer by layer within each score: a concept waits while a weaker-or-equal
  // ancestor of it is still unselected (mutual ancestors in a cycle are peers).
  const ranked:string[]=[]
  for(const score of [...new Set(pool.map(id=>input.scores.get(id)??-1))].sort((a,b)=>a-b)) {
    const remaining=new Set(pool.filter(id=>(input.scores.get(id)??-1)===score))
    while(remaining.size) {
      const layer=[...remaining].filter(id=>![...remaining].some(other=>other!==id&&lineage.get(id)!.has(other)&&!lineage.get(other)!.has(id))).sort()
      for(const id of layer) {ranked.push(id);remaining.delete(id)}
    }
  }
  const minimum=unmetScored.length?Math.min(...unmetScored.map(id=>input.scores.get(id)!)):null
  return {candidates:candidates.length,mode:unmetScored.length?'lowest-mastery' as const:'unknown' as const,unmet:pool.length,minimum,...settings,
    foundations:ranked.slice(0,policy.count).map(conceptId=>({conceptId,supports:supports.get(conceptId)!,understandingPercent:input.scores.get(conceptId)??null}))}
}
