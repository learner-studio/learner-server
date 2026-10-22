import { ASSESSMENT_MODEL, assessmentHash, conceptVersion, type AssessmentConcept, type AssessmentSource, type LearningConceptAssessment } from './learning-concept-assessment.js'
import { gradualAssessmentPrompt, gradualAssessmentSchema, validateGradualAssessment, type GradualAssessmentContext } from './learning-gradual-assessment.js'
import { percentToLevel } from './learning-mastery-model-comparison.js'

/**
 * v6 grades ONE increment against the published estimate. v5 stays untouched for its receipts:
 * it is prior-blind, so a pass over only the new turns overwrote the grade with a read of those turns.
 * Here the model sees the estimate, earlier turns as read-only context, and the new turns as the
 * only gradable and citable evidence. The validator enforces "only citable" because context turns
 * never enter `humanTextBySourceId`.
 */
export const INCREMENTAL_ASSESSMENT_REVISION = 'gradual-understanding-v6-prior-aware-incremental' as const
/** Operator starting allowance: ~40k tokens, measured as conservative UTF-8 bytes like every budget here. */
export const DEFAULT_CONTEXT_ALLOWANCE_BYTES = 160_000

export type HistoryTurn = { id: string; at: string; messages: AssessmentSource[] }
export type IncrementalVariant = { revision: string; instructions: string[] }
type Prior = LearningConceptAssessment['assessment']

// v5 paragraphs that define WHAT counts as understanding and how to cite it carry over verbatim, matched by
// their opening words so a v5 edit that moves or drops one fails loudly. The prior-blind paragraph and the
// unknown rule are replaced: both assume a from-scratch read.
const CARRIED_V5 = ['OBJECTIVE:', 'Assess provisional', 'Give your best', 'Use your judgment', 'AUTHORITY:', 'Every demonstrated item', 'Read the supplied', 'EVIDENCE DEFINITIONS:', 'Distinguish (1)', 'A following assistant', 'OUTCOME:', 'Separate gaps:', 'Return only']
const INCREMENTAL_RULES = [
  'INCREMENTAL UPDATE: You are revising the CURRENT PUBLISHED ESTIMATE for this concept, not grading from scratch. That estimate already reflects every earlier turn, including those shown as context. Judge only what the new evidence adds. Raise the estimate when the new evidence shows deeper, broader or more independent understanding than the estimate credits; lower it when the new evidence shows an observed difficulty or misconception that contradicts what the estimate credits; otherwise return the same percent and confidence. Never raise a score because more turns accumulated, and never lower it because the new evidence is unrelated, thin or off-topic: missing evidence is not inability.',
  'NO ESTIMATE YET: When the current published estimate is none, assess the new evidence on its own. Use null (unknown), confidence=insufficient and demonstrated=[] when it supports no understanding estimate; missing evidence is NOT 0% understanding. When an estimate exists and the new evidence adds nothing, keep its percent and confidence instead of returning null.',
  'CONTEXT IS READ-ONLY: the context section holds earlier turns, newest first, that are ALREADY reflected in the current estimate. Use it only to interpret the new evidence: what was asked, what guidance preceded it, whether the human is repeating earlier guidance. Do not credit or penalise it a second time and never cite it. Every sourceId and quote must come from a HUMAN message in the new-evidence section. Context may be cut off; the absence of older turns is not evidence.',
  'demonstrated lists only what the new evidence shows (0-5 items); earlier demonstrations stay on record and are already reflected in the percent. Gaps may restate aspects the current estimate still leaves untested.',
]
export function v5Paragraphs(openings: string[]) {
  const paragraphs = gradualAssessmentPrompt({ nodeStates: [], nativeObservations: [], evidence: [] }).split('\n\n')
  return openings.map(opening => {
    const found = paragraphs.filter(p => p.startsWith(opening))
    if (found.length !== 1) throw new Error(`v5 assessment paragraph not found exactly once: ${opening}`)
    return found[0]!
  })
}
export function defaultIncrementalVariant(): IncrementalVariant {
  const carried = v5Paragraphs(CARRIED_V5)
  return { revision: INCREMENTAL_ASSESSMENT_REVISION, instructions: [...carried.slice(0, -1), ...INCREMENTAL_RULES, carried.at(-1)!] }
}
/** A candidate's instructions under a revision that names its content, so receipts can never conflate two texts. */
export function incrementalVariant(instructions: string[]): IncrementalVariant {
  if (!instructions.length || instructions.some(p => !p.trim() || p.includes('### '))) throw new Error('Instructions must be non-empty paragraphs without section markers')
  const same = JSON.stringify(instructions) === JSON.stringify(defaultIncrementalVariant().instructions)
  return { revision: same ? INCREMENTAL_ASSESSMENT_REVISION : `${INCREMENTAL_ASSESSMENT_REVISION}+${assessmentHash(instructions).slice(0, 12)}`, instructions }
}

