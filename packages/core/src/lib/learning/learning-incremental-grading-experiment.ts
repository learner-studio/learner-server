import { z } from 'zod'
import { ASSESSMENT_MODEL, type AssessmentConcept, type LearningConceptAssessment } from './learning-concept-assessment.js'
import { MASTERY_AB_MODELS, percentToLevel } from './learning-mastery-model-comparison.js'
import { promptAbHash } from './learning-prompt-ab.js'
import { incrementalVariant, selectContextTurns, v5Paragraphs, type HistoryTurn } from './learning-incremental-assessment.js'
import type { VectorMessage, VectorTurn } from './learning-vector-turns.js'
import { errorMessage } from '../error-message.js'

export const INCREMENTAL_GRADING_KIND = 'incremental-grading-optimization'
/** Luna = the production grader (baseline and every v6 arm); Opus = golden review and prompt feedback. */
export const INCREMENTAL_GRADING_MODELS = { luna: { ...ASSESSMENT_MODEL }, opus: MASTERY_AB_MODELS.reference } as const
export type GradingLane = keyof typeof INCREMENTAL_GRADING_MODELS
export const INCREMENTAL_GRADING_QUEUES: Record<GradingLane, string> = { luna: 'learning.incremental-grading-luna', opus: 'learning.incremental-grading-opus' }
/** Luna raised to 6 for the 50-concept rounds (team-lead, 2026-10-21; codex CLI is memory-bound, never above 6). */
export const INCREMENTAL_GRADING_CONCURRENCY: Record<GradingLane, number> = { luna: 6, opus: 3 }
/** The live path's conservative ceiling (`assertVectorPromptBudget(…,400_000)`), so arms are graded under production limits. */
export const MAX_INPUT_BYTES = 400_000
/** Frozen history per concept: the newest whole turns that fit. Below MAX_INPUT_BYTES so the v5 baseline reads it in one call. */
export const DEFAULT_HISTORY_BYTES = 320_000
export const FEEDBACK_CONCEPT_ID = 'incremental-grading:feedback'
export const GOLDEN_CANDIDATE = 'baseline-v5-full-history'
export const LABEL_STATUS = 'agent-golden:claude-opus-5-5 reviews the v5 full-history grade (not human gold)'
export const BLIND_LABEL_STATUS = 'agent-golden:claude-opus-5-5 blind full-history grade, v5 grade not shown (not human gold)'

export const GRADE_BANDS = ['unknown', 'low', 'mid', 'high'] as const
export type GradeBand = typeof GRADE_BANDS[number]
/** Bands over the production rubric levels: unknown (null), low (0-20), mid (25-45), high (50+). */
export const gradeBand = (percent: number | null): GradeBand => (['unknown', 'low', 'mid', 'high', 'high', 'high'] as const)[percentToLevel(percent)]!

/** Round-robin across bands, each band in seeded-hash order, so the first N candidates are stratified. */
export function stratifiedOrder<T extends { conceptId: string; band: GradeBand }>(pool: T[], seed: string) {
  const byBand = GRADE_BANDS.map(band => pool.filter(c => c.band === band).sort((a, b) => promptAbHash([seed, a.conceptId]).localeCompare(promptAbHash([seed, b.conceptId]))))
  const out: T[] = []
  for (let i = 0; out.length < pool.length; i++) for (const band of byBand) if (band[i]) out.push(band[i]!)
  return out
}

export type SampleCandidate = { conceptId: string; band: GradeBand; historyBytes: number; droppedTurns: number }
export type Volume = 'small' | 'medium' | 'large'
/** Per-band quotas: a quarter blanks (published unknown), a quarter strong (50+), the rest split low/mid. */
export function sampleQuotas(n: number): Record<GradeBand, number> {
  const unknown = Math.round(n * 0.24), high = Math.round(n * 0.24), low = Math.ceil((n - unknown - high) / 2)
  return { unknown, low, mid: n - unknown - high - low, high }
}
export const SAMPLE_RULE = 'representative-v1: quotas per published band (unknown = blanks, high = strong); strong concepts take the richest histories first; every other band rotates large/small/medium history-volume tertiles in seeded order; a short band\'s shortfall is filled from the remaining eligible candidates, richest band first.'
/**
 * Deliberate, not random: the operator wants blanks, strong concepts and a spread of evidence volume
 * (including histories over the per-call budget). Deterministic for a seed.
 */
