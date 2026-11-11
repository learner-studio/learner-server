import { describe, expect, test } from 'bun:test'
import { liveFeedbackContext } from '@learner/contract/learning/learning-live-hook.js'
import { LIVE_FEEDBACK_INSTRUCTIONS } from './learning-live-feedback.js'
import { HALYARD_CATALOG, HALYARD_MANUAL, HALYARD_TASKS } from './learning-sim-halyard.js'
import { factSheet } from './learning-sim-facts.js'
import { agentReplyPrompt, hookExtra, learnerTurnPrompt, REPLY_SCHEMA } from './learning-sim-prompts.js'
import { EXAM_FACTS, examLeaks, factsIn, HALYARD_LENS, REDACTED, redactReply, TITLE_ANSWERS } from './learning-sim-matcher.js'
import { MEMORY_RULES, SIM_LANES, draw, parseNotebook, renderNotebook, updateNotebook } from './learning-sim-memory.js'
import { ceilingTable, simulateLearner } from './learning-sim-ceiling.js'
import { williamsRow } from './learning-sim-design.js'

const catalog = HALYARD_CATALOG.concepts.map((x) => ({ id: x.id, title: x.title }))
const packet = { turnId: 't1', catalogVersion: HALYARD_CATALOG.version, catalog: [...HALYARD_CATALOG.concepts], instructions: LIVE_FEEDBACK_INSTRUCTIONS, recentFeedback: [] }
const hook = hookExtra(liveFeedbackContext(packet, 's1', { separateCatalog: false, submissionCommand: 'Submission: return the feedback JSON when asked.' }).hookSpecificOutput.additionalContext,
  { decision: 'influence', conceptIds: [catalog[3]!.id], review: catalog[5]!.id })
const fact = (id: string) => EXAM_FACTS.find((f) => f.id === id)!

describe('simulated learner: no exam answer outside the fact channel', () => {
  test('the leak test finds the leaks it is meant to find (positive control: the fact sheets themselves)', () => {
    expect(examLeaks(catalog.map((c) => factSheet(c.id).facts.map((f) => f.fact).join(' ')).join('\n')).length).toBeGreaterThan(80)
    // Title answers ("a tessel", "a rebraid") are the concepts' own names; nothing else is exempt.
    expect(TITLE_ANSWERS.length).toBe(8)
    for (const id of TITLE_ANSWERS) expect(/\d/.test(fact(id).answer)).toBe(false)
  })

  test('no arm\'s base prompt (manual, brief, hook context, learner prompt) states an exam answer at >= 80% of its content tokens with a concept term', () => {
    expect(examLeaks(HALYARD_MANUAL)).toEqual([])
    for (const task of HALYARD_TASKS) {
      for (const extra of [null, hook]) {
        const prompt = agentReplyPrompt({ task, messages: [], message: 'Where do I start?', extra, sheets: [], budget: { total: 4, left: 4 }, catalog })
        expect({ task: task.id, hook: Boolean(extra), leaks: examLeaks(prompt) }).toEqual({ task: task.id, hook: Boolean(extra), leaks: [] })
      }
      expect(examLeaks(learnerTurnPrompt({ notebook: '', task, messages: [], turn: 1, turns: 3 }))).toEqual([])
    }
  })

  test('statedFactIds is an enum of the offered ids; none offered allows none', () => {
    const offered = factSheet(catalog[0]!.id).facts.map((f) => f.id)
    expect(REPLY_SCHEMA(catalog.map((c) => c.id), offered).properties.statedFactIds).toEqual({ type: 'array', items: { type: 'string', enum: offered } })
    expect(REPLY_SCHEMA(catalog.map((c) => c.id), []).properties.statedFactIds).toMatchObject({ maxItems: 0 })
  })
})

describe('simulated learner: the arm-blind matcher', () => {
  test('every exam fact is found in its own text, and nothing else is', () => {
    for (const f of EXAM_FACTS) expect(factsIn(f.fact)).toEqual([f.id])
  })

  test('a paraphrase with the concept named is found; unrelated text is not', () => {
    expect(factsIn('Under the twin rule, if two tessels share a keel key, the first one to arrive wins.')).toContain('twin-rule-f3')
    expect(factsIn('Alpine cushion plants grow as dense low domes that trap warm air.')).toEqual([])
  })

  test('redaction: unoffered facts and facts beyond the budget are removed before the learner reads the reply; a repeat is free', () => {
    const a = fact('twin-rule-f1'), b = fact('twin-rule-f2'), c = fact('keel-key-f2')
    const offered = new Set(factSheet(a.conceptId).facts.map((f) => f.id))
    const r = redactReply(`Let me look at the job. ${a.fact} ${b.fact} ${c.fact} So re-sending will not help.`, offered, new Set(), 1)
    expect(r.budgeted).toEqual([a.id])
    expect(r.overBudget).toEqual([b.id])
    expect(r.unoffered).toEqual([c.id])
    expect(r.text).toBe(`Let me look at the job. ${a.fact} ${REDACTED} So re-sending will not help.`)
    // A fact already counted this session costs nothing again.
    expect(redactReply(a.fact, offered, new Set([a.id]), 0)).toMatchObject({ text: a.fact, budgeted: [] })
  })
})

