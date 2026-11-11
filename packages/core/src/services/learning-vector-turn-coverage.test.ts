import { describe, expect, test } from 'bun:test'
import { MAX_UNVERIFIED_CHUNKS, partitionUnverifiedChunks } from './learning-vector-turn-service.js'

/**
 * Until 2026-11-11 any frozen indexed chunk without a vector refused EVERY concept
 * pass ("Native vector coverage incomplete: 4 frozen indexed chunks…", 238 failed
 * steps, 246 sessions breaker-blocked before any paid call). A handful of
 * content-free chunks cannot change a concept's evidence: they are recorded and
 * the pass continues; only a large gap (a bank that is really incomplete) refuses.
 */
describe('assessment coverage of frozen chunks', () => {
  const chunks = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }))
  test('a few unverified chunks are named and the rest proceed', () => {
    const result = partitionUnverifiedChunks(chunks, new Set(['a', 'c', 'e']))
    expect(result.unverified).toEqual(['b', 'd'])
    expect(result.verified.map(c => c.id)).toEqual(['a', 'c', 'e'])
  })
  test('full coverage records nothing', () => {
    expect(partitionUnverifiedChunks(chunks, new Set(chunks.map(c => c.id))).unverified).toEqual([])
  })
  test('more than the limit refuses the pass with the count', () => {
    const many = Array.from({ length: MAX_UNVERIFIED_CHUNKS + 1 }, (_, i) => ({ id: `c${i}` }))
    expect(() => partitionUnverifiedChunks(many, new Set())).toThrow(`Native vector coverage incomplete: ${MAX_UNVERIFIED_CHUNKS + 1} frozen indexed chunks have no embedding (limit ${MAX_UNVERIFIED_CHUNKS})`)
    expect(partitionUnverifiedChunks(many.slice(1), new Set()).unverified).toHaveLength(MAX_UNVERIFIED_CHUNKS)
  })
})
