import { describe, expect, test } from 'bun:test'
import { liveFeedbackContext } from '@learner/contract/learning/learning-live-hook.js'
import { LIVE_FEEDBACK_INSTRUCTIONS } from './learning-live-feedback.js'
import { HALYARD_CATALOG, HALYARD_EDGES, HALYARD_MANUAL, HALYARD_TASKS } from './learning-sim-halyard.js'
import { DROPPED_EXAM_ITEMS, factSheet, HALYARD_FACT_ITEMS_UNSCREENED } from './learning-sim-facts.js'
import { agentReplyPrompt, hookExtra, learnerTurnPrompt, probePrompt, probeQuestion, REPLY_SCHEMA } from './learning-sim-prompts.js'
import { ATTRIBUTION_THRESHOLD, EXAM_FACTS, examLeaks, factsBySentence, factsIn, REDACTED, redactReply, TITLE_ANSWERS, unread } from './learning-sim-matcher.js'
import { HALYARD_GRAPH, laneCapacity, MEMORY_RULES, SIM_LANES, SIM_RUNGS, examResult, heldExam, renderHeld, replayExams, seeded, updateHeld, type ExamResult, type Held } from './learning-sim-memory.js'
import { judgeSample } from './learning-sim-judge.js'
import type { PairedEstimate } from './learning-sim-sequential.js'
import { anchorPlan, ceilingTable, hookPlan, simulateLearner, staticPlan } from './learning-sim-ceiling.js'
import { factBudget, stratifiedHoldout, williamsRow } from './learning-sim-design.js'
import { analyzeSimRun, sessionDeliveries, renderSimReport, replayedExams, simVerdict, SIM_READINGS, verdictSentence, type SimLearnerData, simRecordIntegrity, simRunDifferences, simRunRecord, simTransportRefusal, SIM_PREREGISTRATION, SIM_PREREGISTRATION_HASH, blindProbes, changeReportVerdict, probeChangeTracking, channelIntegrity, learnerEcho, learnerOverlaps } from './learning-sim-analysis.js'
import { SimLearnerConfig, SIM_SHEETS, simPairKey } from './learning-sim-experiment.js'
import { renderSimHealth, simHealth } from './learning-sim-health.js'
import { lookLearners, sequencePosition, type RecordedLook } from './learning-sim-looks.js'
import { HALYARD_FACT_EXAM } from './learning-sim-facts.js'

const catalog = HALYARD_CATALOG.concepts.map((x) => ({ id: x.id, title: x.title }))
const packet = { turnId: 't1', catalogVersion: HALYARD_CATALOG.version, catalog: [...HALYARD_CATALOG.concepts], instructions: LIVE_FEEDBACK_INSTRUCTIONS, recentFeedback: [] }
const hook = hookExtra(liveFeedbackContext(packet, 's1', { separateCatalog: false, submissionCommand: 'Submission: return the feedback JSON when asked.' }).hookSpecificOutput.additionalContext,
  { decision: 'influence', conceptIds: [catalog[3]!.id], review: catalog[5]!.id })
const fact = (id: string) => EXAM_FACTS.find((f) => f.id === id)!

describe('simulated learner: no exam answer outside the fact channel', () => {
  // Revision 8's screen, mechanical: an item is answerable without the notebook when its answer is yes or no, sits in
  // material every arm sees (a task's title or brief, the manual), in its own or another scored question, or is a
  // concept's name. A new leaky item fails here.
  const norm = (t: string) => ` ${t.toLowerCase().replace(/[`'"().,:;!?]/g, ' ').replace(/\s+/g, ' ').trim()} `
  const answerOf = (a: string) => norm(a.replace(/\([^)]*\)/g, '').trim().replace(/^(a|an|the)\s+/i, '').replace(/\.$/, ''))
  const bare = (a: string) => answerOf(a).replace(/ (because|of|the|a|an|use|only|it|is|called)(?= )/g, '').trim().replace(/s$/, '')
  const shared = norm([...HALYARD_TASKS.map((t) => `${t.title}\n${t.brief}`), HALYARD_MANUAL].join('\n'))
  const titles = new Set(HALYARD_CATALOG.concepts.map((c) => norm(c.title).trim()))
  const screen = (item: { id: string; question: string; answer: string }, questions: Array<{ id: string; question: string }>) =>
    /^(yes|no)\b/i.test(item.answer) ? 'yesNo' : shared.includes(answerOf(item.answer)) ? 'shared'
      : norm(item.question).includes(answerOf(item.answer)) ? 'ownQuestion' : titles.has(bare(item.answer)) ? 'conceptName'
        : questions.some((q) => q.id !== item.id && norm(q.question).includes(answerOf(item.answer))) ? 'otherQuestion' : null
  test('revisions 8 and 9: no scored item can be answered without the notebook; every dropped item was answerable', () => {
    const scored = HALYARD_FACT_ITEMS_UNSCREENED.filter((x) => HALYARD_FACT_EXAM.some((q) => q.id === x.id))
    expect(scored.length).toBe(60)
    expect(scored.flatMap((x) => (screen(x, scored) ? [`${x.id}: ${screen(x, scored)}`] : []))).toEqual([])
    // The observed implied items are gone too.
    for (const id of DROPPED_EXAM_ITEMS.implied) expect(HALYARD_FACT_EXAM.some((q) => q.id === id)).toBe(false)
    // Positive control: each dropped item, put back among the scored ones, is flagged for the reason recorded.
    for (const [why, ids] of Object.entries(DROPPED_EXAM_ITEMS)) for (const id of ids) {
      if (why === 'implied') continue
      const item = HALYARD_FACT_ITEMS_UNSCREENED.find((x) => x.id === id)!
      expect([id, screen(item, [...scored, item])]).toEqual([id, why])
    }
  })
  test('the leak test finds the leaks it is meant to find (positive control: the fact sheets themselves)', () => {
    expect(examLeaks(catalog.map((c) => factSheet(c.id).facts.map((f) => f.fact).join(' ')).join('\n')).length).toBeGreaterThan(0.75 * HALYARD_FACT_EXAM.length) // 80 of 104 before revision 8
    // Title answers ("a tessel", "a rebraid") were the concepts' own names, exempt here; revision 8 dropped all 8 from
    // the exam (an answer every arm can read in the manual), so nothing is exempt.
    expect(TITLE_ANSWERS.length).toBe(0)
    for (const id of TITLE_ANSWERS) expect(/\d/.test(fact(id).answer)).toBe(false)
  })

  test('no arm\'s base prompt (manual, brief, hook context, learner prompt) states an exam answer at >= 80% of its content tokens with a concept term', () => {
    expect(examLeaks(HALYARD_MANUAL)).toEqual([])
    for (const task of HALYARD_TASKS) {
      for (const extra of [null, hook]) {
        const prompt = agentReplyPrompt({ task, messages: [], message: 'Where do I start?', extra, sheets: [], budget: { total: 4, left: 4 } })
        expect({ task: task.id, hook: Boolean(extra), leaks: examLeaks(prompt) }).toEqual({ task: task.id, hook: Boolean(extra), leaks: [] })
      }
      expect(examLeaks(learnerTurnPrompt({ notebook: '', task, messages: [], turn: 1, turns: 3 }))).toEqual([])
    }
  })

  test('statedFactIds is an enum of the offered ids; none offered allows none', () => {
    const offered = factSheet(catalog[0]!.id).facts.map((f) => f.id)
    expect(REPLY_SCHEMA(offered).properties.statedFactIds).toEqual({ type: 'array', items: { type: 'string', enum: offered } })
    expect(REPLY_SCHEMA([]).properties.statedFactIds).toMatchObject({ maxItems: 0 })
  })
})

describe('simulated learner: Sam writes from memory (B5)', () => {
  test('Sam sees its own messages and only the questions of the agent\'s latest reply, never an explanation', () => {
    const m = (seq: number, role: 'learner' | 'agent', text: string) => ({ session: 1, seq, role, text })
    const messages = [m(1, 'learner', 'Where do I start with the replay?'), m(1, 'agent', 'EARLIER-EXPLANATION. Want the EARLIER-QUESTION?'),
      m(2, 'learner', 'And the twins?'), m(2, 'agent', 'LATEST-EXPLANATION is here.\nShould I write LATEST-QUESTION for you? More LATEST-EXPLANATION.')]
    for (const turn of [2, 3]) {
      const prompt = learnerTurnPrompt({ notebook: '', task: HALYARD_TASKS[0]!, messages, turn, turns: 3 })
      expect(prompt).toContain('Should I write LATEST-QUESTION for you?')
      expect(prompt).toContain('And the twins?')
      expect(prompt).not.toMatch(/EARLIER-|LATEST-EXPLANATION/)
      expect(prompt).not.toMatch(/LAST message|your reasoning|what the agent just said/)
    }
    // A reply with no question shows that it asked none.
    expect(learnerTurnPrompt({ notebook: '', task: HALYARD_TASKS[0]!, messages: [m(1, 'learner', 'Hi.'), m(1, 'agent', 'LATEST-EXPLANATION.')], turn: 2, turns: 3 })).toContain('(no question)')
  })
})

describe('simulated learner: claim 2 on blind probes (B6)', () => {
  // One probe per learner before session 2, paired with the exam after session 1 for that concept.
  const learners = (truths: number[], reading: (truth: number, i: number) => number, arm = 'off') => truths.map((truth, i) => ({ config: { arm },
    exams: [{ timepoint: 1, total: truth, byConcept: { c: truth }, points: {} }], probes: [{ session: 2, conceptId: 'c', percent: reading(truth, i) }] })) as never
  const truths = [0, 15, 30, 45, 60, 75, 90] // 15 apart: the planted offsets (-4, +6) keep the order

  test('estimates equal an independent computation, and each pre-registered reading is reached', () => {
    const close = blindProbes(learners(truths, (t, i) => t + (i % 2 ? 6 : -4)))
    expect(close.n).toBe(truths.length)
    expect(close.mae).toBeCloseTo(truths.reduce((a, _t, i) => a + (i % 2 ? 6 : 4), 0) / truths.length, 9)
    expect(close.bias).toBeCloseTo(truths.reduce((a, _t, i) => a + (i % 2 ? 6 : -4), 0) / truths.length, 9)
    expect(close.spearman).toBeCloseTo(1, 9)
    expect(close.verdict).toBe('accurate')
    expect(blindProbes(learners(truths, (t) => t + 25)).verdict).toBe('inconclusive')
    expect(blindProbes(learners(truths, (t) => 100 - t)).verdict).toBe('inaccurate')
    expect(blindProbes(learners([], (t) => t)).verdict).toBe('not computable')
    // Review 2, N2: "accurate" must also beat a constant reading at the mean truth. Truths 40..52 (constant MAE about
    // 3.4) read 10 high: MAE 10 <= 20 and a perfect rank order, but a constant does better.
    const tight = blindProbes(learners([40, 42, 44, 46, 48, 50, 52], (t) => t + 10))
    expect(tight.mae).toBeCloseTo(10, 9)
    expect(tight.constantMae).toBeCloseTo(24 / 7, 9)
    expect(tight.verdict).toBe('inconclusive')
    // Review 3, S4: the constant is the median truth (least MAE), not the mean: truths 0,0,0,0,100 give 20, not 32.
    expect(blindProbes(learners([0, 0, 0, 0, 100], (t) => t)).constantMae).toBeCloseTo(20, 9)
  })
  test('a probe with no estimate, or no exam for its concept, is not a pair', () => {
    const data = [...learners([40, 50], () => null as never, 'on'), { config: { arm: 'off' }, exams: [], probes: [{ session: 2, conceptId: 'c', percent: 50 }] }] as never
    expect(blindProbes(data).n).toBe(0)
    // S5: the probes with no estimate are counted by arm, not dropped silently.
    expect(blindProbes(data).noEstimate).toEqual({ on: { probes: 2, none: 2 }, off: { probes: 1, none: 0 } })
  })
})

