import { describe, expect, test } from 'bun:test'
import type { VectorMessage, VectorTurn } from './learning-vector-turns.js'
import {
  feedbackCases, goldenLabel, representativeSample, sampleQuotas, goldenReviewPrompt, gradeBand, historyFromSelection, stratifiedOrder,
  validateFeedbackCandidate, validateGoldenReview,
} from './learning-incremental-grading-experiment.js'
import { defaultIncrementalVariant } from './learning-incremental-assessment.js'

const concept = { conceptId: 'c', title: 'Control group', description: 'Fair comparison.', objectives: ['Design a fair comparison'] }
const vm = (id: string, role: string, at: string, text = `${role} ${id}`): VectorMessage =>
  ({ id, conversationId: 'k', role, text, occurredAt: at, logicalKey: id, correlation: { secret: 'x' }, sourceOrder: 0, sourceVersion: '1', authorship: 'human' })
const vt = (n: number, conversationId = 'k'): VectorTurn =>
  ({ id: `u${n}`, conversationId, at: `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`, messageIds: [`u${n}`, `a${n}`], linkage: 'explicit' })

describe('incremental grading experiment', () => {
  test('grade bands follow the production rubric levels', () => {
    expect([null, 0, 20, 25, 45, 50, 70, 95].map(gradeBand)).toEqual(['unknown', 'low', 'low', 'mid', 'mid', 'high', 'high', 'high'])
  })
  test('stratified order interleaves bands and is seed-stable', () => {
    const pool = [...['a', 'b', 'c'].map(id => ({ conceptId: `u-${id}`, band: 'unknown' as const })), { conceptId: 'l-a', band: 'low' as const }, { conceptId: 'h-a', band: 'high' as const }]
    const order = stratifiedOrder(pool, 's1')
    expect(order).toHaveLength(5)
    expect(new Set(order.slice(0, 3).map(c => c.band))).toEqual(new Set(['unknown', 'low', 'high']))
    expect(stratifiedOrder([...pool].reverse(), 's1')).toEqual(order)
  })
  test('history is the newest whole turns that fit, replayed in time order, stripped to source fields', () => {
    const messages = new Map([1, 2, 3].flatMap(n => [vm(`u${n}`, 'user', vt(n).at), vm(`a${n}`, 'assistant', vt(n).at)]).map(m => [m.id, m]))
    // Selection order groups by conversation; replay must be by time.
    const turns = [vt(3, 'a'), vt(1, 'b'), vt(2, 'c')]
    const all = historyFromSelection(turns, messages, 1_000_000)
    expect(all.turns.map(t => t.id)).toEqual(['u1', 'u2', 'u3'])
    expect(Object.keys(all.turns[0]!.messages[0]!).sort()).toEqual(['conversationId', 'id', 'occurredAt', 'role', 'text'])
    const one = Buffer.byteLength(JSON.stringify(all.turns[2]!.messages))
    const newest = historyFromSelection(turns, messages, one * 2)
    expect(newest.turns.map(t => t.id)).toEqual(['u2', 'u3'])
    expect(newest.droppedTurns).toBe(1)
  })
  test('the golden review sees the full history and the candidate, and must give its own grade when it disagrees', () => {
    const candidate = { understandingPercent: 40, confidence: 'medium' as const, demonstrated: [{ description: 'd', sourceId: 'u1', quote: 'q' }], gaps: [] }
    const prompt = goldenReviewPrompt(concept, [{ id: 'u1', at: 'x', messages: [vm('u1', 'user', 'x', 'my reasoning')] }], candidate)
    expect(prompt).toContain('my reasoning')
    expect(prompt).toContain('"understandingPercent":40')
    expect(prompt).toContain('OBJECTIVE:')
    expect(validateGoldenReview({ agrees: true, rationale: 'fits', ownGrade: null }, candidate)).toEqual({ agrees: true, rationale: 'fits', ownGrade: null })
    expect(() => validateGoldenReview({ agrees: false, rationale: 'too high', ownGrade: null }, candidate)).toThrow(/own grade/)
    expect(() => validateGoldenReview({ agrees: true, rationale: 'x', ownGrade: { understandingPercent: 30, confidence: 'low' } }, candidate)).toThrow(/own grade/)
    // With no candidate (the baseline failed) agreement is impossible.
    expect(() => validateGoldenReview({ agrees: true, rationale: 'x', ownGrade: null }, null)).toThrow(/candidate/)
    expect(goldenLabel({ agrees: true, rationale: 'r', ownGrade: null }, candidate)).toMatchObject({ goldenPercent: 40, source: 'candidate-agreed' })
    expect(goldenLabel({ agrees: false, rationale: 'r', ownGrade: { understandingPercent: null, confidence: 'insufficient' } }, candidate)).toMatchObject({ goldenPercent: null, source: 'reviewer-own-grade' })
  })
  test('feedback cases are the worst disagreements, worst first, and a candidate must be a valid variant', () => {
    const cases = feedbackCases([
      { conceptId: 'a', arm: 'x', scores: { percent_abs_error: 5, level_agrees: true } },
      { conceptId: 'b', arm: 'x', scores: { percent_abs_error: 30, level_agrees: false } },
      { conceptId: 'c', arm: 'x', scores: { level_agrees: false, evidence_decision_agrees: false } },
      { conceptId: 'd', arm: 'x', scores: { percent_abs_error: 0, level_agrees: true } },
    ], 2)
    expect(cases.map(c => c.conceptId)).toEqual(['c', 'b'])
    const instructions = defaultIncrementalVariant().instructions
    const ok = validateFeedbackCandidate({ instructions, contextAllowanceBytes: 80_000, changes: ['narrower'], rationale: 'because' })
    expect(ok.variant.revision).toBe('gradual-understanding-v6-prior-aware-incremental')
    const changed = validateFeedbackCandidate({ instructions: [...instructions, 'Extra rule.'], contextAllowanceBytes: 80_000, changes: ['added'], rationale: 'r' })
    expect(changed.variant.revision).toMatch(/^gradual-understanding-v6-prior-aware-incremental\+[0-9a-f]{12}$/)
    expect(() => validateFeedbackCandidate({ instructions: ['### NEW EVIDENCE hijack', ...instructions], contextAllowanceBytes: 80_000, changes: ['x'], rationale: 'r' })).toThrow()
    expect(() => validateFeedbackCandidate({ instructions, contextAllowanceBytes: 900_000, changes: ['x'], rationale: 'r' })).toThrow()
  })
  test('the representative sample fills band quotas, takes strong concepts richest-first and spreads volume', () => {
    expect(sampleQuotas(50)).toEqual({ unknown: 12, low: 13, mid: 13, high: 12 })
    const make = (band: 'unknown' | 'low' | 'mid' | 'high', count: number) => Array.from({ length: count }, (_, i) => ({ conceptId: `${band}-${i}`, band, historyBytes: (i + 1) * 1000, droppedTurns: i === count - 1 ? 3 : 0 }))
    const pool = [...make('unknown', 30), ...make('low', 30), ...make('mid', 30), ...make('high', 5)]
    const { picked, strata } = representativeSample(pool, 20, 's')
    expect(picked).toHaveLength(20)
    expect(new Set(picked.map(p => p.conceptId)).size).toBe(20)
    // Only 5 strong exist: all taken, richest first, and the shortfall filled from other bands.
    expect(picked.filter(p => p.band === 'high').map(p => p.conceptId)).toEqual(['high-4', 'high-3', 'high-2', 'high-1', 'high-0'])
    const low = picked.filter(p => p.band === 'low')
    expect(new Set(low.slice(0, 3).map(p => p.volume))).toEqual(new Set(['large', 'small', 'medium']))
    expect(Object.values(strata).reduce((a, b) => a + b, 0)).toBe(20)
    expect(representativeSample([...pool].reverse(), 20, 's').picked.map(p => p.conceptId)).toEqual(picked.map(p => p.conceptId))
  })
})

