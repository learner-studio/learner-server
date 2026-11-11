import { describe, expect, test } from 'bun:test'
import { mergeNotebook, parseNotebook, renderNotebook } from './learning-sim-experiment.js'

describe('simulated learner notebook', () => {
  test('keeps every untouched entry verbatim and rewrites a topic in place', () => {
    const before = [{ topic: 'Tessel', notes: 'immutable record: keel key, payload, ballast' }, { topic: 'epoch', notes: 'version counter' }]
    const after = mergeNotebook(before, [{ topic: 'tessel', notes: 'immutable; fix by lofting a rebraid' }, { topic: 'twin', notes: 'duplicate, dropped' }])
    expect(after).toEqual([{ topic: 'Tessel', notes: 'immutable; fix by lofting a rebraid' }, { topic: 'epoch', notes: 'version counter' }, { topic: 'twin', notes: 'duplicate, dropped' }])
  })

  test('round-trips through the stored text, however long it grows', () => {
    const entries = Array.from({ length: 40 }, (_, i) => ({ topic: `topic ${i}`, notes: `notes ${i} `.repeat(50).trim() }))
    const text = renderNotebook(entries)
    expect(text.length).toBeGreaterThan(15_000)
    expect(parseNotebook(text)).toEqual(entries)
  })

  test('a notebook stored before topics existed survives as one entry', () => {
    expect(parseNotebook('Halyard notes: tessel, epoch.')).toEqual([{ topic: 'notes', notes: 'Halyard notes: tessel, epoch.' }])
    expect(parseNotebook('')).toEqual([])
  })
})