describe('simulated learner: verdict 2a, grader change-tracking on scheduled probes (revision 10, D.9)', () => {
  // Learner i's probe user read concept a at the probes before session 2 and at the end (session 6): the product's
  // first-to-last change `reported`, se 10, against the exact held-share change between the exams after sessions 1
  // and 5 (20 -> 20 + truth; the session-4 probe read the exam after session 3, 20). A gain notification on the end
  // probe when the change reported is a rise: it beat the session-4 probe.
  const series = (truths: number[], reported: (t: number, i: number) => number) => truths.map((t, i) => {
    const rep = reported(t, i)
    return { config: { arm: i % 2 ? 'on' : 'off', learnerId: `l${i}` },
      exams: [{ timepoint: 1, byConcept: { a: 20 } }, { timepoint: 2, byConcept: { a: 90 } }, { timepoint: 3, byConcept: { a: 20 } }, { timepoint: 5, byConcept: { a: 20 + t } }],
      probes: [{ session: 2, conceptId: 'a', percent: 20, assessmentRunId: `r${i}-2`, at: 2_000 }, { session: 4, conceptId: 'a', percent: 50, assessmentRunId: `r${i}-4`, at: 4_000 },
        { session: 6, conceptId: 'a', percent: 20 + rep, assessmentRunId: `r${i}-6`, at: 6_000 }],
      probeChanges: { concepts: [{ conceptId: 'a', fromAt: 2_000, toAt: 6_000, delta: rep, deltaSe: 10 }] },
      probeNotifications: rep > 0 ? [{ runId: `r${i}-6`, conceptId: 'a', kind: 'gain' }] : [] }
  }) as never
  const truths = Array.from({ length: 30 }, (_, i) => [50, 30, -40][i % 3]!)
  const near = (t: number, i: number) => t + ((i * 7) % 9) - 4

  test('accurate, inaccurate and not computable on planted series; truth is read at the probe times', () => {
    const ok = probeChangeTracking(series(truths, near))
    expect(ok).toMatchObject({ changes: 30, unmatched: 0, sign: { n: 30, agree: 30 }, coverage: { n: 30, covered: 30 }, gains: { n: 20, falseGains: 0, unknown: 0 } })
    expect(ok.spearman.n).toBe(30)
    expect(ok.spearman.lo).toBeGreaterThan(0)
    expect(ok.verdict).toBe('accurate')
    // The truth is the exam after session 5 minus the one after session 1, never the exam after the probe's own session (90).
    expect(probeChangeTracking(series([50], (t) => t)).truths).toEqual([50])
    const wrong = probeChangeTracking(series(truths, (t) => -t))
    expect(wrong.sign).toEqual({ n: 30, agree: 0 })
    expect(wrong.gains.falseGains).toBe(10)
    expect(wrong.verdict).toBe('inaccurate')
    expect(probeChangeTracking(series(truths.slice(0, 10), near)).verdict).toBe('not computable')
    // A change whose ends match no probe of its concept (time or concept) is not paired, and is counted.
    const odd = series([50, 30], near) as unknown as Array<Record<string, any>>
    odd[0]!.probeChanges.concepts[0].fromAt = 3_000
    odd[1]!.probeChanges.concepts[0].conceptId = 'b'
    for (const e of odd[1]!.exams) e.byConcept.b = e.byConcept.a // b has exams, but no probe of b read it
    expect(probeChangeTracking(odd as never)).toMatchObject({ changes: 0, unmatched: 2 })
    // A gain is checked against the probe it beat (the previous one with a reading, session 4), not the first: the exam
    // rose before session 4 and not after, so the end probe's gain is false.
    const early = series([40], (t) => t) as unknown as Array<Record<string, any>>
    early[0]!.exams[2].byConcept.a = 60
    expect(probeChangeTracking(early as never).gains).toEqual({ n: 1, falseGains: 1, unknown: 0 })
    // False gains alone fail 2a: a gain notified for every learner, falling ones included (10 of 30 false).
    const noisy = series(truths, near) as unknown as Array<Record<string, any>>
    for (const [i, d] of noisy.entries()) d.probeNotifications = [{ runId: `r${i}-6`, conceptId: 'a', kind: 'gain' }]
    expect(probeChangeTracking(noisy as never)).toMatchObject({ sign: { n: 30, agree: 30 }, coverage: { n: 30, covered: 30 }, gains: { n: 30, falseGains: 10 }, verdict: 'inaccurate' })
  })

  test('the false-gain filter: only gain notifications count, and an undecidable gain is left out of the verdict', () => {
    // A first_clear is not a gain: one on every learner's session-4 probe (decidable, and its exam did not rise since the
    // session-2 probe, so it would be a false gain if counted) changes nothing.
    const cleared = series(truths, near) as unknown as Array<Record<string, any>>
    for (const [i, d] of cleared.entries()) d.probeNotifications.push({ runId: `r${i}-4`, conceptId: 'a', kind: 'first_clear' })
    expect(probeChangeTracking(cleared as never)).toMatchObject({ gains: { n: 20, falseGains: 0, unknown: 0 }, verdict: 'accurate' })
    // An undecidable gain (a concept no exam scored) is counted as unknown and kept out of the verdict's n: 9 decidable
    // true gains are below the minimum of 10, so 2a is not computable, not accurate.
    const sparse = series(truths, near) as unknown as Array<Record<string, any>>
    let kept = 0
    for (const [i, d] of sparse.entries()) {
      if (d.probeNotifications.length && kept < 9) { kept++; continue }
      d.probeNotifications = [{ runId: `r${i}-6`, conceptId: 'z', kind: 'gain' }]
    }
    expect(probeChangeTracking(sparse as never)).toMatchObject({ gains: { n: 30, falseGains: 0, unknown: 21 }, verdict: 'not computable' })
  })

  test('the sign criterion counts a true change of exactly 25 points, not 24', () => {
    expect(probeChangeTracking(series([25, 24, -25, -24], (t) => t)).sign).toEqual({ n: 2, agree: 2 })
  })

  test('the fourth criterion: Spearman with its learner-bootstrap lower bound, computed from 30 changes', () => {
    // Signs and intervals right, but the reported size runs against the true size: the ranks disagree.
    const planted = series(Array.from({ length: 30 }, (_, i) => 30 + i), (t) => 90 - t) as unknown as Array<Record<string, any>>
    for (const d of planted) d.probeChanges.concepts[0].deltaSe = 50
    const inverted = probeChangeTracking(planted as never)
    expect(inverted).toMatchObject({ sign: { n: 30, agree: 30 }, coverage: { n: 30, covered: 30 }, gains: { n: 30, falseGains: 0 } })
    expect(inverted.spearman.rho).toBeCloseTo(-1, 9)
    expect(inverted.spearman.lo).toBeLessThan(0)
    expect(inverted.verdict).toBe('inaccurate')
    // The interval resamples learners, not changes: 30 changes from one learner give no interval.
    const one = series(truths, near) as unknown as Array<Record<string, any>>
    one[0]!.probeChanges.concepts = one.map((d) => ({ ...d.probeChanges.concepts[0], conceptId: `c${d.config.learnerId}` }))
    one[0]!.probes = one.flatMap((d) => d.probes.map((p: Record<string, unknown>) => ({ ...p, conceptId: `c${d.config.learnerId}` })))
    one[0]!.exams = one[0]!.exams.map((e: { timepoint: number }) => ({ ...e, byConcept: Object.fromEntries(one.map((d) => [`c${d.config.learnerId}`, d.exams.find((x: { timepoint: number }) => x.timepoint === e.timepoint).byConcept.a])) }))
    const pooled = probeChangeTracking([one[0]] as never)
    expect(pooled.spearman.n).toBe(30)
    expect(pooled.spearman.lo).toBeNaN()
    // Two learners of 15 changes: X tracks perfectly, Y runs exactly backwards. A quarter of learner resamples are Y
    // twice (Spearman -1), so the lower bound is -1; resampling changes would almost never draw Y's alone.
    const merged = (ds: Array<Record<string, any>>) => {
      const d = ds[0]!, key = (x: Record<string, any>) => `c${x.config.learnerId}`
      return { ...d, probeChanges: { concepts: ds.map((x) => ({ ...x.probeChanges.concepts[0], conceptId: key(x) })) },
        probes: ds.flatMap((x) => x.probes.map((q: Record<string, unknown>) => ({ ...q, conceptId: key(x) }))), probeNotifications: [],
        exams: d.exams.map((e: { timepoint: number }) => ({ ...e, byConcept: Object.fromEntries(ds.map((x) => [key(x), x.exams.find((y: { timepoint: number }) => y.timepoint === e.timepoint).byConcept.a])) })) }
    }
    const xs = series(Array.from({ length: 15 }, (_, i) => 30 + i), (t) => t) as unknown as Array<Record<string, any>>
    const ys = (series(Array.from({ length: 15 }, (_, i) => 60 + i), (t) => 134 - t) as unknown as Array<Record<string, any>>).map((d) => ({ ...d, config: { ...d.config, learnerId: `y${d.config.learnerId}` } }))
    const split = probeChangeTracking([merged(xs), { ...merged(ys), config: { arm: 'on', learnerId: 'y' } }] as never)
    expect([split.changes, split.learners]).toEqual([30, 2])
    expect(split.spearman.lo).toBeCloseTo(-1, 9)
  })
})

describe('simulated learner: the arm-blind matcher', () => {
  test('every exam fact is found in its own text, and nothing else is', () => {
    for (const f of EXAM_FACTS) expect(factsIn(f.fact)).toEqual([f.id])
  })

  test('a paraphrase with the concept named is found; unrelated text is not', () => {
    expect(factsIn('Under the twin rule, a tessel whose keel key is already in the reach is discarded as a twin.')).toContain('twin-rule-f1')
    expect(factsIn('Alpine cushion plants grow as dense low domes that trap warm air.')).toEqual([])
    // A command answer with a placeholder is given by the command with a real name (the probe's missed mooring-f8).
    expect(factsIn('Retire depot-sync properly with `halyard unmoor depot-sync`.')).toContain('mooring-f8')
  })

  test('redaction: unoffered facts and facts beyond the budget are removed before the learner reads the reply; a repeat is free', () => {
    const a = fact('twin-rule-f1'), b = fact('twin-rule-f5'), c = fact('keel-key-f2')
    const offered = new Set(factSheet(a.conceptId).facts.map((f) => f.id))
    const r = redactReply(`Let me look at the job. ${a.fact} ${b.fact} ${c.fact} So re-sending will not help.`, offered, new Set(), 1)
    expect(r.budgeted).toEqual([a.id])
    expect(r.overBudget).toEqual([b.id])
    expect(r.unoffered).toEqual([c.id])
    expect(r.text).toBe(`Let me look at the job. ${a.fact} ${REDACTED} So re-sending will not help.`)
    // A fact already counted this session costs nothing again.
    expect(redactReply(a.fact, offered, new Set([a.id]), 0)).toMatchObject({ text: a.fact, budgeted: [] })
  })

  test('a claimed fact the matcher misses is placed in its best sentence and verified there; unclaimed, it passes', () => {
    // The pilot's main leak: an agent's paraphrase (here of draft-limit-f7) the lexical matcher does not find.
    const offered = new Set(factSheet(fact('draft-limit-f1').conceptId).facts.map((f) => f.id))
    const paraphrase = 'Billing-v2 is slower than its producers, so whatever cap we choose it fills up in the end; we only postpone it.'
    const reply = `Here is the plan. ${fact('draft-limit-f1').fact} Then we check the logs. ${paraphrase}`
    expect(factsIn(paraphrase)).toEqual([])
    // Unclaimed: the paraphrase reaches the learner and is not counted (the residual the unbudgeted check measures).
    expect(redactReply(reply, offered, new Set(), 1)).toMatchObject({ text: reply, budgeted: ['draft-limit-f1'] })
    // Claimed but not verified (revision 10, design A3: its concept is not named): whatever the budget, that sentence,
    // and only that one, is removed, and the claim is withheld, never counted.
    for (const left of [1, 2]) expect(redactReply(reply, offered, new Set(), left, new Set(['draft-limit-f7']))).toMatchObject({
      text: `Here is the plan. ${fact('draft-limit-f1').fact} Then we check the logs. ${REDACTED}`, budgeted: ['draft-limit-f1'], overBudget: [], attributed: ['draft-limit-f7'], withheld: ['draft-limit-f7'] })
    // A claim the matcher already found is not placed twice.
    expect(redactReply(reply, offered, new Set(), 0, new Set(['draft-limit-f1'])).text).toBe(`Here is the plan. ${REDACTED} Then we check the logs. ${paraphrase}`)

    // Review 7 round 2 nit: a fact redacted over budget in one sentence and budgeted in a later one is not over budget.
    const [f1, f2] = ['draft-limit-f1', 'draft-limit-f3'].map((id) => fact(id).fact)
    const both = `${f1!.replace(/[.]$/, '')}; also ${f2!.charAt(0).toLowerCase()}${f2!.slice(1)}`
    expect(factsBySentence(both)[0]!.facts.sort()).toEqual(['draft-limit-f1', 'draft-limit-f3'])
    expect(redactReply(`${both} ${f1}`, offered, new Set(), 1)).toMatchObject({ text: `${REDACTED} ${f1}`, budgeted: ['draft-limit-f1'], overBudget: ['draft-limit-f3'] })
    // Review 7 S6: a claim whose tokens appear in no sentence cannot be placed; the learner never read it, so it is
    // recorded as withheld (never silently lost).
    const unplaced = redactReply('Here is the plan. Then we check the logs.', offered, new Set(), 2, new Set(['draft-limit-f7']))
    expect(unplaced).toMatchObject({ budgeted: [], attributed: ['draft-limit-f7'], withheld: ['draft-limit-f7'] })
    // Review 6 B2 (mutant M10): pieces that do not end a sentence are joined by a newline, never merged into one line.
    expect(redactReply('Step one\nStep two\nThen we check the logs.', offered, new Set(), 0).text).toBe('Step one\nStep two\nThen we check the logs.')
  })

  test('revision 10 (A3, B4): a claim the matcher missed counts only at 40% of its tokens with the concept named; every delivery records its path', () => {
    const f = fact('refit-f6')
    expect(f.tokens.length).toBe(10)
    const offered = new Set(factSheet(f.conceptId).facts.map((x) => x.id))
    const claim = new Set([f.id])
    // 4 of its 10 content tokens (before, refit, remov, field), "refit" named: verified at 0.4, missed at 0.6.
    const forty = 'Before a refit, think about removing a field.'
    // 2 of 10 (refit, start): verified at 0.2, not at 0.4.
    const twenty = 'A refit can start now.'
    expect(factsIn(forty)).toEqual([])
    expect(factsIn(forty, ATTRIBUTION_THRESHOLD)).toContain(f.id)
    expect(factsIn(twenty, 0.2)).toContain(f.id)
    expect(factsIn(twenty, ATTRIBUTION_THRESHOLD)).not.toContain(f.id)
    expect(ATTRIBUTION_THRESHOLD).toBe(0.4)
    const lead = 'Here is the plan.'
    expect(redactReply(`${lead} ${forty}`, offered, new Set(), 2, claim)).toMatchObject({
      text: `${lead} ${forty}`, budgeted: [f.id], statedFacts: [{ factId: f.id, path: 'attributed' }], withheld: [] })
    // Verified but over budget: redacted as over budget, as before.
    expect(redactReply(`${lead} ${forty}`, offered, new Set(), 0, claim)).toMatchObject({ text: `${lead} ${REDACTED}`, budgeted: [], overBudget: [f.id], withheld: [] })
    expect(redactReply(`${lead} ${twenty}`, offered, new Set(), 2, claim)).toMatchObject({
      text: `${lead} ${REDACTED}`, budgeted: [], statedFacts: [], overBudget: [], withheld: [f.id], redacted: 1 })
    // Found by the matcher: claimed, matched-claimed; unclaimed, matched. Paths come in delivery order.
    const g = fact('refit-f2')
    expect(redactReply(`${f.fact} ${g.fact}`, offered, new Set(), 2, claim).statedFacts).toEqual([{ factId: f.id, path: 'matched-claimed' }, { factId: g.id, path: 'matched' }])
    // The unverified sentence takes the unclaimed fact it also states with it: the learner reads neither.
    const both = redactReply(`${lead} ${g.fact.replace(/[.]$/, '')}, and ${twenty.charAt(0).toLowerCase()}${twenty.slice(1)}`, offered, new Set(), 4, claim)
    expect(both).toMatchObject({ text: `${lead} ${REDACTED}`, budgeted: [], withheld: [f.id] })
  })

  test('review rev10-p2 B1: the record equals what the learner reads; a delivery its text no longer states is withheld, its sentence kept', () => {
    const all = new Set(EXAM_FACTS.map((x) => x.id))
    const [d, s] = ['draft-limit-f1', 'squall-f2'].map((id) => fact(id).fact.replace(/[.]$/, ''))
    // The middle sentence states two facts over a budget of 1 and is redacted; it was the first half of the last
    // sentence's window, which named the concept ("refit") the last sentence's fact needs.
    const lead = `Here is the plan. ${d}, and ${s!.charAt(0).toLowerCase()}${s!.slice(1)} even during a refit.`
    for (const [last, claim, path] of [['Removing a field needs ballast.', ['refit-f6'], 'attributed'],
      ['Removing a field needs new ballast declared by every mooring.', ['refit-f6'], 'matched-claimed'],
      ['Removing a field needs new ballast declared by every mooring.', [], 'matched']] as const) {
      const reply = `${lead} ${last}`
      // Before the redaction, the last sentence's window states refit-f6 on this path.
      expect(redactReply(reply, all, new Set(), 3, new Set(claim)).statedFacts).toContainEqual({ factId: 'refit-f6', path })
      const out = redactReply(reply, all, new Set(), 1, new Set(claim))
      // Review 2 O1: only the unread fact is un-budgeted; the sentence stays, a filler that states no uncounted fact.
      expect(out).toMatchObject({ text: `Here is the plan. ${REDACTED} ${last}`, budgeted: [], statedFacts: [], withheld: [...claim] })
      expect(unread(out.text, [{ factId: 'refit-f6', path }])).toEqual(['refit-f6'])
    }
    // A sentence that also states a fact of its own keeps it: the stated fact is delivered, only the unread one is
    // withheld. The middle sentence is redacted as unoffered here (squall-f2), so the last one fits a budget of 2.
    const offered = new Set([...all].filter((x) => x !== 'squall-f2'))
    const k = fact('keel-key-f2').fact.replace(/[.]$/, '')
    for (const [last, claim, paths] of [[`${k}, and removing a field needs ballast.`, ['refit-f6'], ['matched', 'attributed']],
      [`${k}, and removing a field needs new ballast declared by every mooring.`, ['refit-f6', 'keel-key-f2'], ['matched-claimed', 'matched-claimed']]] as const) {
      const reply = `${lead} ${last}`
      expect(redactReply(reply, all, new Set(), 4, new Set(claim)).statedFacts.slice(2)).toEqual([{ factId: 'keel-key-f2', path: paths[0] }, { factId: 'refit-f6', path: paths[1] }])
      const out = redactReply(reply, offered, new Set(), 2, new Set(claim))
      expect(out).toMatchObject({ text: `Here is the plan. ${REDACTED} ${last}`, budgeted: ['keel-key-f2'], statedFacts: [{ factId: 'keel-key-f2', path: paths[0] }], withheld: ['refit-f6'], unoffered: ['squall-f2'] })
      expect(unread(out.text, out.statedFacts)).toEqual([])
      expect(unread(out.text, [{ factId: 'refit-f6', path: paths[1] }])).toEqual(['refit-f6'])
    }
  })

  test('review rev10-p2 B2: the order of the claim list changes nothing; one claim never moves another', () => {
    const all = new Set(EXAM_FACTS.map((x) => x.id))
    const text = 'Before a refit, think about removing a field, and a refit can start now.'
    const [a, b] = [['refit-f6', 'refit-f2'], ['refit-f2', 'refit-f6']].map((c) => redactReply(text, all, new Set(), 4, new Set(c)))
    expect(a).toEqual(b!)
    // refit-f2 is placed here and fails at 0.4, so the sentence, and the refit-f6 it verifies, are not read.
    expect(a).toMatchObject({ text: REDACTED, budgeted: [], withheld: ['refit-f2', 'refit-f6'] })
    // Placement reads the matcher's facts only, never another claim: keel-key-f3's tokens here are all keel-key-f2's,
    // so it is placed in the sentence keel-key-f2 verifies in and fails there, whichever fact comes first.
    const origin = 'Here is the plan. The origin is a stable business id.'
    expect(redactReply(origin, all, new Set(), 8, new Set(['keel-key-f2'])).statedFacts).toEqual([{ factId: 'keel-key-f2', path: 'attributed' }])
    expect(redactReply(origin, all, new Set(), 8, new Set(['keel-key-f2', 'keel-key-f3']))).toMatchObject({ text: `Here is the plan. ${REDACTED}`, statedFacts: [], withheld: ['keel-key-f3', 'keel-key-f2'] })
  })

  test('revision 10 (A2): every arm and turn is offered every sheet; the reply schema has no lookups', () => {
    expect(SIM_SHEETS).toEqual(HALYARD_CATALOG.concepts.map((c) => c.id).sort())
    const all = SIM_SHEETS.flatMap((id) => factSheet(id).facts.map((f) => f.id))
    expect(all.sort()).toEqual(EXAM_FACTS.map((f) => f.id).sort())
    const schema = REPLY_SCHEMA(all)
    expect(schema.required).toEqual(['reply', 'statedFactIds'])
    expect(Object.keys(schema.properties)).toEqual(['reply', 'statedFactIds'])
    for (const task of HALYARD_TASKS) for (const extra of [null, hook]) {
      const prompt = agentReplyPrompt({ task, messages: [], message: 'Where do I start?', extra, sheets: SIM_SHEETS.map(factSheet), budget: { total: 8, left: 3 } })
      expect([...prompt.matchAll(/- \[([a-z-]+-f\d+)\]/g)].map((m) => m[1]).sort()).toEqual(EXAM_FACTS.map((x) => x.id).sort())
      expect(prompt).not.toContain('lookups')
    }
  })

  test('review 6: a claim the learner never read is withheld, not unaccounted (B1); a redaction never merges fragments into a leak (B2)', () => {
    const f1 = fact('draft-limit-f1'), f2 = fact('squall-f2')
    const offered = new Set(factSheet(f1.conceptId).facts.map((f) => f.id))
    // B1: the claimed, offered f1 shares a sentence with the unoffered squall-f2; the sentence is redacted.
    const joined = `${f1.fact.replace(/\.$/, '')}, and ${f2.fact.charAt(0).toLowerCase()}${f2.fact.slice(1)}`
    const r = redactReply(joined, offered, new Set(), 4, new Set([f1.id]))
    expect(r).toMatchObject({ text: REDACTED, budgeted: [], overBudget: [], unoffered: [f2.id], withheld: [f1.id] })
    const turn = (meta: { statedFactIds: string[]; claimedFactIds: string[]; overBudgetFacts: string[]; withheldFacts?: string[] }, text: string) => ({ config: {}, agentTurns: [{ session: 1, turn: 1, decision: 'none', conceptIds: [], invalidFacts: 0, review: null, unofferedFacts: [], redacted: 1, attributedFacts: [], text, ...meta }] })
    expect(channelIntegrity([turn({ statedFactIds: [], claimedFactIds: [f1.id], overBudgetFacts: [], withheldFacts: r.withheld }, r.text)] as never)).toMatchObject({ claimedUnaccounted: 0, ok: true })
    expect(channelIntegrity([turn({ statedFactIds: [], claimedFactIds: [f1.id], overBudgetFacts: [] }, r.text)] as never)).toMatchObject({ claimedUnaccounted: 1, ok: false })
    // B2: lines without end punctuation around a redacted line. Joined with a space (the old channel), the two kept
    // halves of draft-limit-f1 merge into one sentence that states it; the channel keeps them apart, and a re-match
    // redacts anything a join would still state beyond the record.
    const a = f1, words = a.fact.split(' '), half = Math.floor(words.length / 2)
    const lines = [words.slice(0, half).join(' '), fact('keel-key-f2').fact, words.slice(half).join(' ')]
    const twin = offered
    expect(factsBySentence(lines.join('\n')).flatMap((x) => x.facts)).not.toContain(a.id)
    expect(factsIn(`${lines[0]} ${REDACTED} ${lines[2]}`)).toContain(a.id) // what the old join delivered
    const split = redactReply(lines.join('\n'), twin, new Set(), 0)
    expect(split.unoffered).toEqual(['keel-key-f2'])
    expect(factsBySentence(split.text).flatMap((x) => x.facts)).not.toContain(a.id)
    expect(channelIntegrity([turn({ statedFactIds: split.budgeted, claimedFactIds: [], overBudgetFacts: split.overBudget }, split.text)] as never).ok).toBe(true)
  })
})

