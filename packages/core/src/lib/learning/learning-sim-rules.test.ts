import { describe, expect, test } from 'bun:test'
import { liveFeedbackContext } from '@learner/contract/learning/learning-live-hook.js'
import { LIVE_FEEDBACK_INSTRUCTIONS } from './learning-live-feedback.js'
import { HALYARD_CATALOG, HALYARD_EDGES, HALYARD_MANUAL, HALYARD_TASKS } from './learning-sim-halyard.js'
import { DROPPED_EXAM_ITEMS, factSheet, HALYARD_FACT_ITEMS_UNSCREENED } from './learning-sim-facts.js'
import { agentReplyPrompt, hookExtra, learnerTurnPrompt, probePrompt, probeQuestion, REPLY_SCHEMA } from './learning-sim-prompts.js'
import { ATTRIBUTION_THRESHOLD, EXAM_FACTS, examLeaks, factsBySentence, factsIn, REDACTED, redactReply, TITLE_ANSWERS } from './learning-sim-matcher.js'
import { HALYARD_GRAPH, MEMORY_RULES, SIM_LANES, examResult, heldExam, renderHeld, replayExams, seeded, updateHeld, type Held } from './learning-sim-memory.js'
import { ceilingTable, examOf, simulateLearner } from './learning-sim-ceiling.js'
import { factBudget, williamsRow } from './learning-sim-design.js'
import { analyzeSimRun, renderSimReport, signFlipP, unbudgetedGuard, simRecordIntegrity, simRunDifferences, simRunRecord, simTransportRefusal, SIM_PREREGISTRATION, blindProbes, changeReportVerdict, channelIntegrity, learnerEcho, learnerOverlaps } from './learning-sim-analysis.js'
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
    // 2 of 10 (refit, field): not verified.
    const twenty = 'A refit changes a field.'
    expect(factsIn(forty)).toEqual([])
    expect(factsIn(forty, ATTRIBUTION_THRESHOLD)).toContain(f.id)
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

  test('ceiling: the run\'s own memory rule; deterministic; with the rules on, oracle beats off and omniscient beats oracle in every lane', () => {
    expect(simulateLearner('oracle', 'medium', 3, 'x')).toEqual(simulateLearner('oracle', 'medium', 3, 'x'))
    expect(examOf({ 'twin-rule-f1': 0 }).byConcept['halyard-core--twin-rule']).toBe(50)
    for (const r of ceilingTable(['slow', 'medium'], 20)) {
      expect(r.oracle).toBeGreaterThan(r.off)
      expect(r.omniscient).toBeGreaterThan(r.oracle)
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
   * mostly task talk, so the channel stays as it is. What gets through is bounded where it would bias the primary:
   * unbudgeted knowledge gated on the final exam (the revision-9 paired guard), and the delivered-only sensitivity series
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

describe('simulated learner: what can withhold or reveal the primary (review 2: N1, N2, N3 pilot)', () => {
  // Pure fixtures through the real analyzeSimRun: learner k knows the first `known` exam facts, all delivered in
  // session 1; `leak` more facts are right on the final exam only and were never delivered.
  const ids = HALYARD_FACT_EXAM.map((q) => q.id)
  let n = 0
  const learner = (arm: string, lane: string, known: number, o: { leak?: number; partial?: number; incomplete?: boolean; calls?: Array<{ invocations: number; attempts: number }> } = {}) => {
    const facts = ids.slice(0, known), last = { ...Object.fromEntries(ids.slice(known, known + (o.partial ?? 0)).map((id) => [id, 1])), ...Object.fromEntries([...facts, ...ids.slice(known, known + (o.leak ?? 0))].map((id) => [id, 2])) }
    const exams = [0, 1, 2, 3, 4, 5].filter((t) => !(o.incomplete && t === 5)).map((t) => examResult(t, t === 0 ? {} : t === 5 ? last : Object.fromEntries(facts.map((id) => [id, 2]))))
    return { config: { arm, lane, sessions: 5, learnerId: `l${++n}`, heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 8 }, userId: `u${n}`, exams, readings: [], notifications: [],
      agentTurns: [1, 2].map((session) => ({ session, turn: 1, decision: 'none', conceptIds: [], statedFactIds: facts, invalidFacts: 0, review: null, claimedFactIds: facts, unofferedFacts: [], overBudgetFacts: [], redacted: 0, text: '' })),
      notebooks: [], calls: o.calls ?? [], probes: [], learnerOverlaps: [] }
  }
  const spread = (base: number, i: number) => base + ((i * 7) % 9) - 4
  // The never-learns control (lane none, arm on, budget 0): `known` facts right on its exams; what Learner reported.
  const control = (known = 0, o: { toast?: boolean; change?: number; aggregate?: [number, number]; calls?: Array<{ invocations: number; attempts: number }> } = {}) => {
    const d = learner('on', 'none', known, { calls: o.calls }) as Record<string, any>
    d.config.factBudget = 0
    if (o.toast) d.notifications = [{ runId: 'r', conceptId: 'c', kind: 'first_clear', percent: 80, delta: null }]
    d.changes = { concepts: o.change === undefined ? [] : [{ conceptId: 'c', fromAt: 0, toAt: 1, delta: o.change, deltaSe: 3, beyondNoise: true }], aggregate: { changeInterval: o.aggregate ?? null } }
    return d
  }
  // The main batch's shape: fast off 30, on 30 (a large clean effect), oracle 4; slow and medium off 2 each; 2 controls.
  const main = (o: { oracleLeak?: number; oracleIncomplete?: number; slowHigh?: boolean; controls?: unknown[]; onBypass?: boolean; bypass?: number[] } = {}) => [
    ...Array.from({ length: 30 }, (_, i) => learner('off', 'fast', spread(14, i))),
    // onBypass: on's advantage is partial credit (1 point) on facts the channel never delivered, plus delivered facts
    // that differ from the pair's off learner by +2, -1, 0 in turn (a paired delivered-only mean above 0 whose 95%
    // interval still covers 0: pairing would make a constant +1 significant).
    ...Array.from({ length: 30 }, (_, i) => o.onBypass ? learner('on', 'fast', spread(14, i) + (o.bypass ?? [2, -1, 0])[i % (o.bypass ?? [2, -1, 0]).length]!, { partial: 30 }) : learner('on', 'fast', spread(24, i))),
    ...Array.from({ length: 4 }, (_, i) => learner('oracle', 'fast', spread(24, i), { leak: i === 0 ? o.oracleLeak : 0, incomplete: i < (o.oracleIncomplete ?? 0) })),
    ...Array.from({ length: 2 }, (_, i) => learner('off', 'slow', i === 0 && o.slowHigh ? 22 : 2)),
    ...Array.from({ length: 2 }, () => learner('off', 'medium', 6)),
    ...(o.controls ?? [control(), control()]),
  ] as never
  const verified = { integrity: { ok: true, detail: 'fixture' } }

  test('cells outside the primary (oracle, slow, medium) never withhold its verdict', () => {
    expect(analyzeSimRun(main(), verified).outcome!.verdict).toBe('supported')
    expect(analyzeSimRun(main({ oracleLeak: 8 }), verified).outcome!.verdict).toBe('supported') // 8/34 per learner if oracle were pooled with on
    expect(analyzeSimRun(main({ slowHigh: true }), verified).outcome!.verdict).toBe('supported')
    const lost = analyzeSimRun(main({ oracleIncomplete: 2 }), verified)
    expect(lost.checks.incompletionOk).toBe(true)
    expect(lost.outcome!.verdict).toBe('supported')
  })

  test('revision 8: supported must hold on delivered facts too; the unbudgeted gap is reported with its interval', () => {
    const ok = analyzeSimRun(main(), verified).outcome!
    expect(ok.verdict).toBe('supported')
    expect(ok.deliveredOk).toBe(true)
    expect(ok.unbudgetedGap.mean).toBe(0)
    // Knowledge that bypassed the channel (1-point answers, so not counted as unbudgeted) carries the primary alone.
    const bypass = analyzeSimRun(main({ onBypass: true }), verified)
    expect(bypass.checks.unbudgetedOk).toBe(true)
    expect(bypass.outcome!.reading).toBe('supported')
    expect(bypass.outcome!.sensitivityDelivered.mean).toBeGreaterThan(0)
    expect(bypass.outcome!.sensitivityDelivered.lo).toBeLessThanOrEqual(0)
    expect(bypass.outcome!.deliveredOk).toBe(false)
    expect(bypass.outcome!.verdict).toContain('withheld (supported on delivered facts too')
    // Not supported: the check does not apply.
    const same = [...[0, 1].flatMap(() => Array.from({ length: 30 }, (_, i) => learner(['off', 'on'][0]!, 'fast', spread(14, i)))).map((d, i) => ({ ...d, config: { ...d.config, arm: i < 30 ? 'off' : 'on' } })), control(), control()]
    const flat = analyzeSimRun(same as never, verified).outcome!
    expect(flat.reading).not.toBe('supported')
    expect(flat.deliveredOk).toBe(true)
  })

  test('review 6 D4: the delivered-only check reads the 95% lower end, not the 90% one', () => {
    // Delivered facts differ from the pair's off learner by +2, 0, +1, -1, +2 in turn (+1 last before revision 9: the
    // exam's per-concept weights moved with its 60 items): the 90% lower end is above 0, the 95% one is not, so the
    // check fails (a 90% reading would pass it).
    const o = analyzeSimRun(main({ onBypass: true, bypass: [2, 0, 1, -1, 2] }), verified).outcome!
    expect(o.reading).toBe('supported')
    expect(o.sensitivityDelivered.lo90).toBeGreaterThan(0)
    expect(o.sensitivityDelivered.lo).toBeLessThanOrEqual(0)
    expect(o.deliveredOk).toBe(false)
    expect(o.verdict).toContain('withheld (supported on delivered facts too')
  })

  test('revision 9: the unbudgeted guard is a paired sign-flip test plus a lower bound, not a fixed 0.2 gap', () => {
    // Exact sign-flip p: all 2^m sign patterns of the nonzero differences.
    expect(signFlipP([])).toBe(1)
    expect(signFlipP([0, 0, 1])).toBe(1)
    expect(signFlipP([1, 1, 1])).toBeCloseTo(2 / 8, 12)
    expect(signFlipP([2, 1])).toBeCloseTo(2 / 4, 12)
    expect(signFlipP([1, 1, 1, 1, -1, 0])).toBeCloseTo(12 / 32, 12)
    expect(signFlipP(Array(10).fill(-1))).toBeCloseTo(2 / 1024, 12)
    // The pilot's shape (3 pairs, one learner with 1 fact, the other arm 0): the old rule failed it (gap 0.33 > 0.2).
    const pilot = unbudgetedGuard([{ on: 1, off: 0 }, { on: 0, off: 0 }, { on: 0, off: 0 }])
    expect(pilot).toMatchObject({ pairs: 3, p: 1, ok: true })
    expect(pilot.onLower).toBeLessThan(0)
    // A shared leak moves no difference (p 1) but the level bound fires: 10 pairs at 2 facts each.
    expect(unbudgetedGuard(Array(10).fill({ on: 2, off: 2 }))).toMatchObject({ p: 1, onLower: 2, offLower: 2, ok: false })
    expect(unbudgetedGuard([{ on: 1, off: 0 }])).toMatchObject({ pairs: 1, ok: null })
    expect(unbudgetedGuard([])).toMatchObject({ pairs: 0, ok: null })

    // Through analyzeSimRun, the main batch's shape with unbudgeted facts on the final exam of the fast pairs listed.
    const leaky = (on: number[], off: number[]) => [
      ...Array.from({ length: 30 }, (_, i) => learner('off', 'fast', spread(14, i), { leak: off.includes(i) ? 1 : 0 })),
      ...Array.from({ length: 30 }, (_, i) => learner('on', 'fast', spread(24, i), { leak: on.includes(i) ? 1 : 0 })),
      ...(main() as unknown[]).slice(60),
    ] as never
    // Balance noise: on 9 learners, off 2 (means 0.30 and 0.07, gap 0.23: the old rule withheld this); p = 134/2048.
    const noise = analyzeSimRun(leaky([0, 1, 2, 3, 4, 5, 6, 7, 8], [20, 21]), verified)
    expect(noise.checks.unbudgetedArmGap).toBeGreaterThan(0.2)
    expect(noise.checks.unbudgetedPairs.p).toBeCloseTo(134 / 2048, 12)
    expect(noise.checks.unbudgetedOk).toBe(true)
    expect(noise.outcome!.verdict).toBe('supported')
    // A real imbalance: on 10 learners, off none (p = 2/1024, every level bound under 0.5): withheld.
    const imbalance = analyzeSimRun(leaky([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], []), verified)
    expect(imbalance.checks.unbudgetedPairs.onLower).toBeLessThanOrEqual(0.5)
    expect(imbalance.checks.unbudgetedOk).toBe(false)
    expect(imbalance.outcome!.verdict).toContain('unbudgeted knowledge about 0 and balanced (revision 9 guard): failed')
  })

  test('revision 8: the pilot gate on the channel itself (re-review 5 point 2)', () => {
    const d = () => learner('off', 'fast', 4) as unknown as Record<string, any>
    expect(channelIntegrity([d()] as never)).toMatchObject({ turns: 2, claimedUnaccounted: 0, overBudgetKept: 0, ok: true })
    // A claim neither budgeted nor redacted over budget.
    const lost = d(); lost.agentTurns[0].claimedFactIds = [...lost.agentTurns[0].claimedFactIds, ids[10]]
    expect(channelIntegrity([lost] as never)).toMatchObject({ claimedUnaccounted: 1, ok: false })
    // Redacted over budget: accounted. Restated later in the same session: free, accounted.
    const over = d(); over.agentTurns[0].claimedFactIds = [...over.agentTurns[0].claimedFactIds, ids[10]]; over.agentTurns[0].overBudgetFacts = [ids[10]]
    expect(channelIntegrity([over] as never).ok).toBe(true)
    const again = d(); again.agentTurns.push({ ...again.agentTurns[0], turn: 2, statedFactIds: [], claimedFactIds: [ids[0]] })
    expect(channelIntegrity([again] as never)).toMatchObject({ turns: 3, ok: true })
    // An over-budget fact still in the text the learner read.
    const fact = factSheet(HALYARD_FACT_EXAM.find((q) => q.id === ids[10])!.conceptId).facts.find((f) => f.id === ids[10])!.fact
    const kept = d(); kept.agentTurns[0].overBudgetFacts = [ids[10]]; kept.agentTurns[0].claimedFactIds = [...kept.agentTurns[0].claimedFactIds, ids[10]]; kept.agentTurns[0].text = fact
    expect(channelIntegrity([kept] as never)).toMatchObject({ overBudgetKept: 1, ok: false })
    // A turn without its text cannot be checked: the gate fails as not computable.
    const blind = d(); delete blind.agentTurns[1].text
    expect(channelIntegrity([blind] as never).ok).toBeNull()
    expect(channelIntegrity([]).ok).toBeNull()
    // In the report: every learner, controls included.
    const leakyControl = control() as Record<string, any>; leakyControl.agentTurns[0].claimedFactIds = [ids[10]]
    expect(analyzeSimRun([d(), leakyControl] as never, verified).gates.channel).toMatchObject({ claimedUnaccounted: 1, ok: false })
  })

  test('revision 8: interim looks return no between-arm number until the sequence stops; a look waits for its pairs', () => {
    // A small positive effect in matched pairs (+2, -1, +1, 0, 0 facts in turn): continue at 10 and 20 pairs.
    const sequence = (pairs: number) => [
      ...Array.from({ length: pairs }, (_, i) => learner('off', 'fast', spread(14, i))),
      ...Array.from({ length: pairs }, (_, i) => learner('on', 'fast', spread(14, i) + [2, -1, 1, 0, 0][i % 5]!)),
      ...Array.from({ length: 2 }, () => learner('off', 'slow', 2)), control(), control(),
    ] as never
    const looks = { ...verified, looks: [10, 20, 30] }
    const one = analyzeSimRun(sequence(10), looks), two = analyzeSimRun(sequence(20), looks)
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
    const three = analyzeSimRun(sequence(30), looks)
    // At 30 pairs the sequence ends whatever the data: the outcome appears, read on all 30 pairs.
    expect(three.outcome!.stoppedAt).toBe(3)
    expect(three.outcome!.primary.pairs).toBe(30)
    expect(three.outcome!.reading).toBe(three.sequential!.decisions.at(-1)!.decision === 'efficacy' ? 'supported' : 'inconclusive')
    expect(three.sequential!.detail).toHaveLength(3)
    // 15 pairs: only the first look is due. 30 present but only 10 ended (a resumed runner, --analyze-only mid-block):
    // look 2 is not read off the half-run block, and nothing between-arm is returned.
    expect(analyzeSimRun(sequence(15), looks).sequential!.decisions).toHaveLength(1)
    const midBlock = analyzeSimRun(sequence(30), { ...looks, endedPairs: 10 })
    // Review 7 round 2 nit: stopped by a failed check at a look that said "continue": the report says it stopped.
    const checkStop = analyzeSimRun(sequence(10), { ...looks, stoppedBy: 'a pre-registered check failed at look 1' })
    expect(checkStop.outcome).toBeNull()
    expect(renderSimReport('r', checkStop)).toContain('The batch stopped (a pre-registered check failed at look 1); the verdict is withheld.')
    expect(renderSimReport('r', one)).toContain('The sequence has not stopped.')
    expect(midBlock.sequential!.decisions.map((l) => l.decision)).toEqual(['continue'])
    expect(midBlock.outcome).toBeNull()
    // A large effect stops at the first look, and the estimate is read on its 10 pairs.
    const big = analyzeSimRun(main(), looks)
    expect(big.sequential!.decisions.map((l) => l.decision)).toEqual(['efficacy'])
    expect(big.outcome!.primary.pairs).toBe(10)
    // Review 7 S6: look 1 reads pairs 0-9 (pair < 10), not 11 pairs.
    expect(big.sequential!.detail![0]!.estimate.pairs).toBe(10)
    expect(big.outcome!.verdict).toBe('supported')
  })

  test('revision 8.5 (review 10 B1, S2): the run record lives in every learner\'s config in the database', () => {
    const ids = HALYARD_CATALOG.concepts.map((c) => c.id), m = { model: 'm', effort: 'low', timeoutSec: 1 }
    const run = { commit: 'abc', maxCalls: 6000, gradingReplicates: 2, sequential: true, arms: ['on', 'off'], lanes: ['slow'], perArm: { slow: { on: 2, off: 2 } }, looks: [...SIM_PREREGISTRATION.primary.sequential.looks] }
    const config = (learnerId: string, r: Record<string, unknown> | null = run) => SimLearnerConfig.parse({ runId: '00000000-0000-4000-8000-000000000009', learnerId, arm: 'on', lane: 'slow', sessions: 5, turns: 3,
      transport: 'codex', learnerModel: m, agentModel: m, heldOut: ids.slice(0, 3), taskOrder: [2, 3, 4, 0, 1], factBudget: 2, dayGap: 5, ...(r ? { run: r } : {}) })
    const data = ['l1001', 'l1002'].map((id) => ({ config: config(id) }))
    const check = (d: Array<{ config: SimLearnerConfig }>, o: Partial<{ stub: boolean; changed: string[] }> = {}) => simRecordIntegrity(d, { stub: false, changed: [], head: 'abc', ...o }).ok
    expect(simRunRecord(data.map((d) => d.config))).toEqual(run)
    expect(check(data)).toBe(true)
    expect(check(data, { changed: ['x.ts'] })).toBe(false)
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
    const run = (s1: Array<ReturnType<typeof grade>>, later = [2, 3, 4].map((s) => grade(s)), sessions = 5, replicates: Array<{ session: number; status: string }> = []) => (main() as unknown as Array<Record<string, any>>)
      .map((d) => d.config.arm === 'on' ? { ...d, config: { ...d.config, sessions }, readings: [...s1, ...later].filter((r) => r.session < sessions), replicates } : d)
    const report = (data: unknown) => analyzeSimRun(data as never, verified)
    const gate = (data: unknown) => report(data).gates.onReadings
    expect(gate(run([grade(1, { percent: null })]))).toBe(true)
    expect(gate(run([]))).toBe(true) // N4: every session-1 concept skipped for no evidence: nothing lost
    expect(gate(run([grade(1, { percent: null })], [grade(2)], 3))).toBe(true)
    expect(gate(run([grade(1)], [], 2))).toBe(null) // S1: one graded session cannot show part (b)
    expect(gate(run([], [], 1))).toBe(null)
    // S2: every recorded grading must settle; a failed one settles and is reported, a pending or refused one fails.
    const failed = run([grade(1), grade(1, { status: 'failed' })])
    expect(gate(failed)).toBe(true)
    expect(Object.values(report(failed).readingsBySession)[0]![0]).toMatchObject({ completed: 1, failed: 1, unsettled: 0 })
    expect(gate(run([grade(1), grade(1, { status: 'uncertain' })]))).toBe(false)
    // Review 9 S-A: a reservation never recorded is a lost grading; a session that recorded gradings needs a completed one.
    expect(gate(run([grade(1), grade(1, { status: 'reserved', percent: null })]))).toBe(false)
    expect(gate(run([grade(1, { status: 'failed' })]))).toBe(false)
    // Review 10 S3: part (a) is "not all failed": a session whose gradings were all skipped as unchanged or no
    // evidence passes, and the per-session line counts them.
    const skipped = run([grade(1, { status: 'unchanged', percent: null }), grade(1, { status: 'no_evidence', percent: null })])
    expect(gate(skipped)).toBe(true)
    expect(Object.values(report(skipped).readingsBySession)[0]![0]).toMatchObject({ completed: 0, failed: 0, unchanged: 1, noEvidence: 1, unsettled: 0 })
    expect(renderSimReport('r', report(skipped))).toContain('s1 0/0/1/1/0')
    expect(gate(run([grade(1, { status: 'failed' }), grade(1, { status: 'unchanged', percent: null })]))).toBe(true)
    // Review 9 N4: the replicates are gradings too.
    expect(gate(run([grade(1)], undefined, 5, [{ session: 2, status: 'completed' }]))).toBe(true)
    expect(gate(run([grade(1)], undefined, 5, [{ session: 2, status: 'uncertain' }]))).toBe(false)
    expect(gate(run([grade(1)], [grade(2), grade(3, { percent: null }), grade(4)]))).toBe(false) // all null in session 3
    expect(gate(run([grade(1)], [grade(2, { percent: null }), grade(3), grade(4)]))).toBe(false) // review 10 S5 (X4): session 2 counts
  })

  test('review 7 B2: a look reads only its blocks, is recorded once, and a restart adopts it (both reviewer scenarios)', async () => {
    // 20 pairs started; block 2 (pairs 10-19) is mid-run: 4 of its on learners have no final exam yet (the reviewer's case).
    const off = Array.from({ length: 20 }, (_, i) => learner('off', 'fast', spread(14, i)))
    const on = Array.from({ length: 20 }, (_, i) => learner('on', 'fast', spread(14, i) + [2, -1, 1, 0, 0][i % 5]!, { incomplete: i >= 10 && i < 14 }))
    const rest = [learner('off', 'slow', 2), learner('off', 'slow', 2), control(), control()]
    const all = [...off, ...on, ...rest] as never as Array<{ config: { learnerId: string } }>
    const ids = (xs: unknown[]) => (xs as Array<{ config: { learnerId: string } }>).map((d) => ({ learnerId: d.config.learnerId }))
    const blocks = [ids([...off.slice(0, 10), ...on.slice(0, 10), ...rest]), ids([...off.slice(10), ...on.slice(10)])]
    // Scenario 1, before the fix: look 1 recomputed over every learner present counts block 2's half-run learners.
    const unfiltered = analyzeSimRun(all as never, { ...verified, endedPairs: 10 }).sequential!
    expect(unfiltered.failedChecks.length).toBeGreaterThan(0)
    // After: the look reads blocks 1..1 only, and its checks pass.
    const scoped = analyzeSimRun(lookLearners(all, blocks, 0) as never, { ...verified, endedPairs: 10 }).sequential!
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
    const data = main() as unknown as Array<Record<string, any>>
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
    expect(text).not.toMatch(/\b(on|off|oracle)\b\s*[:=-]/)
    expect(h.gates.neverLearns.examOk).toBe(true)
    // Review 7 S6: the never-learns controls are counted apart, never pooled into the learners' exams.
    expect(h.controlFinalExams).toBe(2)
    expect(h.finalExams).toBe(data.filter((d) => d.config.lane !== 'none').length)
    expect(h.gates.channel.ok).toBe(true)
  })

  test('a pilot-sized run computes no outcome and no claim 2; its gates count leaks and read the noise', () => {
    const pilot = (onLeaks: number, offLeaks = 0) => [
      ...[13, 15, 20].map((k, i) => learner('off', 'fast', k, { leak: i < offLeaks ? 1 : 0 })),
      ...[20, 24, 26].map((k, i) => learner('on', 'fast', k, { leak: i < onLeaks ? 1 : 0, calls: i ? [] : [{ invocations: 2, attempts: 1 }, { invocations: 1, attempts: 1 }, { invocations: 1, attempts: 1 }, { invocations: 1, attempts: 1 }] })),
      learner('oracle', 'fast', 24), learner('off', 'slow', 2), learner('off', 'medium', 6),
    ] as never
    const r = analyzeSimRun(pilot(1), verified)
    expect(r.outcome).toBeNull()
    expect(r.claim2).toBeNull()
    // A claim placed by the claim alone (the matcher did not find it) is not a claim the matcher confirms.
    const placed = pilot(1) as unknown as Array<Record<string, any>>
    placed.find((d) => d.config.arm === 'on')!.agentTurns[0].attributedFacts = [ids[0]]
    const claims = analyzeSimRun(placed as never, verified).mechanism
    expect(claims.on!.claimedConfirmed).toBeLessThan(1)
    expect(claims.off!.claimedConfirmed).toBe(1)
    // Review 3, S1: the exam-derived mechanism columns are pooled over arms in a pilot (by arm, on's misses would be
    // 1 learner-session x (60 - known) summed over its 3 learners: its interim exam level).
    const ms = Object.values(r.mechanism)
    expect(new Set(ms.map((m) => m.misses)).size).toBe(1)
    expect(new Set(ms.map((m) => m.alreadyRightShare)).size).toBe(1)
    expect(ms[0]!.misses).toBe([13, 15, 20, 20, 24, 26, 24, 2, 6].reduce((n, k) => n + HALYARD_FACT_EXAM.length - k, 0))
    const main = analyzeSimRun(pilot(0), { ...verified, mainPerArm: 3 }).mechanism
    expect(main.on!.misses).not.toBe(main.off!.misses) // a main-sized run keeps them by arm
    // Review 3, S3: the retry share sizes the main cap: 5 paid invocations over 4 call keys.
    expect(r.cost.retryShare).toBeCloseTo(0.25, 9)
    // Whole-exam totals (60 facts, 2 points each): independent pooled SD of the on and off gains.
    const total = (k: number) => examResult(5, Object.fromEntries(ids.slice(0, k).map((id) => [id, 2]))).total
    const sdOf = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) }
    expect(r.gates.noise.pooledSd).toBeCloseTo(Math.sqrt((sdOf([13, 15, 20].map(total)) + sdOf([21, 24, 26].map(total))) / 2), 9) // the leaked fact counts on the final exam
    expect(r.gates.noise.ok).toBe(true)
    expect(r.gates.unbudgeted).toBe(true) // on 1, off 0: each <= floor(3/2), 1 apart
    expect(analyzeSimRun(pilot(2), verified).gates.unbudgeted).toBe(false) // on 2 > floor(3/2), and 2 apart
    expect(analyzeSimRun(pilot(2, 1), verified).gates.unbudgeted).toBe(false) // 1 apart, but on 2 > floor(3/2)
    expect(analyzeSimRun(pilot(1, 1), verified).gates.unbudgeted).toBe(true)
  })

  test('the never-learns control: read by its own gate only; its exam gain must cover 0 and Learner must report no rise', () => {
    // The lane: capacity 0 and budget 0, so its notebook never holds a fact.
    expect(factBudget('none')).toBe(0)
    expect(updateHeld({}, ['tessel-f5'], 'none', 's', 1)).toMatchObject({ added: 0, overCapacity: 1, held: {} })
    const pilot = [...[13, 15, 20].map((k) => learner('off', 'fast', k)), ...[20, 24, 26].map((k) => learner('on', 'fast', k)), learner('oracle', 'fast', 24)]
    const alone = analyzeSimRun(pilot as never, verified)
    // Pilot gate: not computable (fails) without a control; the control enters no other gate, check or mechanism row.
    expect(alone.gates.neverLearns).toBeNull()
    const leaky = analyzeSimRun([...pilot, control(30, { calls: [{ invocations: 3, attempts: 3 }] }), control(0)] as never, verified)
    expect(leaky.mechanism).toEqual(alone.mechanism)
    expect(leaky.checks.unbudgeted).toEqual(alone.checks.unbudgeted)
    expect(leaky.gates.noise).toEqual(alone.gates.noise)
    expect(leaky.learners).toBe(9)
    expect(leaky.cost.retryShare).toBe(2) // its calls are paid: they count in the cost (and the cap)
    expect(leaky.gates.neverLearns).toBe(true) // 30 and 0: the bootstrap interval reaches 0
    const gate = (...cs: unknown[]) => analyzeSimRun([...pilot, ...cs] as never, verified).checks.neverLearns
    expect(gate(control(2), control(3))).toMatchObject({ examOk: false, masteryOk: true }) // neither scored 0
    expect(gate(control(0))).toMatchObject({ examOk: true }) // one learner: its gain is 0
    expect(gate(control(1))).toMatchObject({ examOk: false })
    expect(gate(control(0, { toast: true }), control(0)).masteryOk).toBe(false)
    expect(gate(control(0, { change: 12 }), control(0)).masteryOk).toBe(false) // a rise beyond noise
    expect(gate(control(0, { change: -12 }), control(0)).masteryOk).toBe(true) // a drop is not a rise
    expect(gate(control(0, { aggregate: [1, 9] }), control(0)).masteryOk).toBe(false)
    expect(gate(control(0, { aggregate: [-1, 9] }), control(0)).masteryOk).toBe(true)
    expect(analyzeSimRun([...pilot, control(0, { toast: true }), control(0)] as never, verified).gates.neverLearns).toBe(false)
    // Main batch: the exam part withholds the primary verdict; the mastery part reads claim 2's change verdict inaccurate.
    expect(analyzeSimRun(main(), verified).claim2!.changeVerdict).toBe('not computable') // no change data, nothing failed
    expect(analyzeSimRun(main({ controls: [] }), verified).outcome!.verdict).toBe('withheld (never-learns control: exam gain covers 0: not computable)')
    expect(analyzeSimRun(main({ controls: [control(2), control(3)] }), verified).outcome!.verdict).toBe('withheld (never-learns control: exam gain covers 0: failed)')
    const talk = analyzeSimRun(main({ controls: [control(0, { change: 12 }), control(0)] }), verified)
    expect(talk.outcome!.verdict).toBe('supported')
    expect(talk.claim2!.changeVerdict).toBe('inaccurate')
  })

  test('claim 2 sign agreement counts only changes where the exam moved 25+ points and the app reported a change', () => {
    const run = main() as unknown as Array<Record<string, any>>
    const on = run.find((d) => d.config.arm === 'on')!
    const [a, b, c] = Object.keys(on.exams[1].byConcept)
    Object.assign(on.exams[1].byConcept, { [a!]: 50, [b!]: 20, [c!]: 10 })
    Object.assign(on.exams[3].byConcept, { [a!]: 60, [b!]: 50, [c!]: 50 }) // truths +10, +30, +40
    const change = (conceptId: string, delta: number) => ({ conceptId, fromAt: 5, toAt: 25, delta, deltaSe: null, beyondNoise: null })
    Object.assign(on, { sessionStarts: [0, 10, 20, 30, 40], measurements: { blind: [] },
      changes: { concepts: [change(a!, -5), change(b!, 5), change(c!, 0)], aggregate: { changeInterval: null } } })
    // +10 is below two facts and the 0 is no report: one clear change, and its sign agrees.
    expect(analyzeSimRun(run as never, verified).claim2!.priorBlind.signAgreement).toEqual({ n: 1, agree: 1 })
  })

  test('claim 2 on the app\'s change reports: every criterion at its minimum n, any failure reads inaccurate', () => {
    const ok = { sign: { n: 20, agree: 15 }, coverage: { n: 20, covered: 17 }, gains: { n: 10, falseGains: 2 } }
    expect(changeReportVerdict(ok)).toBe('accurate')
    expect(changeReportVerdict({ ...ok, sign: { n: 20, agree: 14 } })).toBe('inaccurate')
    expect(changeReportVerdict({ ...ok, coverage: { n: 20, covered: 16 } })).toBe('inaccurate')
    expect(changeReportVerdict({ ...ok, gains: { n: 10, falseGains: 3 } })).toBe('inaccurate')
    expect(changeReportVerdict({ ...ok, sign: { n: 19, agree: 19 } })).toBe('not computable')
    expect(changeReportVerdict({ ...ok, sign: { n: 19, agree: 19 }, gains: { n: 10, falseGains: 9 } })).toBe('inaccurate')
  })
})
