import { describe, expect, test } from 'bun:test'
import { SIM_LANES, draw, forgetNotebook, learnNotebook, parseNotebook, renderNotebook, updateNotebook } from './learning-sim-memory.js'

describe('simulated learner memory', () => {
  test('round-trips facts by topic, however long the notebook grows', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ topic: `topic ${i}`, facts: Array.from({ length: 10 }, (_, j) => `fact ${i}.${j} about something`) }))
    const text = renderNotebook(entries)
    expect(text.length).toBeGreaterThan(10_000)
    expect(parseNotebook(text)).toEqual(entries)
    expect(parseNotebook('Halyard notes: tessel.\nepoch counts versions.')).toEqual([{ topic: 'notes', facts: ['Halyard notes: tessel.', 'epoch counts versions.'] }])
  })

  test('learns whole facts in order within the character budget; a restated fact is free', () => {
    const before = [{ topic: 'Tessel', facts: ['A tessel is immutable.'] }]
    // 18 + 23 = 41 characters fit in 45; the next fact does not, and the short one after it is over capacity too.
    const r = learnNotebook(before, [{ topic: 'tessel', facts: ['a tessel is  immutable.', 'It has a keel key.'] }, { topic: 'twin', facts: ['Twins share a keel key.', 'Twins are dropped.', 'Rare.'] }], 45)
    expect(r).toEqual({ entries: [{ topic: 'Tessel', facts: ['A tessel is immutable.', 'It has a keel key.'] }, { topic: 'twin', facts: ['Twins share a keel key.'] }], added: 2, used: 41, overCapacity: 2 })
  })

  test('forgetting is deterministic and close to the lane rate', () => {
    const entries = [{ topic: 't', facts: Array.from({ length: 2000 }, (_, i) => `fact ${i}`) }]
    const a = forgetNotebook(entries, SIM_LANES.slow.forget, 'seed', 2)
    expect(forgetNotebook(entries, SIM_LANES.slow.forget, 'seed', 2)).toEqual(a)
    expect(a.forgotten / 2000).toBeGreaterThan(0.05)
    expect(a.forgotten / 2000).toBeLessThan(0.11)
    expect(draw('x')).toBe(draw('x'))
  })

  test('a session forgets first, then learns', () => {
    const fact = (n: number) => `fact ${n} `.padEnd(40, 'x')
    const u = updateNotebook('', [{ topic: 'keel key', facts: [fact(1), fact(2), fact(3)] }], 'slow', 's', 1)
    expect(u).toMatchObject({ added: 2, used: 80, overCapacity: 1, forgotten: 0, facts: 2 })
    expect(SIM_LANES.slow.capacity).toBeLessThan(SIM_LANES.medium.capacity)
    expect(SIM_LANES.medium.capacity).toBeLessThan(SIM_LANES.fast.capacity)
  })
})
