import { describe, expect, test } from 'bun:test'
import { REVIEW_HOPS_ALL, REVIEW_UNSCORED_DAYS, reviewIntervalDays } from '@learner/contract/learning/learning-policy.js'
import { relatedHops, reviewQueue, selectReview, type ReviewHistory } from './learning-spaced-repetition.js'

const DAY = 86_400_000
const now = new Date('2026-10-23T00:00:00Z')
const ago = (days: number) => new Date(now.getTime() - days * DAY)
const rel = (from: string, to: string) => ({ from, to, kind: 'related' })
const pre = (from: string, to: string) => ({ from, to, kind: 'hard-prerequisite' })
// t - a - b - c - d - e - f   (a chain: a is 1 hop from t, f is 6), plus a cycle a->x->y->a
// and an island z1 - z2 with no path to t.
const edges = [rel('t', 'a'), pre('a', 'b'), rel('c', 'b'), pre('c', 'd'), rel('d', 'e'), rel('e', 'f'), pre('a', 'x'), pre('x', 'y'), pre('y', 'a'), rel('z1', 'z2')]
const catalogIds = ['t', 'a', 'b', 'c', 'd', 'e', 'f', 'x', 'y', 'z1', 'z2', 'never']
const history = (entries: Record<string, number>, offered: string[] = []): ReviewHistory =>
  ({ exposures: new Map(Object.entries(entries).map(([id, days]) => [id, ago(days)])), offered: new Set(offered) })
const queue = (h: ReviewHistory, overrides: Partial<Parameters<typeof reviewQueue>[0]> = {}) =>
  reviewQueue({ now, history: h, scores: new Map(), edges, catalogIds, turnConceptIds: ['t'], excluded: new Set(), ...overrides })

describe('schedule', () => {
  test('mastery bands double the interval; unscored is its own middle interval', () => {
    expect([0, 19, 20, 39, 40, 59, 60, 79, 80, 100].map(reviewIntervalDays)).toEqual([1, 1, 2, 2, 4, 4, 8, 8, 16, 16])
    expect(reviewIntervalDays(null)).toBe(REVIEW_UNSCORED_DAYS)
    expect(REVIEW_UNSCORED_DAYS).toBe(3)
  })
  test('due exactly at the interval, not a moment before', () => {
    const scores = new Map([['a', 50]])
    expect(queue(history({ a: 4 }), { scores }).map((e) => e.conceptId)).toEqual(['a'])
    expect(queue(history({ a: 3.99 }), { scores })).toEqual([])
  })
  test('an unscored concept is due after 3 days, a weak one after 1', () => {
    expect(queue(history({ a: 2 }))).toEqual([])
    expect(queue(history({ a: 3 })).map((e) => e.conceptId)).toEqual(['a'])
    expect(queue(history({ a: 1 }), { scores: new Map([['a', 10]]) }).map((e) => e.conceptId)).toEqual(['a'])
  })
})

describe('relatedness: undirected, both edge kinds, cycle safe', () => {
  test('shortest hop distance and the nearest turn concept', () => {
    const hops = relatedHops({ edges, catalogIds, from: ['t'] })
    expect(Object.fromEntries([...hops].map(([id, h]) => [id, h.hops]))).toEqual({ a: 1, b: 2, x: 2, y: 2, c: 3, d: 4, e: 5, f: 6 })
    expect(hops.get('f')!.relatedTo).toBe('t')
    expect(hops.has('z1')).toBe(false)
    expect(hops.has('t')).toBe(false)
  })
  test('several turn concepts: the nearest one wins', () => {
    const hops = relatedHops({ edges, catalogIds, from: ['t', 'e'] })
    expect(hops.get('f')).toEqual({ hops: 1, relatedTo: 'e' })
    expect(hops.get('c')).toEqual({ hops: 2, relatedTo: 'e' })
  })
  test('edges outside the catalog and self loops are ignored', () => {
    const hops = relatedHops({ edges: [...edges, rel('t', 'ghost'), rel('ghost', 'z1'), rel('t', 't')], catalogIds, from: ['t'] })
    expect(hops.has('z1')).toBe(false)
    expect(hops.has('ghost')).toBe(false)
  })
})

describe('queue', () => {
  test('most overdue first; ties by nearer hop, then ID; unreachable last among equals', () => {
    const h = history({ z1: 6, b: 6, a: 6, c: 9 })
    expect(queue(h).map((e) => [e.conceptId, e.hops])).toEqual([['c', 3], ['a', 1], ['b', 2], ['z1', null]])
    expect(queue(history({ x: 5, y: 5 })).map((e) => e.conceptId)).toEqual(['x', 'y'])
  })
  test('the overdue ratio uses mastery: a weak concept seen 2 days ago beats a strong one seen 10', () => {
    const scores = new Map([['a', 10], ['b', 90]])
    expect(queue(history({ a: 2, b: 20 }), { scores }).map((e) => [e.conceptId, e.intervalDays, e.overdue])).toEqual([['a', 1, 2], ['b', 16, 1.25]])
  })
  test('exclusions: never exposed, outside the catalog, the turn itself, suppressed, offered', () => {
    const h = history({ t: 30, ghost: 30, a: 30, b: 30, c: 30 }, ['b'])
    expect(queue(h, { excluded: new Set(['a']) }).map((e) => e.conceptId)).toEqual(['c'])
    expect(queue(h).some((e) => e.conceptId === 'never')).toBe(false)
  })
})

describe('selection by hop distance', () => {
  const h = history({ a: 4, b: 5, c: 6, d: 7, e: 8, f: 9, z1: 10 })
  const pick = (hops: number) => selectReview(queue(h), hops)?.conceptId ?? null
  test('the head of the queue is used only when related; otherwise walk on', () => {
    // queue order by urgency: z1 (unreachable), f(6), e(5), d(4), c(3), b(2), a(1)
    expect(queue(h).map((e) => e.conceptId)).toEqual(['z1', 'f', 'e', 'd', 'c', 'b', 'a'])
    expect([1, 2, 3, 4].map(pick)).toEqual(['a', 'b', 'c', 'd'])
  })
  test('each hop setting reaches exactly its distance; 5 means all, unreachable never', () => {
    expect(pick(1)).toBe('a')
    expect(pick(2)).toBe('b')
    expect(pick(3)).toBe('c')
    expect(pick(4)).toBe('d')
    expect(pick(REVIEW_HOPS_ALL)).toBe('f')
    expect(selectReview(queue(history({ z1: 10 })), REVIEW_HOPS_ALL)).toBeNull()
  })
  test('a skip set moves the review to the next related entry', () => {
    expect(selectReview(queue(h), 4, new Set(['d']))?.conceptId).toBe('c')
  })
  test('no turn concepts means nothing is related', () => {
    expect(selectReview(queue(h, { turnConceptIds: [] }), REVIEW_HOPS_ALL)).toBeNull()
  })
})
