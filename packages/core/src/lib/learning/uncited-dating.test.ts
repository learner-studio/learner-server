import { describe, expect, test } from 'bun:test'
import { datingErrors, percentileDisc, scoreQuantile, shapeOf, splitHalf, uncitedLike, type DatingCase } from './uncited-dating.js'

const DAY = 86_400_000
const days = (...d: number[]) => d.map((x) => x * DAY)

describe('uncited-reading dating evaluation (review N7)', () => {
  test('percentileDisc matches PostgreSQL percentile_disc', () => {
    // SELECT percentile_disc(q) WITHIN GROUP (ORDER BY x) FROM unnest('{1,2,3,4}'::int[]) x
    expect([0, 0.25, 0.26, 0.5, 0.75, 0.76, 1].map((q) => percentileDisc([1, 2, 3, 4], q))).toEqual([1, 1, 2, 2, 3, 4, 4])
    expect(percentileDisc([7], 0.75)).toBe(7)
  })
  test('errors are dated minus cited, in days, over cited cases only', () => {
    const cases: DatingCase[] = [
      { learnerAt: days(0, 1, 2, 3), citedAt: 2 * DAY }, // p75 = 2: exact
      { learnerAt: days(0, 10), citedAt: 0 },           // p75 = 10: +10
      { learnerAt: days(5), citedAt: null },            // uncited: not scored
    ]
    expect(datingErrors(cases, 0.75)).toEqual([0, 10])
    expect(scoreQuantile(cases, 0.75)).toEqual({ quantile: 0.75, n: 2, meanDays: 5, medianAbsDays: 5, meanAbsDays: 5 })
  })
  test('split half picks the unbiased quantile and is reproducible', () => {
    // The cited message is always the 3rd of 4: percentile 0.75 (index 2) is exact, 1.0 is a day late.
    const cases = Array.from({ length: 60 }, (_, i): DatingCase => ({ learnerAt: days(i, i + 1, i + 2, i + 3), citedAt: (i + 2) * DAY }))
    const r = splitHalf(cases, [0.5, 0.75, 1], 50, 3)
    expect(r.chosen).toEqual([{ quantile: 0.75, share: 1 }])
    expect(r.heldOutBias).toEqual({ median: 0, low: 0, high: 0 })
    expect(splitHalf(cases, [0.5, 0.75, 1], 50, 3)).toEqual(r)
  })
  test('uncited-like cases are contiguous runs of the drawn count and span that keep the cited message', () => {
    // Messages a day apart, so a run of m spans m − 1 days.
    const cases = Array.from({ length: 30 }, (_, i): DatingCase => ({ learnerAt: days(...Array.from({ length: 12 }, (_, k) => i + k)), citedAt: (i + 7) * DAY }))
    const shapes = [{ messages: 3, spanDays: 2 }, { messages: 5, spanDays: 4 }]
    const cut = uncitedLike(cases, shapes, 200, 9)
    expect(cut.length).toBe(200)
    for (const c of cut) {
      expect(shapes).toContainEqual(shapeOf(c))
      expect(c.learnerAt).toContain(c.citedAt!)
      for (let k = 1; k < c.learnerAt.length; k++) expect(c.learnerAt[k]! - c.learnerAt[k - 1]!).toBe(DAY)
    }
    expect(uncitedLike(cases, shapes, 200, 9)).toEqual(cut)
    // A span no run of that count has: skipped, never a mismatched stand-in.
    expect(uncitedLike(cases, [{ messages: 3, spanDays: 9 }], 10, 9)).toEqual([])
    expect(uncitedLike(cases, [{ messages: 50, spanDays: 49 }], 10, 9)).toEqual([])
  })
})