/** The estimate as the model sees it: descriptions only. Earlier quotes are not citable in this pass. */
const priorForPrompt = (prior: Prior) => prior && {
  understandingPercent: prior.understandingPercent, confidence: prior.confidence,
  demonstrated: prior.demonstrated.map(d => d.description), gaps: prior.gaps.map(g => ({ kind: g.kind, description: g.description })), nextCheck: prior.nextCheck,
}

export function buildIncrementalAssessmentInput(concept: AssessmentConcept, evidence: AssessmentSource[], prior: Prior, context: HistoryTurn[], variant: IncrementalVariant) {
  const nodeVersion = conceptVersion(concept)
  const nodeStates = [{ ...concept, nodeVersion }]
  const prompt = [
    `Learning educational assessment, revision ${variant.revision}. Produce one review-only proposal for the supplied concept/nodeVersion. Do not modify learner state.`,
    ...variant.instructions,
    `### CONCEPT\n${JSON.stringify(nodeStates)}`,
    `### CURRENT PUBLISHED ESTIMATE (already reflects every earlier turn)\n${prior ? JSON.stringify(priorForPrompt(prior)) : 'none'}`,
    `### CONTEXT (already reflected in the current estimate; read-only, NOT evidence, NOT citable; newest first)\n${JSON.stringify(context.map(t => ({ at: t.at, messages: t.messages })))}`,
    `### NEW EVIDENCE (the only gradable and citable material; chronological)\n${JSON.stringify(evidence)}`,
  ].join('\n\n')
  const schema = gradualAssessmentSchema([concept.conceptId])
  return {
    nodeVersion, prompt, schema,
    // The answer contract is part of the input: the server-stamped schema (no nodeVersion) never reuses an earlier receipt.
    inputHash: assessmentHash({ revision: variant.revision, instructions: assessmentHash(variant.instructions), model: ASSESSMENT_MODEL, schema: assessmentHash(schema), concept, evidence, prior, context: context.map(t => t.id) }),
    // Context stays out of this map, so a context quote fails validation as an unknown source.
    context: { nodeStates, humanTextBySourceId: Object.fromEntries(evidence.filter(item => item.role === 'user').map(item => [item.id, item.text])) } satisfies GradualAssessmentContext,
  }
}

const turnBytes = (turn: HistoryTurn) => Buffer.byteLength(JSON.stringify(turn.messages))
/** Earlier turns newest first, whole turns only. Stops at the first turn that does not fit, so context is
 * always a contiguous most-recent window, never an older fragment slotted into leftover space. */
export function selectContextTurns(history: HistoryTurn[], newTurnIds: ReadonlySet<string>, allowanceBytes: number) {
  const earlier = history.filter(t => !newTurnIds.has(t.id)).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
  const turns: HistoryTurn[] = []
  let bytes = 0
  for (const turn of earlier) {
    const size = turnBytes(turn)
    if (bytes + size > allowanceBytes) break
    turns.push(turn); bytes += size
  }
  return { turns, bytes, omitted: earlier.length - turns.length }
}

/** Context fills what is left of the input budget after instructions, prior and evidence, up to its own
 * allowance. Evidence is never trimmed: if it does not fit alone, the increment is refused. */
