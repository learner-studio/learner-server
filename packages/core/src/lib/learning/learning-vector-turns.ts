import { z } from 'zod'
import { assessmentHash, AssessmentSourceSchema, buildConceptAssessmentInput, type AssessmentConcept, type AssessmentSource, type LearningConceptAssessment } from './learning-concept-assessment.js'

import { VectorTurnConfig } from './learning-vector-turn-schemas.js'
import { sliceHistoryTurns } from './learning-incremental-assessment.js'
export { VectorTurnConfig } from './learning-vector-turn-schemas.js'
export type VectorConfig = z.infer<typeof VectorTurnConfig>
export const VectorMessageSchema = AssessmentSourceSchema.extend({ authorship: z.string().optional(), logicalKey: z.string(), correlation: z.record(z.string(),z.unknown()), sourceOrder: z.number(), sourceVersion: z.string() })
export type VectorMessage = z.infer<typeof VectorMessageSchema>
export type VectorTurn = { id: string; conversationId: string; at: string; messageIds: string[]; linkage: 'explicit'|'unpaired'; nativeOrder?:{sourceId:string;sourceOrder:number}; chronology?:'consistent'|'conflicting'|'unknown' }
export const VECTOR_SELECTION_REVISION='complete-human-turns-v3-native-chronology'

/** Equal archive timestamps do not establish adjacency across unrelated native sources. */
export function hasAmbiguousVectorTurnOrder(a:VectorTurn,b:VectorTurn) {
  return a.id!==b.id && a.conversationId===b.conversationId && a.at===b.at &&
    (!a.nativeOrder || !b.nativeOrder || a.nativeOrder.sourceId!==b.nativeOrder.sourceId || a.nativeOrder.sourceOrder===b.nativeOrder.sourceOrder)
}
/** Source grouping makes the deterministic fallback transitive; it is NOT evidence of chronology. */
export function compareVectorTurnChronology(a:VectorTurn,b:VectorTurn) {
  return a.conversationId.localeCompare(b.conversationId)||a.at.localeCompare(b.at)||
    (a.nativeOrder?.sourceId??'').localeCompare(b.nativeOrder?.sourceId??'')||
    (a.nativeOrder && b.nativeOrder ? a.nativeOrder.sourceOrder-b.nativeOrder.sourceOrder : 0)||a.id.localeCompare(b.id)
}

/** Repack only unreceipted work; never reorder the chronology of concept parts. */
export function remainingVectorBatches(batches:Array<Array<{conceptId:string;part:number}>>, settled:Set<string>, concurrency:number) {
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>9) throw new Error('Invalid execution concurrency')
  const remaining=batches.flat().filter(item=>!settled.has(`${item.conceptId}:${item.part}`))
  const result:Array<Array<{conceptId:string;part:number}>>=[]
  for(const part of [...new Set(remaining.map(item=>item.part))].sort((a,b)=>a-b)) {
    const wave=remaining.filter(item=>item.part===part)
    for(let i=0;i<wave.length;i+=concurrency) result.push(wave.slice(i,i+concurrency))
  }
  return result
}

/** Identity links only; chronological proximity must never manufacture a partner. */
export type VectorUserIdentity = Pick<VectorMessage,'logicalKey'|'conversationId'|'correlation'>
export function reconstructVectorTurns(messages: VectorMessage[], storeUsers: VectorUserIdentity[] = messages.filter(m=>m.role==='user')): VectorTurn[] {
  const keys = (m: VectorUserIdentity) => {
    const c = m.correlation
    return [typeof c.runId === 'string' ? `run:${c.runId}` : null,
      typeof c.codexTurnId === 'string' && typeof c.codexThreadId === 'string' ? `codex:${c.codexThreadId}:${c.codexTurnId}` : null,
      typeof c.turnId === 'string' ? `turn:${m.conversationId}:${c.turnId}` : null].filter((x): x is string => x !== null)
  }
  const users = messages.filter(m => m.role === 'user')
  const identityOwners = new Map<string,Set<string>>()
  for (const user of storeUsers) for (const key of keys(user)) {
    const owners=identityOwners.get(key) ?? new Set<string>()
    owners.add(user.logicalKey);identityOwners.set(key,owners)
  }
  const byKey = new Map<string, VectorMessage[]>()
  for (const m of users) for (const key of keys(m)) byKey.set(key,[...(byKey.get(key) ?? []),m])
  const byLogical = new Map(users.map(m => [m.logicalKey,m]))
  const groups = new Map<string, VectorMessage[]>()
  for (const m of messages) {
    const hasParent = typeof m.correlation.parentLogicalMessageKey === 'string'
    const parent = hasParent ? byLogical.get(String(m.correlation.parentLogicalMessageKey)) : undefined
    const candidates = new Map(keys(m).flatMap(k => (identityOwners.get(k)?.size === 1 && byKey.get(k)?.length === 1 ? byKey.get(k)! : [])).map(x => [x.id,x]))
    const linked = m.role === 'user' ? m : hasParent ? parent : (candidates.size === 1 ? [...candidates.values()][0] : undefined)
    const owner = linked?.conversationId === m.conversationId ? linked : undefined
    const key = owner?.id ?? m.id
    groups.set(key,[...(groups.get(key) ?? []),m])
  }
  return [...groups.entries()].map(([id, group]) => {
    group.sort((a,b) => (a.occurredAt ?? '').localeCompare(b.occurredAt ?? '') || a.sourceOrder-b.sourceOrder || a.id.localeCompare(b.id))
    const anchor=group.find(m=>m.id===id)!
    const sourceId=anchor.correlation.sourceId
    const sourceOrder=anchor.correlation.sourceOrder
    const nativeOrder=typeof sourceId==='string' && sourceId.length>0 && typeof sourceOrder==='number' && Number.isFinite(sourceOrder)
      ? {sourceId,sourceOrder} : undefined
    const chronology=anchor.role!=='user' || !anchor.occurredAt || group.some(m=>!m.occurredAt) ? 'unknown' as const
      : group.some(m=>m.role==='assistant' && m.occurredAt!<anchor.occurredAt!) ? 'conflicting' as const : 'consistent' as const
    return { id, conversationId:anchor.conversationId,at:anchor.occurredAt ?? '',messageIds:group.map(m=>m.id),chronology,
      ...(nativeOrder ? {nativeOrder} : {}),
      linkage: group.some(m=>m.role==='user' && m.authorship==='human') && group.some(m=>m.role==='assistant') ? 'explicit' as const : 'unpaired' as const }
  }).sort(compareVectorTurnChronology)
}

