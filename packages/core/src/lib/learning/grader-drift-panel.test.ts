import { describe, expect, test } from 'bun:test'
import {
  addWeeks, bandDrifts, jsonbRoundTrip, PANEL_LEVELS, PANEL_MIN_WEEKS, PANEL_SIZE, panelDrift, panelGradingInput, panelGraderKey, panelIngredients, panelInputMismatch,
  panelLevel, PanelIngredients, reproducesPriorBlind, selectPanel, weekClusteredSlope, weekOf, weeksBetween, type PanelCandidate, type PanelGroup,
} from './grader-drift-panel.js'
import { buildIncrementalAssessmentInput, incrementalVariant, priorBlindPrompt } from './learning-incremental-assessment.js'
import { LIVE_INCREMENTAL_VARIANT } from './learning-live-incremental-variant.js'
import { aggregateChange, blindDrift, conceptChanges, graderOnlyNoise, seededRandom, type CountedReading } from './mastery-change-statistics.js'
import { blindGrading } from './mastery-known-truth.js'

// Every text below is synthetic: no learner evidence appears in this public repository.
const source = (id: string, role: string, text: string) => jsonbRoundTrip({ id, role, text, authorship: 'human', logicalKey: `k-${id}`, occurredAt: '2026-11-02T10:00:00.000Z',
  correlation: { turn: id }, sourceOrder: 1, sourceVersion: 'v1', conversationId: 'conv-1' })
const concept = jsonbRoundTrip({ conceptId: 'concept-a', title: 'Synthetic concept', description: 'A made-up concept for tests.', objectives: ['explain it', 'apply it'] })
const evidence = [source('m1', 'user', 'I would cache the result because recomputing is slow.'), source('m2', 'assistant', 'Sounds reasonable.')]
const context = [{ id: 't0', at: '2026-11-01T09:00:00.000Z', messages: [source('m0', 'user', 'What should we cache?')] }]
const prior = { understandingPercent: 40, confidence: 'medium', demonstrated: [{ description: 'cached a result', sourceId: 'm0', quote: 'cache' }], gaps: [], nextCheck: 'ask why', needsReview: true } as never

describe('panel evidence: exactly what the past prior-blind grading saw', () => {
  const frozen = buildIncrementalAssessmentInput(concept, evidence, prior, context, LIVE_INCREMENTAL_VARIANT).prompt

  test('the rebuilt input is the frozen live prompt with its estimate withheld, byte for byte (the replicate prompt)', () => {
    const ingredients = panelIngredients(frozen)!
    expect(ingredients).not.toBeNull()
    // Every field the grader saw survives, not only the schema's: authorship, sourceVersion, correlation...
    expect(Object.keys(ingredients.evidence[0]!)).toEqual(Object.keys(evidence[0]!))
    expect(panelGradingInput(ingredients).prompt).toBe(priorBlindPrompt(frozen))
    expect(reproducesPriorBlind(ingredients, frozen)).toBe(true)
    // Prior-blind by construction: the estimate section says none.
    expect(panelGradingInput(ingredients).prompt).toContain('### CURRENT PUBLISHED ESTIMATE (already reflects every earlier turn)\nnone')
  })

  test('a concept read in builder order (not jsonb order) does not reproduce after the database round trip, and is left out', () => {
    const builderOrder = { conceptId: 'concept-a', title: 'Synthetic concept', description: 'A made-up concept for tests.', objectives: ['explain it', 'apply it'] }
    const p = buildIncrementalAssessmentInput(builderOrder, evidence, prior, context, LIVE_INCREMENTAL_VARIANT).prompt
    expect(reproducesPriorBlind(panelIngredients(p)!, p)).toBe(false)
  })

  test('the regrade uses the CURRENT revision: under another variant the instructions change and the evidence does not', () => {
    const other = incrementalVariant([...LIVE_INCREMENTAL_VARIANT.instructions.slice(0, -1), 'Return only the structured JSON, briefly.'])
    const a = panelGradingInput(panelIngredients(frozen)!), b = panelGradingInput(panelIngredients(frozen)!, other)
    expect(b.prompt).not.toBe(a.prompt)
    expect(b.prompt.slice(b.prompt.indexOf('### CONCEPT'))).toBe(a.prompt.slice(a.prompt.indexOf('### CONCEPT')))
    expect(panelGraderKey(other)).not.toBe(panelGraderKey())
  })

  test('the paid-path guard: the raw stored objects pass; schema-parsed ones (fields dropped) are refused before any call (review B1)', () => {
    const stored = jsonbRoundTrip(panelIngredients(frozen)!)
    expect(panelInputMismatch(panelGradingInput(stored).prompt, frozen, true)).toBeNull()
    const stripped = panelGradingInput(PanelIngredients.parse(stored)).prompt
    expect(stripped.length).toBeLessThan(panelGradingInput(stored).prompt.length)
    expect(panelInputMismatch(stripped, frozen, true)).toBe('evidence sections differ from the verified prior-blind prompt')
    // Under another revision only the data sections must match; at the source's own revision, the whole prompt.
    const other = incrementalVariant(['A different instruction paragraph.'])
    expect(panelInputMismatch(panelGradingInput(stored, other).prompt, frozen, false)).toBeNull()
    expect(panelInputMismatch(panelGradingInput(stored, other).prompt, frozen, true)).toBe('prompt differs from the verified prior-blind prompt')
    expect(panelInputMismatch('not an incremental prompt', frozen, false)).toBe('prompt shape not recognised')
  })

  test('any other prompt shape has no ingredients', () => {
    expect(panelIngredients('Learning assessment.\n\nINPUT:\n{"nodeStates":[],"evidence":[]}')).toBeNull()
    expect(panelIngredients(frozen.replace('### NEW EVIDENCE', '### EVIDENCE'))).toBeNull()
  })
})

