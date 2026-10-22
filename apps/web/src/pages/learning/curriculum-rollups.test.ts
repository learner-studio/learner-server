import { expect, test } from 'bun:test'
import { NO_ROLLUP, rollupLabel } from './curriculum-rollups'

test('the label reads as completion, with how much of the lesson has been assessed', () => {
  expect(rollupLabel({ estimate: 20, known: 1, unknown: 3, required: 4, coverage: 25, complete: false })).toBe('20% complete · 1/4 assessed · 3 unknown')
  expect(rollupLabel({ estimate: 100, known: 1, unknown: 0, required: 1, coverage: 100, complete: true })).toBe('100% complete · 1/1 assessed · 0 unknown')
  expect(rollupLabel(NO_ROLLUP)).toBe('No concepts · 0/0 assessed · 0 unknown')
})
