import { createHash } from 'node:crypto'
import type { metaDbQuery } from '../db-metadata/_shared.js'
import { buildConceptAssessmentInput, type AssessmentConcept, type AssessmentSource, type LearningConceptAssessment } from './learning-concept-assessment.js'
import { liveIncrementalInput } from './learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from './learning-live-incremental-variant.js'
import type { VectorConfig, VectorMessage, VectorTurn } from './learning-vector-turns.js'

type Query = typeof metaDbQuery
type Prior = LearningConceptAssessment['assessment']
/** A pass stores each message as {id, sourceVersion} plus the native-chain anchor selection added; rows written before
 * 2026-11-13 still carry the whole message. The text lives once, in learning_semantic_index_messages, immutable per message_id. */
export type SourceRef = Pick<VectorMessage, 'id' | 'sourceVersion'> & { parentLogicalMessageKey?: unknown }
type PartSelection = { concept: AssessmentConcept; parts: string[][]; turns: VectorTurn[]; context?: VectorTurn[] }
export const SOURCE_COLUMNS = `message_id AS id,conversation_id AS "conversationId",role,source_text AS text,
        observed_at::text AS "occurredAt",logical_message_key AS "logicalKey",payload->>'authorship' AS authorship,payload->'correlation' AS correlation,
        COALESCE((payload->'correlation'->>'sourceOrder')::float8,0) AS "sourceOrder",raw_version_id::text AS "sourceVersion"`
export const promptSha256 = (prompt: string) => createHash('sha256').update(prompt).digest('hex')

/** One part's model input from its pass: the selection, the pass's message references re-read by id from the immutable
 * rows (a moved version is refused), and the prior. preparePart builds a run with it; a live run rebuilds its prompt with it. */
export async function vectorPartInput(query: Query, config: Pick<VectorConfig, 'incremental' | 'contextAllowanceBytes' | 'maxInputTokens'>, selection: PartSelection,
  messages: ReadonlyArray<SourceRef | VectorMessage>, part: number, prior: Prior) {
  const needed = new Set([...selection.parts.flat(), ...selection.turns.flatMap(t => t.messageIds), ...(selection.context ?? []).flatMap(t => t.messageIds)])
  const refs = messages.filter(m => needed.has(m.id))
  const rows = new Map((await query<VectorMessage>(`SELECT ${SOURCE_COLUMNS} FROM learning_semantic_index_messages WHERE message_id=ANY($1::text[])`, [refs.map(m => m.id)])).rows.map(m => [m.id, m]))
  const resolved = refs.flatMap((ref): VectorMessage[] => {
    if ('text' in ref) return [ref]
    const m = rows.get(ref.id)
    if (!m || m.sourceVersion !== ref.sourceVersion) return []
    return [ref.parentLogicalMessageKey !== undefined && m.correlation.parentLogicalMessageKey === undefined ? { ...m, correlation: { ...m.correlation, parentLogicalMessageKey: ref.parentLogicalMessageKey } } : m]
  })
  // Through jsonb, as a pass's selection and whole messages are stored and read back: key order is part of the prompt and input hash.
  const { read, selected } = (await query<{ read: VectorMessage[]; selected: PartSelection }>('SELECT $1::jsonb AS read,$2::jsonb AS selected', [JSON.stringify(resolved), JSON.stringify(selection)])).rows[0]!
  const sources = new Map(read.map(m => [m.id, m]))
  const evidence = [...new Set(selected.parts[part])].map(id => { const source = sources.get(id); if (!source) throw new Error('A selected source is missing from the immutable snapshot'); return source })
  const incremental = config.incremental ? { revision: LIVE_INCREMENTAL_VARIANT.revision, built: liveIncrementalInput({ concept: selected.concept, prior, parts: selected.parts, part, turns: selected.turns,
    context: selected.context ?? [], sources, contextAllowanceBytes: config.contextAllowanceBytes, maxInputBytes: config.maxInputTokens, variant: LIVE_INCREMENTAL_VARIANT }) } : undefined
  return { evidence, incremental, built: incremental?.built ?? buildConceptAssessmentInput(selected.concept, evidence, prior) }
}

type Stored = { prompt?: string; context: { nodeStates: unknown[] }; evidence: Array<Partial<AssessmentSource>>; prior: Prior; experimentId?: string; part?: number; promptSha256?: string }
/**
 * A run's snapshot as graded. A live run (2026-11-13) stores its evidence as references and no prompt; its prompt,
 * evidence and quote context are rebuilt from its pass and refused unless byte-identical to what was frozen.
 */
export async function frozenRun<S extends Stored>(query: Query, run: { concept_id: string; input_hash: string; snapshot: S }) {
  const s = run.snapshot
  if (s.prompt !== undefined) return s as S & { prompt: string; evidence: AssessmentSource[] }
  const pass = (await query<{ config: VectorConfig; selected: PartSelection; messages: Array<SourceRef | VectorMessage> }>(`SELECT e.config,s AS selected,e.snapshot->'messages' AS messages FROM learning_vector_turn_experiments e,jsonb_array_elements(e.snapshot->'selections') s
    WHERE e.run_id::text=$1 AND s#>>'{concept,conceptId}'=$2`, [s.experimentId, run.concept_id])).rows[0]
  if (!pass) throw new Error('The pass this run was prepared from is gone; its prompt cannot be rebuilt')
  const { evidence, built } = await vectorPartInput(query, pass.config, pass.selected, pass.messages, s.part!, s.prior)
  if (built.inputHash !== run.input_hash || promptSha256(built.prompt) !== s.promptSha256) throw new Error('The rebuilt prompt differs from the one this run froze; refused')
  return { ...s, prompt: built.prompt, context: built.context, evidence }
}