/** Computed once from the rule and pinned: any change to the order of turns, the tie rule or the rank shows here. */
const PINNED_PICKS = ['0:c:0', '1:d:2', '2:f:4', '3:a:0', '4:e:2']

describe('panel selection: deterministic, stratified, frozen by storage', () => {
  // 120 candidates over 40 concepts; the top level is scarce (3), as on dev.
  const rand = seededRandom(5)
  const pool: PanelCandidate[] = Array.from({ length: 120 }, (_, i) => ({ runId: `run-${i}`, conceptId: `c${i % 40}`, blindPercent: i < 3 ? 85 : Math.floor(rand() * 80) }))
  const shuffled = [...pool].sort(() => rand() - 0.5)

  test('same candidate set and seed, any order: the same panel', () => {
    const a = selectPanel(pool, 's|u1'), b = selectPanel(shuffled, 's|u1')
    expect(b).toEqual(a)
    expect(a).toHaveLength(PANEL_SIZE)
    expect(a.map((p) => p.item)).toEqual(Array.from({ length: PANEL_SIZE }, (_, i) => i))
    expect(new Set(a.map((p) => p.runId)).size).toBe(PANEL_SIZE)
  })

  test('another seed (another learner) draws another panel', () => {
    expect(selectPanel(pool, 's|u2').map((p) => p.runId)).not.toEqual(selectPanel(pool, 's|u1').map((p) => p.runId))
  })

  test('levels take equal shares until one runs out; the scarce level gives all it has', () => {
    const counts = Array.from({ length: PANEL_LEVELS }, (_, l) => selectPanel(pool, 's|u1').filter((p) => p.level === l).length)
    expect(counts[4]).toBe(3)
    expect(Math.max(...counts.slice(0, 4)) - Math.min(...counts.slice(0, 4))).toBeLessThanOrEqual(1)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(PANEL_SIZE)
  })

  test('concepts spread: no concept twice while an unused one is available in that level', () => {
    const picks = selectPanel(pool, 's|u1')
    for (const [i, pick] of picks.entries()) {
      const before = picks.slice(0, i), usedBefore = new Set(before.map((p) => p.conceptId))
      if (!usedBefore.has(pick.conceptId)) continue
      const left = pool.filter((c) => panelLevel(c.blindPercent) === pick.level && !before.some((p) => p.runId === c.runId))
      expect(left.every((c) => usedBefore.has(c.conceptId))).toBe(true)
    }
    expect(new Set(picks.map((p) => p.conceptId)).size).toBeGreaterThanOrEqual(PANEL_SIZE - 2)
  })

  test('the exact picks are pinned: lowest level first, least-used concept, then the seeded rank', () => {
    const small: PanelCandidate[] = [
      { runId: 'a', conceptId: 'x', blindPercent: 10 }, { runId: 'b', conceptId: 'x', blindPercent: 12 }, { runId: 'c', conceptId: 'y', blindPercent: 15 },
      { runId: 'd', conceptId: 'x', blindPercent: 50 }, { runId: 'e', conceptId: 'z', blindPercent: 55 }, { runId: 'f', conceptId: 'y', blindPercent: 90 },
    ]
    expect(selectPanel(small, 'pin', 5).map((p) => `${p.item}:${p.runId}:${p.level}`)).toEqual(PINNED_PICKS)
  })

  test('levels are 20-point bands, 100 in the top one', () => {
    expect([0, 19, 20, 59, 60, 80, 100].map(panelLevel)).toEqual([0, 0, 1, 2, 3, 4, 4])
  })

  test('fewer candidates than the panel size: all of them, once', () => {
    expect(selectPanel(pool.slice(0, 7), 's|u1')).toHaveLength(7)
  })
})

