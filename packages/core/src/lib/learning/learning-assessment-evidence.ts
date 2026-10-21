import { z } from 'zod'

export const AssessmentEvidenceProvenanceSchema = z.object({
  origin: z.enum(['vector-selection', 'manual-vector-selection', 'legacy-assessment']),
  experimentId: z.string().nullable(),
  selectionRevision: z.string().nullable(),
  sourceIds: z.array(z.string()),
  groups: z.array(z.object({ id: z.string(), conversationId: z.string(), messageIds: z.array(z.string()), linkage: z.enum(['explicit', 'unpaired', 'unknown']) })),
  completeTurns: z.number(), unpairedGroups: z.number(), unknownGroups: z.number(),
})
export type AssessmentEvidenceProvenance = z.infer<typeof AssessmentEvidenceProvenanceSchema>

/** Project the immutable selection, never search current transcripts for replacements. */
export function assessmentEvidenceProvenance(
  evidence: readonly {id:string;conversationId:string;role:string}[],
  selection?: { experimentId: string|null; origin: 'vector-selection'|'manual-vector-selection'; revision?:string|undefined; turns: readonly {id:string;conversationId:string;messageIds:string[];linkage:'explicit'|'unpaired'}[] },
): AssessmentEvidenceProvenance {
  const sources=new Map(evidence.map(source=>[source.id,source]))
  const covered=new Set<string>()
  const groups:AssessmentEvidenceProvenance['groups']=[]
  for(const turn of selection?.turns??[]) {
    const messageIds=turn.messageIds.filter(id=>sources.has(id))
    if(!messageIds.length) continue
    for(const id of messageIds) covered.add(id)
    const paired=turn.linkage==='explicit' && messageIds.some(id=>sources.get(id)?.role==='user') && messageIds.some(id=>sources.get(id)?.role==='assistant')
    groups.push({id:turn.id,conversationId:turn.conversationId,messageIds,linkage:paired?'explicit':'unpaired'})
  }
  for(const source of evidence) if(!covered.has(source.id)) groups.push({id:source.id,conversationId:source.conversationId,messageIds:[source.id],linkage:'unknown'})
  return {origin:selection?.origin??'legacy-assessment',experimentId:selection?.experimentId??null,selectionRevision:selection?.revision??null,
    sourceIds:evidence.map(source=>source.id),groups,completeTurns:groups.filter(group=>group.linkage==='explicit').length,
    unpairedGroups:groups.filter(group=>group.linkage==='unpaired').length,unknownGroups:groups.filter(group=>group.linkage==='unknown').length}
}
