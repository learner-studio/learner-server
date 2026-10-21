import { describe, expect, test } from 'bun:test'
import { validateGradualAssessment } from './learning-gradual-assessment.js'
import type { AssessmentConcept, AssessmentSource } from './learning-concept-assessment.js'
import {
  INCREMENTAL_ASSESSMENT_REVISION, buildIncrementalAssessmentInput, defaultIncrementalVariant, incrementalArmScores,
  mergeIncrementalAssessment, planIncrementalInput, quoteRejected, selectContextTurns, sliceHistoryTurns, type HistoryTurn,
} from './learning-incremental-assessment.js'

const concept: AssessmentConcept = { conceptId: 'control-group', title: 'Control group', description: 'Holding other factors fixed.', objectives: ['Design a fair comparison'] }
const message = (id: string, role: string, text: string, at: string): AssessmentSource => ({ id, conversationId: 'c1', role, text, occurredAt: at })
const turn = (n: number, text = `human reasoning number ${n}`, size = 0): HistoryTurn => {
  const at = `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`
  return { id: `u${n}`, at, messages: [message(`u${n}`, 'user', text + 'x'.repeat(size), at), message(`a${n}`, 'assistant', `reply ${n}`, at)] }
}
const bytes = (turns: HistoryTurn[]) => turns.reduce((n, t) => n + Buffer.byteLength(JSON.stringify(t.messages)), 0)
const prior = {
  conceptId: concept.conceptId, nodeVersion: 'a'.repeat(64), understandingPercent: 40, confidence: 'medium' as const,
  demonstrated: [{ description: 'Names unequal components as a confound.', sourceId: 'u1', quote: 'human reasoning number 1' }],
  gaps: [{ kind: 'untested' as const, description: 'Randomisation is untested.', sourceId: null, quote: null }],
  nextCheck: 'How would you randomise?', needsReview: true as const,
}

