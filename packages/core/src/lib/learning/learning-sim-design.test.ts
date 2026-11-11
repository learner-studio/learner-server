import { describe, expect, test } from 'bun:test'
import { batch2Slots, factBudget, HELD_OUT_PER_LEARNER, latinRow, stratifiedHoldout } from './learning-sim-design.js'
import { conceptsNamedIn, HALYARD_CATALOG, HALYARD_EDGES, HALYARD_TASKS_V2 } from './learning-sim-halyard.js'
import { factSheet, HALYARD_FACT_EXAM } from './learning-sim-facts.js'
import { agentReplyPromptV2 } from './learning-sim-prompts.js'
import { V2_POLICY, armPolicy, heldOutOf, simActions, SimLearnerConfig } from './learning-sim-experiment.js'
import { BATCH2_PREREGISTRATION } from './learning-sim-analysis.js'

const ids = HALYARD_CATALOG.concepts.map((c) => c.id)
const runId = '00000000-0000-4000-8000-000000000002'

describe('batch 2 design', () => {
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
    const slots = batch2Slots(runId, ['slow', 'medium'], () => 16, ['off', 'on', 'oracle'], 5)
    expect(slots.length).toBe(96)
    expect(batch2Slots(runId, ['slow', 'medium'], () => 16, ['off', 'on', 'oracle'], 5)).toEqual(slots)
    for (const lane of ['slow', 'medium'] as const) {
      const l = slots.filter((s) => s.lane === lane)
      for (const arm of ['off', 'on', 'oracle']) expect(l.filter((s) => s.arm === arm).length).toBe(16)
      // Not blocked by arm: the arm sequence along the lane is shuffled.
      expect(l.map((s) => s.arm).join(',')).not.toBe([...l.map((s) => s.arm)].sort().join(','))
      expect(new Set(l.map((s) => s.factBudget))).toEqual(new Set([factBudget(lane)]))
      for (const arm of ['off', 'on', 'oracle']) {
        const counts = ids.map((id) => l.filter((s) => s.arm === arm && s.heldOut.includes(id)).length)
        expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
      }
    }
    expect(factBudget('slow')).toBeLessThan(factBudget('medium'))
    expect(factBudget('medium')).toBeLessThan(factBudget('fast'))
  })

  test('briefs: named concepts appear, unnamed ones do not, one unnamed per brief is not adjacent to a named one, all 13 exercised', () => {
    for (const t of HALYARD_TASKS_V2) {
      expect(conceptsNamedIn(t.brief).sort()).toEqual([...t.named].sort())
      const adjacent = (id: string) => HALYARD_EDGES.some(([a, b]) => (a === id && t.named.includes(b)) || (b === id && t.named.includes(a)))
      expect(t.unnamed.some((id) => !adjacent(id))).toBe(true)
    }
    expect(new Set(HALYARD_TASKS_V2.flatMap((t) => t.conceptIds))).toEqual(new Set(ids))
  })

  test('fact channel: the sheet ids are the exam ids; the agent prompt carries no fact outside the sheets it was given', () => {
    for (const id of ids) expect(factSheet(id).facts.map((f) => f.id)).toEqual(HALYARD_FACT_EXAM.filter((q) => q.conceptId === id).map((q) => q.id))
    const prompt = agentReplyPromptV2({ task: HALYARD_TASKS_V2[0]!, messages: [], message: 'hi', extra: null, sheets: [factSheet(ids[0]!)], budget: { total: 2, left: 2 }, catalog: [...HALYARD_CATALOG.concepts] })
    const listed = [...prompt.matchAll(/- \[([a-z-]+-f\d+)\]/g)].map((m) => m[1])
    expect(listed).toEqual(factSheet(ids[0]!).facts.map((f) => f.id))
    // The exam's other facts are not in the prompt verbatim (the narrative manual is, as in every arm).
    const other = HALYARD_FACT_EXAM.filter((q) => q.conceptId === ids[5]).map((q) => q.id)
    expect(other.some((id) => prompt.includes(`[${id}]`))).toBe(false)
  })

  test('configs: on and oracle share the policy (spaced repetition on); off never grades; only on grades, never after the last session; no baseline exam', () => {
    const base = { runId, learnerId: 'l1001', lane: 'slow', sessions: 5, turns: 3, transport: 'stub', learnerModel: { model: 'm', effort: 'low', timeoutSec: 1 }, agentModel: { model: 'm', effort: 'low', timeoutSec: 1 }, scorerModel: { model: 'm', effort: 'low', timeoutSec: 1 },
      design: 'v2', heldOut: ids.slice(0, 3), taskOrder: [2, 3, 4, 0, 1], factBudget: 2, dayGap: 5 }
    const on = SimLearnerConfig.parse({ ...base, arm: 'on' }), oracle = SimLearnerConfig.parse({ ...base, arm: 'oracle' }), off = SimLearnerConfig.parse({ ...base, arm: 'off' })
    expect(armPolicy(on)).toEqual(V2_POLICY)
    expect(armPolicy(oracle)).toEqual(V2_POLICY)
    expect(V2_POLICY.spacedRepetition).toBe(true)
    expect([...heldOutOf(on)]).toEqual(ids.slice(0, 3))
    const grades = (c: SimLearnerConfig) => simActions(c).filter((a) => a.kind === 'grade')
    expect(grades(off)).toEqual([])
    expect(grades(oracle)).toEqual([])
    expect(new Set(grades(on).map((a) => a.session))).toEqual(new Set([1, 2, 3, 4]))
    expect(simActions(off).filter((a) => a.kind === 'exam-answer').map((a) => a.session)).toEqual([1, 2, 3, 4, 5])
    // Every arm has the same learner, agent and notebook actions.
    const shape = (c: SimLearnerConfig) => simActions(c).filter((a) => a.kind !== 'grade')
    expect(shape(on)).toEqual(shape(off))
    expect(shape(oracle)).toEqual(shape(off))
  })

  test('pre-registration names a primary that does not reward moving teaching between concepts', () => {
    expect(BATCH2_PREREGISTRATION.primary.estimand).toContain('Whole-exam gain')
    expect(BATCH2_PREREGISTRATION.changedFromDesign).toContain('favours arm on by construction')
  })
})