export function planIncrementalInput(input: { concept: AssessmentConcept; prior: Prior; evidence: HistoryTurn[]; earlier: HistoryTurn[]; contextAllowanceBytes: number; maxInputBytes: number; variant: IncrementalVariant }) {
  const evidence = input.evidence.flatMap(t => t.messages)
  const measure = (context: HistoryTurn[]) => {
    const built = buildIncrementalAssessmentInput(input.concept, evidence, input.prior, context, input.variant)
    return { built, inputBytes: Buffer.byteLength(built.prompt) + Buffer.byteLength(JSON.stringify(built.schema)) }
  }
  const fixed = measure([])
  if (fixed.inputBytes > input.maxInputBytes) throw new Error(`New evidence alone exceeds the input budget (${fixed.inputBytes} conservative bytes > ${input.maxInputBytes}); nothing was truncated`)
  const ids = new Set(input.evidence.map(t => t.id))
  let room = Math.min(input.contextAllowanceBytes, input.maxInputBytes - fixed.inputBytes)
  // Turn wrappers cost a few bytes beyond their messages; shrink by the overflow until the whole prompt fits.
  for (;;) {
    const context = selectContextTurns(input.earlier, ids, room)
    const planned = measure(context.turns)
    if (planned.inputBytes <= input.maxInputBytes) return { ...planned, context, fixedBytes: fixed.inputBytes }
    room -= planned.inputBytes - input.maxInputBytes
  }
}

/** Records kept on a published estimate: a v6 pass lists only what its NEW evidence shows, so publishing it
 * as-is would drop every earlier demonstration while the percent still credits them. */
export const MAX_RECORDED_DEMONSTRATIONS = 10
const demonstrationKey = (d: { sourceId: string; quote: string }) => `${d.sourceId}\u0000${d.quote.replace(/\s+/g, ' ').trim()}`

/** The estimate to publish after an increment: the new proposal, with the prior's demonstrations carried
 * behind its own (newest first, deduped by source and whitespace-normalised quote, the newer description
 * wins), bounded to the newest MAX_RECORDED_DEMONSTRATIONS. An unknown estimate carries nothing. */
export function mergeIncrementalAssessment<T extends NonNullable<Prior>>(prior: Prior, next: T): T {
  if (!prior || next.understandingPercent === null) return next
  const seen = new Set<string>()
  const demonstrated = [...next.demonstrated, ...prior.demonstrated].filter(d => {
    const key = demonstrationKey(d)
    return !seen.has(key) && (seen.add(key), true)
  }).slice(0, MAX_RECORDED_DEMONSTRATIONS)
  return { ...next, demonstrated }
}

type LiveTurn = { id: string; at: string; messageIds: string[] }
/** The live pass's input for one part: its own turns are the evidence; turns the published estimate already
 * reflects, plus this pass's earlier parts, are read-only context. The validation context's node states carry
 * the shape v5 persists to the cache, so publication is unchanged; the prompt is not affected. */
export function liveIncrementalInput(input: { concept: AssessmentConcept; prior: Prior; parts: string[][]; part: number; turns: LiveTurn[]; context: LiveTurn[];
  sources: ReadonlyMap<string, AssessmentSource>; contextAllowanceBytes: number; maxInputBytes: number; variant: IncrementalVariant }) {
  const history = (turn: LiveTurn): HistoryTurn => ({ id: turn.id, at: turn.at, messages: turn.messageIds.map(id => {
    const source = input.sources.get(id); if (!source) throw new Error('A selected source is missing from the immutable snapshot'); return source }) })
  const own = new Set(input.parts[input.part] ?? []), before = new Set(input.parts.slice(0, input.part).flat())
  if (!own.size) throw new Error('Unknown concept evidence batch')
  const plan = planIncrementalInput({ concept: input.concept, prior: input.prior, variant: input.variant, contextAllowanceBytes: input.contextAllowanceBytes, maxInputBytes: input.maxInputBytes,
    evidence: input.turns.filter(t => t.messageIds.some(id => own.has(id))).map(history),
    earlier: [...input.context, ...input.turns.filter(t => t.messageIds.some(id => before.has(id)))].map(history) })
  return { ...plan.built, context: { ...plan.built.context, nodeStates: plan.built.context.nodeStates.map(node => ({ ...node, understandingPercent: null })) } }
}

/** At most `k` chronological slices of near-equal turn count; every turn exactly once, no empty slice. */
export function sliceHistoryTurns<T>(turns: T[], k: number) {
  if (!turns.length || !Number.isInteger(k) || k < 1) throw new Error('Replay needs at least one turn and a positive slice count')
  const n = Math.min(k, turns.length), base = Math.floor(turns.length / n), extra = turns.length % n
  const slices: T[][] = []
  let at = 0
  for (let i = 0; i < n; i++) { const size = base + (i < extra ? 1 : 0); slices.push(turns.slice(at, at + size)); at += size }
  return slices
}