describe('weeks', () => {
  test('a week is its Monday (UTC)', () => {
    expect(weekOf(Date.parse('2026-11-11T23:59:00Z'))).toBe('2026-11-09')
    expect(weekOf(Date.parse('2026-11-09T00:00:00Z'))).toBe('2026-11-09')
    expect(weekOf(Date.parse('2026-11-15T23:59:59Z'))).toBe('2026-11-09')
    expect(addWeeks('2026-11-09', 3)).toBe('2026-11-30')
    expect(weeksBetween('2026-11-09', '2026-12-28')).toBe(7)
  })
})

// ------------------------------------------------------------------ statistics
//
// The generator ASSUMES what the estimator does not: the drift is exactly linear in calendar weeks, the same for
// every item and score level; each regrade is the item's level + drift + an optional week shock shared by all
// items that week + Gaussian noise of sd 6.74, then put on the 5-point grid and clamped to 0–100 (blindGrading);
// item levels lie in 15–65, so clamping is rare. The estimator assumes linearity too, but NOT normality, the grid,
// the noise sd (its week-clustered part estimates its own scatter) nor the absence of week shocks.
const SD = 6.74
const normal = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r())
function simulatedPanel(seed: number, driftPerWeek: number, opts: { weekShockSd?: number; items?: number; weeks?: number } = {}): PanelGroup[] {
  const rand = seededRandom(seed)
  const items = opts.items ?? 30, weeks = opts.weeks ?? 8
  const levels = Array.from({ length: items }, () => 15 + 50 * rand())
  const shocks = Array.from({ length: weeks }, () => (opts.weekShockSd ?? 0) * normal(rand))
  return levels.map((level) => Array.from({ length: weeks }, (_, w) => ({ weeks: w, percent: blindGrading(rand, level + driftPerWeek * w + shocks[w]!, SD) })))
}
const REPS = 400
/** The 1st percentile of Binomial(REPS, 0.95) is 368 (92 %): a correct 95 % interval covers at least that often. */
const MIN_COVERED = 368

