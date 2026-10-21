import { describe, expect, test } from 'bun:test'
import { assessmentHash, conceptVersion, nodeVersionMatches } from './learning-concept-assessment.js'
import { metaDbQuery } from '../db-metadata/_shared.js'

const concept = { conceptId: 'control-group', title: 'Control groups', description: 'Hold conditions equal\nso the comparison is fair', objectives: ['Identify confounds', 'Keep one variable'] }

describe('canonical concept version', () => {
  test('a concept hashes the same after a real JSONB round trip, which reorders its keys', async () => {
    const stored = (await metaDbQuery<{ c: typeof concept }>('SELECT $1::jsonb AS c', [JSON.stringify(concept)])).rows[0]!.c
    // The bug this replaces: JSONB orders keys by length, so a hash of the serialized object moved.
    expect(Object.keys(stored)).not.toEqual(Object.keys(concept))
    expect(assessmentHash(stored)).not.toBe(assessmentHash(concept))
    expect(conceptVersion(stored)).toBe(conceptVersion(concept))
  })
  test('fields outside the concept definition never move the version; its content does', () => {
    expect(conceptVersion({ ...concept, nodeVersion: 'x', understandingPercent: 40 } as typeof concept)).toBe(conceptVersion(concept))
    expect(conceptVersion({ ...concept, title: 'Controls' })).not.toBe(conceptVersion(concept))
    expect(conceptVersion({ ...concept, objectives: [...concept.objectives].reverse() })).not.toBe(conceptVersion(concept))
  })
  test('rows written under either legacy key order still match, so the cache is not mass-invalidated', () => {
    const builderOrder = assessmentHash(concept)
    const jsonbOrder = assessmentHash({ title: concept.title, conceptId: concept.conceptId, objectives: concept.objectives, description: concept.description })
    for (const stored of [conceptVersion(concept), builderOrder, jsonbOrder]) expect(nodeVersionMatches(stored, concept)).toBe(true)
    expect(nodeVersionMatches(assessmentHash({ ...concept, title: 'Controls' }), concept)).toBe(false)
  })
})