describe('simulated learner: memory rules', () => {
  test('round-trips facts by topic, however long the notebook grows', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ topic: `topic ${i}`, facts: Array.from({ length: 10 }, (_, j) => `fact ${i}.${j} about something`) }))
    const text = renderNotebook(entries)
    expect(text.length).toBeGreaterThan(10_000)
    expect(parseNotebook(text)).toEqual(entries)
    expect(parseNotebook('Halyard notes: tessel.\nepoch counts versions.')).toEqual([{ topic: 'notes', facts: ['Halyard notes: tessel.', 'epoch counts versions.'] }])
    expect(draw('x')).toBe(draw('x'))
  })

  test('learns whole facts in order within the lane capacity; a restated fact is free', () => {
    // No forgetting and a lens that tags nothing (no prerequisite, no strengthening): capacity alone decides.
    const lens = { tag: () => [], conceptOf: (id: string) => id, prerequisites: () => [] }
    const rules = { ...MEMORY_RULES, forget: { slow: 0, medium: 0, fast: 0 } }
    const fact = (n: number) => `fact ${n} `.padEnd(40, 'x')
    const before = renderNotebook([{ topic: 'Tessel', facts: ['A tessel is immutable.'] }])
    // 40 + 40 characters fit in the slow lane's 100; the third fact does not, and the short one after it is over capacity too.
    const u = updateNotebook(before, {}, [{ topic: 'tessel', facts: ['a tessel is  immutable.', fact(1)] }, { topic: 'keel key', facts: [fact(2), fact(3), 'Rare.'] }], 'slow', 's', 1, new Set(), lens, rules)
    expect(u).toMatchObject({ added: 2, used: 80, overCapacity: 2, forgotten: 0, facts: 3 })
    expect(parseNotebook(u.text)).toEqual([{ topic: 'Tessel', facts: ['A tessel is immutable.', fact(1).trim()] }, { topic: 'keel key', facts: [fact(2).trim()] }])
    expect(SIM_LANES.slow.capacity).toBeLessThan(SIM_LANES.medium.capacity)
    expect(SIM_LANES.medium.capacity).toBeLessThan(SIM_LANES.fast.capacity)
  })

  const nb = (facts: string[]) => facts.map((f) => `### notes\n- ${f}`).join('\n\n')
  const seed = 'memory-test'
  test('prerequisite absorption: a fact whose prerequisite concept is absent is kept with probability prerequisiteAbsorb, and always once it is present', () => {
    const twin = EXAM_FACTS.filter((f) => f.conceptId.endsWith('twin-rule'))
    let kept = 0, n = 0
    for (let s = 1; s <= 200; s++) for (const f of twin) { n++; kept += updateNotebook('', {}, [{ topic: 't', facts: [f.fact] }], 'fast', seed, s, new Set(), HALYARD_LENS).added }
    expect(Math.abs(kept / n - MEMORY_RULES.prerequisiteAbsorb)).toBeLessThan(0.06)
    const withKeel = nb([fact('keel-key-f1').fact])
    for (const f of twin) expect(updateNotebook(withKeel, {}, [{ topic: 't', facts: [f.fact] }], 'fast', seed, 1, new Set(), { ...HALYARD_LENS }, { ...MEMORY_RULES, forget: { slow: 0, medium: 0, fast: 0 } }).added).toBe(1)
  })

  test('forgetting and spacing: forget rate per lane, multiplied by spacing per re-taught session', () => {
    const f = fact('tessel-f1').fact
    const lost = (strength: number) => { let gone = 0; for (let s = 1; s <= 2000; s++) gone += updateNotebook(nb([f]), { [f.toLowerCase()]: strength }, [], 'medium', `${seed}${s}`, s, new Set(), HALYARD_LENS).forgotten; return gone / 2000 }
    expect(Math.abs(lost(0) - MEMORY_RULES.forget.medium)).toBeLessThan(0.03)
    expect(Math.abs(lost(1) - MEMORY_RULES.forget.medium * MEMORY_RULES.spacing)).toBeLessThan(0.03)
    // A fact the channel delivered again this session gains strength; one it did not keeps its strength.
    const kept = (exposed: string[]) => updateNotebook(nb([f]), {}, [], 'medium', 'keep', 1, new Set(exposed), HALYARD_LENS, { ...MEMORY_RULES, forget: { slow: 0, medium: 0, fast: 0 } }).strengths
    expect(kept(['tessel-f1'])).toEqual({ [f.toLowerCase()]: 1 })
    expect(kept(['tessel-f2'])).toEqual({ [f.toLowerCase()]: 0 })
  })

  test('ceiling: deterministic; with the rules on, oracle beats off and omniscient beats oracle in every lane', () => {
    expect(simulateLearner('oracle', 'medium', 3, 'x')).toBe(simulateLearner('oracle', 'medium', 3, 'x'))
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
})