describe('simulated learner: memory rules', () => {
  // Revision 10 (design A0, A1): the memory is a rule on delivered fact ids, its draws keyed by pair and fact id.
  const noPrerequisites = { ...HALYARD_GRAPH, prerequisites: () => [] }
  const noForgetting = { ...MEMORY_RULES, forget: { none: 1, slow: 0, medium: 0, fast: 0 } }
  const keys = Array.from({ length: 400 }, (_, i) => `run|fast|pair${i}`)
  const lanes = ['none', 'slow', 'medium', 'fast'] as const
  /** Seeded delivery sequences: 5 sessions of up to 8 exam facts each, every one a fresh draw. */
  const sequences = (n: number) => Array.from({ length: n }, (_, i) => {
    const r = seeded(`sequence${i}`)
    return { lane: lanes[i % 4]!, key: `run|l${i}`, sessions: Array.from({ length: 5 }, () => Array.from({ length: Math.floor(r() * 9) }, () => ({ factId: EXAM_FACTS[Math.floor(r() * EXAM_FACTS.length)]!.id, path: 'matched' as const }))) }
  })

  test('CRN (A0): a pair shares every draw for a fact; a fact only one member got does not perturb the other facts; the key never reads the arm', () => {
    // Member A also gets one extra fact in session 1; on the real graph, A's held set minus that fact equals B's at
    // every session. The rule itself could still let the extra fact move another (it can use capacity ahead of it, or
    // relieve its prerequisite tax), so the test closes both: the extra fact is delivered LAST in session 1 (under
    // skip-and-continue every other uptake is decided before it uses capacity; later it is held, so it costs none) and
    // is from a leaf concept (no concept's prerequisite), and B is never delivered it. What is left is the draws: a key
    // that read anything differing within the pair (the deliveries' length, say) breaks it.
    const leaves = EXAM_FACTS.filter((f) => !HALYARD_EDGES.some(([from]) => from === f.conceptId))
    expect(leaves.length).toBeGreaterThan(0)
    let extraHeld = 0, othersHeld = 0
    for (const [i, { key, sessions }] of sequences(300).entries()) {
      const lane = (['slow', 'medium', 'fast'] as const)[i % 3]!
      const extra = leaves[i % leaves.length]!.id
      const shared = sessions.map((ids) => ids.map((d) => d.factId).filter((id) => id !== extra))
      let a: Held = {}, b: Held = {}
      for (const [s, ids] of shared.entries()) {
        a = updateHeld(a, s === 0 ? [...ids, extra] : ids, lane, key, s + 1).held
        b = updateHeld(b, ids, lane, key, s + 1).held
        const { [extra]: _, ...rest } = a
        expect(rest).toEqual(b)
        if (extra in a) extraHeld++
        if (Object.keys(b).length) othersHeld++
      }
    }
    // Not vacuous: the extra fact is often held, and so are the others.
    expect(extraHeld).toBeGreaterThan(150)
    expect(othersHeld).toBeGreaterThan(750)
    // The key is the pair's (shared by its arms), or the learner's when unpaired; the rule takes no arm at all.
    const c = SimLearnerConfig.parse({ runId: '00000000-0000-4000-8000-000000000001', learnerId: 'l3001', arm: 'on', lane: 'fast', sessions: 5, turns: 3, transport: 'stub',
      learnerModel: { model: 'm', effort: 'low', timeoutSec: 1 }, agentModel: { model: 'm', effort: 'low', timeoutSec: 1 }, heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 8, dayGap: 5, pair: 4 })
    expect(simPairKey(c)).toBe(`${c.runId}|fast|pair4`)
    expect(simPairKey({ ...c, arm: 'off', learnerId: 'l3002' })).toBe(simPairKey(c))
    expect(simPairKey({ ...c, pair: undefined })).toBe(`${c.runId}|l3001`)
  })

  test('capacity: skip-and-continue, in delivery order on canonical sheet length; a new fact that does not fit is over capacity and skipped, a later one that fits is still taken, none truncated', () => {
    // mooring-f1 is 55 characters, tessel-f2 91, becalming-f1 36: in the slow lane's 100, tessel-f2 does not fit after
    // mooring-f1 and is skipped; becalming-f1 then fits (91) and is taken. A held fact delivered again costs nothing.
    // The design's power simulator does the same (rev10sim2.py: `if used+L>cap: continue`).
    const u = updateHeld({ 'beat-f2': 0 }, ['beat-f2', 'mooring-f1', 'tessel-f2', 'becalming-f1'], 'slow', 'k', 1, noPrerequisites, noForgetting)
    expect(u).toMatchObject({ held: { 'beat-f2': 1, 'mooring-f1': 0, 'becalming-f1': 0 }, added: 2, used: 91, overCapacity: 1, strengthened: 1, forgotten: 0, unabsorbed: 0, facts: 3 })
    expect([fact('mooring-f1').fact.length, fact('tessel-f2').fact.length, fact('becalming-f1').fact.length]).toEqual([55, 91, 36])
    // Delivery order decides: tessel-f2 first takes 91 and leaves no room for either shorter fact.
    expect(updateHeld({}, ['tessel-f2', 'mooring-f1', 'becalming-f1'], 'slow', 'k', 1, noPrerequisites, noForgetting)).toMatchObject({ held: { 'tessel-f2': 0 }, used: 91, overCapacity: 2 })
    expect(SIM_LANES.slow.capacity).toBeLessThan(SIM_LANES.medium.capacity)
    expect(SIM_LANES.medium.capacity).toBeLessThan(SIM_LANES.fast.capacity)
  })

  test('absorption: a fact whose concept has a prerequisite with no held fact is kept with probability prerequisiteAbsorb; a held prerequisite fact relieves it, one taken up earlier the same session included', () => {
    expect(HALYARD_GRAPH.prerequisites('halyard-core--beat')).toEqual(['halyard-core--mooring'])
    const kept = keys.filter((key) => 'beat-f1' in updateHeld({}, ['beat-f1'], 'fast', key, 1).held).length
    expect(Math.abs(kept / keys.length - MEMORY_RULES.prerequisiteAbsorb)).toBeLessThan(0.06)
    for (const key of keys) {
      expect('beat-f1' in updateHeld({ 'mooring-f2': 0 }, ['beat-f1'], 'fast', key, 1, HALYARD_GRAPH, noForgetting).held).toBe(true)
      expect('beat-f1' in updateHeld({}, ['mooring-f1', 'beat-f1'], 'fast', key, 1).held).toBe(true)
    }
    // An unabsorbed fact still paid its reading: it used capacity.
    const taxed = updateHeld({}, ['beat-f1'], 'fast', keys.find((key) => !('beat-f1' in updateHeld({}, ['beat-f1'], 'fast', key, 1).held))!, 1)
    expect(taxed).toMatchObject({ unabsorbed: 1, used: fact('beat-f1').fact.length, held: {} })
  })

  test('forgetting and spacing: forget rate per lane, times spacing per session the held fact was delivered again', () => {
    const lost = (strength: number) => keys.concat(keys.map((k) => `${k}b`)).filter((key) => !('tessel-f2' in updateHeld({ 'tessel-f2': strength }, [], 'medium', key, 2).held)).length / (2 * keys.length)
    expect(Math.abs(lost(0) - MEMORY_RULES.forget.medium)).toBeLessThan(0.04)
    expect(Math.abs(lost(1) - MEMORY_RULES.forget.medium * MEMORY_RULES.spacing)).toBeLessThan(0.04)
    // Spacing: a held fact delivered again gains strength; one not delivered keeps its strength.
    expect(updateHeld({ 'tessel-f2': 0 }, ['tessel-f2'], 'medium', 'k', 2, HALYARD_GRAPH, noForgetting).held).toEqual({ 'tessel-f2': 1 })
    expect(updateHeld({ 'tessel-f2': 0 }, ['tessel-f5'], 'medium', 'k', 2, HALYARD_GRAPH, noForgetting).held).toEqual({ 'tessel-f2': 0, 'tessel-f5': 0 })
  })

  test('the exam is computed from the held facts, and no item scores without a delivery up to that session (exam within delivered)', () => {
    expect(heldExam(1, Object.fromEntries(EXAM_FACTS.map((f) => [f.id, 0])))).toMatchObject({ total: 100, items: 100 })
    const twin = EXAM_FACTS.filter((f) => f.conceptId === 'halyard-core--twin-rule')
    expect(twin.length).toBe(2)
    const one = heldExam(2, { [twin[0]!.id]: 0 })
    expect(one.byConcept['halyard-core--twin-rule']).toBe(50)
    expect(one.items).toBeCloseTo(100 / EXAM_FACTS.length, 12)
    expect(one.points[twin[0]!.id]).toBe(2)
    for (const { lane, key, sessions } of sequences(200)) {
      const exams = replayExams(sessions, lane, key)
      for (const [i, e] of exams.entries()) {
        const delivered = new Set(sessions.slice(0, i + 1).flat().map((d) => d.factId))
        expect(Object.entries(e.points).filter(([, p]) => p > 0).every(([id]) => delivered.has(id))).toBe(true)
      }
    }
    expect(renderHeld({ 'mooring-f1': 0, 'beat-f1': 2 })).toBe(`### Beat\n- ${fact('beat-f1').fact}\n\n### Mooring\n- ${fact('mooring-f1').fact}`)
  })

  test('review rev10-p2 R1: a turn with delivered ids but no stored paths is refused for the replay, never read as empty', () => {
    const t = (session: number, turn: number, statedFactIds: string[], statedFacts?: Array<{ factId: string; path: 'matched' }>) => ({ session, turn, statedFactIds, statedFacts })
    const d = (agentTurns: ReturnType<typeof t>[]) => ({ config: { sessions: 2 }, agentTurns }) as never
    const m = (id: string) => ({ factId: id, path: 'matched' as const })
    expect(sessionDeliveries(d([t(2, 1, ['b'], [m('b')]), t(1, 2, ['c'], [m('c')]), t(1, 1, ['a'], [m('a')]), t(2, 2, [])]))).toEqual([[m('a'), m('c')], [m('b')]])
    expect(() => sessionDeliveries(d([t(1, 1, ['a'], [m('a')]), t(2, 1, ['b'])]))).toThrow('cannot be replayed')
  })

  test('replayExams: absorb 1 never lowers an exam; dropping a path no delivery took, or truncating to the delivered counts, changes nothing; a real drop does', () => {
    let raised = 0
    for (const { lane, key, sessions } of sequences(200)) {
      const primary = replayExams(sessions, lane, key)
      const noTax = replayExams(sessions, lane, key, { absorb: 1 })
      for (const [i, e] of primary.entries()) {
        expect(noTax[i]!.items).toBeGreaterThanOrEqual(e.items)
        for (const [c, p] of Object.entries(e.byConcept)) expect(noTax[i]!.byConcept[c]!).toBeGreaterThanOrEqual(p)
        if (noTax[i]!.items > e.items) raised++
      }
      expect(replayExams(sessions, lane, key, { dropPaths: ['attributed'] })).toEqual(primary)
      expect(replayExams(sessions, lane, key, { truncateTo: sessions.map((s) => s.length) })).toEqual(primary)
    }
    expect(raised).toBeGreaterThan(0)
    // Not vacuous: the dropped path and the truncation do remove deliveries.
    const s = [[{ factId: 'mooring-f1', path: 'matched' as const }, { factId: 'mooring-f2', path: 'attributed' as const }]]
    const dropped = replayExams(s, 'fast', 'k', { dropPaths: ['attributed'] })[0]!.points
    expect(Object.keys(dropped).filter((id) => dropped[id])).toEqual(['mooring-f1'])
    expect(replayExams(s, 'fast', 'k', { truncateTo: [1] })[0]!.points['mooring-f2']).toBe(0)
    expect(replayExams(s, 'fast', 'k')[0]!.points['mooring-f2']).toBe(2)
  })

  // Stats review RC3: the K6/cap800 rung, the one pre-declared alternative, is a run parameter with exactly these values.
  test('the K6/cap800 rung: fast budget 8 -> 6 and capacity 400 -> 800, pre-registered, and the replay reads the run\'s capacity', () => {
    expect(SIM_RUNGS).toEqual({ 'K6/cap800': { lane: 'fast', factBudget: 6, capacity: 800 } })
    expect([factBudget('fast'), SIM_LANES.fast.capacity]).toEqual([8, 400])
    const r = SIM_PREREGISTRATION.pilot.rung
    expect({ lane: r.lane, factBudget: r.factBudget, capacity: r.capacity, base: r.base }).toEqual({ lane: 'fast', factBudget: 6, capacity: 800, base: { factBudget: 8, capacity: 400 } })
    expect(r.text).toContain('lane fast, teaching budget 8 → 6 facts per session and notebook capacity 400 → 800 characters; nothing else changes')
    expect([laneCapacity('fast'), laneCapacity('fast', 'K6/cap800'), laneCapacity('none', 'K6/cap800')]).toEqual([400, 800, 0])
    // One session whose deliveries need more than 400 characters and at most 800: the base cuts some, the rung keeps all.
    const ids: string[] = []
    for (const f of EXAM_FACTS) { if (ids.reduce((n, id) => n + EXAM_FACTS.find((x) => x.id === id)!.fact.length, 0) > 400) break; ids.push(f.id) }
    const config = (rung?: 'K6/cap800') => ({ runId: 'r', learnerId: 'l', lane: 'fast', pair: 0, sessions: 1, run: rung ? { rung } : {} })
    const d = (rung?: 'K6/cap800') => ({ config: config(rung), agentTurns: [{ session: 1, turn: 1, statedFactIds: ids, statedFacts: ids.map((factId) => ({ factId, path: 'matched' as const })) }] }) as never
    const held = (rung?: 'K6/cap800') => Object.values(replayedExams(d(rung), { absorb: 1 })[0]!.points).filter((p) => p === 2).length
    expect(held('K6/cap800')).toBe(ids.length)
    expect(held()).toBeLessThan(ids.length)
  })

  // Design C.1 / packet 3: the anchor arm's directive and the simulator's `anchor` policy are one function, `anchorPlan`.
  const id = (c: string) => `halyard-core--${c}`
  const plan = (named: string[], o: { heldOut?: string[]; held?: Held; budgetLeft?: number } = {}) =>
    anchorPlan({ named: named.map(id), heldOut: (o.heldOut ?? []).map(id), held: o.held ?? {}, budgetLeft: o.budgetLeft ?? 99 })
  test('anchorPlan: unheld prerequisites first (at most 2 concepts, 2 facts each, sheet order), then the brief\'s unheld facts, then its held facts', () => {
    // twin-rule <- keel-key <- tessel; overbear <- twin-rule (named, so not a prerequisite here).
    expect(plan(['twin-rule', 'overbear'], { budgetLeft: 8 })).toEqual(['tessel-f2', 'tessel-f5', 'keel-key-f1', 'keel-key-f2', 'twin-rule-f1', 'twin-rule-f5', 'overbear-f1', 'overbear-f2'])
    // A prerequisite with any held fact is met; squall's ancestors come foundations first, and only 2 are taken.
    expect(plan(['twin-rule', 'overbear'], { held: { 'tessel-f8': 0 } })).toEqual(['keel-key-f1', 'keel-key-f2', 'twin-rule-f1', 'twin-rule-f5', 'overbear-f1', 'overbear-f2', 'overbear-f5'])
    expect(plan(['squall', 'overbear']).slice(0, 6)).toEqual(['mooring-f1', 'mooring-f2', 'draft-limit-f1', 'draft-limit-f3', 'squall-f1', 'squall-f2'])
    // A held fact of a brief concept is reviewed last, after every unheld one.
    const review = plan(['twin-rule', 'overbear'], { held: { 'twin-rule-f1': 2, 'tessel-f2': 0 } })
    expect(review.at(-1)).toBe('twin-rule-f1')
    expect(review.indexOf('twin-rule-f5')).toBeLessThan(review.indexOf('overbear-f1'))
  })
  test('anchorPlan: a held-out concept is never planned, as a prerequisite, a brief concept or a review', () => {
    const p = plan(['twin-rule', 'overbear'], { heldOut: ['keel-key', 'overbear'], held: { 'overbear-f1': 0 } })
    expect(p).toEqual(['tessel-f2', 'tessel-f5', 'twin-rule-f1', 'twin-rule-f5'])
    for (const k of [0, 3, 7]) for (const t of HALYARD_TASKS) {
      const heldOut = stratifiedHoldout(k, 'anchor')
      const planned = anchorPlan({ named: t.named, heldOut, held: { 'tessel-f2': 0, 'twin-rule-f1': 0, 'beat-f1': 1 }, budgetLeft: 99 })
      expect(planned.filter((f) => heldOut.includes(HALYARD_GRAPH.conceptOf(f)))).toEqual([])
    }
  })
  test('anchorPlan: a named concept never fills a prerequisite slot, and a held-out brief concept\'s ancestors are not planned', () => {
    // tessel is a foundation ancestor of twin-rule but named: it does not take the first prerequisite slot, so keel-key
    // comes first (a named concept in a slot would plan tessel-f2, tessel-f5 ahead of keel-key).
    expect(plan(['tessel', 'twin-rule'], { budgetLeft: 8 })).toEqual(['keel-key-f1', 'keel-key-f2', 'tessel-f2', 'tessel-f5', 'tessel-f8', 'twin-rule-f1', 'twin-rule-f5'])
    // draft-limit is an ancestor of becalming but named: taught whole as a brief concept (this case alone cannot tell a
    // named concept in the SECOND slot apart, because its first 2 facts dedupe into the same order).
    expect(plan(['draft-limit', 'becalming'], { budgetLeft: 8 })).toEqual(['mooring-f1', 'mooring-f2', 'draft-limit-f1', 'draft-limit-f3', 'draft-limit-f5', 'draft-limit-f7', 'draft-limit-f8', 'becalming-f1'])
    // slack-window held out: its ancestors (tessel, keel-key) do not enter; only beat's (mooring).
    expect(plan(['slack-window', 'beat'], { heldOut: ['slack-window'], budgetLeft: 8 })).toEqual(['mooring-f1', 'mooring-f2', 'beat-f1', 'beat-f2', 'beat-f4', 'beat-f5', 'beat-f7', 'beat-f8'])
    // squall held out: overbear's ancestors (tessel, keel-key), not squall's (mooring, draft-limit).
    expect(plan(['squall', 'overbear'], { heldOut: ['squall'], budgetLeft: 8 })).toEqual(['tessel-f2', 'tessel-f5', 'keel-key-f1', 'keel-key-f2', 'overbear-f1', 'overbear-f2', 'overbear-f5'])
  })
  test('anchorPlan: at most budgetLeft facts (a prefix of the full plan), deterministic, and blind to fact lengths', () => {
    const full = plan(['squall', 'overbear'], { held: { 'squall-f1': 0 } })
    for (let b = 0; b <= full.length + 2; b++) expect(plan(['squall', 'overbear'], { held: { 'squall-f1': 0 }, budgetLeft: b })).toEqual(full.slice(0, b))
    expect(plan(['squall', 'overbear'], { held: { 'squall-f1': 0 } })).toEqual(full)
    // The texts (and so the lengths) permuted across facts: the same plan (review B6d: no length sort).
    const texts = EXAM_FACTS.map((f) => f.fact).reverse()
    const permuted = (c: string) => EXAM_FACTS.map((f, i) => ({ ...f, fact: texts[i]! })).filter((f) => f.conceptId === c)
    for (const t of HALYARD_TASKS) {
      const input = { named: t.named, heldOut: [], held: { 'squall-f1': 0 }, budgetLeft: 8 }
      expect(anchorPlan(input, permuted)).toEqual(anchorPlan(input))
    }
  })
  test('the static prompt is the hook proxy with no readings: the same plan whenever nothing is read; a reading changes the hook\'s', () => {
    for (const k of [0, 1, 5]) for (const t of HALYARD_TASKS) {
      const heldOut = stratifiedHoldout(k, 'static')
      expect(hookPlan(t.named, heldOut, new Map(), 8)).toEqual(staticPlan(t.named, heldOut, 8))
    }
    // overbear's prerequisites within 2 hops: twin-rule (named) and keel-key. A met keel-key (70 >= 60) and an unmet
    // twin-rule (20): the product's selection then takes twin-rule alone, so keel-key's facts leave the plan.
    const named = ['overbear'].map(id), read = new Map([[id('keel-key'), 70], [id('twin-rule'), 20]])
    expect(staticPlan(named, [], 8).slice(0, 5)).toEqual(['keel-key-f1', 'keel-key-f2', 'keel-key-f3', 'keel-key-f4', 'keel-key-f6'])
    expect(hookPlan(named, [], read, 8)).toEqual(['twin-rule-f1', 'twin-rule-f5', 'overbear-f1', 'overbear-f2', 'overbear-f5'])
  })
  test('ceiling: the run\'s own memory rule and every policy; deterministic; anchor beats off; omniscient beats every policy in every lane', () => {
    expect(simulateLearner('anchor', 'medium', 3, 'x')).toEqual(simulateLearner('anchor', 'medium', 3, 'x'))
    for (const r of ceilingTable(['slow', 'fast'], 30)) {
      expect(Object.keys(r.policies).sort()).toEqual(['anchor', 'hook', 'nudge', 'omniscient', 'placebo', 'static'])
      expect(r.policies.anchor!.aucGain).toBeGreaterThan(0)
      for (const p of ['anchor', 'hook', 'static', 'nudge', 'placebo'] as const) expect(r.policies.omniscient!.final).toBeGreaterThan(r.policies[p]!.final)
    }
  })

  test('Williams design: over 10 rows each brief takes each position twice and each ordered pair of briefs is adjacent twice', () => {
    const rows = Array.from({ length: 10 }, (_, k) => williamsRow(k))
    for (let pos = 0; pos < 5; pos++) for (let t = 0; t < 5; t++) expect(rows.filter((r) => r[pos] === t).length).toBe(2)
    const pairs = new Map<string, number>()
    for (const r of rows) for (let i = 1; i < 5; i++) pairs.set(`${r[i - 1]}${r[i]}`, (pairs.get(`${r[i - 1]}${r[i]}`) ?? 0) + 1)
    expect(pairs.size).toBe(20)
    expect(new Set(pairs.values())).toEqual(new Set([2]))
  })
  /**
   * B2: the channel's recall on loose paraphrases, a measurement (never tuned against). `reviewer`: the batch-2
   * reviewer's 24 (terms dropped, numbers spelled out, synonyms, two answers a sentence away from the concept's name);
   * `fresh`: 24 written before any matcher change, one per fact, avoiding the sheet's wording. The lexical matcher
   * stops 4 and 13 of them. Tightening was measured on the 652 batch-1 agent replies instead of on these: a
   * concept-substance rule raised recall to 0.58-0.75 on `fresh` but flagged 10-37% more of the agents' sentences,
   * mostly task talk, so the channel stays as it is. What gets through is bounded where it would bias the primary by
   * the sensitivity versions (design D.6: matcher-only and volume-matched) and the arm-blind judge
   * (learning-sim-analysis.ts). This pins the measured recall.
   */
  test('the channel stops 2 of the reviewer\'s 14 loose paraphrases of scored facts and 12 of 18 fresh ones (B2 recall, measured)', () => {
    const reviewer: Array<[string, string]> = [
      ['draft-limit-f2', 'Out of the box a mooring tolerates sixty-four outstanding unacked events.'],
      ['draft-limit-f2', 'The cap on unacknowledged items is 64 unless you change it.'],
      ['draft-limit-f4', 'Hitting that cap never loses or refuses a message; nothing is thrown away.'],
      ['draft-limit-f5', 'Making the cap bigger just eats more RAM on the consumer side.'],
      ['draft-limit-f7', 'A bigger cap will not speed up how quickly the consumer works through its backlog.'],
      ['slack-window-f1', 'Once superseded, an old version can still be fetched for three more ticks of the logical clock.'],
      ['slack-window-f3', 'Past that grace period, asking for the old version errors out with LAPSED.'],
      ['slack-window-f7', 'If the clock stops advancing, disk usage keeps climbing because old versions are kept around.'],
      ['keel-key-f3', 'Version numbers for a given shipment begin at one.'],
      ['keel-key-f6', 'When two records share a version number they are sorted alphabetically by their shipment id.'],
      ['keel-key-f7', 'The order you receive things in is irrelevant; a straggler may be placed ahead of earlier ones.'],
      ['twin-rule-f6', 'Retrying a send after a timeout is harmless: worst case the duplicate is silently discarded.'],
      ['overbear-f4', 'Consumers that already consumed the first copy never see the replacement.'],
      ['rebraid-f2', 'Jumping ahead two version numbers gets you a GAP error.'],
      ['mooring-f2', 'A consumer that is switched off but still registered keeps holding back the clock for everyone.'],
      ['beat-f1', 'The clock only ticks forward once every registered consumer has acknowledged everything sent before the tick.'],
      ['becalming-f3', 'Producers resume only once the backlog falls under three quarters of the cap.'],
      ['squall-f1', 'If the clock is frozen for over thirty intervals, the stream goes into emergency mode.'],
      ['squall-f6', 'That emergency state does not clear itself; someone has to run halyard clear-squall once the cause is fixed.'],
      ['refit-f2', 'A schema change window lasts no fewer than five ticks.'],
      ['refit-f7', 'Removing a column while some consumer has not declared readiness fails with MOORING_UNREADY.'],
      ['ballast-check-f1', 'Each new version is compared against the shape of the one before it.'],
      // concept named, near-verbatim but split across non-adjacent sentences
      ['draft-limit-f2', 'Let us look at the draft limit. First, check the dashboard. Its default value, by the way, is 64.'],
      ['slack-window-f1', 'About the slack window: we will come back to it. Note the job timing. It lasts 3 beats.'],
    ]
    const fresh: Array<[string, string]> = [
      ['keel-key-f1', 'What identifies a tessel is its keel key, which combines where it came from (the origin) with its epoch.'],
      ['keel-key-f5', 'Inside a reach, tessels are sorted with the epoch taking priority over everything else.'],
      ['draft-limit-f1', 'The draft limit caps how many tessels a mooring can have outstanding without having acked them.'],
      ['draft-limit-f5', 'If you raise the draft limit, the mooring pays for it in RAM.'],
      ['refit-f1', 'Think of a refit as announcing a change to the reach schema: which fields come in and which go away.'],
      ['refit-f5', 'Every mooring states up front the ballast versions it can read.'],
      ['slack-window-f1', 'Once retired, a tessel can still be read for three more beats, no more, no less.'],
      ['slack-window-f5', 'The slack window is measured in beats rather than in seconds on a clock.'],
      ['tessel-f5', 'A reach is basically a stream of tessels that has a name.'],
      ['twin-rule-f1', 'Send a tessel whose keel key is already in the reach and it gets thrown away as a twin.'],
      ['twin-rule-f5', 'Those discarded twins show up in the twins_dropped counter.'],
      ['overbear-f1', 'Setting overbear on a tessel means it overwrites the existing twin rather than getting dropped.'],
      ['overbear-f5', 'Each overbear leaves a record in the audit reach.'],
      ['rebraid-f1', 'If an origin needs its data changed, a rebraid is your one and only option.'],
      ['rebraid-f5', 'A rebraid retires the old epoch; it does not delete it.'],
      ['beat-f1', 'A beat is how a reach keeps logical time.'],
      ['beat-f5', 'A single mooring that stops acking will freeze the beat for the entire reach.'],
      ['mooring-f1', 'A mooring is a durable, registered reader of a reach.'],
      ['mooring-f5', 'Even when a mooring is offline it still holds the beats back.'],
      ['becalming-f1', 'Becalming is the backpressure mechanism in Halyard.'],
      ['becalming-f5', 'When becalmed you will see loft latency go up and becalmed_ms keep climbing.'],
      ['ballast-check-f5', 'If a rebraid changes the set of fields versus the previous epoch, it gets refused with LISTING.'],
      ['squall-f1', 'A squall is the state a reach is in when it has failed.'],
      ['squall-f5', 'During a squall, lofts are refused outright instead of waiting.'],
    ]
    const stopped = (set: Array<[string, string]>) => set.filter(([, text]) => redactReply(text, new Set(), new Set(), 0).redacted > 0).length
    // Revisions 8 and 9 dropped items from the exam and the sheets: only paraphrases of facts still scored are measured
    // (revision 9 dropped ballast-check-f1, which the channel did not stop: 15 -> 14).
    const scored = (set: Array<[string, string]>) => set.filter(([id]) => EXAM_FACTS.some((f) => f.id === id))
    expect([scored(reviewer).length, scored(fresh).length]).toEqual([14, 18])
    expect([stopped(scored(reviewer)), stopped(scored(fresh))]).toEqual([2, 12]) // before revision 8, on all 24 + 24: 4 and 15 (13 before revision 7)
  })
  test('the blind probe asks from the notebook only and names the concept, never a fact (B6)', () => {
    const question = probeQuestion('Slack window')
    const p = probePrompt({ notebook: '### slack window\n- retired tessels stay readable for a while', question })
    expect(question).toContain('Slack window')
    expect(examLeaks(question)).toEqual([])
    expect(p).toContain('ONLY what is in Sam\'s notebook')
    expect(p).toContain('retired tessels stay readable for a while')
    expect(p).toContain(question)
    // No session text and no agent explanation reach the probe: only the notebook and the question.
    expect(p).not.toMatch(/THIS SESSION|agent's latest reply/i)
  })

  test('the echo gate: overlap with the previous 3 agent messages of the session, all and length-matched (B5)', () => {
    const words = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}word`).join(' ')
    const rows = [
      { session: 1, seq: 1, role: 'learner', text: words(30, 'own') },
      { session: 1, seq: 1, role: 'agent', text: words(30, 'tut') },
      // seq 2: Sam copies 15 of the agent's 30 types and adds 15 of his own (0.5); the agent of the SAME seq is later.
      { session: 1, seq: 2, role: 'agent', text: words(30, 'zzz') },
      { session: 1, seq: 2, role: 'learner', text: `${words(15, 'tut')} ${words(15, 'new')}` },
      // A new session: the earlier session's agent text is not a source.
      { session: 2, seq: 1, role: 'learner', text: words(10, 'tut') },
    ]
    const o = learnerOverlaps(rows)
    expect(o).toEqual([{ session: 1, overlap: 0.5, types: 30, introduced: 0.5 }])
    // Revision 7: words Sam already had (the brief, its own earlier messages) are not introduced by the message. With the
    // copied words in the brief, Sam introduces only its 15 new words, none from the agent.
    expect(learnerOverlaps(rows, () => words(15, 'tut'))).toEqual([{ session: 1, overlap: 0.5, types: 30, introduced: 0 }])
    expect(learnerOverlaps([...rows.slice(0, 2), { ...rows[0]!, seq: 2, text: words(30, 'own') }])).toEqual([{ session: 1, overlap: 0, types: 30, introduced: null }])
    type Overlap = { session: number; overlap: number; types: number; introduced?: number | null }
    const data = (overlaps: Overlap[]) => [{ learnerOverlaps: overlaps }] as unknown as Parameters<typeof learnerEcho>[0]
    expect(learnerEcho(data(o)).ok).toBe(false) // introduced mean 0.5 > 0.35
    const low = [...Array.from({ length: 19 }, () => ({ session: 1, overlap: 0.2, types: 30, introduced: 0.2 })), { session: 1, overlap: 0.8, types: 30, introduced: 0.8 }]
    expect(learnerEcho(data(low))).toMatchObject({ ok: true, all: { n: 20, shareHigh: 0.05 } })
    expect(learnerEcho(data([...low, { session: 1, overlap: 0.8, types: 30, introduced: 0.2 }])).ok).toBe(false) // plain overlap >= 0.7 above 5%
    // The mean reads `introduced`, not the plain overlap: a high plain mean from the brief's words passes, a high
    // introduced mean fails, and a message that introduces nothing is not in the mean.
    const branded = learnerEcho(data(low.map((x) => ({ ...x, overlap: Math.min(x.overlap + 0.4, 0.69), introduced: 0.2 }))))
    expect(branded.ok).toBe(true)
    expect(branded.all.mean).toBeCloseTo(0.2, 9)
    expect(branded.all.overlapMean).toBeGreaterThan(0.35)
    expect(learnerEcho(data(low.map((x) => ({ ...x, overlap: 0.2, introduced: 0.5 })))).ok).toBe(false)
    expect(learnerEcho(data([...low, { session: 1, overlap: 0.3, types: 30, introduced: null }])).all.mean).toBeCloseTo(learnerEcho(data(low)).all.mean, 9)
    // No message of 25-50 content types: the length-matched summary cannot be computed, so the gate fails.
    expect(learnerEcho(data(low.map((x) => ({ ...x, types: 60 }))))).toMatchObject({ ok: false, lengthMatched: { n: 0 } })
    expect(learnerEcho(data([])).ok).toBeNull()
  })
})

describe('simulated learner: what can withhold or reveal the primary (revision 10)', () => {
  // Pure fixtures through the real analyzeSimRun. A learner's deliveries are one agent turn per fact, stated in the
  // text the learner read; its stored exams are replayed from them (P1's replayExams), so the versions and the replay
  // identity read the same record a run writes. Arm on (and anchor) delivers the static plan of each session's named
  // concepts, arm off the brief's first 8 facts: a large clean effect (12 pairs: G +6.5, final E_5 +7.0, with the
  // prerequisite rule switched off -2.5). `g` plants a constant item mean on every stored exam instead (looks tests).
  const RUN = '00000000-0000-4000-8000-0000000000a1'
  const m = { model: 'm', effort: 'low', timeoutSec: 1 }
  const ids = HALYARD_FACT_EXAM.map((q) => q.id)
  const factOf = (id: string) => EXAM_FACTS.find((f) => f.id === id)!
  const named = (taskOrder: number[], s: number) => HALYARD_TASKS[taskOrder[s]!]!.named
  const brief = (concepts: readonly string[]) => EXAM_FACTS.filter((f) => concepts.includes(f.conceptId)).map((f) => f.id).slice(0, 8)
  const onPlan = (taskOrder: number[]) => taskOrder.map((_, s) => staticPlan(named(taskOrder, s), [], 8))
  const offPlan = (taskOrder: number[]) => taskOrder.map((_, s) => brief(named(taskOrder, s)))
  type Opts = { pair?: number; plan?: string[][]; path?: (factId: string, k: number) => 'matched' | 'matched-claimed' | 'attributed'; incomplete?: boolean; g?: number
    calls?: Array<{ invocations: number; attempts: number }> }
  let n = 0
  const learner = (arm: string, lane: string, o: Opts = {}) => {
    const taskOrder = williamsRow(o.pair ?? 0).slice(0, 5)
    const config = SimLearnerConfig.parse({ runId: RUN, learnerId: `l${String(++n).padStart(3, '0')}`, arm, lane, sessions: 5, turns: 2, transport: 'stub', learnerModel: m, agentModel: m,
      heldOut: [], taskOrder, factBudget: lane === 'none' ? 0 : 8, dayGap: 5, ...(o.pair === undefined ? {} : { pair: o.pair }) })
    const plan = o.plan ?? (lane === 'none' ? taskOrder.map(() => []) : arm === 'off' ? offPlan(taskOrder) : onPlan(taskOrder))
    const agentTurns = plan.flatMap((facts, s) => facts.map((factId, k) => ({ session: s + 1, turn: k + 1, decision: 'none', conceptIds: [] as string[], statedFactIds: [factId],
      statedFacts: [{ factId, path: o.path?.(factId, k) ?? 'matched' as const }], invalidFacts: 0, review: null, claimedFactIds: [factId], unofferedFacts: [] as string[],
      overBudgetFacts: [] as string[], redacted: 0, text: `Here is the plan. ${factOf(factId).fact}` })))
    const d = { config, userId: `u${n}`, exams: [] as ExamResult[], readings: [], notifications: [], agentTurns, notebooks: [], calls: o.calls ?? [], probes: [], learnerOverlaps: [] } as Record<string, any>
    d.exams = [heldExam(0, {}), ...(o.g === undefined ? replayedExams(d as never) : [1, 2, 3, 4, 5].map((t) => ({ ...heldExam(t, {}), items: o.g! })))]
      .filter((e) => !(o.incomplete && e.timepoint === 5))
    return d
  }
  // The never-learns control (lane none, arm on, budget 0: no delivery) and what Learner reported for it.
  const control = (o: { toast?: boolean; change?: number; aggregate?: [number, number]; calls?: Array<{ invocations: number; attempts: number }> } = {}) => {
    const d = learner('on', 'none', { calls: o.calls })
    if (o.toast) d.notifications = [{ runId: 'r', conceptId: 'c', kind: 'first_clear', percent: 80, delta: null }]
    d.changes = { concepts: o.change === undefined ? [] : [{ conceptId: 'c', fromAt: 0, toAt: 1, delta: o.change, deltaSe: 3, beyondNoise: true }], aggregate: { changeInterval: o.aggregate ?? null } }
    return d
  }
  // The main batch's shape at its first look: fast off 12, on 12, anchor 10 (pairs 0-9); slow off 2; 2 controls.
  const main = (o: { pairs?: number; anchorIncomplete?: number; weakAnchor?: boolean; controls?: unknown[]; on?: Opts } = {}) => [
    ...Array.from({ length: o.pairs ?? 12 }, (_, pair) => learner('off', 'fast', { pair })),
    ...Array.from({ length: o.pairs ?? 12 }, (_, pair) => learner('on', 'fast', { pair, ...o.on })),
    ...Array.from({ length: 10 }, (_, pair) => learner('anchor', 'fast', { pair, incomplete: pair < (o.anchorIncomplete ?? 0), ...(o.weakAnchor ? { plan: offPlan(williamsRow(pair).slice(0, 5)) } : {}) })),
    learner('off', 'slow'), learner('off', 'slow'),
    ...(o.controls ?? [control(), control()]),
  ] as Array<Record<string, any>>
  /** The judge's answers: "no" to every planted false pair, "yes" otherwise (a judge that trusts every delivery). */
  const judgeOf = (data: Array<Record<string, any>>, answer = (kind: string) => kind === 'planted-false' ? 'no' : 'yes') =>
    judgeSample(RUN, (data as never as SimLearnerData[]).filter((d) => d.config.lane !== 'none')).items.map((x) => answer(x.kind))
  const verified = { integrity: { ok: true, detail: 'fixture' } }
  const run = (data: unknown, o: Parameters<typeof analyzeSimRun>[1] = {}) => analyzeSimRun(data as never, { ...verified, ...o })
  const judged = (data: Array<Record<string, any>>, o: Parameters<typeof analyzeSimRun>[1] = {}) => run(data, { judge: judgeOf(data), ...o })

  test('the planted supported fixture: verdict, its sentence, version (i) beside the primary, the decomposition and the replay identity', () => {
    const data = main(), r = judged(data), o = r.outcome!
    expect(r.sequential!.decisions.map((l) => l.decision)).toEqual(['efficacy'])
    expect(o.primary.pairs).toBe(12)
    // Exact on this fixture (G moves in steps of 1/36 over 12 pairs): primary +218/36, final E_5 +260/36, rule off -78/36.
    expect(o.primary.mean).toBeCloseTo(218 / 36, 9)
    expect(o.final.mean).toBeCloseTo(260 / 36, 9)
    expect(o.ruleOff.mean).toBeCloseTo(-78 / 36, 9)
    expect([o.reading, o.verdict, o.fired]).toEqual(['supported', 'supported', []])
    // Every delivery is matched: version (i) is the primary. The static plan delivers fewer than 8 in some sessions, so
    // version (ii) truncates off there and differs, but keeps the effect.
    expect(o.matcherOnly).toEqual(o.primary)
    expect(o.volumeMatched.mean).not.toBe(o.primary.mean)
    expect(o.volumeMatched.lo).toBeGreaterThan(0)
    // Stats review RC5 (R14): (ii) cuts BOTH learners of a pair to the smaller count. Here off delivers more and is cut
    // (+198/36, not the primary's +218/36); with the arms swapped on delivers more and is cut, the mirror image.
    expect(o.volumeMatched.mean).toBeCloseTo(198 / 36, 9)
    const swapped = data.map((d) => (d.config.lane === 'fast' && ['on', 'off'].includes(d.config.arm) ? { ...d, config: { ...d.config, arm: d.config.arm === 'on' ? 'off' : 'on' } } : d))
    const mirror = judged(swapped).outcome!
    expect([mirror.primary.mean, mirror.volumeMatched.mean].map((x) => +(x * 36).toFixed(6))).toEqual([-218, -198])
    expect(o.replayIdentity).toEqual({ learners: 24, reproduced: 24 })
    expect(o.anchorCheck.pairs).toBe(10)
    expect(o.anchorCheck.lo90).toBeGreaterThan(0)
    expect(o.judge!.withheld).toEqual([])
    const s = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`
    expect(o.sentence).toBe(`Learner's live hook, in its shipped default configuration (not a tuned configuration), changed the agent's teaching in a way this fixed memory model (which taxes facts whose direct prerequisite is unheld) rewards: ${s(o.primary.mean)} [95% CI ${s(o.primary.lo)}, ${s(o.primary.hi)}] AUC points; ${s(o.ruleOff.mean)} points remain when the prerequisite rule is switched off on the same deliveries (D.7). This design cannot attribute any of it to Learner's mastery readings.`)
    const text = renderSimReport('r', r)
    expect(text).toContain(`**${o.sentence}**`)
    expect(text).toContain('Version (i) matcher-only beside the primary (N4): ')
    expect(text).toContain('signed difference (i) minus primary +0.00')
    expect(text).toContain('Withhold rules that fired (N3; a "supported" would be withheld by the first group): 0 — none.')
    expect(text).toContain(`Replay identity: 24 of 24 learners' stored exams reproduced by replaying their deliveries.`)
    expect(text).toContain('- One operator, one start: a run id is started once')
    // The lead's item (b): P5's probe guarantee, pre-registered in these words.
    expect(text).toContain('one uniform draw per pair and probe key; each learner takes that quantile of its own delivered concepts; the same rank only when the two learners\' sets have the same size.')
    // P4 (lead's decision): the shipped label is not changed; its contradiction is pre-registered and printed.
    expect(text).toContain(`> ${SIM_PREREGISTRATION.labelContradiction}`)
    expect(text).toContain(SIM_PREREGISTRATION.primary.sequential.capFloor.text)
    expect(SIM_PREREGISTRATION.labelContradiction).toContain('PREREQUISITE_EXPERIMENT_LABEL')
    // P6's notes: the judge's mechanics and its failure rule, pre-registered.
    expect(text).toContain('- Judge mechanics: ')
    for (const part of ['`${runId}|judge`', 'canonical order (learner id, session, turn, delivery order)', 'only from the same arm\'s matcher stratum', 'judgePrompt', 'the run\'s agent model', '`judge:<i>`', 'A final judge failure is unanswered and fires "judge incomplete"', 'never makes an item final', 'clustered by learner'])
      expect(text).toContain(part)
    expect(text).not.toContain('### Pilot gates')
    // A stored exam the deliveries do not reproduce is counted (reported, not gated).
    data[12]!.exams[3] = { ...data[12]!.exams[3], points: { ...data[12]!.exams[3].points, [ids[0]!]: 1 } }
    expect(judged(data).outcome!.replayIdentity).toEqual({ learners: 24, reproduced: 23 })
    // The judge not run: a supported reading is withheld.
    const blind = run(main()).outcome!
    expect([blind.reading, blind.verdict]).toEqual(['supported', 'withheld (judge: not run)'])
    expect(renderSimReport('r', run(main()))).toContain('Judge: not run.')
  })

  test('version (i) drops the attributed deliveries; a supported resting on them is withheld (N4: its signed difference is printed)', () => {
    // Half of arm on's deliveries arrive by attribution only: without them on keeps half its plan.
    const data = main({ on: { path: (_, k) => (k % 2 ? 'attributed' : 'matched') } }), o = judged(data).outcome!
    expect(o.reading).toBe('supported')
    expect(o.matcherOnly.mean).toBeLessThan(o.primary.mean)
    expect(o.matcherOnly.lo).toBeLessThanOrEqual(0)
    expect(o.verdict).toBe('withheld (sensitivity version (i) matcher-only: 95% lower bound ≤ 0)')
    expect(renderSimReport('r', judged(data))).toContain(`signed difference (i) minus primary ${(o.matcherOnly.mean - o.primary.mean).toFixed(2)}`)
  })

  test('cells outside the primary (anchor, slow) never withhold its verdict; the in-batch anchor check reads pairs 0-9', () => {
    const lost = judged(main({ anchorIncomplete: 2 }))
    expect(lost.checks.incompletionOk).toBe(true)
    expect(lost.outcome!.verdict).toBe('supported')
    expect(lost.outcome!.anchorCheck.pairs).toBe(8)
    // An anchor no better than off: the check fails, but it overrides only a null reading, never a supported one.
    const weak = judged(main({ weakAnchor: true })).outcome!
    expect(weak.anchorCheck.lo90).toBeNaN() // the same deliveries as off: every difference 0, no interval
    expect(weak.verdict).toBe('supported')
    expect(weak.fired).toEqual(['in-batch anchor check: 90% lower bound ≤ 0 or not computable'])
  })

  // Planted estimates through the pure verdict: no fixture can steer a lower bound to a boundary as exactly.
  const e = (mean: number, lo: number, hi: number, lo90 = lo, hi90 = hi): PairedEstimate => ({ pairs: 36, lanes: 1, mean, se: 1, df: 35, t: mean, p: 0.5, lo, hi, lo90, hi90 })
  const good = { decision: 'efficacy' as const, primary: e(5, 2, 8), final: e(3, 1, 5), matcherOnly: e(4, 1, 7), volumeMatched: e(4, 1, 7), judge: [] as string[] | null, anchorCheck: e(5, 1, 9, 2, 8), failedChecks: [] as string[] }
  const nullRun = { ...good, decision: 'futility' as const, primary: e(0.5, -1.5, 1.8, -1.2, 1.5), matcherOnly: e(0.4, -1.6, 1.9, -1.3, 1.6), volumeMatched: e(0.3, -1.7, 1.9, -1.4, 1.6) }
  test('simVerdict: supported, the gatekeeper, no effect, harm, inconclusive and the anchor override, from planted estimates', () => {
    expect(simVerdict(good)).toEqual({ reading: 'supported', verdict: 'supported', fired: [] })
    // The gatekeeper: faster early but the final exam not non-inferior (mean ≥ 0 and a 95% lower bound > -2, both).
    for (const final of [e(-3, -6, 0), e(0.5, -2, 3), e(-0.1, -1, 1)]) expect(simVerdict({ ...good, final }).reading).toBe(SIM_READINGS.gatekept)
    expect(simVerdict({ ...good, final: e(0, -1.99, 2) }).reading).toBe('supported')
    // A gatekept efficacy stop is not a null reading: the anchor check does not override it.
    expect(simVerdict({ ...good, final: e(-3, -6, 0), anchorCheck: e(0, -1, 1) }).verdict).toBe(SIM_READINGS.gatekept)
    expect(simVerdict(nullRun).verdict).toBe('no effect of 2 points or more')
    // N1: "no effect" needs versions (i) and (ii) within ±2 at 90% too; version (ii) reaching -2.5 disagrees.
    expect(simVerdict({ ...nullRun, volumeMatched: e(-0.5, -3, 1.5, -2.5, 1.2) }).verdict).toBe(SIM_READINGS.versionsDisagree)
    expect(simVerdict({ ...nullRun, matcherOnly: e(0.5, -1.5, 2.6, -1.2, 2.1) }).verdict).toBe(SIM_READINGS.versionsDisagree)
    expect(simVerdict({ ...nullRun, primary: e(0.5, -2.5, 2.4, -2.1, 1.9) }).verdict).toBe('inconclusive (stopped for futility)')
    expect(simVerdict({ ...nullRun, decision: 'final', primary: e(1, -1, 3, -0.5, 2.5) }).verdict).toBe('inconclusive')
    expect(simVerdict({ ...nullRun, primary: e(NaN, NaN, NaN) }).verdict).toBe('inconclusive (too few pairs)')
    expect(simVerdict({ ...nullRun, decision: 'final', primary: e(-4, -7, -1) }).verdict).toBe('harm shown')
    // The in-batch anchor check overrides a null reading (and only a null one): 90% lower bound must be above 0.
    const blindAnchor = { anchorCheck: e(1, -0.5, 2.5, 0, 2) }
    expect(simVerdict({ ...nullRun, ...blindAnchor }).verdict).toBe(SIM_READINGS.anchorNotConfirmed)
    expect(simVerdict({ ...nullRun, anchorCheck: e(NaN, NaN, NaN) }).verdict).toBe(SIM_READINGS.anchorNotConfirmed)
    expect(simVerdict({ ...nullRun, decision: 'final', primary: e(-4, -7, -1), ...blindAnchor }).verdict).toBe('harm shown')
    expect(simVerdict({ ...good, ...blindAnchor }).verdict).toBe('supported')
    // Stats review RC5: which interval each rule reads. "No effect" reads the 90% interval (R03): within ±2 at 90%
    // but not at 95% is still no effect. The anchor check reads the 90% lower bound (R06): above 0 at 90%, below at
    // 95%, confirmed.
    const narrow90 = e(0.2, -2.3, 2.3, -1.9, 1.9)
    expect(simVerdict({ ...nullRun, decision: 'final', primary: narrow90, matcherOnly: narrow90, volumeMatched: narrow90 }).verdict).toBe('no effect of 2 points or more')
    const anchor90 = { anchorCheck: e(1, -0.2, 2.2, 0.3, 1.7) }
    const confirmed = simVerdict({ ...nullRun, primary: e(0.5, -2.5, 2.4, -2.1, 1.9), ...anchor90 })
    expect(confirmed.reading).toBe('inconclusive (stopped for futility)')
    expect(confirmed.fired.filter((x) => x.startsWith('in-batch anchor'))).toEqual([])
    // O1: too few pairs stays "too few pairs" when the anchor check is not computable either; the check is still listed.
    const tooFew = simVerdict({ ...nullRun, primary: e(NaN, NaN, NaN), anchorCheck: e(NaN, NaN, NaN) })
    expect(tooFew.verdict).toBe('inconclusive (too few pairs)')
    expect(tooFew.fired).toContain('in-batch anchor check: 90% lower bound ≤ 0 or not computable')
  })

  test('simVerdict: what withholds a supported, and N3: every rule that fired is listed even on a null reading', () => {
    const w = (x: Partial<typeof good>) => simVerdict({ ...good, ...x }).verdict
    expect(w({ matcherOnly: e(4, 0, 7) })).toBe('withheld (sensitivity version (i) matcher-only: 95% lower bound ≤ 0)')
    // Stats review RC5 (R08): the withhold reads the 95% lower bound, not the 90% one.
    expect(w({ matcherOnly: e(4, -0.1, 7, 0.3, 6.5) })).toBe('withheld (sensitivity version (i) matcher-only: 95% lower bound ≤ 0)')
    expect(w({ volumeMatched: e(4, -0.1, 7, 0.3, 6.5) })).toBe('withheld (sensitivity version (ii) volume-matched: 95% lower bound ≤ 0)')
    expect(w({ volumeMatched: e(NaN, NaN, NaN) })).toBe('withheld (sensitivity version (ii) volume-matched: 95% lower bound not computable)')
    expect(w({ judge: null })).toBe('withheld (judge: not run)')
    expect(w({ judge: ['judge untrusted: yes to more than 2 of 6 planted false pairs'] })).toBe('withheld (judge untrusted: yes to more than 2 of 6 planted false pairs)')
    expect(w({ judge: ['judge untrusted: no to more than 2 of 6 planted true pairs'] })).toBe('withheld (judge untrusted: no to more than 2 of 6 planted true pairs)')
    // A failed check withholds whatever the reading, and alone (its own list).
    expect(w({ failedChecks: ['frozen code and spec: failed'], judge: null })).toBe('withheld (frozen code and spec: failed)')
    expect(simVerdict({ ...nullRun, failedChecks: ['incompletion balanced: failed'] }).verdict).toBe('withheld (incompletion balanced: failed)')
    // N3: a null reading still lists what would have withheld a supported.
    const fired = simVerdict({ ...nullRun, matcherOnly: e(0.4, -1.6, 1.9, -1.3, 1.6), judge: null, anchorCheck: e(1, -0.5, 2.5, 0, 2), failedChecks: ['x: failed'] })
    expect(fired.reading).toBe(SIM_READINGS.anchorNotConfirmed)
    expect(fired.fired).toEqual(['sensitivity version (i) matcher-only: 95% lower bound ≤ 0', 'sensitivity version (ii) volume-matched: 95% lower bound ≤ 0', 'judge: not run',
      'in-batch anchor check: 90% lower bound ≤ 0 or not computable', 'x: failed'])
  })

  test('the verdict sentence: its fixed qualifier and configuration name, pinned', () => {
    expect(verdictSentence('no effect of 2 points or more', e(0, -1, 1), e(0, -1, 1)))
      .toBe('Learner\'s live hook, in its shipped default configuration (not a tuned configuration): no effect of 2 points or more.')
    expect(verdictSentence('supported', e(6.534, 4.1, 8.966), e(-2.5, -4, -1)))
      .toBe('Learner\'s live hook, in its shipped default configuration (not a tuned configuration), changed the agent\'s teaching in a way this fixed memory model (which taxes facts whose direct prerequisite is unheld) rewards: +6.53 [95% CI +4.10, +8.97] AUC points; -2.50 points remain when the prerequisite rule is switched off on the same deliveries (D.7). This design cannot attribute any of it to Learner\'s mastery readings.')
  })

  test('the judge in the analysis: a judge that distrusts arm on, or fails its planted pairs, withholds the supported', () => {
    const data = main()
    const sample = judgeSample(RUN, (data as never as SimLearnerData[]).filter((d) => d.config.lane !== 'none'))
    const answers = (f: (x: (typeof sample.items)[number]) => string | null) => sample.items.map(f)
    const on = run(data, { judge: answers((x) => x.kind === 'planted-false' ? 'no' : x.kind === 'delivery' && x.arm === 'on' ? 'no' : 'yes') }).outcome!
    expect(on.verdict).toBe('withheld (judge: on false-delivery share above off)')
    const gullible = run(data, { judge: answers((x) => 'yes') }).outcome!
    expect(gullible.verdict).toBe('withheld (judge untrusted: yes to more than 2 of 6 planted false pairs)')
    const missing = run(data, { judge: answers((x) => x.index === 0 ? null : x.kind === 'planted-false' ? 'no' : 'yes') }).outcome!
    expect(missing.verdict).toBe(`withheld (judge incomplete: 1 of ${sample.items.length} items unanswered)`)
  })

  test('revision 8: the pilot gate on the channel itself (re-review 5 point 2)', () => {
    const d = () => learner('off', 'fast', { pair: 0 }), turns = d().agentTurns.length
    const first = d().agentTurns[0], spare = ids.find((id) => !d().agentTurns.filter((t: { session: number }) => t.session === 1).some((t: { statedFactIds: string[] }) => t.statedFactIds.includes(id)))!
    expect(channelIntegrity([d()] as never)).toMatchObject({ turns, claimedUnaccounted: 0, overBudgetKept: 0, ok: true })
    // A claim neither budgeted nor redacted over budget.
    const lost = d(); lost.agentTurns[0].claimedFactIds = [first.statedFactIds[0], spare]
    expect(channelIntegrity([lost] as never)).toMatchObject({ claimedUnaccounted: 1, ok: false })
    // Redacted over budget: accounted. Restated later in the same session: free, accounted.
    const over = d(); over.agentTurns[0].claimedFactIds = [first.statedFactIds[0], spare]; over.agentTurns[0].overBudgetFacts = [spare]
    expect(channelIntegrity([over] as never).ok).toBe(true)
    const again = d(); again.agentTurns.push({ ...again.agentTurns[0], turn: 99, statedFactIds: [], statedFacts: [], claimedFactIds: [first.statedFactIds[0]] })
    expect(channelIntegrity([again] as never)).toMatchObject({ turns: turns + 1, ok: true })
    // An over-budget fact still in the text the learner read.
    const kept = d(); kept.agentTurns[0].overBudgetFacts = [spare]; kept.agentTurns[0].claimedFactIds = [first.statedFactIds[0], spare]; kept.agentTurns[0].text = `${kept.agentTurns[0].text} ${factOf(spare).fact}`
    expect(channelIntegrity([kept] as never)).toMatchObject({ overBudgetKept: 1, ok: false })
    // A turn without its text cannot be checked: the gate fails as not computable.
    const blind = d(); delete blind.agentTurns[1].text
    expect(channelIntegrity([blind] as never).ok).toBeNull()
    expect(channelIntegrity([]).ok).toBeNull()
    // In the report: every learner, controls included, and a failed channel withholds the verdict.
    const leakyControl = control(); leakyControl.agentTurns = [{ ...first, claimedFactIds: [spare], statedFactIds: [], statedFacts: [] }]
    const leaky = judged(main({ controls: [leakyControl, control()] }))
    expect(leaky.gates.channel).toMatchObject({ claimedUnaccounted: 1, ok: false })
    expect(leaky.outcome!.verdict).toBe('withheld (the channel gate on every learner: failed)')
  })

  test('revision 8: interim looks return no between-arm number until the sequence stops; a look waits for its pairs', () => {
    // A small planted effect in matched pairs (G +2, -1, +1, 0, 0 in turn): continue at 12 and 24 pairs.
    const sequence = (pairs: number) => [
      ...Array.from({ length: pairs }, (_, pair) => learner('off', 'fast', { pair, g: 20 })),
      ...Array.from({ length: pairs }, (_, pair) => learner('on', 'fast', { pair, g: 20 + [2, -1, 1, 0, 0][pair % 5]! })),
      learner('off', 'slow'), learner('off', 'slow'), control(), control(),
    ]
    const one = run(sequence(12)), two = run(sequence(24))
    expect(one.sequential!.decisions.map((l) => l.decision)).toEqual(['continue'])
    expect(two.sequential!.decisions.map((l) => l.decision)).toEqual(['continue', 'continue'])
    for (const r of [one, two]) {
      expect(r.outcome).toBeNull()
      expect(r.claim2).toBeNull()
      expect(r.sequential!.detail).toBeNull()
      // The exam-derived mechanism columns are pooled over arms while the sequence runs.
      expect(r.mechanism.on!.alreadyRightShare).toBe(r.mechanism.off!.alreadyRightShare)
      expect(JSON.stringify(r.sequential)).not.toContain('"mean"')
    }
    const three = run(sequence(36))
    // At 36 pairs the sequence ends whatever the data: the outcome appears, read on all 36 pairs.
    expect(three.outcome!.stoppedAt).toBe(3)
    expect(three.outcome!.primary.pairs).toBe(36)
    expect(three.outcome!.primary.mean).toBeCloseTo(16 / 36, 9) // 7 full cycles (+2 each) and pair 35's +2
    expect(three.sequential!.decisions.map((l) => l.decision)).toEqual(['continue', 'continue', 'efficacy'])
    expect(three.outcome!.reading).toBe('supported')
    expect(three.sequential!.detail).toHaveLength(3)
    // 18 pairs: only the first look is due. 36 present but only 12 ended (a resumed runner, --analyze-only mid-block):
    // look 2 is not read off the half-run block, and nothing between-arm is returned.
    expect(run(sequence(18)).sequential!.decisions).toHaveLength(1)
    const midBlock = run(sequence(36), { endedPairs: 12 })
    expect(midBlock.sequential!.decisions.map((l) => l.decision)).toEqual(['continue'])
    expect(midBlock.outcome).toBeNull()
    // Review 7 round 2 nit: stopped by a failed check at a look that said "continue": the report says it stopped.
    const checkStop = run(sequence(12), { stoppedBy: 'a pre-registered check failed at look 1' })
    expect(checkStop.outcome).toBeNull()
    expect(renderSimReport('r', checkStop)).toContain('The batch stopped (a pre-registered check failed at look 1); the verdict is withheld.')
    expect(renderSimReport('r', one)).toContain('The sequence has not stopped.')
    // A large effect stops at the first look, and the estimate is read on its 12 pairs (pair < 12, review 7 S6).
    const big = judged(main())
    expect(big.sequential!.decisions.map((l) => l.decision)).toEqual(['efficacy'])
    expect(big.outcome!.primary.pairs).toBe(12)
    expect(big.sequential!.detail![0]!.estimate.pairs).toBe(12)
  })

  test('revision 8.5 (review 10 B1, S2): the run record lives in every learner\'s config in the database', () => {
    const ids = HALYARD_CATALOG.concepts.map((c) => c.id), m = { model: 'm', effort: 'low', timeoutSec: 1 }
    const run = { commit: 'abc', maxCalls: 6000, gradingReplicates: 2, sequential: true, arms: ['on', 'off'], lanes: ['slow'], perArm: { slow: { on: 2, off: 2 } }, looks: [...SIM_PREREGISTRATION.primary.sequential.looks], prereg: SIM_PREREGISTRATION_HASH }
    const config = (learnerId: string, r: Record<string, unknown> | null = run) => SimLearnerConfig.parse({ runId: '00000000-0000-4000-8000-000000000009', learnerId, arm: 'on', lane: 'slow', sessions: 5, turns: 3,
      transport: 'codex', learnerModel: m, agentModel: m, heldOut: ids.slice(0, 3), taskOrder: [2, 3, 4, 0, 1], factBudget: 2, dayGap: 5, ...(r ? { run: r } : {}) })
    const data = ['l1001', 'l1002'].map((id) => ({ config: config(id) }))
    const check = (d: Array<{ config: SimLearnerConfig }>, o: Partial<{ stub: boolean; changed: string[]; unreadable: string }> = {}) => simRecordIntegrity(d, { stub: false, changed: [], head: 'abc', ...o }).ok
    expect(simRunRecord(data.map((d) => d.config))).toEqual(run)
    expect(check(data)).toBe(true)
    expect(check(data, { changed: ['x.ts'] })).toBe(false)
    // Stats review RC2: the integrity line prints the recorded pre-registration hash; a real run recorded with another fails.
    expect(simRecordIntegrity(data, { stub: false, changed: [], head: 'abc' }).detail).toContain(`pre-registration sha256 ${SIM_PREREGISTRATION_HASH}`)
    const other = ['l1001', 'l1002'].map((id) => ({ config: config(id, { ...run, prereg: 'e'.repeat(64) }) }))
    expect(check(other)).toBe(false)
    expect(check(other, { stub: true })).toBe(true)
    expect(simRecordIntegrity(other, { stub: false, changed: [], head: 'abc' }).detail).toContain(`pre-registration sha256 ${'e'.repeat(64)}, not this code's ${SIM_PREREGISTRATION_HASH}`)
    // Review RC1: a frozen tree git cannot compare with the record fails integrity, with no file listed.
    expect(check(data, { unreadable: 'commit abc is not in this checkout' })).toBe(false)
    expect(simRecordIntegrity(data, { stub: false, changed: [], unreadable: 'commit abc is not in this checkout', head: 'abc' }).detail).toContain('the frozen tree cannot be checked: commit abc is not in this checkout')
    expect(check([data[0]!, { config: config('l1002', { ...run, maxCalls: 6001 }) }])).toBe(false) // learners that disagree
    expect(check([data[0]!, { config: config('l1002', null) }])).toBe(false) // one learner without a record
    expect(check([])).toBe(false) // nothing recorded fails closed
    const moved = ['l1001', 'l1002'].map((id) => ({ config: config(id, { ...run, looks: [3, 4, 5] }) }))
    expect(check(moved)).toBe(false) // a real record with moved looks
    expect(check(moved, { stub: true })).toBe(true) // a stub run's own looks
    // A start or resume: every stored learner must equal this invocation's, the record included (B1: maxCalls pinned).
    const now = data.map((d) => d.config)
    expect(simRunDifferences(now, now)).toEqual([])
    expect(simRunDifferences([config('l1001', { ...run, perArm: { slow: { off: 2, on: 2 } } })], now)).toEqual([]) // key order (jsonb) is not a difference
    expect(simRunDifferences([config('l1001', { ...run, maxCalls: 7 })], now)).toEqual(['run.maxCalls'])
    expect(simRunDifferences([config('l1001', null)], now)).toEqual(['run'])
    expect(simRunDifferences([{ ...config('l1001'), turns: 2 }], now)).toEqual(['turns'])
    expect(simRunDifferences([config('l9999')], now)).toEqual(['learners'])
    expect(simRunDifferences([], now)).toEqual([])
  })

  test('review 10 S5 (X1): a stub process takes only stub learners, a real one only codex learners', () => {
    expect(simTransportRefusal([], false)).toBeNull()
    expect(simTransportRefusal([], true)).toBeNull()
    expect(simTransportRefusal(['codex'], false)).toBeNull()
    expect(simTransportRefusal(['stub'], true)).toBeNull()
    expect(simTransportRefusal(['stub'], false)).toContain('has stub learners')
    expect(simTransportRefusal(['codex'], true)).toContain('has codex learners')
    expect(simTransportRefusal(['codex', 'stub'], false)).toContain('has stub learners')
  })

  test('revision 8.4: arm on has ≥ 2 graded sessions, every grading settled (one completed), and a reading from session 2 on', () => {
    const grade = (session: number, o: { percent?: number | null; status?: string } = {}) =>
      ({ session, conceptId: 'c', percent: o.percent === undefined ? 40 : o.percent, confidence: null, assessmentRunId: 'a', status: o.status ?? 'completed' })
    // Pilot db59766b's shape: session 1 graded, the grader abstaining (null); sessions 2-4 with a reading.
    const base = main()
    const data = (s1: Array<ReturnType<typeof grade>>, later = [2, 3, 4].map((s) => grade(s)), sessions = 5, replicates: Array<{ session: number; status: string }> = []) => base
      .map((d) => d.config.arm === 'on' ? { ...d, config: { ...d.config, sessions }, readings: [...s1, ...later].filter((r) => r.session < sessions), replicates } : d)
    const report = (x: unknown) => run(x)
    const gate = (x: unknown) => report(x).gates.onReadings
    expect(gate(data([grade(1, { percent: null })]))).toBe(true)
    expect(gate(data([]))).toBe(true) // N4: every session-1 concept skipped for no evidence: nothing lost
    expect(gate(data([grade(1, { percent: null })], [grade(2)], 3))).toBe(true)
    expect(gate(data([grade(1)], [], 2))).toBe(null) // S1: one graded session cannot show part (b)
    expect(gate(data([], [], 1))).toBe(null)
    // S2: every recorded grading must settle; a failed one settles and is reported, a pending or refused one fails.
    const failed = data([grade(1), grade(1, { status: 'failed' })])
    expect(gate(failed)).toBe(true)
    expect(Object.values(report(failed).readingsBySession)[0]![0]).toMatchObject({ completed: 1, failed: 1, unsettled: 0 })
    expect(gate(data([grade(1), grade(1, { status: 'uncertain' })]))).toBe(false)
    // Review 9 S-A: a reservation never recorded is a lost grading; a session that recorded gradings needs a completed one.
    expect(gate(data([grade(1), grade(1, { status: 'reserved', percent: null })]))).toBe(false)
    expect(gate(data([grade(1, { status: 'failed' })]))).toBe(false)
    // Review 10 S3: part (a) is "not all failed": a session whose gradings were all skipped as unchanged or no
    // evidence passes, and the per-session line counts them.
    const skipped = data([grade(1, { status: 'unchanged', percent: null }), grade(1, { status: 'no_evidence', percent: null })])
    expect(gate(skipped)).toBe(true)
    expect(Object.values(report(skipped).readingsBySession)[0]![0]).toMatchObject({ completed: 0, failed: 0, unchanged: 1, noEvidence: 1, unsettled: 0 })
    expect(renderSimReport('r', report(skipped))).toContain('s1 0/0/1/1/0')
    expect(gate(data([grade(1, { status: 'failed' }), grade(1, { status: 'unchanged', percent: null })]))).toBe(true)
    // Review 9 N4: the replicates are gradings too.
    expect(gate(data([grade(1)], undefined, 5, [{ session: 2, status: 'completed' }]))).toBe(true)
    expect(gate(data([grade(1)], undefined, 5, [{ session: 2, status: 'uncertain' }]))).toBe(false)
    expect(gate(data([grade(1)], [grade(2), grade(3, { percent: null }), grade(4)]))).toBe(false) // all null in session 3
    expect(gate(data([grade(1)], [grade(2, { percent: null }), grade(3), grade(4)]))).toBe(false) // review 10 S5 (X4): session 2 counts
  }, 30_000)

  test('review 7 B2: a look reads only its blocks, is recorded once, and a restart adopts it (both reviewer scenarios)', async () => {
    // 20 pairs started; block 2 (pairs 10-19) is mid-run: 4 of its on learners have no final exam yet (the reviewer's case).
    const off = Array.from({ length: 20 }, (_, pair) => learner('off', 'fast', { pair, g: 20 }))
    const on = Array.from({ length: 20 }, (_, pair) => learner('on', 'fast', { pair, g: 20 + [2, -1, 1, 0, 0][pair % 5]!, incomplete: pair >= 10 && pair < 14 }))
    const rest = [learner('off', 'slow'), learner('off', 'slow'), control(), control()]
    const all = [...off, ...on, ...rest] as never as Array<{ config: { learnerId: string } }>
    const ids = (xs: unknown[]) => (xs as Array<{ config: { learnerId: string } }>).map((d) => ({ learnerId: d.config.learnerId }))
    const blocks = [ids([...off.slice(0, 10), ...on.slice(0, 10), ...rest]), ids([...off.slice(10), ...on.slice(10)])]
    // Scenario 1, before the fix: look 1 recomputed over every learner present counts block 2's half-run learners.
    const unfiltered = run(all, { looks: [10, 20, 30], endedPairs: 10 }).sequential!
    expect(unfiltered.failedChecks.length).toBeGreaterThan(0)
    // After: the look reads blocks 1..1 only, and its checks pass.
    const scoped = run(lookLearners(all, blocks, 0), { looks: [10, 20, 30], endedPairs: 10 }).sequential!
    expect(scoped.failedChecks).toEqual([])
    expect(scoped.decisions.map((l) => l.decision)).toEqual(['continue'])
    // Recording (once, never revised) is in the database: simulated-learner.test.ts. The position from recorded looks:
    const first: RecordedLook = { look: 1, plannedPairs: 10, decision: 'continue', failedChecks: [], learners: blocks[0]!.map((c) => c.learnerId), at: 'x' }
    expect(sequencePosition([first], 3)).toEqual({ stopped: false, block: 1 })
    expect(sequencePosition([first, { ...first, look: 2, decision: 'efficacy' }], 3)).toEqual({ stopped: true, by: 'look 2: efficacy' })
    // A failed check at a look stops the sequence too; all three looks continuing ends it.
    expect(sequencePosition([{ ...first, failedChecks: ['c'] }], 3).stopped).toBe(true)
    expect(sequencePosition([first, { ...first, look: 2 }, { ...first, look: 3 }], 3)).toEqual({ stopped: true, by: 'every block was looked at' })
  })

  test('revision 8: the health look is arm-blind (swapping the arm labels changes nothing), counts 429s and prints no text', () => {
    const data = main()
    data[0]!.agentTurns[0].text = 'SECRET-LEARNER-TEXT'
    data[0]!.calls = [{ role: 'learner', model: 'm', effort: 'low', inputTokens: 1, outputTokens: 1, durationMs: 2000, attempts: 1, invocations: 1, rateLimited: 3 },
      { role: 'agent', model: 'm', effort: 'low', inputTokens: 1, outputTokens: 1, durationMs: 0, attempts: 0, invocations: 1, pending: true }]
    const statuses = Object.fromEntries(data.map((d, i) => [d.config.learnerId, i === 1 ? 'failed' : 'completed']))
    const swapped = data.map((d) => ({ ...d, config: { ...d.config, arm: d.config.arm === 'on' ? 'off' : d.config.arm === 'off' ? 'on' : d.config.arm } }))
    const h = simHealth(data as never, statuses)
    expect(simHealth(swapped as never, statuses)).toEqual(h)
    expect(h.calls.rateLimited).toBe(3)
    expect(h.calls.pending).toBe(1)
    expect(h.byStatus).toEqual({ completed: data.length - 1, failed: 1 })
    expect(h.failed).toEqual([data[1]!.config.learnerId])
    const text = renderSimHealth('r', h) + JSON.stringify(h)
    expect(text).not.toContain('SECRET-LEARNER-TEXT')
    expect(text).not.toMatch(/\b(on|off|anchor)\b\s*[:=-]/)
    // Revision 10: the control's gate is its mastery part only, and its exams are not screened.
    expect(h.gates.neverLearns).toMatchObject({ n: 2, ok: true })
    expect(h.finalExams).toBe(data.filter((d) => d.config.lane !== 'none').length)
    expect(h.gates.channel.ok).toBe(true)
  })

  // The pilot's shape (design C.1): fast off 12, on 3, anchor 12 (pairs 0-11), 2 controls.
  const pilot = (o: { anchorG?: (pair: number) => number; on?: (pair: number) => Opts; off?: (pair: number) => Opts; anchors?: number } = {}) => [
    ...Array.from({ length: 12 }, (_, pair) => learner('off', 'fast', { pair, ...(o.anchorG ? { g: 20 } : {}), ...o.off?.(pair) })),
    ...Array.from({ length: 3 }, (_, pair) => learner('on', 'fast', { pair, ...o.on?.(pair) })),
    ...Array.from({ length: o.anchors ?? 12 }, (_, pair) => learner('anchor', 'fast', { pair, ...(o.anchorG ? { g: 20 + o.anchorG(pair) } : {}) })),
    control(), control(),
  ]
  test('a pilot computes no outcome and no claim 2; its report prints no number derived from arm on\'s exams', () => {
    const r = run(pilot())
    expect(r.pilot).toBe(true)
    expect(r.outcome).toBeNull()
    expect(r.claim2).toBeNull()
    expect(r.sequential).toBeNull()
    // A claim placed by the claim alone (the matcher did not find it) is not a claim the matcher confirms.
    const placed = pilot()
    placed.find((d) => d.config.arm === 'on')!.agentTurns[0].attributedFacts = [placed.find((d) => d.config.arm === 'on')!.agentTurns[0].statedFactIds[0]]
    const claims = run(placed).mechanism
    expect(claims.on!.claimedConfirmed).toBeLessThan(1)
    expect(claims.off!.claimedConfirmed).toBe(1)
    // The exam-derived mechanism columns are pooled, and the pool leaves arm on out (revision 10, C.5).
    const ms = Object.values(r.mechanism)
    expect(new Set(ms.map((x) => x.misses)).size).toBe(1)
    expect(new Set(ms.map((x) => x.alreadyRightShare)).size).toBe(1)
    const zeros = (d: Record<string, any>) => [2, 3, 4, 5].reduce((k, s) => k + ids.filter((id) => (d.exams.find((x: ExamResult) => x.timepoint === s - 1)!.points[id] ?? 0) === 0).length, 0)
    expect(ms[0]!.misses).toBe(pilot().filter((d) => d.config.arm !== 'on' && d.config.lane !== 'none').reduce((k, d) => k + zeros(d), 0))
    // Whatever arm on's exams say, the pilot's report is the same text.
    const before = pilot(), top = structuredClone(before)
    for (const d of top.filter((x) => x.config.arm === 'on')) d.exams = d.exams.map((x: ExamResult) => examResult(x.timepoint, Object.fromEntries(ids.map((id) => [id, x.timepoint ? 2 : 0]))))
    expect(renderSimReport('r', run(top))).toBe(renderSimReport('r', run(before)))
    expect(renderSimReport('r', r)).toContain('### Pilot gates')
    // A main-sized run keeps the columns by arm once it has stopped.
    const stopped = judged(main()).mechanism
    expect(stopped.on!.misses).not.toBe(stopped.off!.misses)
    // Review 3, S3: the retry share sizes the main cap: 5 paid invocations over 4 call keys.
    const paid = run(pilot({ on: (pair) => (pair ? {} : { calls: [{ invocations: 2, attempts: 1 }, { invocations: 1, attempts: 1 }, { invocations: 1, attempts: 1 }, { invocations: 1, attempts: 1 }] }) }))
    expect(paid.cost.retryShare).toBeCloseTo(0.25, 9)
  })

  test('C.2, the anchor gate: anchor minus off on G over pairs 0-11, t ≥ 1.65 and mean > 0; fewer pairs fail', () => {
    // Planted G differences c ± 1 over 12 pairs: sd √(12/11), so t = c √12 / √(12/11) = c √11.
    const at = (t: number) => run(pilot({ anchorG: (pair) => t / Math.sqrt(11) + (pair % 2 ? -1 : 1) })).gates.anchor
    // 1.651 and 1.649 bracket the threshold: a threshold moved by 0.002 either way fails one of them.
    expect(at(1.651).estimate!.t).toBeCloseTo(1.651, 9)
    expect(at(1.651)).toMatchObject({ pairs: 12, ok: true })
    expect(at(1.649)).toMatchObject({ pairs: 12, ok: false })
    // The work order's named points.
    expect(at(1.66)).toMatchObject({ pairs: 12, ok: true })
    expect(at(1.64)).toMatchObject({ pairs: 12, ok: false })
    expect(run(pilot()).gates.anchor.ok).toBe(true) // the static plan: a strong anchor
    const short = run(pilot({ anchors: 11 }))
    expect(short.gates.anchor).toMatchObject({ pairs: 11, ok: null })
    expect(short.gateFailures).toContainEqual({ gate: 'anchor', clause: 'C.2' })
    // Main-sized: anchor minus off is read after the stop only, so the gate is not computed.
    expect(judged(main()).gates.anchor).toMatchObject({ estimate: null, ok: null })
  })

  test('C.4, the dose gate: the pooled off-brief delivered share, on minus matched off, ≥ +3 pp (rounded to 1e-9); a missing mate fails', () => {
    // Pair 0 delivers `k` of 100 facts off the session-1 brief (the rest on it); pairs 1-2 deliver nothing.
    const order = williamsRow(0).slice(0, 5), onBrief = brief(named(order, 0))[0]!
    const offBriefFact = EXAM_FACTS.find((f) => !named(order, 0).includes(f.conceptId))!.id
    const plan = (k: number) => [[...Array(k).fill(offBriefFact), ...Array(100 - k).fill(onBrief)], [], [], [], []]
    const dose = (on: number, off: number) => run(pilot({ on: (pair) => ({ plan: pair ? [[], [], [], [], []] : plan(on) }), off: (pair) => ({ plan: pair ? [[], [], [], [], []] : plan(off) }) })).gates.dose
    // 29/100 - 26/100 is 0.02999999999999997 in floating point: rounded, it is the +3.0 pp it means.
    expect(29 / 100 - 26 / 100).toBeLessThan(0.03)
    expect(dose(29, 26)).toMatchObject({ on: { delivered: 100, off: 29 }, off: { delivered: 100, off: 26 }, pairs: 3, diffPp: 3, ok: true })
    expect(dose(28, 26)).toMatchObject({ diffPp: 2, ok: false })
    expect(run(pilot()).gates.dose.ok).toBe(true) // the static plan reaches past the brief
    const failed = run(pilot({ on: (pair) => ({ plan: pair ? [[], [], [], [], []] : plan(2) }), off: (pair) => ({ plan: pair ? [[], [], [], [], []] : plan(0) }) }))
    expect(failed.gateFailures).toContainEqual({ gate: 'dose', clause: 'C.4' })
    expect(renderSimReport('r', failed)).toContain('The shipped guidance is not executed by this agent (dose difference 2.0 pp): claim 1 stops')
    // An on learner without its off mate: not computable (fails).
    const orphan = [...pilot(), learner('on', 'fast', { pair: 40 })]
    expect(run(orphan).gates.dose).toMatchObject({ onLearners: 4, pairs: 3, ok: null })
  })

  test('C.5 valid ids: every arm\'s share of claimed ids that were valid is at least 95% (stats review RC5, R21)', () => {
    // Plant `invalid` bad ids on arm off's first turn: its share is 1 - invalid / claimed.
    const withInvalid = (share: (claimed: number) => number) => {
      const data = pilot(), off = data.filter((d) => d.config.arm === 'off' && d.config.lane === 'fast')
      const claimed = off.reduce((n, d) => n + d.agentTurns.reduce((k: number, t: { claimedFactIds: string[] }) => k + t.claimedFactIds.length, 0), 0)
      off[0]!.agentTurns[0]!.invalidFacts = share(claimed)
      const r = run(data)
      return { share: r.mechanism.off!.validIdShare, ok: r.gates.validIds }
    }
    const at95 = withInvalid((c) => Math.floor(0.05 * c)), below = withInvalid((c) => Math.ceil(0.07 * c))
    expect(at95.share).toBeGreaterThanOrEqual(0.95)
    expect(at95.ok).toBe(true)
    expect(below.share).toBeLessThan(0.95)
    expect(below.share).toBeGreaterThan(0.9)
    expect(below.ok).toBe(false)
  })

  test('the never-learns control: mastery part only; read by its own gate and as a withholding check', () => {
    // The lane: capacity 0 and budget 0, so its notebook never holds a fact.
    expect(factBudget('none')).toBe(0)
    expect(updateHeld({}, ['tessel-f5'], 'none', 's', 1)).toMatchObject({ added: 0, overCapacity: 1, held: {} })
    const alone = run(pilot().filter((d) => d.config.lane !== 'none'))
    expect(alone.gates.neverLearns).toBeNull()
    expect(alone.gateFailures).toContainEqual({ gate: 'neverLearns', clause: 'C.5' })
    const paid = run([...pilot().filter((d) => d.config.lane !== 'none'), control({ calls: [{ invocations: 3, attempts: 3 }] }), control()])
    expect(paid.mechanism).toEqual(alone.mechanism)
    expect(paid.cost.retryShare).toBe(2) // its calls are paid: they count in the cost (and the cap)
    expect(paid.gates.neverLearns).toBe(true)
    const gate = (...cs: unknown[]) => run([...pilot().filter((d) => d.config.lane !== 'none'), ...cs]).checks.neverLearns.ok
    expect(gate(control({ toast: true }), control())).toBe(false)
    expect(gate(control({ change: 12 }), control())).toBe(false) // a rise beyond noise
    expect(gate(control({ change: -12 }), control())).toBe(true) // a drop is not a rise
    expect(gate(control({ aggregate: [1, 9] }), control())).toBe(false)
    expect(gate(control({ aggregate: [-1, 9] }), control())).toBe(true)
    // Main batch: a reported rise withholds the primary verdict and reads claim 2's change verdict inaccurate.
    expect(judged(main()).claim2!.changeVerdict).toBe('not computable') // no change data, nothing failed
    expect(judged(main({ controls: [] })).outcome!.verdict).toBe('withheld (never-learns control: no reported rise: not computable)')
    const talk = judged(main({ controls: [control({ change: 12 }), control()] }))
    expect(talk.outcome!.verdict).toBe('withheld (never-learns control: no reported rise: failed)')
    expect(talk.claim2!.changeVerdict).toBe('inaccurate')
  })

  test('claim 2 sign agreement counts only changes where the exam moved 25+ points and the app reported a change', () => {
    const data = main()
    const on = data.find((d) => d.config.arm === 'on')!
    const [a, b, c] = Object.keys(on.exams[1].byConcept)
    Object.assign(on.exams[1].byConcept, { [a!]: 50, [b!]: 20, [c!]: 10 })
    Object.assign(on.exams[3].byConcept, { [a!]: 60, [b!]: 50, [c!]: 50 }) // truths +10, +30, +40
    const change = (conceptId: string, delta: number) => ({ conceptId, fromAt: 5, toAt: 25, delta, deltaSe: null, beyondNoise: null })
    Object.assign(on, { sessionStarts: [0, 10, 20, 30, 40], measurements: { blind: [] },
      changes: { concepts: [change(a!, -5), change(b!, 5), change(c!, 0)], aggregate: { changeInterval: null } } })
    // +10 is below two facts and the 0 is no report: one clear change, and its sign agrees.
    expect(judged(data).claim2!.priorBlind.signAgreement).toEqual({ n: 1, agree: 1 })
  })

  // Verdict 2b, planted on the 24 on learners of the primary lane (a batch that stopped at look 1 with 24 pairs started): concept c0's exam goes 0 -> 50 between sessions 1
  // and 3; Learner reports a change of `delta` (se 10) over the same sessions and a gain notification at session 3,
  // from two counted readings (session 2's grading gave none).
  const live = (delta: number) => {
    const data = main({ pairs: 24 })
    for (const on of data.filter((d) => d.config.arm === 'on' && d.config.lane === 'fast')) {
      const c0 = Object.keys(on.exams[1].byConcept)[0]!
      on.exams[1].byConcept[c0] = 0
      on.exams[3].byConcept[c0] = 50
      Object.assign(on, { sessionStarts: [0, 10, 20, 30, 40], measurements: { blind: [] },
        changes: { concepts: [{ conceptId: c0, fromAt: 5, toAt: 25, delta, deltaSe: 10, beyondNoise: true }], aggregate: { changeInterval: null } },
        readings: [{ session: 1, conceptId: c0, percent: 10, assessmentRunId: 'f', counted: true }, { session: 2, conceptId: c0, percent: null, assessmentRunId: 'h', counted: false },
          { session: 3, conceptId: c0, percent: 10 + delta, assessmentRunId: 'g', counted: true }],
        notifications: delta > 0 ? [{ runId: 'g', conceptId: c0, kind: 'gain', percent: 10 + delta, delta }] : [] })
    }
    return judged(data)
  }

  test('verdict 2b, the live user\'s change report: accurate, inaccurate and not computable on planted fixtures, with its coverage', () => {
    const ok = live(45)
    expect(ok.claim2!.changeVerdict).toBe('accurate')
    // Coverage: 2 counted readings of the 52 planned concept-sessions (4 graded sessions x 13 concepts) per learner.
    expect(ok.claim2!.liveCoverage).toEqual({ conceptSessions: 24 * 52, counted: 48, share: 48 / (24 * 52), series: 24 })
    expect(live(-45).claim2!.changeVerdict).toBe('inaccurate')
    const text = renderSimReport('r', ok)
    expect(text).toContain('Verdict 2a, grader change-tracking on scheduled probes')
    expect(text).toContain('Verdict 2b, the live user\'s change report')
    expect(text).toContain('Counted series (concepts with two or more counted readings): 24')
    // The pre-registration names the phrase only to rule it out; the claim 2 section never uses it.
    expect(text.slice(text.indexOf('## Claim 2'), text.indexOf('## Cost'))).not.toMatch(/reports? improvement accurately/i)
  })

  test('claim 2 on the app\'s change reports: every criterion at its minimum n, any failure reads inaccurate', () => {
    const ok = { sign: { n: 20, agree: 15 }, coverage: { n: 20, covered: 17 }, gains: { n: 10, falseGains: 2 } }
    // Revision 10 (D.9): the fourth criterion, 2a only: Spearman's 95% lower bound above 0 at n >= 30.
    const rho = { n: 30, lo: 0.01 }
    expect(changeReportVerdict({ ...ok, spearman: rho })).toBe('accurate')
    expect(changeReportVerdict({ ...ok, spearman: { n: 30, lo: 0 } })).toBe('inaccurate')
    expect(changeReportVerdict({ ...ok, spearman: { n: 29, lo: 0.5 } })).toBe('not computable')
    // C8 (lead's decision): a NaN lower bound at n >= 30 (one learner, or every change tied) is not computable, never
    // "inaccurate"; another criterion that fails still reads inaccurate.
    expect(changeReportVerdict({ ...ok, spearman: { n: 30, lo: NaN } })).toBe('not computable')
    expect(changeReportVerdict({ ...ok, gains: { n: 10, falseGains: 9 }, spearman: { n: 30, lo: NaN } })).toBe('inaccurate')
    // The conjunction, pinned: sign agreement at n 19 with everything else met is not computable (v1's loosening,
    // "the first two met, the third met or not computable", would have read accurate).
    expect(changeReportVerdict({ ...ok, sign: { n: 19, agree: 19 }, spearman: rho })).toBe('not computable')
    expect(changeReportVerdict({ ...ok, gains: { n: 10, falseGains: 3 }, spearman: rho })).toBe('inaccurate')
    // Revision 9's stored inputs (report of record, run ccec88a3): sign 1/1, coverage 4/4, false gains 0/0.
    expect(changeReportVerdict({ sign: { n: 1, agree: 1 }, coverage: { n: 4, covered: 4 }, gains: { n: 0, falseGains: 0 } })).toBe('not computable')
    expect(changeReportVerdict(ok)).toBe('accurate')
    expect(changeReportVerdict({ ...ok, sign: { n: 20, agree: 14 } })).toBe('inaccurate')
    expect(changeReportVerdict({ ...ok, coverage: { n: 20, covered: 16 } })).toBe('inaccurate')
    expect(changeReportVerdict({ ...ok, gains: { n: 10, falseGains: 3 } })).toBe('inaccurate')
    expect(changeReportVerdict({ ...ok, sign: { n: 19, agree: 19 } })).toBe('not computable')
    expect(changeReportVerdict({ ...ok, sign: { n: 19, agree: 19 }, gains: { n: 10, falseGains: 9 } })).toBe('inaccurate')
  })
})
