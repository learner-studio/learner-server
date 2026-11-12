import { describe, expect, test } from 'bun:test'
import { liveFeedbackContext } from '@learner/contract/learning/learning-live-hook.js'
import { LIVE_FEEDBACK_INSTRUCTIONS } from './learning-live-feedback.js'
import { HALYARD_CATALOG, HALYARD_MANUAL, HALYARD_TASKS } from './learning-sim-halyard.js'
import { factSheet } from './learning-sim-facts.js'
import { agentReplyPrompt, hookExtra, learnerTurnPrompt, probePrompt, probeQuestion, REPLY_SCHEMA } from './learning-sim-prompts.js'
import { EXAM_FACTS, examLeaks, factsIn, HALYARD_LENS, REDACTED, redactReply, TITLE_ANSWERS } from './learning-sim-matcher.js'
import { MEMORY_RULES, SIM_LANES, draw, parseNotebook, renderNotebook, updateNotebook } from './learning-sim-memory.js'
import { ceilingTable, simulateLearner } from './learning-sim-ceiling.js'
import { factBudget, williamsRow } from './learning-sim-design.js'
import { analyzeSimRun, blindProbes, changeReportVerdict, learnerEcho, learnerOverlaps } from './learning-sim-analysis.js'
import { examResult } from './learning-sim-experiment.js'
import { HALYARD_FACT_EXAM } from './learning-sim-facts.js'

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
    expect(factsIn('Under the twin rule, if two tessels share a keel key, the first one to arrive wins.')).toContain('twin-rule-f3')
    expect(factsIn('Alpine cushion plants grow as dense low domes that trap warm air.')).toEqual([])
    // A command answer with a placeholder is given by the command with a real name (the probe's missed mooring-f8).
    expect(factsIn('Retire depot-sync properly with `halyard unmoor depot-sync`.')).toContain('mooring-f8')
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

  test('a claimed fact the matcher misses is placed in its best sentence and budgeted or redacted there; unclaimed, it passes', () => {
    // The pilot's main leak: the agent's paraphrase (draft-limit-f6) the lexical matcher does not find.
    const offered = new Set(factSheet(fact('draft-limit-f1').conceptId).facts.map((f) => f.id))
    const paraphrase = 'Raising the limit to 512 would not increase the processing rate of billing-v2.'
    const reply = `Here is the plan. ${fact('draft-limit-f1').fact} Then we check the logs. ${paraphrase}`
    expect(factsIn(paraphrase)).toEqual([])
    // Unclaimed: the paraphrase reaches the learner and is not counted (the residual the unbudgeted check measures).
    expect(redactReply(reply, offered, new Set(), 1)).toMatchObject({ text: reply, budgeted: ['draft-limit-f1'] })
    // Claimed and over budget: that sentence, and only that one, is removed.
    expect(redactReply(reply, offered, new Set(), 1, new Set(['draft-limit-f6']))).toMatchObject({
      text: `Here is the plan. ${fact('draft-limit-f1').fact} Then we check the logs. ${REDACTED}`, budgeted: ['draft-limit-f1'], overBudget: ['draft-limit-f6'] })
    // Claimed and within budget: kept and counted as delivered.
    expect(redactReply(reply, offered, new Set(), 2, new Set(['draft-limit-f6']))).toMatchObject({ text: reply, budgeted: ['draft-limit-f1', 'draft-limit-f6'], attributed: ['draft-limit-f6'] })
    // A claim the matcher already found is not placed twice.
    expect(redactReply(reply, offered, new Set(), 0, new Set(['draft-limit-f1'])).text).toBe(`Here is the plan. ${REDACTED} Then we check the logs. ${paraphrase}`)
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
    const rules = { ...MEMORY_RULES, forget: { none: 1, slow: 0, medium: 0, fast: 0 } }
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
    for (const f of twin) expect(updateNotebook(withKeel, {}, [{ topic: 't', facts: [f.fact] }], 'fast', seed, 1, new Set(), { ...HALYARD_LENS }, { ...MEMORY_RULES, forget: { none: 1, slow: 0, medium: 0, fast: 0 } }).added).toBe(1)
  })

  test('forgetting and spacing: forget rate per lane, multiplied by spacing per re-taught session', () => {
    const f = fact('tessel-f1').fact
    const lost = (strength: number) => { let gone = 0; for (let s = 1; s <= 2000; s++) gone += updateNotebook(nb([f]), { [f.toLowerCase()]: strength }, [], 'medium', `${seed}${s}`, s, new Set(), HALYARD_LENS).forgotten; return gone / 2000 }
    expect(Math.abs(lost(0) - MEMORY_RULES.forget.medium)).toBeLessThan(0.03)
    expect(Math.abs(lost(1) - MEMORY_RULES.forget.medium * MEMORY_RULES.spacing)).toBeLessThan(0.03)
    // A fact the channel delivered again this session gains strength; one it did not keeps its strength.
    const kept = (exposed: string[]) => updateNotebook(nb([f]), {}, [], 'medium', 'keep', 1, new Set(exposed), HALYARD_LENS, { ...MEMORY_RULES, forget: { none: 1, slow: 0, medium: 0, fast: 0 } }).strengths
    expect(kept(['tessel-f1'])).toEqual({ [f.toLowerCase()]: 1 })
    expect(kept(['tessel-f2'])).toEqual({ [f.toLowerCase()]: 0 })
  })

  test('ceiling: deterministic; with the rules on, oracle beats off and omniscient beats oracle in every lane', () => {
    expect(simulateLearner('oracle', 'medium', 3, 'x')).toEqual(simulateLearner('oracle', 'medium', 3, 'x'))
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
   * unbudgeted knowledge gated on the final exam with the arms within 0.2, and the delivered-only sensitivity series
   * (learning-sim-analysis.ts). This pins the measured recall.
   */
  test('the channel stops 4 of the reviewer\'s 24 loose paraphrases and 15 of 24 fresh ones (B2 recall, measured)', () => {
    const reviewer: Array<[string, string]> = [
      ['draft-limit-f2', 'Out of the box a mooring tolerates sixty-four outstanding unacked events.'],
      ['draft-limit-f2', 'The cap on unacknowledged items is 64 unless you change it.'],
      ['draft-limit-f4', 'Hitting that cap never loses or refuses a message; nothing is thrown away.'],
      ['draft-limit-f5', 'Making the cap bigger just eats more RAM on the consumer side.'],
      ['draft-limit-f6', 'A bigger cap will not speed up how quickly the consumer works through its backlog.'],
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
    expect([...reviewer, ...fresh].every(([id]) => EXAM_FACTS.some((f) => f.id === id))).toBe(true)
    expect([reviewer.length, fresh.length]).toEqual([24, 24])
    expect([stopped(reviewer), stopped(fresh)]).toEqual([4, 15]) // 13 before placeholders such as <name> stopped counting as content (revision 7)
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
  const learner = (arm: string, lane: string, known: number, o: { leak?: number; incomplete?: boolean; calls?: Array<{ invocations: number; attempts: number }> } = {}) => {
    const facts = ids.slice(0, known), last = Object.fromEntries([...facts, ...ids.slice(known, known + (o.leak ?? 0))].map((id) => [id, 2]))
    const exams = [0, 1, 2, 3, 4, 5].filter((t) => !(o.incomplete && t === 5)).map((t) => examResult(t, t === 0 ? {} : t === 5 ? last : Object.fromEntries(facts.map((id) => [id, 2]))))
    return { config: { arm, lane, sessions: 5, learnerId: `l${++n}`, heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 8 }, userId: `u${n}`, exams, readings: [], notifications: [],
      agentTurns: [1, 2].map((session) => ({ session, turn: 1, decision: 'none', conceptIds: [], statedFactIds: facts, invalidFacts: 0, review: null, claimedFactIds: facts, unofferedFacts: [], overBudgetFacts: [], redacted: 0 })),
      notebooks: [], calls: o.calls ?? [], probes: [], learnerOverlaps: [], doubleScores: [] }
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
  const main = (o: { oracleLeak?: number; oracleIncomplete?: number; slowHigh?: boolean; controls?: unknown[] } = {}) => [
    ...Array.from({ length: 30 }, (_, i) => learner('off', 'fast', spread(14, i))),
    ...Array.from({ length: 30 }, (_, i) => learner('on', 'fast', spread(24, i))),
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
    // 1 learner-session x (104 - known) summed over its 3 learners: its interim exam level).
    const ms = Object.values(r.mechanism)
    expect(new Set(ms.map((m) => m.misses)).size).toBe(1)
    expect(new Set(ms.map((m) => m.alreadyRightShare)).size).toBe(1)
    expect(ms[0]!.misses).toBe([13, 15, 20, 20, 24, 26, 24, 2, 6].reduce((n, k) => n + 104 - k, 0))
    const main = analyzeSimRun(pilot(0), { ...verified, mainPerArm: 3 }).mechanism
    expect(main.on!.misses).not.toBe(main.off!.misses) // a main-sized run keeps them by arm
    // Review 3, S3: the retry share sizes the main cap: 5 paid invocations over 4 call keys.
    expect(r.cost.retryShare).toBeCloseTo(0.25, 9)
    // Whole-exam totals (104 facts, 2 points each): independent pooled SD of the on and off gains.
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
    expect(updateNotebook('', {}, [{ topic: 't', facts: ['a tessel is immutable.'] }], 'none', 's', 1, new Set(), HALYARD_LENS)).toMatchObject({ added: 0, overCapacity: 1, text: '' })
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