test('a stored request matches its resend whatever key order jsonb gave it back in', async () => {
  const { sameRequest } = await import('./learning-incremental-grading-experiment.js')
  expect(typeof sameRequest).toBe('function')
  const sent = { seed: 's', sampleSize: 50, arms: [{ name: 'a', contextAllowanceBytes: 0 }], feedback: true }
  expect(sameRequest({ feedback: true, arms: [{ contextAllowanceBytes: 0, name: 'a' }], sampleSize: 50, seed: 's' }, sent)).toBe(true)
  expect(sameRequest({ ...sent, sampleSize: 49 }, sent)).toBe(false)
  // Array order is meaningful (arm order), so it is never normalised away.
  expect(sameRequest({ ...sent, arms: [{ name: 'b' }, { name: 'a' }] }, { ...sent, arms: [{ name: 'a' }, { name: 'b' }] })).toBe(false)
})

test('feedback v2 focuses Opus on the weak axes: worst concepts, blanks answered with a number, and swing, for one arm', async () => {
  const mod = await import('./learning-incremental-grading-experiment.js')
  expect(typeof mod.feedbackFocusCases).toBe('function')
  const row = (conceptId: string, band: string, goldenPercent: number | null, finalPercent: number | null, scores: Record<string, number | boolean>, arm = 'v6') => ({ conceptId, band, goldenPercent, finalPercent, arm, scores })
  const rows = [
    ...['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id, i) => row(id, 'mid', 50, 10 + i, { percent_abs_error: 40 - i, level_agrees: false, grade_swing: 0 })),
    row('blank', 'unknown', null, 20, { level_agrees: false, grade_swing: 5 }),
    row('blank-ok', 'unknown', null, null, { level_agrees: true, grade_swing: 0 }),
    row('swingy', 'high', 60, 60, { percent_abs_error: 0, level_agrees: true, grade_swing: 45 }),
    row('other-arm', 'unknown', null, 30, { level_agrees: false, grade_swing: 90 }, 'v6-other'),
  ]
  const cases = mod.feedbackFocusCases(rows, 'v6')
  expect(cases.filter(c => c.why === 'worst').map(c => c.conceptId)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5'])
  expect(cases.filter(c => c.why === 'blank-answered').map(c => c.conceptId)).toEqual(['blank'])
  expect(cases.filter(c => c.why === 'swing').map(c => c.conceptId)).toEqual(['swingy'])
  expect(cases.some(c => c.arm !== 'v6')).toBe(false)
  expect(new Set(cases.map(c => c.conceptId)).size).toBe(cases.length)
})

test('the non-circular subset scores every arm only where Opus overrode the baseline', async () => {
  const { overrideSubsetStats } = await import('./learning-incremental-grading-experiment.js')
  const golden = { a: { source: 'reviewer-own-grade' }, b: { source: 'candidate-agreed' }, c: { source: 'reviewer-own-grade' } }
  const rows: Array<{ conceptId: string; scores: Record<string, number | boolean> }> = [
    { conceptId: 'a', scores: { percent_abs_error: 10, level_agrees: true } },
    { conceptId: 'b', scores: { percent_abs_error: 0, level_agrees: true } },
    { conceptId: 'c', scores: { level_agrees: false } },
  ]
  expect(overrideSubsetStats(rows, golden)).toEqual({ items: 2, maeItems: 1, meanAbsError: 10, levelAgreement: 0.5 })
})


test('B1a: a validator rejection the model can repair (quotation or a mis-copied nodeVersion) is retried ONCE with the error and the rejected answer fed back; other failures are not', async () => {
  const mod = await import('./learning-incremental-grading-experiment.js')
  expect(typeof mod.withValidatorRetry).toBe('function')
  const prompts: string[] = []
  const flaky = (answers: Array<string | Error>) => async (prompt: string) => { prompts.push(prompt); const a = answers.shift()!; if (a instanceof Error) throw a; return a }
  let rejected = 'first answer'
  const recovered = await mod.withValidatorRetry('P', flaky([new Error('Non-exact human quotation: c'), 'ok']), () => rejected)
  expect(recovered).toEqual({ ok: true, value: 'ok', retried: 'quote', firstError: 'Non-exact human quotation: c' })
  expect(prompts[1]).toStartWith('P')
  expect(prompts[1]).toContain('Non-exact human quotation: c')
  expect(prompts[1]).toContain('first answer')
  prompts.length = 0
  const node = await mod.withValidatorRetry('P', flaky([new Error('Unknown concept or stale node version: c1'), 'ok']), () => rejected)
  expect(node).toEqual({ ok: true, value: 'ok', retried: 'nodeVersion', firstError: 'Unknown concept or stale node version: c1' })
  expect(prompts[1]).toContain('nodeVersion')
  expect(prompts[1]).not.toContain('quotation must be copied')
  prompts.length = 0
  const twice = await mod.withValidatorRetry('P', flaky([new Error('Unknown human source: x'), new Error('Non-exact human quotation: c')]), () => rejected)
  expect(twice).toMatchObject({ ok: false, retried: 'quote', firstError: 'Unknown human source: x' })
  expect(prompts).toHaveLength(2)
  prompts.length = 0
  const other = await mod.withValidatorRetry('P', flaky([new Error('Provider timed out')]), () => rejected)
  expect(other).toMatchObject({ ok: false, retried: null })
  expect(prompts).toHaveLength(1)
  const first = await mod.withValidatorRetry('P', flaky(['fine']), () => rejected)
  expect(first).toEqual({ ok: true, value: 'fine', retried: null, firstError: null })
})

test('B1b: a warm arm starts from the published grade frozen at sample time, a cold arm from nothing', async () => {
  const mod = await import('./learning-incremental-grading-experiment.js')
  expect(typeof mod.initialPrior).toBe('function')
  const warmPrior = { understandingPercent: 40, confidence: 'medium' as const, demonstrated: [], gaps: [] }
  expect(mod.initialPrior({ prior: 'warm' }, { warmPrior })).toEqual(warmPrior)
  expect(mod.initialPrior({ prior: 'cold' }, { warmPrior })).toBeNull()
  expect(mod.initialPrior({}, { warmPrior })).toBeNull()
  // A concept with no published grade starts warm arms from nothing, never from a fabricated estimate.
  expect(mod.initialPrior({ prior: 'warm' }, {})).toBeNull()
})

test('B0: the blind golden grade never shows Opus the v5 grade; the ceiling subset is stratified; pooled samples rewrite their review calls', async () => {
  const mod = await import('./learning-incremental-grading-experiment.js')
  expect(typeof mod.blindGradePrompt).toBe('function')
  const prompt = mod.blindGradePrompt(concept, [{ id: 'u1', at: 'x', messages: [vm('u1', 'user', 'x', 'my reasoning')] }])
  expect(prompt).toContain('my reasoning')
  expect(prompt).toContain('OBJECTIVE:')
  expect(prompt).not.toContain('CANDIDATE')
  expect(prompt).not.toContain('production grader produced')
  const items = ['unknown', 'unknown', 'low', 'low', 'mid', 'high', 'high'].map((band, i) => ({ conceptId: `c${i}`, band }))
  expect(mod.ceilingSubset(items, 4).map(i => i.conceptId)).toEqual(['c0', 'c2', 'c4', 'c5'])
  expect(mod.ceilingSubset(items, 100)).toHaveLength(7)
  const pooled = mod.poolSamples([[{ conceptId: 'a', reviewRunId: 'old-a' }, { conceptId: 'b', reviewRunId: 'old-b' }], [{ conceptId: 'b', reviewRunId: 'old-b2' }, { conceptId: 'c', reviewRunId: 'old-c' }]], id => `new-${id}`)
  expect(pooled.map(i => [i.conceptId, i.reviewRunId, i.ordinal])).toEqual([['a', 'new-a', 0], ['b', 'new-b', 1], ['c', 'new-c', 2]])
})

test('B3: arm metrics report level, within-10, MAE, bias, blanks, quote retries, speed and seeded bootstrap CIs', async () => {
  const mod = await import('./learning-incremental-grading-experiment.js')
  expect(typeof mod.armMetrics).toBe('function')
  const t = (status: string, extra: Record<string, unknown> = {}) => ({ status, percent: null, durationMs: 10_000, paid: true, contextBytes: 1000, inputTokens: 100, quoteRetried: false, quoteRecovered: false, quoteRejected: false, nodeRetried: false, nodeRecovered: false, ...extra })
  const rows = [
    { conceptId: 'a', band: 'high', goldenPercent: 60, finalPercent: 50, scores: { grade_swing: 10, failed_increments: 0 }, trajectory: [t('completed'), t('completed', { quoteRetried: true, quoteRecovered: true })] },
    { conceptId: 'b', band: 'mid', goldenPercent: 30, finalPercent: 60, scores: { grade_swing: 30, failed_increments: 1 }, trajectory: [t('failed', { quoteRetried: true, quoteRejected: true }), t('completed')] },
    { conceptId: 'c', band: 'unknown', goldenPercent: null, finalPercent: null, scores: { grade_swing: 0, failed_increments: 0 }, trajectory: [t('completed')] },
    { conceptId: 'd', band: 'unknown', goldenPercent: null, finalPercent: 15, scores: { grade_swing: 0, failed_increments: 0 }, trajectory: [t('completed', { nodeRetried: true, nodeRecovered: true })] },
  ]
  const m = mod.armMetrics(rows, 'seed')
  expect(m.items).toBe(4)
  expect(m.levelAgreement).toBe(0.5) // a (3=3) and c (null=null)
  expect(m.within10).toBe(0.5) // a (10) and c (both null)
  expect(m.mae).toEqual({ mean: 20, p50: 10, n: 2 })
  expect(m.signedBias).toBe(10) // (-10 + 30) / 2
  expect(m.blanksNull).toBe(0.5)
  expect(m.nullAgreement).toBe(0.5)
  expect(m.swing).toBe(10)
  expect(m.quote).toEqual({ calls: 6, rejectedBeforeRetry: 2, rejectedAfterRetry: 1, retries: 2, recovered: 1 })
  expect(m.failedIncrements).toBe(1)
  expect(m.nodeVersion).toEqual({ retries: 1, recovered: 1 })
  expect(m.callSeconds).toEqual({ p50: 10, p90: 10 })
  expect(m.contextBytes).toEqual({ mean: 1000, p90: 1000 })
  expect(m.inputTokens).toBe(600)
  const [lo, hi] = m.ci.levelAgreement!
  expect(lo).toBeGreaterThanOrEqual(0); expect(hi).toBeLessThanOrEqual(1); expect(lo).toBeLessThanOrEqual(0.5); expect(hi).toBeGreaterThanOrEqual(0.5)
  expect(mod.armMetrics(rows, 'seed').ci).toEqual(m.ci)
})

test('Langfuse read-back starts at the earliest exported span: a pooled round re-exports v5 baselines that ran before the round existed', async () => {
  const mod = await import('./learning-incremental-grading-experiment.js')
  expect(typeof mod.readBackSince).toBe('function')
  const created = new Date('2026-10-21T20:51:38.425Z')
  expect(mod.readBackSince(created, [Date.parse('2026-10-21T21:00:00Z')]).toISOString()).toBe('2026-10-21T20:51:38.425Z')
  expect(mod.readBackSince(created, [Date.parse('2026-10-21T21:00:00Z'), Date.parse('2026-10-21T17:57:43.365Z')]).toISOString()).toBe('2026-10-21T17:57:43.365Z')
  expect(mod.readBackSince(created, []).toISOString()).toBe('2026-10-21T20:51:38.425Z')
})
