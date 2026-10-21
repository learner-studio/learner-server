import { describe, expect, test } from 'bun:test'
import { foundationOrder } from './learning-foundation-priority.js'
import { resolveRetrievalLookup } from './learning-playground-retrieval.js'
import { LearningPlaygroundLookupOutput } from './learning-playground.js'
import type { LearningConceptAssessment } from './learning-concept-assessment.js'

const edge = (from: string, to: string, kind = 'hard-prerequisite') => ({ from, to, kind })
const cache = (id: string, source = id): LearningConceptAssessment & { sourceIds: string[] } => ({
  conceptId: id, sourceIds: [source], status: 'ready', runId: 'test', assessedAt: null,
  assessment: { conceptId: id, nodeVersion: 'a'.repeat(64), understandingPercent: null, confidence: 'insufficient', needsReview: true,
    demonstrated: [], gaps: [{ kind: 'untested', description: 'Not demonstrated', sourceId: null, quote: null }], nextCheck: 'Explain why?' },
})

describe('foundation-first retrieval policy', () => {
  test('orders transitive prerequisites without adding missing intermediate concepts', () => {
    expect(foundationOrder(['advanced', 'basic'], [edge('basic','middle'),edge('middle','advanced')])).toEqual(['basic','advanced'])
  })
  test('ignores related edges and preserves relevance between unrelated concepts', () => {
    expect(foundationOrder(['advanced','basic'], [edge('basic','advanced','related')])).toEqual(['advanced','basic'])
  })
  test('cycles terminate in stable relevance order', () => {
    expect(foundationOrder(['b','a','c'], [edge('a','b'),edge('b','a'),edge('b','c')])).toEqual(['b','a','c'])
  })
  test('parameter toggles hierarchy with retrieval rank and stable ID tie-break', () => {
    const hits = [{ messageId:'advanced' },{ messageId:'basic' }]
    const input = { fixtureId:'test', dependencyEdges:[edge('basic','advanced')] }
    const caches = [cache('basic'),cache('advanced')]
    expect(resolveRetrievalLookup(input,hits,caches).matches.map(c=>c.conceptId)).toEqual(['advanced','basic'])
    const enabled=resolveRetrievalLookup({...input,foundationFirst:true},hits,caches)
    expect(enabled.matches.map(c=>c.conceptId)).toEqual(['basic','advanced'])
    expect(enabled.context).toContain('Two concepts is a ceiling, not a quota')
    expect(enabled.context).toContain('at most one brief understanding probe')
    expect(enabled.invocationCount).toBe(0)
    expect(resolveRetrievalLookup(input,[{messageId:'shared'}],[cache('z','shared'),cache('a','shared')]).matches.map(c=>c.conceptId)).toEqual(['a','z'])
  })
  test('ranks before top-five limit; excludes nonmatching and stale prerequisites', () => {
    const caches=['a','b','c','d','e','foundation'].map(id=>cache(id,'shared'))
    const out=resolveRetrievalLookup({fixtureId:'test',foundationFirst:true,dependencyEdges:[edge('foundation','a')]},[{messageId:'shared'}],caches)
    expect(out.matches.map(c=>c.conceptId)).toContain('foundation')
    const excluded=resolveRetrievalLookup({fixtureId:'test',foundationFirst:true,dependencyEdges:[edge('basic','advanced')]},[{messageId:'advanced'}],[cache('basic'),cache('advanced')])
    expect(excluded.matches.map(c=>c.conceptId)).toEqual(['advanced'])
    expect(resolveRetrievalLookup({fixtureId:'test',foundationFirst:true},[{messageId:'basic'}],[{...cache('basic'),status:'stale'}]).context).toBe('')
  })
  test('long packets obey total context schema and preserve whole JSON; failure remains empty', () => {
    const caches=['a','b','c','d','e'].map(id=>{const item=cache(id,'shared'); item.assessment!.nextCheck='x'.repeat(600);return item})
    const out=LearningPlaygroundLookupOutput.parse(resolveRetrievalLookup({fixtureId:'test',foundationFirst:true},[{messageId:'shared'}],caches))
    expect(out.context.length).toBeLessThanOrEqual(4000)
    expect(JSON.parse(out.context.split('\n').at(-1)!)).toHaveLength(out.matches.length)
    expect(resolveRetrievalLookup({fixtureId:'test',foundationFirst:true},[],[],'offline').context).toBe('')
  })
})
