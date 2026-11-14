import { describe, expect, test } from 'bun:test'
import { simSlots, factBudget, HELD_OUT_PER_LEARNER, latinRow, stratifiedHoldout } from './learning-sim-design.js'
import { HALYARD_CATALOG, HALYARD_EDGES, HALYARD_TASKS, HALYARD_TERMS, termRegex } from './learning-sim-halyard.js'
import { factSheet, HALYARD_FACT_EXAM } from './learning-sim-facts.js'
import { agentReplyPrompt, anchorDirective } from './learning-sim-prompts.js'
import { heldOutOf, probeConcept, probeDraw, simPairKey, simPlan, SimLearnerConfig, SIM_ARMS, SIM_SHEETS } from './learning-sim-experiment.js'
import { draw } from './learning-sim-memory.js'
import { plannedCalls } from './learning-sim-analysis.js'

const ids = HALYARD_CATALOG.concepts.map((c) => c.id)
const runId = '00000000-0000-4000-8000-000000000002'

describe('simulated-learner design', () => {
  test('holdout: 3 of 13 per learner, every concept held out equally often over 13 learners of a cell', () => {
    const sets = Array.from({ length: 13 }, (_, k) => stratifiedHoldout(k, 'seed'))
    for (const s of sets) { expect(s.length).toBe(HELD_OUT_PER_LEARNER); expect(new Set(s).size).toBe(HELD_OUT_PER_LEARNER) }
    const counts = ids.map((id) => sets.filter((s) => s.includes(id)).length)
    expect(new Set(counts)).toEqual(new Set([3]))
    // Another seed is another permutation: the holdout is not a fixed set of concepts.
    expect(stratifiedHoldout(0, 'other')).not.toEqual(stratifiedHoldout(0, 'seed'))
  })

  test('task order is a Latin square: each brief in each session position once over 5 learners', () => {
    const rows = Array.from({ length: 5 }, (_, k) => latinRow(k))
    for (const row of rows) expect([...row].sort()).toEqual([0, 1, 2, 3, 4])
    for (let pos = 0; pos < 5; pos++) expect(new Set(rows.map((r) => r[pos])).size).toBe(5)
  })

  test('slots: arm randomized within lane, counts kept, holdout balanced per cell, deterministic per run', () => {
    const slots = simSlots(runId, ['slow', 'medium'], () => 16, ['off', 'on', 'anchor'], 5)
    expect(slots.length).toBe(96)
    expect(simSlots(runId, ['slow', 'medium'], () => 16, ['off', 'on', 'anchor'], 5)).toEqual(slots)
    for (const lane of ['slow', 'medium'] as const) {
      const l = slots.filter((s) => s.lane === lane)
      for (const arm of ['off', 'on', 'anchor']) expect(l.filter((s) => s.arm === arm).length).toBe(16)
      // Not blocked by arm: the arm sequence along the lane is shuffled.
      expect(l.map((s) => s.arm).join(',')).not.toBe([...l.map((s) => s.arm)].sort().join(','))
      expect(new Set(l.map((s) => s.factBudget))).toEqual(new Set([factBudget(lane)]))
      for (const arm of ['off', 'on', 'anchor']) {
        const counts = ids.map((id) => l.filter((s) => s.arm === arm && s.heldOut.includes(id)).length)
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
      }
    }
    expect(factBudget('slow')).toBeLessThan(factBudget('medium'))
    expect(factBudget('medium')).toBeLessThan(factBudget('fast'))
  })

  test('briefs: named concepts appear, unnamed ones do not, one unnamed per brief is not adjacent to a named one, all 13 exercised', () => {
    for (const t of HALYARD_TASKS) {
      // `named` is a term of the concept in the brief, by the grader's evidence rule (`termRegex`); BRIEFED rests on it.
      expect(Object.keys(HALYARD_TERMS).filter((id) => termRegex(HALYARD_TERMS[id]!).test(t.brief)).sort()).toEqual([...t.named].sort())
      const adjacent = (id: string) => HALYARD_EDGES.some(([a, b]) => (a === id && t.named.includes(b)) || (b === id && t.named.includes(a)))
      expect(t.unnamed.some((id) => !adjacent(id))).toBe(true)
    }
    expect(new Set(HALYARD_TASKS.flatMap((t) => t.conceptIds))).toEqual(new Set(ids))
  })

  test('fact channel: the sheet ids are the exam ids; the agent prompt carries no fact outside the sheets it was given', () => {
    for (const id of ids) expect(factSheet(id).facts.map((f) => f.id)).toEqual(HALYARD_FACT_EXAM.filter((q) => q.conceptId === id).map((q) => q.id))
    const prompt = agentReplyPrompt({ task: HALYARD_TASKS[0]!, messages: [], message: 'hi', extra: null, sheets: [factSheet(ids[0]!)], budget: { total: 2, left: 2 } })
    const listed = [...prompt.matchAll(/- \[([a-z-]+-f\d+)\]/g)].map((m) => m[1])
    expect(listed).toEqual(factSheet(ids[0]!).facts.map((f) => f.id))
    // The exam's other facts are not in the prompt.
    const other = HALYARD_FACT_EXAM.filter((q) => q.conceptId === ids[5]).map((q) => q.id)
    expect(other.some((id) => prompt.includes(`[${id}]`))).toBe(false)
  })

  test('plan: only on grades, never after the last session; every arm has the same probes, conversation and notebook; no exam step; anchor plans off\'s calls', () => {
    const base = { runId, learnerId: 'l1001', lane: 'slow', sessions: 5, turns: 3, transport: 'stub', learnerModel: { model: 'm', effort: 'low', timeoutSec: 1 }, agentModel: { model: 'm', effort: 'low', timeoutSec: 1 },
      heldOut: ids.slice(0, 3), taskOrder: [2, 3, 4, 0, 1], factBudget: 2, dayGap: 5 }
    expect([...SIM_ARMS]).toEqual(['on', 'off', 'anchor'])
    const [on, anchor, off] = (['on', 'anchor', 'off'] as const).map((arm) => SimLearnerConfig.parse({ ...base, arm }))
    expect([...heldOutOf(on!)]).toEqual(ids.slice(0, 3))
    const grades = (c: SimLearnerConfig) => simPlan(c).flatMap((s) => s.grades)
    expect(grades(off!)).toEqual([])
    expect(grades(anchor!)).toEqual([])
    expect(new Set(grades(on!).map((g) => g.session))).toEqual(new Set([1, 2, 3, 4]))
    const shape = (c: SimLearnerConfig) => simPlan(c).flatMap((s) => s.actions.map((a) => a.action))
    expect(new Set(shape(off!).map((a) => a.kind))).toEqual(new Set(['probe', 'learner', 'agent', 'notebook']))
    expect(shape(off!).filter((a) => a.kind === 'notebook').map((a) => a.session)).toEqual([1, 2, 3, 4, 5])
    expect(shape(on!)).toEqual(shape(off!))
    expect(shape(anchor!)).toEqual(shape(off!))
    // No Learner in the anchor arm: no match call and no grading, so its planned keys are off's, every role.
    expect(plannedCalls(anchor!)).toEqual(plannedCalls(off!))
    expect(plannedCalls(anchor!)['agent-match']).toBe(0)
    expect(plannedCalls(on!)['agent-match']).toBe(15)
    // Revision 10 (D.9): a probe before sessions 2-5, and the end probe (session = sessions + 1) after the last notebook.
    expect(shape(off!).filter((a) => a.kind === 'probe').map((a) => a.session)).toEqual([2, 3, 4, 5, 6])
    expect(simPlan(off!).at(-1)!.actions.map((a) => a.action.kind).slice(-2)).toEqual(['notebook', 'probe'])
    // Planned keys (design D.4): +2 per learner against revision 9 (the end probe and its grading).
    const total = (c: SimLearnerConfig) => Object.values(plannedCalls(c)).reduce((a, b) => a + b, 0)
    expect([total(on!), total(off!), total(anchor!)]).toEqual([107, 40, 40])
  })

  test('the anchor directive: the planned facts as id and sheet text, in plan order, in the reply prompt', () => {
    const planned = ['tessel-f2', 'tessel-f5', 'keel-key-f1', 'keel-key-f2', 'twin-rule-f1', 'twin-rule-f5', 'overbear-f1', 'overbear-f2']
    const sheets = SIM_SHEETS.map(factSheet)
    const text = anchorDirective(planned, sheets)
    const facts = sheets.flatMap((s) => s.facts)
    expect(text.startsWith('TEACHING PLAN for this session (from a tutor who has Sam\'s last exam)')).toBe(true)
    const at = planned.map((f) => text.indexOf(`${f}: ${facts.find((x) => x.id === f)!.fact}`))
    expect(at.every((i) => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(text.length).toBeGreaterThanOrEqual(550)
    expect(text.length).toBeLessThanOrEqual(800)
    const prompt = agentReplyPrompt({ task: HALYARD_TASKS[0]!, messages: [], message: 'Where do I start?', extra: text, sheets, budget: { total: 8, left: 8 } })
    expect(prompt).toContain(text)
    expect(() => anchorDirective(['no-such-f1'], sheets)).toThrow()
  })

  test('revision 10 (D.9): the probe series is A / B / A / B / A, deterministic, and arm-blind (a pair shares the draw)', () => {
    const facts = (k: number) => factSheet(ids[k]!).facts.map((f) => f.id)
    const config = (arm: 'on' | 'off' | 'anchor', learnerId: string, run = runId) => SimLearnerConfig.parse({ runId: run, learnerId, arm, lane: 'fast', pair: 3, sessions: 5, turns: 3, transport: 'stub',
      learnerModel: { model: 'm', effort: 'low', timeoutSec: 1 }, agentModel: { model: 'm', effort: 'low', timeoutSec: 1 }, heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 2, dayGap: 5 })
    const series = (c: SimLearnerConfig, delivered: string[][]) => [2, 3, 4, 5, 6].map((s) => probeConcept(c, s, delivered.slice(0, s - 1)))
    // Session 1 delivers concepts 0-3, session 2 adds 4-6.
    const delivered = [[0, 1, 2, 3].flatMap(facts), [4, 5, 6].flatMap(facts), facts(7), facts(8), facts(9)]
    const on = config('on', 'l3001')
    const [a, b] = series(on, delivered)
    expect(series(on, delivered)).toEqual([a, b, a, b, a])
    expect(ids.slice(0, 4)).toContain(a!)
    expect(ids.slice(0, 7).filter((x) => x !== a)).toContain(b!)
    expect(probeConcept(on, 1, [])).toBeNull()
    // A pair shares the draw: every arm (on, off, anchor) of pair 3 gets the same concepts from the same deliveries, and
    // the same ranks from different ones OF THE SAME SIZE (session 1: concepts 0-3 against 6-9), over 40 runs.
    for (let i = 0; i < 40; i++) {
      const run = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      const [x, y, z] = [config('on', 'l3001', run), config('off', 'l3002', run), config('anchor', 'l3003', run)]
      expect(series(x, delivered)).toEqual(series(y, delivered))
      expect(series(z, delivered)).toEqual(series(y, delivered))
      expect(series(x, delivered)[1]).not.toBe(series(x, delivered)[0]) // B != A while session 2 delivered another concept
      const other = [[6, 7, 8, 9].flatMap(facts), [10, 11, 12].flatMap(facts), [], [], []]
      const sorted = (ks: number[]) => ks.map((k) => ids[k]!).sort()
      expect(sorted([6, 7, 8, 9]).indexOf(probeConcept(y, 2, other.slice(0, 1))!)).toBe(sorted([0, 1, 2, 3]).indexOf(probeConcept(x, 2, delivered.slice(0, 1))!))
    }
    // The end probe asks A whatever the parity of sessions + 1 (here 4 sessions: the end probe is session 5).
    const four = SimLearnerConfig.parse({ ...on, sessions: 4 })
    expect(probeConcept(four, 5, delivered.slice(0, 4))).toBe(a)
    // With one concept ever delivered, B is A; with nothing in session 1 there is no A (sessions 2, 4 and the end ask nothing).
    expect(series(on, [facts(5), [], [], [], []])).toEqual(Array(5).fill(ids[5]))
    const late = series(on, [[], facts(5), [], [], []])
    expect(late).toEqual([null, ids[5], null, ids[5], null])
  })

  test('revision 10 (D.9): what the pair shares is the uniform draw, not the rank: each learner indexes its own delivered set with it', () => {
    const facts = (k: number) => factSheet(ids[k]!).facts.map((f) => f.id)
    const config = (arm: 'on' | 'off' | 'anchor', learnerId: string, run: string, pair = 3) => SimLearnerConfig.parse({ runId: run, learnerId, arm, lane: 'fast', pair, sessions: 5, turns: 3, transport: 'stub',
      learnerModel: { model: 'm', effort: 'low', timeoutSec: 1 }, agentModel: { model: 'm', effort: 'low', timeoutSec: 1 }, heldOut: [], taskOrder: [0, 1, 2, 3, 4], factBudget: 2, dayGap: 5 })
    const sorted = (ks: number[]) => ks.map((k) => ids[k]!).sort()
    // The two learners of a pair delivered session-1 sets of different sizes (3 concepts against 5), as arms do.
    const small = [[0, 1, 2].flatMap(facts), [3].flatMap(facts)], large = [[4, 5, 6, 7, 8].flatMap(facts), [9, 10].flatMap(facts)]
    let rankDiffers = 0
    for (let i = 0; i < 40; i++) {
      const run = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
      const [x, y, z] = [config('on', 'l3001', run), config('off', 'l3002', run), config('anchor', 'l3003', run)]
      for (const s of [2, 3]) {
        // One uniform draw per pair and probe key (work order: `${runId}|${pairKey}|probe${session}`), whatever the arm or learner.
        expect(probeDraw(x, s)).toBe(draw(`${run}|${simPairKey(x)}|probe${s}`))
        expect([probeDraw(y, s), probeDraw(z, s)]).toEqual([probeDraw(x, s), probeDraw(x, s)])
      }
      expect(probeDraw(config('on', 'l3001', run, 4), 2)).not.toBe(probeDraw(x, 2))
      // A is the learner's own sorted session-1 set at floor(u x size); B the same over sessions 1-2 minus A.
      const expected = (d: number[][], u2: number, u3: number) => {
        const s1 = sorted(d[0]!), a = s1[Math.floor(u2 * s1.length)]!, rest = sorted([...d[0]!, ...d[1]!]).filter((k) => k !== a)
        return [a, rest[Math.floor(u3 * rest.length)]!]
      }
      const [u2, u3] = [probeDraw(x, 2), probeDraw(x, 3)]
      expect([probeConcept(x, 2, small.slice(0, 1)), probeConcept(x, 3, small)]).toEqual(expected([[0, 1, 2], [3]], u2, u3))
      expect([probeConcept(y, 2, large.slice(0, 1)), probeConcept(y, 3, large)]).toEqual(expected([[4, 5, 6, 7, 8], [9, 10]], u2, u3))
      expect([probeConcept(z, 2, large.slice(0, 1)), probeConcept(z, 3, large)]).toEqual([probeConcept(y, 2, large.slice(0, 1)), probeConcept(y, 3, large)])
      // The rank is shared only when the sizes are: here, sizes 3 and 5, it differs in some runs (the e2e's case).
      if (sorted([0, 1, 2]).indexOf(probeConcept(x, 2, small.slice(0, 1))!) !== sorted([4, 5, 6, 7, 8]).indexOf(probeConcept(y, 2, large.slice(0, 1))!)) rankDiffers++
    }
    expect(rankDiffers).toBeGreaterThan(0)
  })
})