describe('panel drift: interval coverage with planted drift (30 items × 8 weeks)', () => {
  for (const drift of [0, 0.25, 0.5]) {
    test(`drift ${drift} points/week: the 95 % interval covers it in at least ${MIN_COVERED}/${REPS} panels`, () => {
      let covered = 0, half = 0
      for (let s = 1; s <= REPS; s++) {
        const d = panelDrift(simulatedPanel(1000 * s + 7, drift), SD)
        if (d.interval![0] <= drift && drift <= d.interval![1]) covered++
        half += (d.interval![1] - d.interval![0]) / 2 / REPS
      }
      expect(covered).toBeGreaterThanOrEqual(MIN_COVERED)
      expect(half).toBeLessThan(0.55) // ±0.47 measured; the proposal's ±0.37 is the item-level part alone
    })
  }

  test('a shock shared by a whole week (sd 2): the item-level interval alone under-covers; the panel interval still covers', () => {
    let item = 0, panel = 0
    for (let s = 1; s <= REPS; s++) {
      const g = simulatedPanel(1000 * s + 11, 0.25, { weekShockSd: 2 })
      const b = blindDrift(g, SD), d = panelDrift(g, SD)
      if (b.interval![0] <= 0.25 && 0.25 <= b.interval![1]) item++
      if (d.interval![0] <= 0.25 && 0.25 <= d.interval![1]) panel++
    }
    expect(item).toBeLessThan(0.8 * REPS) // 69 % measured
    expect(panel).toBeGreaterThanOrEqual(0.9 * REPS) // 93 % measured
  })

  test(`below ${PANEL_MIN_WEEKS} weekly runs there is no interval (unmeasured), from ${PANEL_MIN_WEEKS} there is`, () => {
    expect(panelDrift(simulatedPanel(3, 0, { weeks: PANEL_MIN_WEEKS - 1 }), SD).interval).toBeNull()
    expect(panelDrift(simulatedPanel(3, 0, { weeks: PANEL_MIN_WEEKS }), SD).interval).not.toBeNull()
    expect(weekClusteredSlope(simulatedPanel(3, 0, { weeks: 2 }))).toBeNull()
  })

  test('the week-clustered slope is OLS on week means with a t interval on weeks - 2 df (hand-computed)', () => {
    // Two items; week means of item-centred residuals are -7/6, -1/6, 4/3 at weeks 0, 1, 2: slope 1.25, residuals 1/12, -1/6, 1/12, s² = 1/24 on 1 df.
    const g: PanelGroup[] = [[{ weeks: 0, percent: 9 }, { weeks: 1, percent: 10 }, { weeks: 2, percent: 11.5 }], [{ weeks: 0, percent: 49 }, { weeks: 1, percent: 50 }, { weeks: 2, percent: 51.5 }]]
    const c = weekClusteredSlope(g)!
    expect(c.slope).toBeCloseTo(1.25, 9)
    // half = t(0.975, 1) × sqrt(s² / Sxx) = 12.7062 × sqrt((1/24) / 2)
    expect(c.interval[1] - c.slope).toBeCloseTo(12.7062 * Math.sqrt(1 / 24 / 2), 3)
  })

  test('weekly shocks that PERSIST (AR(1) rho 0.7, sd 2): the interval covers the grader\'s realised trend over the window, not the underlying rate (the stated bound)', () => {
    // The window's realised trend is what moved the readings graded in it; a persistent wander IS a trend over 8 weeks,
    // so no 8-week estimator separates it from a linear rate. Measured (2,000 seeds): realised 99.2 %, rate 81.5 %.
    let realised = 0, rate = 0
    const rho = 0.7, tau = 2, drift = 0.25
    for (let s = 1; s <= REPS; s++) {
      const rand = seededRandom(7000 + s)
      let e = 0
      const shocks = Array.from({ length: 8 }, (_, w) => (e = w === 0 ? tau * normal(rand) : rho * e + Math.sqrt(1 - rho * rho) * tau * normal(rand)))
      const g = Array.from({ length: 30 }, () => 15 + 50 * rand()).map((level) => Array.from({ length: 8 }, (_, w) => ({ weeks: w, percent: blindGrading(rand, level + drift * w + shocks[w]!, SD) })))
      const trend = shocks.reduce((a, x, w) => a + (w - 3.5) * (drift * w + x), 0) / 42
      const i = panelDrift(g, SD).interval!
      if (i[0] <= trend && trend <= i[1]) realised++
      if (i[0] <= drift && drift <= i[1]) rate++
    }
    expect(realised).toBeGreaterThanOrEqual(MIN_COVERED)
    expect(rate).toBeLessThan(0.9 * REPS)
  })

  test('per score band: bands that drift apart (a ceiling effect) are reported as disagreeing; the pooled drift alone would hide it', () => {
    const low = simulatedPanel(21, 0, { items: 15 }), high = simulatedPanel(22, -3, { items: 15 })
    const levels = [...low.map(() => 0), ...high.map(() => 3)]
    const split = bandDrifts([...low, ...high], levels, SD)
    expect(split.bands.map((b) => [b.level, b.items])).toEqual([[0, 15], [3, 15]])
    expect(split.disagree).toBe(true)
    expect(bandDrifts([...low, ...simulatedPanel(23, 0, { items: 15 })], levels, SD).disagree).toBe(false)
  })

  test('the panel interval contains both the item-level and the week-clustered interval', () => {
    const g = simulatedPanel(9, 0.3, { weekShockSd: 1 })
    const d = panelDrift(g, SD), b = blindDrift(g, SD), c = weekClusteredSlope(g)!
    expect(d.interval![0]).toBe(Math.min(b.interval![0], c.interval[0]))
    expect(d.interval![1]).toBe(Math.max(b.interval![1], c.interval[1]))
    expect(d.perWeek).toBe(b.perWeek)
  })
})