export function representativeSample<T extends SampleCandidate>(candidates: T[], n: number, seed: string) {
  const quotas = sampleQuotas(n), seeded = (c: T) => promptAbHash([seed, c.conceptId])
  const picked: Array<T & { volume: Volume }> = []
  const volumeOf = new Map<string, Volume>()
  for (const band of GRADE_BANDS) {
    const pool = candidates.filter(c => c.band === band).sort((a, b) => a.historyBytes - b.historyBytes || a.conceptId.localeCompare(b.conceptId))
    pool.forEach((c, i) => volumeOf.set(c.conceptId, (['small', 'medium', 'large'] as const)[Math.min(2, Math.floor(3 * i / pool.length))]!))
    const order = band === 'high' ? [...pool].reverse()
      : (() => { const tiers = (['large', 'small', 'medium'] as const).map(v => pool.filter(c => volumeOf.get(c.conceptId) === v).sort((a, b) => seeded(a).localeCompare(seeded(b))))
        const out: T[] = []; for (let i = 0; out.length < pool.length; i++) for (const t of tiers) if (t[i]) out.push(t[i]!); return out })()
    for (const c of order.slice(0, quotas[band])) picked.push({ ...c, volume: volumeOf.get(c.conceptId)! })
  }
  const chosen = new Set(picked.map(p => p.conceptId))
  const rest = candidates.filter(c => !chosen.has(c.conceptId)).sort((a, b) => GRADE_BANDS.indexOf(b.band) - GRADE_BANDS.indexOf(a.band) || b.historyBytes - a.historyBytes || a.conceptId.localeCompare(b.conceptId))
  for (const c of rest) { if (picked.length >= n) break; picked.push({ ...c, volume: volumeOf.get(c.conceptId)! }) }
  const strata: Record<string, number> = {}
  for (const p of picked) { const key = `${p.band}/${p.volume}${p.droppedTurns ? '+over-budget' : ''}`; strata[key] = (strata[key] ?? 0) + 1 }
  return { picked, quotas, strata }
}

/** A concept's frozen replay history: matching explicit turns, newest whole turns within `historyBytes`, in time order.
 * Selection order groups by conversation; replay is by time, because an increment is "what arrived next". */
export function historyFromSelection(turns: VectorTurn[], messages: Map<string, VectorMessage>, historyBytes: number) {
  const all: HistoryTurn[] = turns.filter(t => t.linkage === 'explicit').map(t => ({ id: t.id, at: t.at, messages: t.messageIds.map(id => {
    const m = messages.get(id)
    if (!m) throw new Error('Turn source is missing from the snapshot')
    return { id: m.id, conversationId: m.conversationId, role: m.role, text: m.text, occurredAt: m.occurredAt }
  }) }))
  const kept = selectContextTurns(all, new Set(), historyBytes)
  return { turns: kept.turns.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)), matchingTurns: all.length, droppedTurns: kept.omitted, historyBytes: kept.bytes }
}

type Candidate = Pick<NonNullable<LearningConceptAssessment['assessment']>, 'understandingPercent' | 'confidence' | 'demonstrated' | 'gaps'>
const Percent = z.number().int().min(0).max(100).multipleOf(5).nullable()
export const GoldenReviewSchema = z.object({
  agrees: z.boolean(), rationale: z.string().min(1).max(2_000),
  ownGrade: z.object({ understandingPercent: Percent, confidence: z.enum(['insufficient', 'low', 'medium', 'high']) }).strict().nullable(),
}).strict()
export type GoldenReview = z.infer<typeof GoldenReviewSchema>
const RUBRIC = ['OBJECTIVE:', 'Assess provisional', 'Give your best', 'Use null', 'Use your judgment', 'AUTHORITY:', 'Read the supplied', 'EVIDENCE DEFINITIONS:', 'Distinguish (1)', 'A following assistant', 'OUTCOME:']