/** One Claude-format observation's native link: its own key, its `parentUuid`, and whether it is a human prompt. */
export type NativeLinkRow = { logicalKey: string; parentUuid: string | null; human: boolean }

/**
 * Claude-format rows carry no turn id; a reply reaches its prompt only through
 * the native `parentUuid` chain, across thinking, tool-use and tool-result rows.
 * The first human prompt on that chain is the reply's turn. Identity only: a
 * broken chain links nothing, and so does an unindexed prompt when the caller
 * does not find it among the indexed users.
 */
export function nativeTurnAnchors(rows: readonly NativeLinkRow[]): Map<string, string> {
  const split = (key: string) => { const [provider, thread, role, ...native] = key.split(':'); return { provider, thread, role, native: native.join(':') } }
  const byNative = new Map<string, NativeLinkRow>()
  for (const row of rows) {
    const k = split(row.logicalKey)
    if (k.provider !== 'claude' || !k.thread || !k.native) continue
    const id = `${k.thread}\u0000${k.native}`
    // One native line can project to more than one row; the human prompt wins.
    if (!byNative.get(id)?.human) byNative.set(id, row)
  }
  const anchors = new Map<string, string>()
  for (const row of rows) {
    const k = split(row.logicalKey)
    if (k.provider !== 'claude' || k.role !== 'assistant') continue
    const seen = new Set<string>()
    let parent = row.parentUuid
    while (parent && !seen.has(parent)) {
      seen.add(parent)
      const next = byNative.get(`${k.thread}\u0000${parent}`)
      if (!next) break
      if (next.human) { anchors.set(row.logicalKey, next.logicalKey); break }
      parent = next.parentUuid
    }
  }
  return anchors
}

export function selectVectorTurns(turns: VectorTurn[], matchingIds: Set<string>, config: VectorConfig, scores:Map<string,number>=new Map()) {
  // The limit counts complete human turns, never orphan messages or CLI inputs.
  const matching = turns.filter(t=>t.linkage==='explicit' && t.messageIds.some(id=>matchingIds.has(id)))
  const score=(t:VectorTurn)=>Math.max(...t.messageIds.map(id=>scores.get(id)??-Infinity))
  if(config.selection==='relevant' && matching.some(t=>!Number.isFinite(score(t)))) throw new Error('Relevant turn selection requires similarity scores')
  const selected = config.selection === 'all' ? matching : [...matching].sort((a,b)=>(config.selection==='relevant'?score(b)-score(a):0)||b.at.localeCompare(a.at)||
    a.conversationId.localeCompare(b.conversationId)||compareVectorTurnChronology(b,a)).slice(0,config.latestTurns)
  return selected.sort(compareVectorTurnChronology)
}

/** A message is covered per source version: an edited message is new evidence. */
export const vectorCoverageKey=(message:Pick<VectorMessage,'id'|'sourceVersion'>)=>`${message.id}@${message.sourceVersion}`

/** Incremental live selection: every matching turn (no cap) that carries at least one message
 * the published estimate has not seen. A covered question with a new reply is reselected whole. */