describe('the withholding rule fed by the panel', () => {
  const DAY = 86_400_000
  /** One learner: 40 concepts read at day 0 and day 28 prior-blind, by a grader drifting `drift` a week, with `learning` points of true gain. */
  const learner = (seed: number, drift: number, learning: number) => {
    const rand = seededRandom(seed)
    const readings: CountedReading[] = []
    for (let i = 0; i < 40; i++) {
      const truth = 20 + 40 * rand()
      readings.push({ conceptId: `c${i}`, at: 0, percent: blindGrading(rand, truth, SD) }, { conceptId: `c${i}`, at: 28 * DAY, percent: blindGrading(rand, truth + learning + 4 * drift, SD) })
    }
    return conceptChanges(readings, graderOnlyNoise(SD))
  }
  const RUNS = 60

  test('no learning, grader drifting +0.5/week: "rose" fires often without the rule and rarely with the panel\'s drift', () => {
    let plain = 0, ruled = 0, withheld = 0
    for (let s = 1; s <= RUNS; s++) {
      const changes = learner(s, 0.5, 0)
      const free = aggregateChange(changes, { reps: 300 })
      const withPanel = aggregateChange(changes, { reps: 300, drift: panelDrift(simulatedPanel(500 + s, 0.5), SD) })
      if (free.conclusive && free.changeInterval![0] > 0) plain++
      if (withPanel.conclusive && withPanel.changeInterval![0] > 0) ruled++
      if (withPanel.withheldForDrift) withheld++
    }
    expect(plain).toBeGreaterThan(9) // above the 99th percentile of Binomial(60, 5 %)
    expect(ruled).toBeLessThanOrEqual(7)
    expect(withheld).toBeGreaterThan(0)
  }, 60_000)

  test('real learning of +12 and no drift: the rule releases "rose" in most runs', () => {
    let released = 0
    for (let s = 1; s <= RUNS; s++) {
      const a = aggregateChange(learner(100 + s, 0, 12), { reps: 300, drift: panelDrift(simulatedPanel(900 + s, 0), SD) })
      if (a.conclusive && a.changeInterval![0] > 0) released++
    }
    expect(released).toBeGreaterThanOrEqual(0.8 * RUNS)
  }, 60_000)

  test('before the panel has enough weeks even a large change is withheld', () => {
    const a = aggregateChange(learner(7, 0, 25), { reps: 300, drift: panelDrift(simulatedPanel(7, 0, { weeks: 2 }), SD) })
    expect(a.changeInterval![0]).toBeGreaterThan(0)
    expect([a.conclusive, a.withheldForDrift]).toEqual([false, true])
  })
})
