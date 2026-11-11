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

  test('learns new facts in order up to capacity; a restated fact is free', () => {
    const before = [{ topic: 'Tessel', facts: ['A tessel is immutable.'] }]
    const r = learnNotebook(before, [{ topic: 'tessel', facts: ['a tessel is  immutable.', 'It has a keel key.'] }, { topic: 'twin', facts: ['Twins share a keel key.', 'Twins are dropped.'] }], 2)
    expect(r).toEqual({ entries: [{ topic: 'Tessel', facts: ['A tessel is immutable.', 'It has a keel key.'] }, { topic: 'twin', facts: ['Twins share a keel key.'] }], added: 2, overCapacity: 1 })
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
    const u = updateNotebook('', [{ topic: 'keel key', facts: ['origin and epoch', 'ordered by epoch', 'arrival time ignored'] }], 'slow', 's', 1)
    expect(u).toMatchObject({ added: 2, overCapacity: 1, forgotten: 0, facts: 2 })
    expect(SIM_LANES.slow.capacity).toBeLessThan(SIM_LANES.medium.capacity)
    expect(SIM_LANES.medium.capacity).toBeLessThan(SIM_LANES.fast.capacity)
  })
})