type PartReceipt<A> = { status: string; assessment: A | null } | null
/** A cold chain's prior for part `part`, exactly as the v2-cold arm chains increments: none for the first, then the
 * RAW estimate of the last completed earlier part (no merge). A failed part publishes nothing and is skipped. */
/** A part holds an estimate when it was graded, or reused the estimate of an identical completed attempt. */
const graded = <A>(receipt: PartReceipt<A>) => (receipt!.status === 'completed' || receipt!.status === 'unchanged') && !!receipt!.assessment
export function coldChainPrior<A>(earlier: Array<{ part: number; receipt: PartReceipt<A> }>, part: number): A | null {
  if (earlier.length !== part || earlier.some((e, i) => e.part !== i || !e.receipt)) throw new Error('An earlier cold part has no receipt; later estimate refused')
  return earlier.reduce<A | null>((prior, e) => graded(e.receipt!) ? e.receipt!.assessment! : prior, null)
}
/** A cold pass settles once every part has a receipt and publishes its last completed estimate (else its last
 * evidence-free one). It fails only when no part completed, so one bad slice cannot discard the whole history. */
export function coldPassResult<A>(parts: Array<{ part: number; runId: string; receipt: PartReceipt<A> }>, total: number) {
  if (!total) return { status: 'completed' as const, runId: null, assessment: null }
  if (parts.length < total || parts.some(p => !p.receipt)) return { status: 'pending' as const, runId: parts.at(-1)?.runId ?? null, assessment: null }
  const last = parts.filter(p => graded(p.receipt!)).at(-1)
  const settled = last ?? parts.filter(p => ['completed', 'no_evidence', 'unchanged'].includes(p.receipt!.status)).at(-1)
  return settled ? { status: 'completed' as const, runId: settled.runId, assessment: last?.receipt!.assessment ?? null } : { status: 'failed' as const, runId: parts.at(-1)?.runId ?? null, assessment: null }
}

/** Whether a failed receipt was refused for a citation (the context-quote failure mode), not a provider error. */
export function quoteRejected(raw: string, context: GradualAssessmentContext) {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return false }
  const value = Array.isArray(parsed) ? { proposals: parsed } : parsed
  try { validateGradualAssessment(value, context); return false } catch (error) {
    return error instanceof Error && /Unknown human source|Non-exact human quotation|Observed difficulty requires/.test(error.message)
  }
}

export type IncrementOutcome = { status: string; percent: number | null; quoteRejected: boolean; inputBytes: number; inputTokens: number | null; outputTokens: number | null }
/** Pre-registered per-item scores. The final grade is the last completed increment's; a failed increment
 * leaves the chain's estimate where it was, exactly as a failed live pass publishes nothing. */
/** `startPercent`: a warm chain's published grade before increment 0. It is the final grade until an increment completes, and the swing measures the published grade's movement from it. */
export function incrementalArmScores({ goldenPercent, increments, startPercent = null }: { goldenPercent: number | null; increments: IncrementOutcome[]; startPercent?: number | null }) {
  const completed = increments.filter(i => i.status === 'completed')
  const final = completed.length ? completed.at(-1)!.percent : startPercent
  const graded = [...(startPercent === null ? [] : [startPercent]), ...completed.flatMap(i => i.percent === null ? [] : [i.percent])]
  const sum = (key: 'inputTokens' | 'outputTokens' | 'inputBytes') => increments.reduce((n, i) => n + (i[key] ?? 0), 0)
  const scores: Record<string, number | boolean> = {
    level_agrees: percentToLevel(final) === percentToLevel(goldenPercent),
    evidence_decision_agrees: (final === null) === (goldenPercent === null),
    quote_rejection_rate: increments.length ? increments.filter(i => i.quoteRejected).length / increments.length : 0,
    grade_swing: graded.length ? Math.max(...graded) - Math.min(...graded) : 0,
    failed_increments: increments.filter(i => !['completed', 'no_evidence'].includes(i.status)).length,
    input_bytes: sum('inputBytes'), input_tokens: sum('inputTokens'), output_tokens: sum('outputTokens'),
  }
  if (final !== null && goldenPercent !== null) scores.percent_abs_error = Math.abs(final - goldenPercent)
  return scores
}