export function selectUnseenVectorTurns(turns:VectorTurn[],matchingIds:Set<string>,covered:ReadonlySet<string>,messages:Map<string,VectorMessage>) {
  return turns.filter(t=>t.linkage==='explicit' && t.messageIds.some(id=>matchingIds.has(id)) && t.messageIds.some(id=>{
    const source=messages.get(id)
    if(!source) throw new Error('Turn source is missing')
    return !covered.has(vectorCoverageKey(source))
  })).sort(compareVectorTurnChronology)
}

/** Coverage after a pass: the prior estimate's coverage plus every message in every part graded. */
export function extendVectorCoverage(covered:Iterable<string>,parts:string[][],messages:Map<string,VectorMessage>) {
  const next=new Set(covered)
  for(const id of parts.flat()) {
    const source=messages.get(id)
    if(!source) throw new Error('A graded part message is missing from the snapshot')
    next.add(vectorCoverageKey(source))
  }
  return [...next].sort()
}

/** Estimates published before incremental grading recorded no coverage; they covered exactly their parts' evidence. */
export function publishedVectorCoverage(selection:{covered?:string[]}|undefined,partEvidence:Array<Array<Pick<VectorMessage,'id'|'sourceVersion'>>>) {
  return new Set(selection?.covered ?? partEvidence.flat().map(vectorCoverageKey))
}

/** UTF8 bytes are a conservative token upper bound; never split a turn or silently omit one. */
export function partitionVectorTurns(turns: VectorTurn[], messages: Map<string,VectorMessage>, tokenLimit: number, reservedBytes = 16000) {
  const batches: VectorTurn[][] = [[]]
  let bytes = 0
  for (const turn of turns) {
    const source=turn.messageIds.map(id=>{const m=messages.get(id);if(!m) throw new Error('Turn source is missing');return m})
    const size = Buffer.byteLength(JSON.stringify(source))
    if (size + reservedBytes > tokenLimit) throw new Error('One intact turn exceeds the configured input budget; nothing was truncated')
    if (bytes + size + reservedBytes > tokenLimit) { batches.push([]); bytes=0 }
    batches.at(-1)!.push(turn); bytes+=size
  }
  return batches
}

/** A cold live pass: every matching turn in time order (an increment is "what arrived next", across conversations),
 * cut into `slices` chronological slices of near-equal turn count; a slice over the budget is packed into several parts. */
export function coldVectorParts(turns: VectorTurn[], messages: Map<string,VectorMessage>, tokenLimit: number, slices: number) {
  const ordered = [...turns].sort((a,b)=>a.at.localeCompare(b.at)||a.id.localeCompare(b.id))
  const parts = ordered.length ? sliceHistoryTurns(ordered,slices).flatMap(slice=>partitionVectorTurns(slice,messages,tokenLimit)).map(batch=>batch.flatMap(t=>t.messageIds)) : []
  return { turns: ordered, parts }
}

/** Recheck the actual supplied prompt, schema and prior citations before reserving a paid call.
 * UTF8 bytes are deliberately conservative, not reported as measured model tokens. */
export function assertVectorPromptBudget(concept:AssessmentConcept,evidence:AssessmentSource[],prior:LearningConceptAssessment['assessment'],tokenLimit:number) {
  const built=buildConceptAssessmentInput(concept,evidence,prior)
  const inputBytes=Buffer.byteLength(built.prompt)+Buffer.byteLength(JSON.stringify(built.schema))
  if(inputBytes>tokenLimit) throw new Error(`Complete consolidation input exceeds configured budget (${inputBytes} conservative bytes > ${tokenLimit}); no evidence was truncated`)
  return inputBytes
}

export function vectorRunMetadata(runId: string, config: VectorConfig, inputHash: string, promptRevision: string) {
  const tag=config.datasetTag??'dev1'
  const vectorConfig = { model:'BAAI/bge-small-en-v1.5',dimensions:384,modelRevision:'5c38ec7c405ec4b44b94cc5a9bb96e735b38267a',method:'exact-cosine-threshold-v1',threshold:config.threshold }
  const consolidatorConfig = { model:'gemini-3.7-flash',effort:'high',promptRevision,increment:5 }
  return { experimentName:`${tag}: vector+turns`,datasetLabel:tag,runId,inputHash,vectorConfig,consolidatorConfig,selectionRevision:VECTOR_SELECTION_REVISION,
    curriculumRevision:config.curriculumRevision??null,assessmentConceptIds:config.conceptIds??null,baseRunId:config.baseRunId??null,
    vectorConfigHash:assessmentHash(vectorConfig),consolidatorConfigHash:assessmentHash(consolidatorConfig),
    traceId:assessmentHash([tag,runId]).slice(0,32),sessionId:runId,
    tags:[tag,'vector+turns','review-only',`selection:${config.selection}`,`vector:${assessmentHash(vectorConfig).slice(0,12)}`,`consolidator:${assessmentHash(consolidatorConfig).slice(0,12)}`],
    langfuse:{datasetName:`Learning · ${tag} · vector+turns`,environment:'development',exportStatus:'not-exported',usageAccounting:'one generation per actual model call'} }
}