describe('prior-aware incremental assessment v6', () => {
  test('the prompt carries the published estimate and labelled CONTEXT and NEW EVIDENCE sections', () => {
    const built = buildIncrementalAssessmentInput(concept, turn(3).messages, prior, [turn(2), turn(1)], defaultIncrementalVariant())
    const { prompt } = built
    expect(prompt).toContain(INCREMENTAL_ASSESSMENT_REVISION)
    const at = (marker: string) => { const i = prompt.indexOf(marker); expect(i).toBeGreaterThan(-1); return i }
    const published = at('### CURRENT PUBLISHED ESTIMATE'), context = at('### CONTEXT (already reflected'), evidence = at('### NEW EVIDENCE')
    expect(published).toBeLessThan(context)
    expect(context).toBeLessThan(evidence)
    const estimate = prompt.slice(published, context)
    for (const part of ['"understandingPercent":40', '"confidence":"medium"', 'Names unequal components as a confound.', 'Randomisation is untested.']) expect(estimate).toContain(part)
    // Earlier quotes are not handed back: they are not citable in this pass.
    expect(estimate).not.toContain('"quote"')
    expect(prompt.slice(context, evidence)).toContain('human reasoning number 2')
    expect(prompt.slice(evidence)).toContain('human reasoning number 3')
    expect(prompt.slice(evidence)).not.toContain('human reasoning number 2')
    // Context is newest first.
    expect(prompt.slice(context, evidence).indexOf('number 2')).toBeLessThan(prompt.slice(context, evidence).indexOf('number 1'))
  })
  test('with no published estimate the prompt says so instead of inventing one', () => {
    const { prompt } = buildIncrementalAssessmentInput(concept, turn(1).messages, null, [], defaultIncrementalVariant())
    expect(prompt).toMatch(/### CURRENT PUBLISHED ESTIMATE[^\n]*\n(none|null)/)
  })
  test('the validator accepts quotes from new evidence and rejects quotes from context turns', () => {
    const built = buildIncrementalAssessmentInput(concept, turn(3).messages, prior, [turn(2)], defaultIncrementalVariant())
    expect(Object.keys(built.context.humanTextBySourceId)).toEqual(['u3'])
    const proposal = (sourceId: string, quote: string) => ({ proposals: [{ ...prior, nodeVersion: built.nodeVersion, demonstrated: [{ description: 'd', sourceId, quote }] }] })
    expect(validateGradualAssessment(proposal('u3', 'human reasoning number 3'), built.context)).toHaveLength(1)
    expect(() => validateGradualAssessment(proposal('u2', 'human reasoning number 2'), built.context)).toThrow(/Unknown human source/)
    // The receipt keeps only raw text; the rejection metric reclassifies it, and a provider failure is not one.
    expect(quoteRejected(JSON.stringify(proposal('u2', 'human reasoning number 2')), built.context)).toBe(true)
    expect(quoteRejected(JSON.stringify(proposal('u3', 'human reasoning number 3')), built.context)).toBe(false)
    expect(quoteRejected('', built.context)).toBe(false)
  })
  test('context excludes the new turns, packs newest first and never splits a turn', () => {
    const history = [turn(1), turn(2), turn(3), turn(4)]
    const one = bytes([turn(4)])
    const picked = selectContextTurns(history, new Set(['u4']), one * 2 + 10)
    expect(picked.turns.map(t => t.id)).toEqual(['u3', 'u2'])
    expect(picked.bytes).toBe(bytes([turn(3), turn(2)]))
    expect(picked.omitted).toBe(1)
    // A turn that does not fit whole is left out whole, and nothing older slots in behind it.
    const big = [turn(1), turn(2, 'long', 5_000), turn(3)]
    expect(selectContextTurns(big, new Set(['u4']), one + 1_000).turns.map(t => t.id)).toEqual(['u3'])
    expect(selectContextTurns(history, new Set(), 0).turns).toEqual([])
  })
  test('the whole prompt (instructions, prior, context and evidence) fits the input budget', () => {
    const history = Array.from({ length: 12 }, (_, i) => turn(i + 1, `turn ${i + 1}`, 4_000))
    const evidence = history.slice(10)
    const earlier = history.slice(0, 10)
    const roomy = planIncrementalInput({ concept, prior, evidence, earlier, contextAllowanceBytes: 1_000_000, maxInputBytes: 1_000_000, variant: defaultIncrementalVariant() })
    expect(roomy.context.turns).toHaveLength(10)
    const tight = 60_000
    const plan = planIncrementalInput({ concept, prior, evidence, earlier, contextAllowanceBytes: 1_000_000, maxInputBytes: tight, variant: defaultIncrementalVariant() })
    expect(plan.inputBytes).toBeLessThanOrEqual(tight)
    expect(plan.inputBytes).toBe(Buffer.byteLength(plan.built.prompt) + Buffer.byteLength(JSON.stringify(plan.built.schema)))
    expect(plan.context.turns.length).toBeGreaterThan(0)
    expect(plan.context.turns.length).toBeLessThan(10)
    // The allowance caps context even when the overall budget has room.
    const capped = planIncrementalInput({ concept, prior, evidence, earlier, contextAllowanceBytes: bytes([history[9]!]), maxInputBytes: 1_000_000, variant: defaultIncrementalVariant() })
    expect(capped.context.turns.map(t => t.id)).toEqual(['u10'])
    expect(() => planIncrementalInput({ concept, prior, evidence, earlier, contextAllowanceBytes: 0, maxInputBytes: 10_000, variant: defaultIncrementalVariant() })).toThrow(/budget/)
  })
  test('history replays as at most K chronological slices that cover every turn once', () => {
    const history = Array.from({ length: 11 }, (_, i) => turn(i + 1))
    const slices = sliceHistoryTurns(history, 5)
    expect(slices).toHaveLength(5)
    expect(slices.flat().map(t => t.id)).toEqual(history.map(t => t.id))
    expect(slices.every(s => s.length >= 2)).toBe(true)
    expect(sliceHistoryTurns(history.slice(0, 3), 5)).toHaveLength(3)
    expect(() => sliceHistoryTurns([], 5)).toThrow()
  })
  test('item scores measure error against golden, rubric agreement, rejections and swing', () => {
    const scores = incrementalArmScores({ goldenPercent: 50, increments: [
      { status: 'completed', percent: 30, quoteRejected: false, inputBytes: 10, inputTokens: 5, outputTokens: 1 },
      { status: 'failed', percent: null, quoteRejected: true, inputBytes: 10, inputTokens: null, outputTokens: null },
      { status: 'completed', percent: 55, quoteRejected: false, inputBytes: 20, inputTokens: 7, outputTokens: 2 },
    ] })
    expect(scores.percent_abs_error).toBe(5)
    expect(scores.level_agrees).toBe(true)
    expect(scores.quote_rejection_rate).toBeCloseTo(1 / 3)
    expect(scores.grade_swing).toBe(25)
    expect(scores.input_tokens).toBe(12)
    // An unknown golden scored against a percent is a disagreement on the evidence decision, not an error of 0.
    const unknownGolden = incrementalArmScores({ goldenPercent: null, increments: [{ status: 'completed', percent: 20, quoteRejected: false, inputBytes: 1, inputTokens: 1, outputTokens: 1 }] })
    expect(unknownGolden.level_agrees).toBe(false)
    expect(unknownGolden.percent_abs_error).toBeUndefined()
  })
  test('publishing an increment keeps earlier demonstrations: prior plus new, deduped by source and quote, newest first, bounded', () => {
    const next = { ...prior, understandingPercent: 55, demonstrated: [
      { description: 'Proposes randomisation.', sourceId: 'u3', quote: 'randomise the assignment' },
      // The same evidence cited again (whitespace differs) is not a second demonstration.
      { description: 'Re-cites the confound.', sourceId: 'u1', quote: 'human  reasoning number 1' },
    ] }
    const merged = mergeIncrementalAssessment(prior, next)
    expect(merged.understandingPercent).toBe(55)
    expect(merged.demonstrated.map(d => d.sourceId)).toEqual(['u3', 'u1'])
    expect(merged.demonstrated[1]!.description).toBe('Re-cites the confound.')
    expect(mergeIncrementalAssessment(null, next)).toEqual(next)
    const many = (from: number) => Array.from({ length: 5 }, (_, i) => ({ description: `d${from + i}`, sourceId: `s${from + i}`, quote: `q${from + i}` }))
    const bounded = mergeIncrementalAssessment({ ...prior, demonstrated: [...many(0), ...many(5)] }, { ...next, demonstrated: many(10) })
    expect(bounded.demonstrated).toHaveLength(10)
    expect(bounded.demonstrated[0]!.sourceId).toBe('s10')
    expect(bounded.demonstrated.at(-1)!.sourceId).toBe('s4')
    // An estimate that went unknown carries nothing forward to merge into.
    expect(mergeIncrementalAssessment(prior, { ...next, understandingPercent: null, demonstrated: [] }).demonstrated).toEqual([])
  })
  test('live path: a context turn is never citable, earlier parts become context, and node states keep the cache shape', async () => {
    const { liveIncrementalInput } = await import('./learning-incremental-assessment.js')
    const live = (t: HistoryTurn) => ({ id: t.id, at: t.at, messageIds: t.messages.map(m => m.id) })
    const sources = new Map([turn(1), turn(2), turn(3)].flatMap(t => t.messages).map(m => [m.id, m]))
    // u1 is covered by the published estimate (context); u2 and u3 are this pass's two parts.
    const input = (part: number) => liveIncrementalInput({ concept, prior, part, parts: [['u2', 'a2'], ['u3', 'a3']], turns: [live(turn(2)), live(turn(3))], context: [live(turn(1))],
      sources, contextAllowanceBytes: 160_000, maxInputBytes: 400_000, variant: defaultIncrementalVariant() })
    const first = input(0), second = input(1)
    expect(Object.keys(first.context.humanTextBySourceId)).toEqual(['u2'])
    expect(Object.keys(second.context.humanTextBySourceId)).toEqual(['u3'])
    expect(second.prompt).toContain('human reasoning number 2')
    expect(second.context.nodeStates[0]).toMatchObject({ conceptId: concept.conceptId, understandingPercent: null })
    const proposal = (built: typeof first, sourceId: string, quote: string) => ({ proposals: [{ ...prior, nodeVersion: built.nodeVersion, demonstrated: [{ description: 'd', sourceId, quote }] }] })
    expect(() => validateGradualAssessment(proposal(first, 'u1', 'human reasoning number 1'), first.context)).toThrow(/Unknown human source/)
    expect(() => validateGradualAssessment(proposal(second, 'u2', 'human reasoning number 2'), second.context)).toThrow(/Unknown human source/)
    expect(validateGradualAssessment(proposal(second, 'u3', 'human reasoning number 3'), second.context)).toHaveLength(1)
    expect(() => input(2)).toThrow(/Unknown concept evidence batch/)
  })
  test('the live variant is pinned in code, and v5, plain v6 and the live revision are all current priors', async () => {
    const live = await import('./learning-live-incremental-variant.js')
    const { GRADUAL_ASSESSMENT_REVISION } = await import('./learning-gradual-assessment.js')
    const { LIVE_CONTEXT_ALLOWANCE_BYTES } = await import('./learning-vector-turn-schemas.js')
    expect(live.LIVE_INCREMENTAL_VARIANT.revision).toBe(live.LIVE_INCREMENTAL_REVISION)
    for (const revision of [GRADUAL_ASSESSMENT_REVISION, INCREMENTAL_ASSESSMENT_REVISION, live.LIVE_INCREMENTAL_REVISION]) expect(live.isCurrentAssessmentRevision(revision)).toBe(true)
    expect(live.isCurrentAssessmentRevision(`${INCREMENTAL_ASSESSMENT_REVISION}+000000000000`)).toBe(false)
    expect(live.isCurrentAssessmentRevision(null)).toBe(false)
    expect(LIVE_CONTEXT_ALLOWANCE_BYTES).toBeGreaterThan(0)
  })
})

test('B1b: a warm chain starts from the published grade; with no completed increment it ends there, and moving off it is swing', () => {
  const o = (status: string, percent: number | null) => ({ status, percent, quoteRejected: false, inputBytes: 1, inputTokens: 1, outputTokens: 1 })
  const kept = incrementalArmScores({ goldenPercent: 40, startPercent: 40, increments: [o('failed', null), o('no_evidence', null)] })
  expect(kept.level_agrees).toBe(true)
  expect(kept.percent_abs_error).toBe(0)
  expect(kept.grade_swing).toBe(0)
  const moved = incrementalArmScores({ goldenPercent: 40, startPercent: 40, increments: [o('completed', 10)] })
  expect(moved.grade_swing).toBe(30)
  expect(moved.percent_abs_error).toBe(30)
  // Cold is unchanged: nothing completed means no grade.
  expect(incrementalArmScores({ goldenPercent: 40, increments: [o('failed', null)] }).percent_abs_error).toBeUndefined()
})
