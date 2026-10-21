import { createHash } from 'node:crypto'
import { z } from 'zod'
import { classifierV6PromptForConfig, type ClassifierV6Case } from './learning-classifier-v6.js'

const auditSchema = z.object({ contextStrategy: z.string().optional(), attemptAudit: z.array(z.object({
  attempt:z.number(), batchId:z.string(), caseIds:z.array(z.string()), promptHash:z.string().optional(), prompt:z.string().optional(),
})).optional() })

/** Read-only historical reconstruction. A current template is never passed off
 * as an old request unless its complete bytes match the recorded digest. */
export function reviewClassifierInputs(config: unknown, cases: ClassifierV6Case[]) {
  const parsed=auditSchema.safeParse(config)
  if(!parsed.success)return []
  return (parsed.data.attemptAudit??[]).map(attempt=>{
    const batch=attempt.caseIds.map(id=>cases.find(c=>c.caseId===id))
    const unavailable={attempt:attempt.attempt,batchId:attempt.batchId,verification:'unavailable',prompt:null,conversationPayload:null,
      reason:'Exact historical prompt unavailable: missing cases, retry feedback, or a changed prompt/catalog. Frozen case snapshots remain available.'}
    if(!batch.length||batch.some(c=>!c)||new Set(attempt.caseIds).size!==batch.length)return unavailable
    const complete=batch.filter((c):c is ClassifierV6Case=>Boolean(c))
    if(attempt.attempt!==1 && !attempt.prompt)return unavailable
    let prompt:string
    try { prompt=attempt.prompt??classifierV6PromptForConfig(complete,parsed.data.contextStrategy?{contextStrategy:parsed.data.contextStrategy}:{}) } catch { return unavailable }
    if(createHash('sha256').update(prompt).digest('hex')!==attempt.promptHash)return unavailable
    return {attempt:attempt.attempt,batchId:attempt.batchId,verification:attempt.prompt?'hash-verified-recorded':'hash-verified-reconstruction',prompt,
      conversationPayload:parsed.data.contextStrategy==='three-turn-retrospective-v1'
        ?complete.map(({caseId,snapshot})=>({caseId,messages:snapshot.threeTurnSequence?.messages??[]}))
        :parsed.data.contextStrategy==='one-pair-target-response-v1'
          ?complete.map(({caseId,snapshot})=>({caseId,messages:snapshot.onePairSequence?.messages??[]}))
        :complete.map(({caseId,snapshot})=>({caseId,precedingConversation:snapshot.context.map(({role,text})=>({role,text})),currentLearnerMessage:snapshot.current.text})),
      reason:`${attempt.prompt?'Recorded application prompt':'Reconstructed from frozen snapshots'}; the full prompt matches the recorded SHA-256. This is the application input, not CLI-internal system messages.`}
  })
}