/**
 * The reference judgement. Opus reads the concept, the learner's WHOLE frozen history and the production
 * grader's one-pass read of that same history, and says whether it accepts that percent as the reference.
 * Reviewing a candidate (rather than grading cold) is the operator's design; the v5 full-history read is the
 * candidate because it is the only arm that saw everything at once, and it is fixed across rounds.
 */
export function goldenReviewPrompt(concept: AssessmentConcept, turns: HistoryTurn[], candidate: Candidate | null) {
  return [
    'You are the reference grader for a Learning assessment experiment. Your verdict becomes the golden label every grading variant is scored against, so be exact and conservative.',
    'TASK: Read the concept and the learner\'s complete conversation history for it (chronological), then review the CANDIDATE GRADE, which the production grader produced by reading this same history in one pass. Set agrees=true when you would accept its understandingPercent as the reference value: your own evidence-supported estimate is within 10 percentage points of it, in the same rubric band, and you make the same unknown/known decision. Otherwise set agrees=false and give ownGrade, your own percent (or null for unknown) and confidence. When you agree, ownGrade must be null. When the candidate is none, agreement is impossible: give ownGrade.',
    'Explain the decision in rationale: the decisive human evidence, and where the candidate over- or under-credits it. Do not output a reasoning trace or extra fields.',
    'PRODUCTION RUBRIC (what counts as understanding):',
    ...v5Paragraphs(RUBRIC),
    `### CONCEPT\n${JSON.stringify(concept)}`,
    `### CANDIDATE GRADE\n${candidate ? JSON.stringify({ understandingPercent: candidate.understandingPercent, confidence: candidate.confidence, demonstrated: candidate.demonstrated, gaps: candidate.gaps }) : 'none (the production grader did not produce one)'}`,
    `### COMPLETE HISTORY (chronological)\n${JSON.stringify(turns.map(t => ({ at: t.at, messages: t.messages })))}`,
  ].join('\n\n')
}
export const goldenReviewSchema = () => z.toJSONSchema(GoldenReviewSchema)
export function validateGoldenReview(raw: unknown, candidate: Candidate | null): GoldenReview {
  const review = GoldenReviewSchema.parse(raw)
  if (!candidate && review.agrees) throw new Error('There is no candidate to agree with')
  if (review.agrees === (review.ownGrade !== null)) throw new Error('An own grade is required exactly when the reviewer disagrees')
  return review
}
export function goldenLabel(review: GoldenReview, candidate: Candidate | null) {
  const goldenPercent = review.agrees ? candidate!.understandingPercent : review.ownGrade!.understandingPercent
  return { goldenPercent, goldenLevel: percentToLevel(goldenPercent), source: review.agrees ? 'candidate-agreed' as const : 'reviewer-own-grade' as const,
    candidatePercent: candidate?.understandingPercent ?? null, agrees: review.agrees, rationale: review.rationale }
}

export const FeedbackCandidateSchema = z.object({
  instructions: z.array(z.string().min(1).max(4_000)).min(4).max(40),
  contextAllowanceBytes: z.number().int().min(0).max(DEFAULT_HISTORY_BYTES),
  changes: z.array(z.string().min(1).max(600)).min(1).max(10), rationale: z.string().min(1).max(3_000),
}).strict()
export const feedbackCandidateSchema = () => z.toJSONSchema(FeedbackCandidateSchema)
export function validateFeedbackCandidate(raw: unknown) {
  const candidate = FeedbackCandidateSchema.parse(raw)
  return { ...candidate, variant: incrementalVariant(candidate.instructions) }
}

