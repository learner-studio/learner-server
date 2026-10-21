import type { DependencyEdge } from './learning-foundation-priority.js'

export const PREREQUISITE_EXPERIMENT_LABEL='weakest lesson prerequisite in prompt'

/** Only verified prerequisite paths count: lesson co-membership is not dependency.
 * Lowest known score first; upstream among equal scores. Cycles are peers, not
 * infinite depth. Unknown/stale state is never converted into zero mastery.
 */
export function weakestPrerequisites(input:{targets:string[];catalogIds:string[];edges:DependencyEdge[];scores:Map<string,number>;suppressed:Set<string>}) {
  const valid=new Set(input.catalogIds)
  const parents=new Map<string,Set<string>>()
  for(const edge of input.edges) if(edge.kind==='hard-prerequisite'&&edge.from!==edge.to&&valid.has(edge.from)&&valid.has(edge.to)) {
    if(!parents.has(edge.to)) parents.set(edge.to,new Set())
    parents.get(edge.to)!.add(edge.from)
  }
  const ancestors=(id:string)=>{
    const seen=new Set<string>([id]), result=new Set<string>(), pending=[...(parents.get(id)??[])]
    while(pending.length) {
      const next=pending.pop()!
      if(seen.has(next)) continue
      seen.add(next);result.add(next);pending.push(...(parents.get(next)??[]))
    }
    return result
  }
  const supports=new Map<string,string[]>()
  for(const target of [...new Set(input.targets)].filter(id=>valid.has(id))) for(const id of ancestors(target)) {
    if(input.suppressed.has(id)) continue
    supports.set(id,[...(supports.get(id)??[]),target])
  }
  const candidates=[...supports.keys()].sort()
  const scored=candidates.filter(id=>input.scores.has(id))
  const weak=scored.filter(id=>input.scores.get(id)!<100)
  const unknown=candidates.filter(id=>!input.scores.has(id))
  const minimum=weak.length?Math.min(...weak.map(id=>input.scores.get(id)!)):null
  const tied=minimum===null?unknown:weak.filter(id=>input.scores.get(id)===minimum)
  const ancestry=new Map(tied.map(id=>[id,ancestors(id)]))
  const selected=tied.filter(id=>!tied.some(other=>other!==id&&ancestry.get(id)!.has(other)&&!ancestry.get(other)!.has(id)))
  return {candidates:candidates.length,mode:minimum===null?'unknown':'lowest-mastery',minimum,
    foundations:selected.map(conceptId=>({conceptId,supports:supports.get(conceptId)!,understandingPercent:input.scores.get(conceptId)??null}))}
}
