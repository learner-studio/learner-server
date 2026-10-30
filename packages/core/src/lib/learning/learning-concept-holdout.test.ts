import { describe, expect, test } from 'bun:test'
import { Client } from 'pg'
import { DEFAULT_LEARNING_POLICY } from '@learner/contract/learning/learning-policy.js'
import { heldOutConcepts, holdoutBucket, holdoutBucketSql, isHeldOut } from './learning-concept-holdout.js'
import { LIVE_CATALOG } from './learning-live-catalog.js'
import { prerequisitePolicy } from './learning-prerequisite-selection.js'
import { taskTeachingContext } from './learning-teaching-default.js'

const ids = LIVE_CATALOG.map((c) => c.id)
const held = heldOutConcepts(LIVE_CATALOG)
const taught = ids.filter((id) => !held.has(id))
const policy = prerequisitePolicy(DEFAULT_LEARNING_POLICY)

test('one concept in five of the live catalog is held out, by a stable hash', () => {
  expect(held.size / ids.length).toBeGreaterThan(0.15)
  expect(held.size / ids.length).toBeLessThan(0.25)
  expect(ids.every((id) => isHeldOut(id) === (holdoutBucket(id) === 0))).toBe(true)
  expect(heldOutConcepts(LIVE_CATALOG)).toEqual(held)
})

describe.skipIf(!process.env.TEST_DATABASE_URL)('the SQL assignment (GrowthBook) equals the TypeScript one', () => {
  test('for every live catalog concept', async () => {
    const client = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await client.connect()
    try {
      const rows = (await client.query<{ id: string; bucket: number }>(`SELECT id, ${holdoutBucketSql('id')} AS bucket FROM unnest($1::text[]) id`, [ids])).rows
      expect(rows.filter((r) => r.bucket !== holdoutBucket(r.id))).toEqual([])
    } finally { await client.end() }
  })
})

describe('a held-out concept is never a teaching target', () => {
  const catalog = LIVE_CATALOG.map((c) => ({ id: c.id, title: c.title }))
  const base = { catalog, assessments: [], suppressed: new Set<string>(), gaps: [], edges: [], foundationFirst: true, prerequisites: policy, heldOut: held }
  const h = [...held][0]!, t = taught[0]!, t2 = taught[1]!

  test('not the turn\'s main lesson, even with a remaining gap', () => {
    expect(taskTeachingContext({ ...base, ids: [h] }).conceptIds).toEqual([])
    expect(taskTeachingContext({ ...base, ids: [h], gaps: [{ conceptId: h, remainingGap: 'x' }] }).conceptIds).toEqual([])
    expect(taskTeachingContext({ ...base, ids: [h, t] }).conceptIds).toEqual([t])
    // Without the holdout the same turn teaches it.
    expect(taskTeachingContext({ ...base, heldOut: undefined, ids: [h, t] }).conceptIds).toContain(h)
  })

  test('not a prerequisite foundation', () => {
    const edges = [{ from: h, to: t, kind: 'hard-prerequisite' as const }, { from: t2, to: t, kind: 'hard-prerequisite' as const }]
    expect(taskTeachingContext({ ...base, heldOut: undefined, ids: [t], edges }).conceptIds).toContain(h)
    const packet = taskTeachingContext({ ...base, ids: [t], edges })
    expect(packet.conceptIds).not.toContain(h)
    expect(packet.conceptIds).toContain(t)
  })

  test('not in the review queue', () => {
    const now = new Date('2026-11-01T00:00:00Z')
    const old = new Date('2026-09-01T00:00:00Z')
    const edges = [{ from: h, to: t, kind: 'related' as const }, { from: t2, to: t, kind: 'related' as const }]
    const sr = (exposed: string[]) => ({ hops: 5, now, history: { exposures: new Map(exposed.map((id) => [id, old] as const)), offered: new Set<string>() } })
    expect(taskTeachingContext({ ...base, heldOut: undefined, ids: [t], edges, spacedRepetition: sr([h]) }).reviewConceptId).toBe(h)
    expect(taskTeachingContext({ ...base, ids: [t], edges, spacedRepetition: sr([h]) }).reviewConceptId).toBeNull()
    expect(taskTeachingContext({ ...base, ids: [t], edges, spacedRepetition: sr([h, t2]) }).reviewConceptId).toBe(t2)
  })
})