type Scored = { conceptId: string; arm: string; scores: Record<string, number | boolean> }
/** Worst first: a wrong unknown/known decision outranks any percent error; then error, then a band miss. */
export function feedbackCases<T extends Scored>(rows: T[], limit: number) {
  const badness = (r: Scored) => r.scores.evidence_decision_agrees === false ? 1_000 : Number(r.scores.percent_abs_error ?? 0) + (r.scores.level_agrees === false ? 50 : 0)
  return rows.filter(r => badness(r) > 0).sort((a, b) => badness(b) - badness(a) || a.conceptId.localeCompare(b.conceptId) || a.arm.localeCompare(b.arm)).slice(0, limit)
}

/** v2 feedback call (round 1 review, 2026-10-21): aimed at the axes v6 lost on, with per-increment trajectories. */
export const FEEDBACK_REVISION = 'incremental-grading-feedback-v2'
export const FEEDBACK_CALL_KEY = 'feedback-v2'
type Focusable = Scored & { band: string; goldenPercent: number | null; finalPercent: number | null }
/** For one arm: the 5 worst concepts, every blank (golden unknown) the arm answered with a number (max 5), and the
 * 3 largest grade swings among the rest. Each concept once, tagged with why it was chosen. */
export function feedbackFocusCases<T extends Focusable>(rows: T[], arm: string) {
  const own = rows.filter(r => r.arm === arm), chosen = new Set<string>()
  const take = (list: T[], why: 'worst' | 'blank-answered' | 'swing', n: number) => list.filter(r => !chosen.has(r.conceptId)).slice(0, n).map(r => (chosen.add(r.conceptId), { ...r, why }))
  return [
    ...take(feedbackCases(own, own.length), 'worst', 5),
    ...take(own.filter(r => r.goldenPercent === null && r.finalPercent !== null).sort((a, b) => a.conceptId.localeCompare(b.conceptId)), 'blank-answered', 5),
    ...take(own.filter(r => Number(r.scores.grade_swing ?? 0) > 0).sort((a, b) => Number(b.scores.grade_swing) - Number(a.scores.grade_swing) || a.conceptId.localeCompare(b.conceptId)), 'swing', 3),
  ]
}

/** MAE and level agreement where golden is Opus's own grade: the only items on which the v5 baseline is not scored against itself. */
export function overrideSubsetStats(rows: Array<{ conceptId: string; scores: Record<string, number | boolean> }>, golden: Record<string, { source: string }>) {
  const subset = rows.filter(r => golden[r.conceptId]?.source === 'reviewer-own-grade')
  const errors = subset.flatMap(r => typeof r.scores.percent_abs_error === 'number' ? [r.scores.percent_abs_error] : [])
  const levels = subset.filter(r => 'level_agrees' in r.scores)
  return { items: subset.length, maeItems: errors.length, meanAbsError: errors.length ? errors.reduce((a, b) => a + b, 0) / errors.length : null,
    levelAgreement: levels.length ? levels.filter(r => r.scores.level_agrees).length / levels.length : null }
}

export function feedbackPrompt(input: { arm: { name: string; revision: string; instructions: string[]; contextAllowanceBytes: number }; arms: unknown; cases: unknown[] }) {
  return [
    'You improve a production grading prompt. The grader (GPT-5.6 Luna) updates ONE concept\'s understanding estimate from each batch of new conversation turns: it sees the instructions below, the concept, the current published estimate, earlier turns as read-only CONTEXT (newest first, packed into a byte allowance), and the NEW EVIDENCE it may cite. A replay of real histories was scored against golden labels (Claude Opus 5.5 reviewing a one-pass full-history grade).',
    'Propose (a) a revised COMPLETE instruction list and (b) a context allowance in UTF-8 bytes (0 to 320000; about 4 bytes per token). Change only what the evidence below supports; keep the citation rules (quotes only from new evidence, exact and human-authored) and the 5-point rubric anchors intact. Do not add section headers starting with "###"; the application appends the concept, estimate, context and evidence sections itself. List each change and why in changes; summarise the diagnosis in rationale.',
    `### CURRENT ARM\n${JSON.stringify({ name: input.arm.name, revision: input.arm.revision, contextAllowanceBytes: input.arm.contextAllowanceBytes })}`,
    `### CURRENT INSTRUCTIONS\n${JSON.stringify(input.arm.instructions)}`,
    `### ROUND SUMMARY BY ARM\n${JSON.stringify(input.arms)}`,
    'FOCUS: Round 1 showed the incremental grader losing to a one-pass full-history read on two axes, and those are what to fix first. (1) BLANKS: when the golden answer is unknown (null), the grader too often returns a number; v6 answered null on 50-58% of blank concepts against 67% for v5. (2) SWING: grades move between increments more than the evidence justifies. (3) COMPOUNDING: an error made in an early increment becomes the next increment\'s published estimate and is rarely corrected. Read each case\'s per-increment trajectory (prior, the new human text, the grade, what was credited) to find WHERE it went wrong, not only how far the final grade is off. Do not trade away accuracy on concepts that do have evidence.',
    `### CASES (why: worst | blank-answered | swing; golden vs the arm's final grade; per-increment trajectory)\n${JSON.stringify(input.cases)}`,
  ].join('\n\n')
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value
/** Request identity across a jsonb round trip, which reorders object keys; array order still counts. */
export function sameRequest(stored: unknown, sent: unknown) {
  return JSON.stringify(canonical(stored)) === JSON.stringify(canonical(sent))
}

/** A validator rejection the grader can repair by re-quoting: the answer cited a source or quotation that is not in NEW EVIDENCE verbatim. */
export const quoteRetryable = (message: string) => /Non-exact human quotation|Unknown human source/.test(message)
/** A validator rejection the grader can repair by re-copying the 64-hex nodeVersion from the prompt (observed: near-copy typos, 0.97-0.98 similar). */
export const nodeVersionRetryable = (message: string) => /Unknown concept or stale node version/.test(message)
export type ValidatorRetryKind = 'quote' | 'nodeVersion'
const retryKind = (message: string): ValidatorRetryKind | null => quoteRetryable(message) ? 'quote' : nodeVersionRetryable(message) ? 'nodeVersion' : null
const REPAIR_RULE: Record<ValidatorRetryKind, string> = {
  quote: "Every quotation must be copied exactly, character for character, from a human message in NEW EVIDENCE, and cite that message's id. Fix the citation or drop it; change nothing else unless the fix requires it.",
  nodeVersion: 'The conceptId and nodeVersion must be copied exactly, character for character, from the concept in the prompt. Fix them; change nothing else.',
}
export function validatorRepairPrompt(kind: ValidatorRetryKind, prompt: string, error: string, rejected: string) {
  return [prompt, `### VALIDATION ERROR\nYour previous answer was rejected: ${error}\n${REPAIR_RULE[kind]}`, `### PREVIOUS REJECTED RESPONSE\n${rejected}`].join('\n\n')
}
export type ValidatorRetryResult<T> = { ok: true; value: T; retried: ValidatorRetryKind | null; firstError: string | null } | { ok: false; error: string; retried: ValidatorRetryKind | null; firstError: string }
/**
 * Experiment-only (B1a): one retry, and only for a rejection the model can repair (a quotation, or a mis-copied
 * nodeVersion), with the validator's error and the rejected answer fed back. `retried` names which kind fired so the two
 * are counted separately. Any other failure (provider, timeout, schema) is final on the first attempt, so a retry can
 * never hide an infrastructure fault. `rejected` returns the raw answer the failed attempt produced.
 */
export async function withValidatorRetry<T>(prompt: string, attempt: (prompt: string) => Promise<T>, rejected: () => string): Promise<ValidatorRetryResult<T>> {
  let firstError: string
  try { return { ok: true, value: await attempt(prompt), retried: null, firstError: null } } catch (error) { firstError = errorMessage(error) }
  const kind = retryKind(firstError)
  if (!kind) return { ok: false, error: firstError, retried: null, firstError }
  try { return { ok: true, value: await attempt(validatorRepairPrompt(kind, prompt, firstError, rejected())), retried: kind, firstError } }
  catch (error) { return { ok: false, error: errorMessage(error), retried: kind, firstError } }
}

export type PriorMode = 'cold' | 'warm'
/** B1b: a warm arm starts from the grade published when the sample was frozen (live mostly starts warm); a cold arm, or a concept with no published grade, starts from nothing. */
export const initialPrior = <P>(arm: { prior?: PriorMode }, item: { warmPrior?: P | null }) => arm.prior === 'warm' ? item.warmPrior ?? null : null

/**
 * B0 golden: Opus grades from the concept, the rubric and the whole frozen history ALONE. No production grade is
 * shown, so the label cannot anchor on v5. Same output contract as the review (agrees=false, ownGrade required),
 * so labelling and the Opus call fence are shared.
 */
export function blindGradePrompt(concept: AssessmentConcept, turns: HistoryTurn[]) {
  return [
    'You are the reference grader for a Learning assessment experiment. Your grade becomes the golden label every grading variant is scored against, so be exact and conservative.',
    'TASK: Read the concept and the learner\'s complete conversation history for it (chronological), and grade the learner\'s understanding yourself under the rubric below. Set agrees=false (there is nothing to agree with) and give ownGrade: your evidence-supported understandingPercent (a multiple of 5, or null when the history holds no evidence of understanding either way) and your confidence.',
    'Explain the grade in rationale: the decisive human evidence, and what it does not show. Do not output a reasoning trace or extra fields.',
    'PRODUCTION RUBRIC (what counts as understanding):',
    ...v5Paragraphs(RUBRIC),
    `### CONCEPT\n${JSON.stringify(concept)}`,
    `### COMPLETE HISTORY (chronological)\n${JSON.stringify(turns.map(t => ({ at: t.at, messages: t.messages })))}`,
  ].join('\n\n')
}

/** The Opus-vs-Opus ceiling subset: band round-robin in the items' own (stratified) order. */
export function ceilingSubset<T extends { conceptId: string; band: string }>(items: T[], n: number) {
  const byBand = GRADE_BANDS.map(band => items.filter(i => i.band === band))
  const out: T[] = []
  for (let i = 0; out.length < Math.min(n, items.length); i++) for (const band of byBand) if (band[i] && out.length < n) out.push(band[i]!)
  return out
}

/** TUNE = the union of frozen rounds' samples (first occurrence wins), each concept re-keyed to this round's review call and re-numbered. */
export function poolSamples<T extends { conceptId: string; reviewRunId: string }>(sources: T[][], reviewIdFor: (conceptId: string) => string) {
  const seen = new Set<string>()
  return sources.flat().filter(i => !seen.has(i.conceptId) && seen.add(i.conceptId)).map((i, ordinal) => ({ ...i, reviewRunId: reviewIdFor(i.conceptId), ordinal }))
}

type TrajectoryCall = { status: string; durationMs: number | null; paid: boolean; contextBytes: number | null; inputTokens: number | null; quoteRetried: boolean; quoteRecovered: boolean; quoteRejected: boolean; nodeRetried?: boolean; nodeRecovered?: boolean }
export type MetricRow = { conceptId: string; band: string; goldenPercent: number | null; finalPercent: number | null; scores: Record<string, number | boolean>; trajectory: TrajectoryCall[] }
/** Nearest-rank percentile: always an observed value. */
const percentile = (values: number[], p: number) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(p * s.length) - 1)]! : null }
const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
const ratio = <T>(rows: T[], ok: (r: T) => boolean) => rows.length ? rows.filter(ok).length / rows.length : null
const levelAgrees = (r: MetricRow) => percentToLevel(r.goldenPercent) === percentToLevel(r.finalPercent)
const absErrors = (rows: MetricRow[]) => rows.flatMap(r => r.goldenPercent !== null && r.finalPercent !== null ? [Math.abs(r.finalPercent - r.goldenPercent)] : [])
/** Seeded so a re-finalize reports the same interval. */
function seededRandom(seed: string) {
  let s = parseInt(promptAbHash(['bootstrap', seed]).slice(0, 8), 16) >>> 0
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
export const BOOTSTRAP_RESAMPLES = 2_000
function bootstrapCi(rows: MetricRow[], stat: (rows: MetricRow[]) => number | null, seed: string): [number, number] | null {
  if (!rows.length) return null
  const random = seededRandom(seed), stats: number[] = []
  for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) { const v = stat(rows.map(() => rows[Math.floor(random() * rows.length)]!)); if (v !== null) stats.push(v) }
  return stats.length ? [percentile(stats, 0.025)!, percentile(stats, 0.975)!] : null
}
/** B3: one arm's round metrics over every item (golden null included, as level 0), with 95% percentile-bootstrap CIs over concepts. */
export function armMetrics(rows: MetricRow[], seed: string) {
  const errors = absErrors(rows), calls = rows.flatMap(r => r.trajectory), paid = calls.filter(c => c.paid)
  const signed = rows.flatMap(r => r.goldenPercent !== null && r.finalPercent !== null ? [r.finalPercent - r.goldenPercent] : [])
  const nums = (f: (c: TrajectoryCall) => number | null, from = calls) => from.flatMap(c => { const v = f(c); return typeof v === 'number' ? [v] : [] })
  const seconds = nums(c => c.durationMs === null ? null : c.durationMs / 1000, paid), ctx = nums(c => c.contextBytes)
  return {
    items: rows.length,
    levelAgreement: ratio(rows, levelAgrees),
    within10: ratio(rows, r => r.goldenPercent === null || r.finalPercent === null ? r.goldenPercent === r.finalPercent : Math.abs(r.finalPercent - r.goldenPercent) <= 10),
    mae: { mean: mean(errors), p50: percentile(errors, 0.5), n: errors.length },
    signedBias: mean(signed),
    blanksNull: ratio(rows.filter(r => r.band === 'unknown'), r => r.finalPercent === null),
    nullAgreement: ratio(rows.filter(r => r.goldenPercent === null), r => r.finalPercent === null),
    swing: mean(rows.map(r => Number(r.scores.grade_swing ?? 0))),
    quote: { calls: calls.length, rejectedBeforeRetry: calls.filter(c => c.quoteRetried || c.quoteRejected).length, rejectedAfterRetry: calls.filter(c => c.quoteRejected).length,
      retries: calls.filter(c => c.quoteRetried).length, recovered: calls.filter(c => c.quoteRecovered).length },
    nodeVersion: { retries: calls.filter(c => c.nodeRetried).length, recovered: calls.filter(c => c.nodeRecovered).length },
    failedIncrements: rows.reduce((a, r) => a + Number(r.scores.failed_increments ?? 0), 0),
    callSeconds: { p50: percentile(seconds, 0.5), p90: percentile(seconds, 0.9) },
    contextBytes: { mean: mean(ctx), p90: percentile(ctx, 0.9) },
    inputTokens: nums(c => c.inputTokens).reduce((a, b) => a + b, 0),
    ci: { levelAgreement: bootstrapCi(rows, rs => ratio(rs, levelAgrees), `${seed}:level`), mae: bootstrapCi(rows, rs => mean(absErrors(rs)), `${seed}:mae`) },
  }
}

/** Native read-back filters on trace start, so it must start at the earliest span exported, not at the round's creation:
 * a pooled round re-exports v5 baseline calls that ran in the rounds that froze them. */
export const readBackSince = (createdAt: Date, spanStartsMs: number[]) => new Date(Math.min(createdAt.getTime(), ...spanStartsMs))
